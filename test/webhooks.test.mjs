import assert from "node:assert/strict";
import { createHmac, randomUUID } from "node:crypto";
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { EventEmitter } from "node:events";
import { request as httpRequest } from "node:http";
import { createConnection, createServer as createNetServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import {
  createCollectorAcquisitionRuntime,
  createCollectorService,
  createCollectorFrameDecoder,
  createGovernorScope,
  createWebhookIngress,
  encodeCollectorFrame,
  claimProbe,
  inspectGovernor,
  maintainControlLease,
  createWebhookQueue,
  mapWebhookInvalidations,
  normalizeCollectorConfig,
  publishProbe,
  recordResourceBlock,
  runAdmittedOperation,
  verifyWebhookSignature,
  webhookQueuePath,
  webhookReconciliationInterval,
  collectorSocketPath,
} from "../index.mjs";

const EVENTS = JSON.parse(readFileSync(new URL("./fixtures/webhook-events.json", import.meta.url), "utf8"));
const SECRET = Buffer.from("phase-ten-fixture-secret");
const TARGET = { host: "github.com", repo: "acme/widget", provider: "personal" };
const CONFIG = {
  version: 1,
  providers: { personal: { type: "gh", host: "github.com" } },
  targets: [TARGET],
  webhook: {
    enabled: true,
    address: "127.0.0.1",
    port: 8787,
    secretFile: "/private/webhook-secret",
    targets: [{ ...TARGET, resources: ["actions", "issues", "prs", "security"] }],
  },
};

function signature(body, secret = SECRET) {
  return `sha256=${createHmac("sha256", secret).update(body).digest("hex")}`;
}

function temporaryRoot(t) {
  const root = mkdtempSync(join(tmpdir(), "gh-glance-webhook-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  return { root, pathOptions: { env: { XDG_CONFIG_HOME: root }, platform: "linux", home: root } };
}

function publication(at, rows = []) {
  return {
    rows, entities: [], raw: JSON.stringify(rows), pageInfo: { loadedPages: 1, hasNextPage: false },
    lastSuccessAt: at, lastChangedAt: at, nextDueAt: at + 60_000,
    hold: null, capabilities: {}, requestMetrics: { httpRequests: 1, rest200: 1, coreUnits: 1 },
    uncertainReceipts: [], repositoryIdentity: { id: "R_1", nameWithOwner: "acme/widget" },
    meta: { at, truncated: false }, securityNotes: [], securityBlind: false,
  };
}

function fakeHttpServer() {
  let handler;
  const server = new EventEmitter();
  server.listen = (_port, _address, callback) => { queueMicrotask(callback); return server; };
  server.close = (callback) => { queueMicrotask(() => callback()); };
  server.closeAllConnections = () => {};
  const createServer = (next) => { handler = next; return server; };
  const request = ({ method = "POST", url = "/webhooks/github", headers = {}, body = Buffer.alloc(0),
    slow = false, drip = false, onRequest = null }) =>
    new Promise((resolve) => {
      const req = new EventEmitter();
      Object.assign(req, { method, url, headers,
        setTimeout(_delay, callback) { if (slow) queueMicrotask(callback); }, destroy() {} });
      const response = { statusCode: 200, headers: {}, setHeader(key, value) { this.headers[key] = value; },
        end(value = "") { resolve({ status: this.statusCode, body: String(value), headers: this.headers }); } };
      handler(req, response);
      onRequest?.(req);
      if (drip) {
        const split = Math.max(1, Math.floor(body.length / 2));
        setTimeout(() => req.emit("data", body.subarray(0, split)), 20);
        setTimeout(() => req.emit("data", body.subarray(split)), 40);
        setTimeout(() => req.emit("end"), 60);
      } else if (!slow) {
        queueMicrotask(() => { if (body.length > 0) req.emit("data", body); req.emit("end"); });
      }
    });
  return { createServer, request, server };
}

async function freeLoopbackPort() {
  const server = createNetServer();
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const port = server.address().port;
  await new Promise((resolve) => server.close(resolve));
  return port;
}

function postLoopback({ port, headers, body, dripMs = 0 }) {
  return new Promise((resolve, reject) => {
    let settled = false;
    const request = httpRequest({ hostname: "127.0.0.1", port, path: "/webhooks/github", method: "POST", headers },
      (response) => {
        response.resume();
        response.once("end", () => { settled = true; resolve(response.statusCode); });
      });
    request.on("error", (error) => { if (!settled) reject(error); });
    if (dripMs > 0) {
      request.flushHeaders();
      for (let index = 0; index < body.length; index += 1) {
        setTimeout(() => request.write(body.subarray(index, index + 1)), dripMs * (index + 1));
      }
      setTimeout(() => request.end(), dripMs * (body.length + 1));
    } else {
      request.end(body);
    }
  });
}

function connectCollector(path) {
  return new Promise((resolve, reject) => {
    const socket = createConnection(path);
    socket.once("connect", () => resolve(socket));
    socket.once("error", reject);
  });
}

function publishGovernorCapacity(scope, leaseId, at = Date.now()) {
  const values = {
    core: { limit: 5_000, remaining: 5_000, used: 0, resetMs: at + 3_600_000 },
    graphql: { limit: 5_000, remaining: 5_000, used: 0, resetMs: at + 3_600_000 },
  };
  for (const resource of ["core", "graphql"]) {
    const claim = claimProbe(scope, leaseId, at, resource);
    assert.equal(claim.value.status, "claimed");
    assert.equal(publishProbe(scope, leaseId, claim.value.nonce, values, at, resource).ok, true);
  }
}

function within(promise, timeoutMs = 5_000) {
  let timer;
  return Promise.race([promise, new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error("timed out")), timeoutMs);
  })]).finally(() => clearTimeout(timer));
}

