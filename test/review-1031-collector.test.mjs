import assert from "node:assert/strict";
import { generateKeyPairSync } from "node:crypto";
import { EventEmitter } from "node:events";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import {
  createCollectorAcquisitionRuntime,
  createSshCollectorClient,
  encodeCollectorFrame,
  normalizeCollectorConfig,
} from "../index.mjs";

// Regression tests for the 2026-10-31 review findings on collector
// multi-target isolation and collector status (PC-01, PC-02, PC-06, PC-07).

const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
const PRIVATE_KEY = privateKey.export({ type: "pkcs8", format: "pem" });
const APP_PROVIDER = {
  type: "github-app",
  host: "github.com",
  clientId: "Iv1.fixture-client",
  installationId: 123456,
  privateKeyFile: "/private/app.pem",
  repositoryIds: [101, 202],
  permissions: { metadata: "read", actions: "read", issues: "read", pull_requests: "read" },
};
const REPOSITORIES = {
  "acme/widget": { id: "R_widget", databaseId: 101 },
  "acme/gadget": { id: "R_gadget", databaseId: 202 },
};
const DEMAND = { active: true, background: true, floorMs: 5_000, pages: 1 };
// A short budget window keeps governor pacing out of the test duration.
const BUDGET_WINDOW_MS = 60_000;

function privatePathOptions(t) {
  const root = mkdtempSync(join(tmpdir(), "gh-glance-review-1031-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  return { env: { XDG_CONFIG_HOME: root }, platform: "linux", home: root };
}

function tokenResponse(provider, token, expiresAt) {
  return {
    status: 201,
    headers: { "x-ratelimit-resource": "core", "x-ratelimit-remaining": "4999" },
    body: JSON.stringify({ token, expires_at: new Date(expiresAt).toISOString(),
      repositories: provider.repositoryIds.map((id) => ({ id })), permissions: provider.permissions }),
  };
}

function ghResponse(resource, body, at, { status = "200 OK" } = {}) {
  return `HTTP/2 ${status}\r\nx-ratelimit-resource: ${resource}\r\n` +
    `x-ratelimit-limit: 5000\r\nx-ratelimit-used: 1\r\nx-ratelimit-remaining: 4999\r\n` +
    `x-ratelimit-reset: ${Math.ceil((at + BUDGET_WINDOW_MS) / 1000)}\r\netag: fixture-etag\r\n\r\n${JSON.stringify(body)}`;
}

// A fake `gh` child. The response is computed after runGh writes stdin, so a
// GraphQL fixture can answer by the repository variables it was sent. A
// `failure` response rejects the way a non-zero gh exit does.
function ghChild(respond) {
  const child = new EventEmitter();
  child.pid = process.pid;
  let input = null;
  child.stdin = { on() {}, end(value) { input = value; } };
  const pending = new Promise((resolve, reject) => setTimeout(() => {
    const { stdout, delayMs = 0, failure = null } = respond(input);
    setTimeout(() => {
      if (failure) {
        const error = new Error(`Command failed: gh\n${failure}`);
        error.code = 1;
        error.stdout = stdout;
        error.stderr = failure;
        reject(error);
      } else {
        resolve({ stdout, stderr: "" });
      }
      child.emit("close", failure ? 1 : 0);
    }, delayMs);
  }, 0));
  pending.child = child;
  return pending;
}

async function within(promise, timeoutMs = 5_000, label = "collector") {
  let timer;
  try {
    return await Promise.race([promise, new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error(`${label} timed out`)), timeoutMs);
    })]);
  } finally {
    clearTimeout(timer);
  }
}

function repositoryFromPath(path) {
  return Object.keys(REPOSITORIES).find((candidate) => path.startsWith(`repos/${candidate}/`)) ?? null;
}

