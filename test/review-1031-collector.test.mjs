import assert from "node:assert/strict";
import { generateKeyPairSync } from "node:crypto";
import { EventEmitter } from "node:events";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import {
  createCollectorAcquisitionRuntime,
  normalizeCollectorConfig,
} from "../index.mjs";

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

function ghResponse(resource, body, at, resetMs = at + 3_600_000) {
  return `HTTP/2 200 OK\r\nx-ratelimit-resource: ${resource}\r\n` +
    `x-ratelimit-limit: 5000\r\nx-ratelimit-used: 1\r\nx-ratelimit-remaining: 4999\r\n` +
    `x-ratelimit-reset: ${Math.ceil(resetMs / 1000)}\r\netag: fixture-etag\r\n\r\n${JSON.stringify(body)}`;
}

// A fake `gh` child. The response is computed after runGh writes stdin, so a
// GraphQL fixture can answer by the repository variables it was sent.
function ghChild(respond) {
  const child = new EventEmitter();
  child.pid = process.pid;
  let input = null;
  child.stdin = { on() {}, end(value) { input = value; } };
  const pending = new Promise((resolve) => setTimeout(() => {
    const { stdout, delayMs = 0 } = respond(input);
    setTimeout(() => {
      resolve({ stdout, stderr: "" });
      child.emit("close", 0);
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

function sentinelRun(repo) {
  return { databaseId: REPOSITORIES[repo].databaseId, displayTitle: `sentinel ${repo}`,
    workflowName: "CI", number: 1, headBranch: "main", status: "completed", conclusion: "success",
    startedAt: "2026-10-31T00:00:00Z", updatedAt: "2026-10-31T00:01:00Z", workflowId: 1,
    url: `https://github.com/${repo}/actions/runs/${REPOSITORIES[repo].databaseId}` };
}

test("PC-01 (#163): two targets on one provider keep their own repository through default resolution", async (t) => {
  const config = normalizeCollectorConfig({ version: 1, providers: { app: APP_PROVIDER },
    targets: [
      { host: "github.com", repo: "acme/widget", provider: "app" },
      { host: "github.com", repo: "acme/gadget", provider: "app" },
    ] });
  const requests = [];
  // Holds a budget read until a second operation joins it (or 250 ms pass),
  // so the two targets' operations are interleaved deterministically.
  let waiting = [];
  const budgetRendezvous = () => new Promise((resolve) => {
    waiting.push(resolve);
    const release = () => { const ready = waiting; waiting = []; for (const done of ready) done(); };
    if (waiting.length >= 2) release();
    else setTimeout(() => { if (waiting.includes(resolve)) release(); }, 250);
  });
  const executeGh = (command, args) => {
    assert.equal(command, "gh");
    if (args.includes("graphql")) {
      return ghChild((raw) => {
        const input = JSON.parse(raw ?? "{}");
        const at = Date.now();
        const rateLimit = { cost: 1, limit: 5_000, used: 1, remaining: 4_999,
          resetAt: new Date(at + 3_600_000).toISOString() };
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
    const repo = Object.keys(REPOSITORIES).find((candidate) => path.startsWith(`repos/${candidate}/`));
    requests.push({ kind: "rest", repo, path: path.split("?")[0] });
    return ghChild(() => ({ stdout: repo && path.includes("/actions/runs")
      ? ghResponse("core", [sentinelRun(repo)], Date.now())
      : ghResponse("core", { total_count: 0, workflows: [] }, Date.now()) }));
  };
  const diagnostics = [];
  const runtime = createCollectorAcquisitionRuntime({ config, pathOptions: privatePathOptions(t),
    executeGh,
    onDiagnostic: (event) => diagnostics.push(event),
    githubAppOptions: { readPrivateKey: () => PRIVATE_KEY,
      requestToken: async () => tokenResponse(APP_PROVIDER, "installation-token", Date.now() + 3_600_000) },
    // Delayed budget evidence: each read waits until both targets have
    // resolved through the shared provider, so whichever resumes first must
    // still use its own repository.
    readInstallationCore: async () => {
      requests.push({ kind: "core-observer" });
      await budgetRendezvous();
      return { budget: { resource: "core", limit: 5_000, remaining: 4_999, used: 1,
        resetMs: Date.now() + 3_600_000 }, etag: "app-core", receivedAt: Date.now(), cost: 1 };
    },
  });
  t.after(() => runtime.close());
  const snapshots = new Map(config.targets.map((target) => [target.repo, []]));
  const waiters = new Map();
  const nextPublished = (repo, afterGeneration) => new Promise((resolve) => {
    waiters.set(repo, { afterGeneration, resolve });
  });
  const handles = config.targets.map((target) => runtime.subscribe({ target, resource: "actions",
    demand: { active: true, background: true, floorMs: 5_000, pages: 1 },
    onSnapshot(snapshot) {
      snapshots.get(target.repo).push(snapshot);
      const waiter = waiters.get(target.repo);
      if (waiter && snapshot.rows.length > 0 && snapshot.generation > waiter.afterGeneration) {
        waiters.delete(target.repo);
        waiter.resolve(snapshot);
      }
    },
    onHold(hold) { diagnostics.push({ hold, repo: target.repo }); } }));
  const settle = (label, promises) => within(Promise.all(promises), 10_000, label).catch((error) => {
    throw new Error(`${error.message}: ${JSON.stringify({ diagnostics, requests })}`);
  });
  // Concurrent initialization (identity and first poll).
  const initial = await settle("two-target initialization",
    config.targets.map((target) => nextPublished(target.repo, 0)));
  // Concurrent forced polls on already-initialized targets.
  const refreshed = config.targets.map((target, index) => nextPublished(target.repo, initial[index].generation));
  for (const handle of handles) handle.refresh(true);
  await settle("two-target polling", refreshed);
  const identityReads = requests.filter((request) => request.kind === "identity").map((request) => request.repo);
  assert.deepEqual([...new Set(identityReads)].sort(), ["acme/gadget", "acme/widget"],
    `target identity read another target's repository: ${JSON.stringify(requests)}`);
  for (const target of config.targets) {
    for (const snapshot of snapshots.get(target.repo)) {
      assert.deepEqual(snapshot.rows.map((row) => row.displayTitle ?? row.title),
        snapshot.rows.length ? [`sentinel ${target.repo}`] : [],
        `${target.repo} received another target's rows: ${JSON.stringify(requests)}`);
    }
  }
  await runtime.close();
});