test("HOOK-01/07: webhook config, raw-byte HMAC, and loopback boundary are strict", () => {
  const normalized = normalizeCollectorConfig(CONFIG);
  assert.deepEqual(normalized.webhook, CONFIG.webhook);
  for (const address of ["0.0.0.0", "::", "192.168.1.3", "localhost"]) {
    assert.equal(normalizeCollectorConfig({ ...CONFIG,
      webhook: { ...CONFIG.webhook, address } }), null);
  }
  assert.equal(normalizeCollectorConfig({ ...CONFIG,
    webhook: { ...CONFIG.webhook, targets: [{ ...CONFIG.webhook.targets[0], provider: "missing" }] } }), null);
  assert.equal(normalizeCollectorConfig({ ...CONFIG,
    webhook: { ...CONFIG.webhook, targets: [{ ...CONFIG.webhook.targets[0], repo: "other/repo" }] } }), null);
  assert.deepEqual(normalizeCollectorConfig({ ...CONFIG, webhook: { enabled: false } }).webhook,
    { enabled: false });

  const body = Buffer.from(JSON.stringify(EVENTS.workflow_run));
  assert.equal(verifyWebhookSignature(body, signature(body), SECRET), true);
  assert.equal(verifyWebhookSignature(Buffer.concat([body, Buffer.from(" ")]), signature(body), SECRET), false);
  assert.equal(verifyWebhookSignature(body, "sha256=bad", SECRET), false);
  assert.equal(verifyWebhookSignature(body, null, SECRET), false);
});

test("HOOK-01/02/07: ingress authenticates raw bytes before durable acknowledgement and bounds bodies", async (t) => {
  const { root, pathOptions } = temporaryRoot(t);
  const secretFile = join(root, "webhook-secret");
  writeFileSync(secretFile, SECRET, { mode: 0o600 });
  chmodSync(secretFile, 0o600);
  const config = normalizeCollectorConfig({ ...CONFIG,
    webhook: { ...CONFIG.webhook, secretFile } });
  const harness = fakeHttpServer();
  let resolveDispatch;
  const dispatched = new Promise((resolve) => { resolveDispatch = resolve; });
  const ingress = await createWebhookIngress({ config, pathOptions, createServer: harness.createServer,
    requestTimeoutMs: 30,
    dispatch: async (invalidation) => { resolveDispatch(invalidation); } });
  t.after(() => ingress.close());
  const body = Buffer.from(JSON.stringify(EVENTS.issues));
  const headers = { "x-github-delivery": "88888888-8888-4888-8888-888888888888",
    "x-github-event": "issues", "x-hub-signature-256": signature(body), "content-length": String(body.length),
    "content-type": "application/json" };
  assert.equal((await harness.request({ headers, body })).status, 202);
  assert.equal(ingress.queue.inspect().value.pending, 1);
  assert.equal((await within(dispatched)).resource, "issues");
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(ingress.queue.inspect().value.pending, 0);
  assert.equal((await harness.request({ headers: { ...headers,
    "x-github-delivery": "99999999-9999-4999-8999-999999999999",
    "x-hub-signature-256": signature(Buffer.from("{}")) }, body })).status, 401);
  assert.equal(ingress.queue.inspect().value.pending, 0);
  assert.equal((await harness.request({ headers: { ...headers,
    "x-github-delivery": "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
    "content-length": String(25 * 1024 * 1024 + 1) }, body: Buffer.alloc(0) })).status, 413);
  const malformed = Buffer.from("{");
  assert.equal((await harness.request({ headers: { ...headers,
    "x-github-delivery": "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
    "x-hub-signature-256": signature(malformed), "content-length": "1" }, body: malformed })).status, 400);
  assert.equal((await within(harness.request({ headers: { ...headers,
    "x-github-delivery": "cccccccc-cccc-4ccc-8ccc-cccccccccccc" }, body, slow: true }))).status, 408);
  assert.equal((await harness.request({ headers: { ...headers,
    "x-github-delivery": "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee" }, body, drip: true })).status, 408,
  "slow drip must not reset the absolute body deadline");
  const wrong = Buffer.from(JSON.stringify({ ...EVENTS.issues,
    repository: { full_name: "evil/other" } }));
  assert.equal((await harness.request({ headers: { ...headers,
    "x-github-delivery": "dddddddd-dddd-4ddd-8ddd-dddddddddddd",
    "x-hub-signature-256": signature(wrong), "content-length": String(wrong.length) }, body: wrong })).status, 400);
  assert.equal(ingress.queue.inspect().value.pending, 0);
});

test("HOOK-01/07: ingress bounds aggregate body memory and releases reservations exactly once", async (t) => {
  const { root, pathOptions } = temporaryRoot(t);
  const secretFile = join(root, "webhook-secret");
  writeFileSync(secretFile, SECRET, { mode: 0o600 });
  const config = normalizeCollectorConfig({ ...CONFIG,
    webhook: { ...CONFIG.webhook, secretFile } });
  const harness = fakeHttpServer();
  const ingress = await createWebhookIngress({ config, pathOptions, createServer: harness.createServer,
    bodyMaxBytes: 8, aggregateBodyMaxBytes: 3, requestTimeoutMs: 1_000, dispatch: async () => {} });
  t.after(() => ingress.close());
  const body = Buffer.from("{}");
  const headers = { "content-type": "application/json", "content-length": String(body.length),
    "x-github-delivery": "31313131-3131-4131-8131-313131313131",
    "x-github-event": "issues", "x-hub-signature-256": "sha256=bad" };
  let heldRequest;
  const held = harness.request({ headers, body, slow: true, onRequest(request) { heldRequest = request; } });
  assert.equal((await harness.request({ headers: { ...headers,
    "x-github-delivery": "32323232-3232-4232-8232-323232323232" }, body })).status, 503);
  heldRequest.emit("data", body);
  heldRequest.emit("end");
  assert.equal((await held).status, 401);
  assert.equal((await harness.request({ headers: { ...headers,
    "x-github-delivery": "33333333-3333-4333-8333-333333333334" }, body })).status, 401);
});