// One GitHub App provider with two configured targets, resolved through the
// production defaultResolve/defaultProduce path (no resolveProvider or produce
// injection). PC-01 also keeps the default target identity read.
function twoTargetRuntime(t, { provider = APP_PROVIDER, rest, readCore = null, injectTargetIdentity = false } = {}) {
  const config = normalizeCollectorConfig({ version: 1, providers: { app: provider },
    targets: Object.keys(REPOSITORIES).map((repo) => ({ host: "github.com", repo, provider: "app" })) });
  const requests = [];
  const diagnostics = [];
  const executeGh = (command, args) => {
    assert.equal(command, "gh");
    if (args.includes("graphql")) {
      return ghChild((raw) => {
        const input = JSON.parse(raw ?? "{}");
        const at = Date.now();
        const rateLimit = { cost: 1, limit: 5_000, used: 1, remaining: 4_999,
          resetAt: new Date(at + BUDGET_WINDOW_MS).toISOString() };
        const repo = input.variables?.owner ? `${input.variables.owner}/${input.variables.name}` : null;
        if (repo && REPOSITORIES[repo]) {
          requests.push({ kind: "identity", repo });
          // The first target's identity answer is slower, so the second target
          // resolves through the shared provider while the first is waiting.
          return { stdout: ghResponse("graphql", { data: { rateLimit, repository: {
            id: REPOSITORIES[repo].id, nameWithOwner: repo } } }, at),
          delayMs: repo === "acme/widget" ? 40 : 5 };
        }
        requests.push({ kind: "graphql-observer" });
        return { stdout: ghResponse("graphql", { data: { rateLimit } }, at) };
      });
    }
    const path = String(args.find((arg) => String(arg).startsWith("repos/")) ?? "");
    const repo = repositoryFromPath(path);
    requests.push({ kind: "rest", repo, path: path.split("?")[0] });
    return ghChild(() => rest({ repo, path, at: Date.now() }));
  };
  const runtime = createCollectorAcquisitionRuntime({ config, pathOptions: privatePathOptions(t),
    executeGh,
    onDiagnostic: (event) => diagnostics.push(event),
    githubAppOptions: { readPrivateKey: () => PRIVATE_KEY,
      requestToken: async () => tokenResponse(provider, "installation-token", Date.now() + 3_600_000) },
    ...(injectTargetIdentity ? { resolveTargetIdentity: async ({ target }) => ({
      id: REPOSITORIES[target.repo].id, nameWithOwner: target.repo }) } : {}),
    readInstallationCore: async () => {
      requests.push({ kind: "core-observer" });
      await readCore?.();
      return { budget: { resource: "core", limit: 5_000, remaining: 4_999, used: 1,
        resetMs: Date.now() + BUDGET_WINDOW_MS }, etag: "app-core", receivedAt: Date.now(), cost: 1 };
    },
  });
  t.after(() => runtime.close());
  const snapshots = new Map(config.targets.map((target) => [target.repo, []]));
  const waiters = new Map();
  const handles = new Map();
  const nextSnapshot = (repo, afterGeneration, accept = () => true) => new Promise((resolve) => {
    waiters.set(repo, { afterGeneration, accept, resolve });
  });
  const subscribe = (repo, resource) => {
    const target = config.targets.find((candidate) => candidate.repo === repo);
    handles.set(repo, runtime.subscribe({ target, resource, demand: DEMAND,
      onSnapshot(snapshot) {
        snapshots.get(repo).push(snapshot);
        const waiter = waiters.get(repo);
        if (waiter && snapshot.generation > waiter.afterGeneration && waiter.accept(snapshot)) {
          waiters.delete(repo);
          waiter.resolve(snapshot);
        }
      },
      onHold(hold) { diagnostics.push({ hold, repo }); } }));
    return handles.get(repo);
  };
  const settle = (label, promises) => within(Promise.all(promises), 20_000, label).catch((error) => {
    throw new Error(`${error.message}: ${JSON.stringify({ diagnostics, requests })}`);
  });
  return { config, runtime, requests, diagnostics, snapshots, handles, subscribe, nextSnapshot, settle };
}

function sentinelRun(repo) {
  return { databaseId: REPOSITORIES[repo].databaseId, displayTitle: `sentinel ${repo}`,
    workflowName: "CI", number: 1, headBranch: "main", status: "completed", conclusion: "success",
    startedAt: "2026-10-31T00:00:00Z", updatedAt: "2026-10-31T00:01:00Z", workflowId: 1,
    url: `https://github.com/${repo}/actions/runs/${REPOSITORIES[repo].databaseId}` };
}