test("HOOK-07: ingress construction wipes an acquired secret after a synchronous setup failure", async () => {
  const ownedSecret = Buffer.from(SECRET);
  await assert.rejects(createWebhookIngress({ config: normalizeCollectorConfig(CONFIG),
    readSecret: () => ownedSecret,
    createServer() { throw new Error("server construction failed"); },
    dispatch: async () => {} }), /server construction failed/);
  assert.deepEqual(ownedSecret, Buffer.alloc(ownedSecret.length));
});

test("HOOK-03/07: replay starts only after bind and setup rollback awaits active dispatch", async (t) => {
  const { pathOptions } = temporaryRoot(t);
  let queueNow = 1_000;
  const queue = createWebhookQueue({ pathOptions, now: () => queueNow });
  queue.accept({ deliveryId: "34343434-3434-4434-8434-343434343434",
    invalidations: [{ ...TARGET, resource: "issues", accessRemoved: false }] });
  queueNow += 1_000;
  let finishBind;
  const server = {
    once() {}, off() {},
    listen(_port, _address, callback) { finishBind = callback; },
    on() { throw new Error("post-bind setup failed"); },
    close(callback) { callback(); }, closeAllConnections() {},
  };
  let dispatchStarted;
  let releaseDispatch;
  const started = new Promise((resolve) => { dispatchStarted = resolve; });
  const released = new Promise((resolve) => { releaseDispatch = resolve; });
  const ownedSecret = Buffer.from(SECRET);
  const constructing = createWebhookIngress({ config: normalizeCollectorConfig(CONFIG), pathOptions,
    readSecret: () => ownedSecret, createServer: () => server, now: () => queueNow,
    setTimeout(callback) { callback(); return 1; }, clearTimeout() {},
    dispatch: async () => { dispatchStarted(); await released; } });
  await new Promise((resolve) => setImmediate(resolve));
  let dispatched = false;
  started.then(() => { dispatched = true; });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(dispatched, false, "durable replay must not start before the listener binds");
  finishBind();
  await within(started);
  let rolledBack = false;
  constructing.catch(() => { rolledBack = true; });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(rolledBack, false, "rollback must await the active durable dispatch");
  releaseDispatch();
  await assert.rejects(constructing, /post-bind setup failed/);
  assert.deepEqual(ownedSecret, Buffer.alloc(ownedSecret.length));
});

test("HOOK-01/07: real loopback slow drip hits one absolute body deadline without path disclosure", async (t) => {
  const { root, pathOptions } = temporaryRoot(t);
  const secretFile = join(root, "webhook-secret");
  writeFileSync(secretFile, SECRET, { mode: 0o600 });
  const port = await freeLoopbackPort();
  const config = normalizeCollectorConfig({ ...CONFIG,
    webhook: { ...CONFIG.webhook, port, secretFile } });
  const ingress = await createWebhookIngress({ config, pathOptions, requestTimeoutMs: 30,
    dispatch: async () => {} });
  t.after(() => ingress.close());
  const body = Buffer.from("{}");
  const status = await postLoopback({ port, body, dripMs: 20,
    headers: { "content-type": "application/json", "content-length": String(body.length),
      "x-github-delivery": "17171717-1717-4171-8171-171717171717",
      "x-github-event": "issues", "x-hub-signature-256": signature(body) } });
  assert.equal(status, 408);
  const missing = "/private/path-that-must-not-appear/webhook-secret";
  const missingConfig = normalizeCollectorConfig({ ...CONFIG,
    webhook: { ...CONFIG.webhook, port: await freeLoopbackPort(), secretFile: missing } });
  await assert.rejects(createWebhookIngress({ config: missingConfig, pathOptions, dispatch: async () => {} }),
    (error) => error.message === "webhook secret unavailable" && !error.message.includes(missing));
});

test("HOOK-02/03/07: durable queue deduplicates, coalesces, survives restart, and never stores bodies", async (t) => {
  const { root, pathOptions } = temporaryRoot(t);
  let now = 10_000;
  const queue = createWebhookQueue({ pathOptions, now: () => now });
  const actions = [{ ...TARGET, resource: "actions", accessRemoved: false }];
  assert.deepEqual(queue.accept({ deliveryId: "11111111-1111-4111-8111-111111111111",
    invalidations: actions }), { ok: true, duplicate: false, queued: 1, nextDueAt: 11_000 });
  for (let index = 0; index < 100; index += 1) {
    assert.equal(queue.accept({ deliveryId: "11111111-1111-4111-8111-111111111111",
      invalidations: actions }).duplicate, true);
  }
  assert.equal(queue.accept({ deliveryId: "22222222-2222-4222-8222-222222222222",
    invalidations: actions }).queued, 1);
  assert.equal(queue.accept({ deliveryId: "33333333-3333-4333-8333-333333333333",
    invalidations: [{ ...TARGET, resource: "issues", accessRemoved: false }] }).queued, 2);

  const persisted = readFileSync(webhookQueuePath(pathOptions), "utf8");
  assert.doesNotMatch(persisted, /phase-ten-fixture-secret|workflow_run|workflow_run_fixture|"issue"/);
  const restarted = createWebhookQueue({ pathOptions, now: () => now });
  assert.equal(restarted.inspect().value.pending, 2);
  now += 1_000;
  const dispatched = [];
  await restarted.drain(async (invalidation) => { dispatched.push(invalidation.resource); });
  assert.deepEqual(dispatched.sort(), ["actions", "issues"]);
  assert.equal(restarted.inspect().value.pending, 0);
  now += 24 * 60 * 60 * 1_000;
  assert.equal(restarted.inspect().value.deliveries, 0);

  const tiny = createWebhookQueue({ pathOptions: { env: { XDG_CONFIG_HOME: join(root, "tiny") },
    platform: "linux", home: root }, now: () => now, maxInvalidations: 1 });
  assert.equal(tiny.accept({ deliveryId: "44444444-4444-4444-8444-444444444444",
    invalidations: actions }).ok, true);
  assert.deepEqual(tiny.accept({ deliveryId: "55555555-5555-4555-8555-555555555555",
    invalidations: [{ ...TARGET, resource: "issues", accessRemoved: false }] }),
  { ok: false, reason: "capacity" });
});

test("HOOK-02/03/04: a newer dirty revision arriving in flight survives for one follow-up", async (t) => {
  const { pathOptions } = temporaryRoot(t);
  let now = 20_000;
  const queue = createWebhookQueue({ pathOptions, now: () => now });
  const invalidation = { ...TARGET, resource: "actions", accessRemoved: false };
  assert.equal(queue.accept({ deliveryId: "66666666-6666-4666-8666-666666666666",
    invalidations: [invalidation] }).ok, true);
  now += 1_000;
  let release;
  const first = queue.drain(() => new Promise((resolve) => { release = resolve; }));
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(queue.accept({ deliveryId: "77777777-7777-4777-8777-777777777777",
    invalidations: [invalidation] }).ok, true);
  release();
  assert.equal((await first).pending, 1, "completion of the older revision must not erase newer dirtiness");
  now += 1_000;
  let followUps = 0;
  await queue.drain(async () => { followUps += 1; });
  assert.equal(followUps, 1);
  assert.equal(queue.inspect().value.pending, 0);
});

test("HOOK-03/04: a held key cannot block a later unrelated resource", async (t) => {
  const { pathOptions } = temporaryRoot(t);
  let now = 30_000;
  const queue = createWebhookQueue({ pathOptions, now: () => now });
  queue.accept({ deliveryId: "12121212-1212-4121-8121-121212121212",
    invalidations: [{ ...TARGET, resource: "actions", accessRemoved: false }] });
  now += 1_000;
  let releaseActions;
  let actionsStarted;
  const started = new Promise((resolve) => { actionsStarted = resolve; });
  const first = queue.drain((_invalidation) => {
    actionsStarted();
    return new Promise((resolve) => { releaseActions = resolve; });
  });
  await started;
  queue.accept({ deliveryId: "13131313-1313-4131-8131-131313131313",
    invalidations: [{ ...TARGET, resource: "security", accessRemoved: false }] });
  now += 1_000;
  const seen = [];
  await queue.drain(async (invalidation) => { seen.push(invalidation.resource); });
  assert.deepEqual(seen, ["security"]);
  assert.deepEqual(queue.inspect().value.invalidations.map((item) => item.resource), ["actions"]);
  releaseActions();
  await first;
});

test("HOOK-06: a durable access fence preempts older in-flight work for the same key", async (t) => {
  const { pathOptions } = temporaryRoot(t);
  let now = 40_000;
  const queue = createWebhookQueue({ pathOptions, now: () => now });
  const ordinary = { ...TARGET, resource: "issues", accessRemoved: false };
  queue.accept({ deliveryId: "23232323-2323-4232-8232-232323232323", invalidations: [ordinary] });
  now += 1_000;
  let release;
  let started;
  const olderStarted = new Promise((resolve) => { started = resolve; });
  const older = queue.drain(() => { started(); return new Promise((resolve) => { release = resolve; }); });
  await olderStarted;
  queue.accept({ deliveryId: "24242424-2424-4242-8242-242424242424",
    invalidations: [{ ...ordinary, accessRemoved: true }] });
  now += 1_000;
  const dispatched = [];
  await queue.drain(async (invalidation) => { dispatched.push(invalidation.accessRemoved); });
  assert.deepEqual(dispatched, [true]);
  release();
  await older;
});

test("HOOK-03/07: queue rejects future timestamps and recovers only a dead owner's fresh lock", (t) => {
  const { pathOptions } = temporaryRoot(t);
  const deadPid = 2_147_483_647;
  const dead = new Error("dead");
  dead.code = "ESRCH";
  const queue = createWebhookQueue({ pathOptions, pid: 41,
    kill(pid) { if (pid === deadPid) throw dead; } });
  writeFileSync(`${queue.path}.lock`, JSON.stringify({ pid: deadPid,
    nonce: "14141414-1414-4141-8141-141414141414" }), { mode: 0o600 });
  assert.equal(queue.accept({ deliveryId: "15151515-1515-4151-8151-151515151515",
    invalidations: [{ ...TARGET, resource: "issues", accessRemoved: false }] }).ok, true);
  assert.equal(existsSync(`${queue.path}.lock`), false);
  const future = Date.now() + 60_000;
  writeFileSync(queue.path, `${JSON.stringify({ version: 1,
    deliveries: { "16161616-1616-4161-8161-161616161616": future }, invalidations: {} })}\n`,
  { mode: 0o600 });
  assert.equal(queue.inspect().ok, false);
});