test("PC-01 (#163): two targets on one provider keep their own repository through default resolution", async (t) => {
  // Holds a budget read until a second operation joins it (or 250 ms pass),
  // so the two targets' operations interleave after both have resolved
  // through the shared provider.
  let waiting = [];
  const budgetRendezvous = () => new Promise((resolve) => {
    waiting.push(resolve);
    const release = () => { const ready = waiting; waiting = []; for (const done of ready) done(); };
    if (waiting.length >= 2) release();
    else setTimeout(() => { if (waiting.includes(resolve)) release(); }, 250);
  });
  const fixture = twoTargetRuntime(t, {
    readCore: budgetRendezvous,
    rest: ({ repo, path, at }) => ({ stdout: repo && path.includes("/actions/runs")
      ? ghResponse("core", [sentinelRun(repo)], at)
      : ghResponse("core", { total_count: 0, workflows: [] }, at) }),
  });
  const repos = Object.keys(REPOSITORIES);
  const withRows = (snapshot) => snapshot.rows.length > 0;
  // Concurrent initialization (target identity and first poll).
  const initialPending = repos.map((repo) => fixture.nextSnapshot(repo, 0, withRows));
  for (const repo of repos) fixture.subscribe(repo, "actions");
  const initial = await fixture.settle("two-target initialization", initialPending);
  // Concurrent forced polls on already-initialized targets.
  const refreshed = repos.map((repo, index) => fixture.nextSnapshot(repo, initial[index].generation, withRows));
  for (const repo of repos) fixture.handles.get(repo).refresh(true);
  await fixture.settle("two-target polling", refreshed);
  const identityReads = fixture.requests.filter((request) => request.kind === "identity")
    .map((request) => request.repo);
  assert.deepEqual([...new Set(identityReads)].sort(), ["acme/gadget", "acme/widget"],
    `target identity read another target's repository: ${JSON.stringify(fixture.requests)}`);
  for (const repo of repos) {
    for (const snapshot of fixture.snapshots.get(repo)) {
      assert.deepEqual(snapshot.rows.map((row) => row.displayTitle ?? row.title),
        snapshot.rows.length ? [`sentinel ${repo}`] : [],
        `${repo} received another target's rows: ${JSON.stringify(fixture.requests)}`);
    }
  }
});

// Dependabot is the only granted Security source, so each Security poll makes
// exactly one REST request per repository unless a backoff replays it. The
// capability backoff is process-wide, so each test uses its own installation
// (and therefore its own access key).
function dependabotProvider(installationId) {
  return { ...APP_PROVIDER, installationId,
    permissions: { ...APP_PROVIDER.permissions, vulnerability_alerts: "read" } };
}
const DISABLED = "gh: Dependabot alerts are disabled for this repository. (HTTP 403)";

function dependabotRest({ repo, path, at }) {
  assert.match(path, /\/dependabot\/alerts/);
  if (repo === "acme/widget") {
    return { stdout: ghResponse("core", { message: "Dependabot alerts are disabled for this repository." }, at,
      { status: "403 Forbidden" }), failure: DISABLED };
  }
  return { stdout: ghResponse("core", [{ number: 7, state: "open", created_at: "2026-10-30T00:00:00Z",
    severity: "high", title: "Prototype pollution", detail: "lodash" }], at) };
}

function dependabotRequests(fixture, repo) {
  return fixture.requests.filter((request) => request.kind === "rest" && request.repo === repo).length;
}

test("PC-02 (#165): one repository's Dependabot 403 does not hide another repository's alerts", async (t) => {
  const fixture = twoTargetRuntime(t, { provider: dependabotProvider(2001), rest: dependabotRest,
    injectTargetIdentity: true });
  const widget = fixture.nextSnapshot("acme/widget", 0);
  fixture.subscribe("acme/widget", "security");
  const widgetSnapshot = await fixture.settle("repository A security", [widget]);
  assert.deepEqual(widgetSnapshot[0].rows, []);
  assert.equal(dependabotRequests(fixture, "acme/widget"), 1);
  // Repository B polls inside A's 60 s backoff window.
  const gadget = fixture.nextSnapshot("acme/gadget", 0);
  fixture.subscribe("acme/gadget", "security");
  const [gadgetSnapshot] = await fixture.settle("repository B security", [gadget]);
  assert.equal(dependabotRequests(fixture, "acme/gadget"), 1,
    "repository B must request its own Dependabot alerts");
  assert.deepEqual(gadgetSnapshot.rows.map((row) => row.id), ["dependabot-7"]);
  // The other two sources are not granted to the fixture App; only the
  // Dependabot verdict is the invariant here.
  assert.equal(gadgetSnapshot.securityNotes.some((note) => /Dependabot/.test(note)), false);
  assert.equal(Object.hasOwn(gadgetSnapshot.capabilities ?? {}, "dependabot"), false);
});