test("HOOK-03: restart retries a fresh live queue lock and replays after its owner releases", async (t) => {
  const { root, pathOptions } = temporaryRoot(t);
  const secretFile = join(root, "webhook-secret");
  writeFileSync(secretFile, SECRET, { mode: 0o600 });
  const config = normalizeCollectorConfig({ ...CONFIG,
    webhook: { ...CONFIG.webhook, secretFile } });
  const queue = createWebhookQueue({ pathOptions });
  queue.accept({ deliveryId: "18181818-1818-4181-8181-181818181818",
    invalidations: [{ ...TARGET, resource: "issues", accessRemoved: false }] });
  const lockPath = `${queue.path}.lock`;
  writeFileSync(lockPath, JSON.stringify({ pid: process.pid,
    nonce: "19191919-1919-4191-8191-191919191919" }), { mode: 0o600 });
  const releaseLock = setTimeout(() => { if (existsSync(lockPath)) rmSync(lockPath); }, 300);
  t.after(() => clearTimeout(releaseLock));
  let replayed;
  const replay = new Promise((resolve) => { replayed = resolve; });
  const harness = fakeHttpServer();
  const ingress = await createWebhookIngress({ config, pathOptions, createServer: harness.createServer,
    dispatch: async (invalidation) => { replayed(invalidation); } });
  t.after(() => ingress.close());
  assert.equal((await within(replay)).resource, "issues");
});

test("HOOK-01/06: event mapping is allowlisted, resource-specific, and access removal is fenced", () => {
  const config = normalizeCollectorConfig(CONFIG);
  const expected = new Map([
    ["workflow_run", "actions"], ["issues", "issues"], ["pull_request", "prs"],
    ["issue_comment_issue", "issues"], ["issue_comment_pr", "prs"],
    ["code_scanning_alert", "security"],
  ]);
  for (const [fixture, resource] of expected) {
    const event = fixture.startsWith("issue_comment") ? "issue_comment" : fixture;
    const mapped = mapWebhookInvalidations({ event, payload: EVENTS[fixture], config });
    assert.equal(mapped.ok, true);
    assert.deepEqual(mapped.invalidations.map((item) => item.resource), [resource]);
  }
  assert.deepEqual(mapWebhookInvalidations({ event: "push", payload: EVENTS.workflow_run, config }),
    { ok: true, unsupported: true, invalidations: [] });
  assert.equal(mapWebhookInvalidations({ event: "issues", payload: {
    ...EVENTS.issues, repository: { full_name: "evil/other" } }, config }).reason, "target");
  const removal = mapWebhookInvalidations({ event: "installation_repositories",
    payload: EVENTS.installation_repositories, config });
  assert.equal(removal.ok, true);
  assert.equal(removal.invalidations.length, 4);
  assert.ok(removal.invalidations.every((item) => item.accessRemoved));
  const partialCoverage = normalizeCollectorConfig({ ...CONFIG, webhook: { ...CONFIG.webhook,
    targets: [{ ...CONFIG.webhook.targets[0], resources: ["issues"] }] } });
  assert.deepEqual(mapWebhookInvalidations({ event: "installation_repositories",
    payload: EVENTS.installation_repositories, config: partialCoverage }).invalidations.map((item) => item.resource),
  ["actions", "issues", "prs", "security"], "access removal must fence uncovered subscriptions too");
});

test("HOOK-05/06: only explicitly covered quiet resources receive five-minute reconciliation", () => {
  assert.equal(webhookReconciliationInterval({ covered: true, resource: "issues", floorMs: 5_000,
    rows: [], unchangedCount: 0 }), null);
  assert.equal(webhookReconciliationInterval({ covered: true, resource: "issues", floorMs: 5_000,
    rows: [], unchangedCount: 1 }), null);
  assert.equal(webhookReconciliationInterval({ covered: true, resource: "issues", floorMs: 5_000,
    rows: [], unchangedCount: 2 }),
    300_000);
  assert.equal(webhookReconciliationInterval({ covered: true, resource: "prs", floorMs: 420_000,
    rows: [], unchangedCount: 2 }),
    420_000);
  assert.equal(webhookReconciliationInterval({ covered: true, resource: "actions", floorMs: 5_000,
    rows: [{ status: "in_progress" }], unchangedCount: 2 }), null);
  assert.equal(webhookReconciliationInterval({ covered: false, resource: "issues", floorMs: 5_000,
    rows: [], unchangedCount: 2 }),
    null);
});

test("HOOK-03/06: an invalidation with no matching subscriber remains durable", async (t) => {
  const { pathOptions } = temporaryRoot(t);
  let now = 50_000;
  const config = normalizeCollectorConfig(CONFIG);
  const runtime = createCollectorAcquisitionRuntime({ config, pathOptions,
    resolveProvider: async () => ({ host: "github.com", kind: "user", id: 7, login: "octo",
      quotaKey: "q".repeat(64), accessKey: "a".repeat(64), credentialKey: "c".repeat(64),
      generation: 1, observedAt: 1 }) });
  const queue = createWebhookQueue({ pathOptions, now: () => now });
  t.after(() => runtime.close());
  queue.accept({ deliveryId: "ffffffff-ffff-4fff-8fff-ffffffffffff",
    invalidations: [{ ...TARGET, resource: "issues", accessRemoved: false }] });
  const accepted = queue.inspect().value.invalidations[0];
  now += 1_000;
  await queue.drain((invalidation) => runtime.invalidate(invalidation));
  const dormant = queue.inspect().value;
  assert.equal(dormant.pending, 1);
  assert.equal(dormant.invalidations[0].revision, accepted.revision,
    "an unchanged deferral must not manufacture a dirty revision");
  assert.equal(dormant.invalidations[0].dueAt, now + 300_000,
    "no-subscriber work must sleep on the bounded reconciliation cadence");
  let redispatches = 0;
  now += 1_000;
  await queue.drain(async () => { redispatches += 1; });
  assert.equal(redispatches, 0, "dormant work must not retry every second");
});

test("HOOK-03/04/05: runtime invalidation completes only after a newer validated publication", async (t) => {
  const { pathOptions } = temporaryRoot(t);
  let starts = 0;
  let releaseSecond;
  const secondGate = new Promise((resolve) => { releaseSecond = resolve; });
  const snapshots = [];
  const runtime = createCollectorAcquisitionRuntime({
    config: normalizeCollectorConfig(CONFIG),
    pathOptions,
    resolveProvider: async () => ({ host: "github.com", kind: "user", id: 7, login: "octo",
      quotaKey: "q".repeat(64), accessKey: "a".repeat(64), credentialKey: "c".repeat(64),
      generation: 1, observedAt: 1 }),
    resolveTargetIdentity: async () => ({ id: "R_1", nameWithOwner: "acme/widget" }),
    async produce({ markStarted }) {
      starts += 1;
      await markStarted();
      if (starts === 2) await secondGate;
      return publication(Date.now(), [{ number: starts, title: `generation ${starts}`, author: "octo",
        label: "", updatedAt: "2026-09-15T00:00:00Z", url: "https://github.com/acme/widget/issues/1" }]);
    },
  });
  t.after(() => runtime.close());
  await new Promise((resolve) => runtime.subscribe({ target: normalizeCollectorConfig(CONFIG).targets[0],
    resource: "issues", demand: { active: true, background: true, floorMs: 5_000, pages: 1 },
    onSnapshot(value) { snapshots.push(value); resolve(); }, onHold() {} }));
  let completed = false;
  const invalidated = runtime.invalidate({ ...TARGET, resource: "issues", accessRemoved: false })
    .then(() => { completed = true; });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(starts, 2);
  assert.equal(completed, false, "durable work must not complete at dispatch or retained-follower delivery");
  releaseSecond();
  await invalidated;
  assert.equal(completed, true);
  assert.equal(snapshots.at(-1).rows[0].number, 2);
});

test("HOOK-04: invalidation joining an older shared claim requests a follow-up generation", async (t) => {
  const { pathOptions } = temporaryRoot(t);
  const identity = { host: "github.com", kind: "user", id: 7, login: "octo",
    quotaKey: "q".repeat(64), accessKey: "a".repeat(64), credentialKey: "c".repeat(64),
    generation: 1, observedAt: 1 };
  let releaseOlder;
  const olderGate = new Promise((resolve) => { releaseOlder = resolve; });
  let olderStarted;
  const started = new Promise((resolve) => { olderStarted = resolve; });
  const common = { config: normalizeCollectorConfig(CONFIG), pathOptions,
    resolveProvider: async () => identity,
    resolveTargetIdentity: async () => ({ id: "R_1", nameWithOwner: "acme/widget" }) };
  const producer = createCollectorAcquisitionRuntime({ ...common,
    async produce({ markStarted }) {
      await markStarted();
      olderStarted();
      await olderGate;
      return publication(Date.now(), [{ number: 1, title: "older", author: "octo", label: "",
        updatedAt: "2026-09-15T00:00:00Z", url: "https://github.com/acme/widget/issues/1" }]);
    } });
  const follower = createCollectorAcquisitionRuntime({ ...common,
    async produce({ markStarted }) {
      await markStarted();
      return publication(Date.now(), [{ number: 2, title: "follow-up", author: "octo", label: "",
        updatedAt: "2026-09-15T00:00:00Z", url: "https://github.com/acme/widget/issues/2" }]);
    } });
  t.after(async () => { await producer.close(); await follower.close(); });
  producer.subscribe({ target: common.config.targets[0], resource: "issues",
    demand: { active: true, background: true, floorMs: 5_000, pages: 1 }, onSnapshot() {}, onHold() {} });
  await within(started);
  let joined;
  const joinedClaim = new Promise((resolve) => { joined = resolve; });
  let followUp;
  const followUpSnapshot = new Promise((resolve) => { followUp = resolve; });
  follower.subscribe({ target: common.config.targets[0], resource: "issues",
    demand: { active: true, background: true, floorMs: 5_000, pages: 1 },
    onSnapshot(snapshot) { if (snapshot.rows[0]?.number === 2) followUp(snapshot); },
    onHold(hold) { if (hold === "shared-wait") joined(); } });
  await within(joinedClaim);
  const invalidated = follower.invalidate({ ...TARGET, resource: "issues", accessRemoved: false });
  releaseOlder();
  await within(invalidated);
  assert.equal((await within(followUpSnapshot)).rows[0].number, 2);
});