test("PC-02 (#165): another repository's success does not reset a repository's backoff ladder", async (t) => {
  const fixture = twoTargetRuntime(t, { provider: dependabotProvider(2002), rest: dependabotRest,
    injectTargetIdentity: true });
  const gadget = fixture.nextSnapshot("acme/gadget", 0);
  fixture.subscribe("acme/gadget", "security");
  const [gadgetFirst] = await fixture.settle("repository B security", [gadget]);
  const widget = fixture.nextSnapshot("acme/widget", 0);
  fixture.subscribe("acme/widget", "security");
  const [widgetFirst] = await fixture.settle("repository A security", [widget]);
  assert.equal(dependabotRequests(fixture, "acme/widget"), 1);
  // A forced refresh bypasses B's own backoff and succeeds, which clears the
  // backoff entry for the key it is bound to.
  const gadgetForced = fixture.nextSnapshot("acme/gadget", gadgetFirst.generation);
  fixture.handles.get("acme/gadget").refresh(true);
  await fixture.settle("repository B forced success", [gadgetForced]);
  assert.equal(dependabotRequests(fixture, "acme/gadget"), 2);
  // An ordinary manual refresh of A inside its window must replay A's
  // backoff instead of re-probing the disabled endpoint.
  const widgetAgain = fixture.nextSnapshot("acme/widget", widgetFirst.generation);
  fixture.handles.get("acme/widget").refresh(false);
  const [widgetSecond] = await fixture.settle("repository A replay", [widgetAgain]);
  assert.equal(dependabotRequests(fixture, "acme/widget"), 1,
    "repository B's success reset repository A's backoff ladder");
  assert.equal(widgetSecond.capabilities?.dependabot?.verdict, "unavailable");
});

const EPOCH = "11111111-1111-4111-8111-111111111111";
const OTHER_EPOCH = "22222222-2222-4222-8222-222222222222";

class FakeTransport extends EventEmitter {
  writable = true;
  writes = [];
  write(value) { this.writes.push(String(value)); return true; }
  destroy() {
    if (!this.writable) return;
    this.writable = false;
    this.emit("close");
  }
}

function protocolSnapshot(generation, at) {
  return { resource: "actions", generation, rows: [], pageInfo: { loadedPages: 1, hasNextPage: false },
    lastSuccessAt: at, lastChangedAt: at, nextDueAt: at + 5_000, hold: null, meta: { at, truncated: false },
    securityNotes: [], securityBlind: false, capabilities: {} };
}

function sshClientFixture() {
  const transports = [];
  const timers = [];
  const ready = [];
  const delivered = [];
  const client = createSshCollectorClient({ alias: "studio",
    createTransport() { const transport = new FakeTransport(); transports.push(transport); return transport; },
    random: () => 0,
    setTimeout(callback, delay) { const timer = { callback, delay, unref() {} }; timers.push(timer); return timer; },
    clearTimeout() {},
    onReady: (value) => ready.push(value) });
  client.subscribe({ id: "one", host: "github.com", repo: "acme/widget", resource: "actions",
    demand: { active: false, background: false, floorMs: 5_000, pages: 1 },
    onSnapshot: (snapshot) => delivered.push(snapshot.generation) });
  const welcome = (transport, serverEpoch = EPOCH) => transport.emit("data", Buffer.from(encodeCollectorFrame({
    type: "welcome", protocolVersion: 1, serverEpoch, capabilities: { chunks: true, maxSubscriptions: 64 } })));
  const send = (transport, generation, serverEpoch = EPOCH) => transport.emit("data", Buffer.from(
    encodeCollectorFrame({ type: "snapshot", id: "one", serverEpoch, generation, serverNow: 2_000,
      snapshot: protocolSnapshot(generation, 1_000) })));
  const reconnect = () => {
    transports.at(-1).destroy();
    timers.at(-1).callback();
    const transport = transports.at(-1);
    transport.emit("connect");
    return transport;
  };
  return { client, transports, ready, delivered, welcome, send, reconnect };
}

test("PC-06 (#170): an equal-generation replay after a same-epoch reconnect acknowledges the connection", (t) => {
  const fixture = sshClientFixture();
  t.after(() => fixture.client.close());
  const first = fixture.transports[0];
  first.emit("connect");
  fixture.welcome(first);
  fixture.send(first, 5);
  assert.deepEqual(fixture.ready, [true]);
  assert.deepEqual(fixture.delivered, [5]);
  // The same snapshot again on the same connection is not a new delivery.
  fixture.send(first, 5);
  assert.deepEqual(fixture.delivered, [5]);
  const second = fixture.reconnect();
  fixture.welcome(second);
  // The server replays its cached generation 5 for the new subscription.
  fixture.send(second, 5);
  assert.equal(second.writable, true);
  assert.deepEqual(fixture.ready, [true, false, true],
    "a live same-epoch connection must leave Disconnected on an equal-generation replay");
  assert.deepEqual(fixture.delivered, [5, 5],
    "the replay must be delivered so the App restores its snapshot marker");
  fixture.send(second, 5);
  fixture.send(second, 4);
  assert.deepEqual(fixture.delivered, [5, 5], "repeats and older generations stay rejected");
});