test("HOOK-06: access removal retires the old binding and cannot publish its in-flight result", async (t) => {
  const { pathOptions } = temporaryRoot(t);
  let starts = 0;
  let identityChecks = 0;
  let releaseOld;
  const oldGate = new Promise((resolve) => { releaseOld = resolve; });
  const snapshots = [];
  const runtime = createCollectorAcquisitionRuntime({
    config: normalizeCollectorConfig(CONFIG),
    pathOptions,
    resolveProvider: async () => ({ host: "github.com", kind: "user", id: 7, login: "octo",
      quotaKey: "q".repeat(64), accessKey: "a".repeat(64), credentialKey: "c".repeat(64),
      generation: 1, observedAt: 1 }),
    resolveTargetIdentity: async () => { identityChecks += 1; return { id: "R_1", nameWithOwner: "acme/widget" }; },
    async produce({ markStarted }) {
      starts += 1;
      const sequence = starts;
      await markStarted();
      if (sequence === 2) await oldGate;
      return publication(Date.now(), [{ number: sequence, title: `generation ${sequence}`, author: "octo",
        label: "", updatedAt: "2026-09-15T00:00:00Z", url: "https://github.com/acme/widget/issues/1" }]);
    },
  });
  t.after(() => runtime.close());
  await new Promise((resolve) => runtime.subscribe({ target: normalizeCollectorConfig(CONFIG).targets[0],
    resource: "issues", demand: { active: true, background: true, floorMs: 5_000, pages: 1 },
    onSnapshot(value) { snapshots.push(value); resolve(); }, onHold() {} }));
  const ordinary = runtime.invalidate({ ...TARGET, resource: "issues", accessRemoved: false });
  while (starts < 2) await new Promise((resolve) => setImmediate(resolve));
  const removed = runtime.invalidate({ ...TARGET, resource: "issues", accessRemoved: true });
  releaseOld();
  await Promise.all([ordinary, removed]);
  assert.equal(identityChecks, 2, "access removal must revalidate repository access");
  assert.equal(snapshots.filter((snapshot) => snapshot.rows[0]?.number === 1).length, 1,
    "the access reset must not redeliver a retained old snapshot");
  assert.equal(snapshots.some((snapshot) => snapshot.rows[0]?.number === 2), false);
  assert.equal(snapshots.at(-1).rows[0].number, 3);
});

test("HOOK-06: access removal revalidates uncovered background-off subscriptions", async (t) => {
  const { pathOptions } = temporaryRoot(t);
  const config = normalizeCollectorConfig({ ...CONFIG, webhook: { ...CONFIG.webhook,
    targets: [{ ...CONFIG.webhook.targets[0], resources: ["issues"] }] } });
  let identityChecks = 0;
  let initialized;
  const firstInitialization = new Promise((resolve) => { initialized = resolve; });
  let produces = 0;
  const runtime = createCollectorAcquisitionRuntime({ config, pathOptions,
    resolveProvider: async () => ({ host: "github.com", kind: "user", id: 7, login: "octo",
      quotaKey: "q".repeat(64), accessKey: "a".repeat(64), credentialKey: "c".repeat(64),
      generation: 1, observedAt: 1 }),
    resolveTargetIdentity: async () => {
      identityChecks += 1;
      if (identityChecks === 1) initialized();
      return { id: "R_1", nameWithOwner: "acme/widget" };
    },
    async produce() { produces += 1; return publication(Date.now()); },
  });
  t.after(() => runtime.close());
  runtime.subscribe({ target: config.targets[0], resource: "security",
    demand: { active: false, background: false, floorMs: 5_000, pages: 1 },
    onSnapshot() {}, onHold() {} });
  await firstInitialization;
  await new Promise((resolve) => setImmediate(resolve));
  await runtime.invalidate({ ...TARGET, resource: "security", accessRemoved: true });
  assert.equal(identityChecks, 2);
  assert.equal(produces, 0, "background-off access fencing must not invent data demand");
});

test("HOOK-04/05/07: signed HTTP reaches governed collector display and holds stay honestly stale", async (t) => {
  const { root, pathOptions } = temporaryRoot(t);
  const secretFile = join(root, "webhook-secret");
  writeFileSync(secretFile, SECRET, { mode: 0o600 });
  const port = await freeLoopbackPort();
  const config = normalizeCollectorConfig({ ...CONFIG,
    webhook: { ...CONFIG.webhook, port, secretFile } });
  const governor = createGovernorScope({ effectiveHost: "github.com", authIdentity: "hook-e2e", ...pathOptions });
  assert.equal(governor.ok, true);
  const scope = governor.value;
  const leaseId = randomUUID();
  assert.equal(maintainControlLease(scope, leaseId, 5_000, "issues", Date.now()).ok, true);
  publishGovernorCapacity(scope, leaseId);
  let sequence = 0;
  let gateNext = false;
  let signalGatedStart = null;
  let releaseGated = null;
  const fetchStartedAt = new Map();
  const diagnostics = [];
  const runtime = createCollectorAcquisitionRuntime({
    config,
    pathOptions,
    resolveProvider: async () => ({ host: "github.com", kind: "user", id: 7, login: "octo",
      quotaKey: "q".repeat(64), accessKey: "a".repeat(64), credentialKey: "c".repeat(64),
      generation: 1, observedAt: 1 }),
    resolveTargetIdentity: async () => ({ id: "R_1", nameWithOwner: "acme/widget" }),
    onDiagnostic(event) { diagnostics.push(event); },
    async produce({ markStarted, signal }) {
      const governed = await runAdmittedOperation({ scope, leaseId, operation: "tab:issues",
        priority: "active", signal, waitMs: 5_000,
        run: async () => {
          await markStarted();
          const nextSequence = sequence + 1;
          fetchStartedAt.set(nextSequence, performance.now());
          if (gateNext) {
            gateNext = false;
            await new Promise((resolve) => {
              releaseGated = resolve;
              signalGatedStart?.();
            });
          }
          await new Promise((resolve) => setTimeout(resolve, 100));
          sequence = nextSequence;
          return publication(Date.now(), [{ number: nextSequence, title: `API generation ${nextSequence}`,
            author: "octo", label: "", updatedAt: "2026-09-15T00:00:00Z",
            url: `https://github.com/acme/widget/issues/${nextSequence}` }]);
        } });
      if (governed.ok) return governed.value;
      const error = governed.error ?? new Error("governor held");
      error.notStarted = true;
      error.retryAt = Date.now() + 100;
      throw error;
    },
  });
  const service = await createCollectorService({ config, pathOptions, runtime });
  t.after(() => service.close());
  const socket = await connectCollector(service.socketPath);
  t.after(() => socket.destroy());
  const frames = [];
  let latest = null;
  const snapshotWaiters = new Map();
  let rejectDecoder;
  const decoderFailure = new Promise((_, reject) => { rejectDecoder = reject; });
  const decoder = createCollectorFrameDecoder({
    onError(error) { rejectDecoder(error); },
    onFrame(frame) {
      frames.push(frame);
      if (frame.type !== "snapshot") return;
      latest = frame.snapshot;
      snapshotWaiters.get(latest.rows[0]?.number)?.(latest);
    },
  });
  socket.on("data", (chunk) => decoder.push(chunk));
  const waitForSequence = (wanted) => latest?.rows[0]?.number === wanted ? Promise.resolve(latest)
    : Promise.race([new Promise((resolve) => snapshotWaiters.set(wanted, resolve)), decoderFailure]);
  socket.write(encodeCollectorFrame({ type: "hello", protocolVersion: 1 }));
  socket.write(encodeCollectorFrame({ type: "subscribe", id: "hook-e2e", host: "github.com",
    repo: "acme/widget", resource: "issues",
    demand: { active: true, background: true, floorMs: 5_000, pages: 1 } }));
  await within(waitForSequence(1)).catch((error) => {
    error.message = `${error.message}: ${JSON.stringify(diagnostics)}`;
    throw error;
  });
  const initializedGovernor = inspectGovernor(scope, Date.now());
  assert.equal(initializedGovernor.ok, true);
  const readyAt = Math.max(...Object.values(initializedGovernor.value.budgets)
    .map((budget) => budget?.laneNextAt ?? 0));
  await new Promise((resolve) => setTimeout(resolve, Math.max(0, readyAt - Date.now()) + 10));

  const sendIssue = async (deliveryId) => {
    const body = Buffer.from(JSON.stringify({ ...EVENTS.issues, marker: deliveryId }));
    const status = await postLoopback({ port, body, headers: { "content-type": "application/json",
      "content-length": String(body.length), "x-github-delivery": deliveryId,
      "x-github-event": "issues", "x-hub-signature-256": signature(body) } });
    assert.equal(status, 202);
    return body;
  };
  const startedAt = performance.now();
  const firstBody = await sendIssue("20202020-2020-4202-8202-202020202020");
  const acceptedAt = performance.now();
  await within(waitForSequence(2), 3_000);
  const displayedAt = performance.now();
  const firstDeliveryTiming = {
    acknowledgementMs: acceptedAt - startedAt,
    dispatchMs: fetchStartedAt.get(2) - acceptedAt,
    publicationMs: displayedAt - fetchStartedAt.get(2),
    totalMs: displayedAt - startedAt,
  };
  assert.ok(displayedAt - startedAt < 3_000, `webhook latency ${JSON.stringify(firstDeliveryTiming)}`);

  for (const [reason, deliveryId, wanted] of [
    ["rate-limit", "21212121-2121-4212-8212-212121212121", 3],
    ["abuse-limit", "22222222-2222-4222-8222-222222222222", 4],
  ]) {
    const before = latest.lastSuccessAt;
    assert.equal(recordResourceBlock(scope, "graphql", Date.now() + 1_200, reason).ok, true);
    await sendIssue(deliveryId);
    await new Promise((resolve) => setTimeout(resolve, 1_100));
    assert.equal(latest.rows[0].number, wanted - 1);
    assert.equal(latest.lastSuccessAt, before, "a held delivery must not create freshness");
    await within(waitForSequence(wanted));
  }

  gateNext = true;
  const gatedStarted = new Promise((resolve) => { signalGatedStart = resolve; });
  await sendIssue("25252525-2525-4252-8252-252525252525");
  await within(gatedStarted, 3_000);
  const accessBody = Buffer.from(JSON.stringify(EVENTS.installation_repositories));
  assert.equal(await postLoopback({ port, body: accessBody, headers: {
    "content-type": "application/json", "content-length": String(accessBody.length),
    "x-github-delivery": "26262626-2626-4262-8262-262626262626",
    "x-github-event": "installation_repositories", "x-hub-signature-256": signature(accessBody),
  } }), 202);
  await new Promise((resolve) => setTimeout(resolve, 1_100));
  releaseGated();
  await within(waitForSequence(6));
  assert.equal(frames.some((frame) => frame.type === "snapshot" && frame.snapshot.rows[0]?.number === 5), false);

  await new Promise((resolve) => setImmediate(resolve));
  const persisted = readFileSync(webhookQueuePath(pathOptions), "utf8");
  const evidence = `${persisted}\n${JSON.stringify(frames)}\n${JSON.stringify(diagnostics)}`;
  assert.equal(evidence.includes(SECRET.toString()), false);
  assert.equal(evidence.includes(firstBody.toString()), false);
});

test("HOOK-03/07: collector close is awaited, idempotent, and cleans both ingress boundaries on failure", async (t) => {
  const { root, pathOptions } = temporaryRoot(t);
  const secretFile = join(root, "webhook-secret");
  writeFileSync(secretFile, SECRET, { mode: 0o600 });
  const config = normalizeCollectorConfig({ ...CONFIG,
    webhook: { ...CONFIG.webhook, secretFile } });
  const harness = fakeHttpServer();
  let closes = 0;
  const service = await createCollectorService({ config, pathOptions, createWebhookServer: harness.createServer,
    runtime: { subscribe() { return { close() {} }; }, invalidate: async () => {},
      async close() { closes += 1; throw new Error("runtime close failed"); } } });
  const first = service.close();
  const second = service.close();
  assert.equal(first, second);
  await assert.rejects(first, /runtime close failed/);
  assert.equal(closes, 1);
  assert.equal(existsSync(collectorSocketPath(pathOptions)), false);
  assert.equal(existsSync(`${collectorSocketPath(pathOptions)}.lock`), false);
});