test("PC-06 (#170): an older generation or another epoch's frame does not acknowledge a reconnect", (t) => {
  const fixture = sshClientFixture();
  t.after(() => fixture.client.close());
  const first = fixture.transports[0];
  first.emit("connect");
  fixture.welcome(first);
  fixture.send(first, 5);
  const second = fixture.reconnect();
  fixture.welcome(second);
  fixture.send(second, 4);
  fixture.send(second, 5, OTHER_EPOCH);
  assert.deepEqual(fixture.ready, [true, false]);
  assert.deepEqual(fixture.delivered, [5]);
});

test("PC-07 (#173): follower wakes do not re-send an unchanged generation", async (t) => {
  const config = normalizeCollectorConfig({ version: 1,
    providers: { personal: { type: "gh", host: "github.com" } },
    targets: [{ host: "github.com", repo: "acme/widget", provider: "personal" }] });
  const timers = new Set();
  let produced = 0;
  const runtime = createCollectorAcquisitionRuntime({ config, pathOptions: privatePathOptions(t),
    setTimeout(callback, delay) { const timer = { callback, delay, unref() {} }; timers.add(timer); return timer; },
    clearTimeout(timer) { timers.delete(timer); },
    resolveProvider: async () => ({ host: "github.com", kind: "user", id: 7, login: "octo",
      quotaKey: "q".repeat(64), accessKey: "a".repeat(64), credentialKey: "c".repeat(64),
      generation: 1, observedAt: 1 }),
    resolveTargetIdentity: async () => ({ id: "R_widget", nameWithOwner: "acme/widget" }),
    async produce({ markStarted }) {
      produced += 1;
      await markStarted();
      const at = Date.now();
      // Fresh for an hour, so every wake below is a follower read.
      return { rows: [{ number: produced }], entities: [], raw: JSON.stringify(produced),
        pageInfo: { loadedPages: 1, hasNextPage: false }, lastSuccessAt: at, lastChangedAt: at,
        nextDueAt: at + 3_600_000, hold: null, capabilities: {}, requestMetrics: {},
        uncertainReceipts: [], repositoryIdentity: { id: "R_widget", nameWithOwner: "acme/widget" },
        meta: { at, truncated: false }, securityNotes: [], securityBlind: false };
    },
  });
  t.after(() => runtime.close());
  const subscribe = () => {
    const deliveries = [];
    let notify = () => {};
    const handle = runtime.subscribe({ target: config.targets[0], resource: "issues", demand: DEMAND,
      onSnapshot(snapshot) { deliveries.push(snapshot.generation); notify(); }, onHold() {} });
    const next = (count) => within(new Promise((resolve) => {
      notify = () => { if (deliveries.length >= count) resolve(); };
      notify();
    }), 5_000, "collector delivery");
    return { handle, deliveries, next };
  };
  const wake = async (subscribers) => {
    const due = [...timers];
    timers.clear();
    for (const timer of due) timer.callback();
    for (const { handle } of subscribers) await handle.whenCurrentPollSettled();
  };
  const producer = subscribe();
  await producer.next(1);
  await producer.handle.whenCurrentPollSettled();
  // A second connection's subscription is a follower of the same query.
  const follower = subscribe();
  await follower.next(1);
  await follower.handle.whenCurrentPollSettled();
  for (let index = 0; index < 3; index += 1) await wake([producer, follower]);
  assert.equal(produced, 1);
  assert.deepEqual(follower.deliveries, [1],
    "an unchanged generation must not be re-sent on each follower wake");
  assert.deepEqual(producer.deliveries, [1]);
  // A new generation still reaches both subscribers once.
  producer.handle.refresh(true);
  await producer.next(2);
  await follower.next(2);
  await producer.handle.whenCurrentPollSettled();
  await wake([producer, follower]);
  assert.deepEqual(follower.deliveries, [1, 2]);
  // A new connection's subscription still receives the current snapshot.
  const reconnected = subscribe();
  await reconnected.next(1);
  await reconnected.handle.whenCurrentPollSettled();
  await wake([producer, follower, reconnected]);
  assert.deepEqual(reconnected.deliveries, [2]);
});
