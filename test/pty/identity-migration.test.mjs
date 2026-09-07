import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { capture, captureAsync, waitForAwk } from "./capture.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
// Pinned emptyGovernorState() from b819f42 (0.11.2), protocol version 2.
const LEGACY_FIXTURE = join(HERE, "../fixtures/legacy-governor-v2.json");

function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), "gh-glance-identity-pty-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const directory = join(root, "gh-glance");
  mkdirSync(directory, { mode: 0o700 });
  const statePath = join(root, "server.json");
  const now = Date.now();
  const resource = () => ({ limit: 5000, used: 0, remaining: 5000, resetMs: now + 3_600_000 });
  writeFileSync(statePath, JSON.stringify({ createdAt: now, core: resource(), graphql: resource(), delayMs: 100, events: [] }), { mode: 0o600 });
  const legacyPath = join(directory, `rate-governor-v1-${"a".repeat(64)}.json`);
  return { root, directory, statePath, legacyPath, now,
    read: () => JSON.parse(readFileSync(statePath, "utf8")),
    seed: (state) => writeFileSync(legacyPath, `${JSON.stringify(state)}\n`, { mode: 0o600 }),
  };
}

function legacyLease(now, expiresAt) {
  const id = randomUUID();
  return { id, value: { expiresAt, floorMs: 5000, activeTab: "actions", phaseSeed: { seed: id, registeredAt: now - 1000 }, demand: { core: 2, graphql: 0 } } };
}

function runPane(box, extra = {}) {
  return capture({ cols: 80, rows: 24, signal: "none", settle: 10,
    stdin: "sleep 4; printf q", args: "--repo acme/widget --refresh 40", configHome: box.root,
    env: { GH_GLANCE_FIXTURE_STATE: box.statePath }, ...extra });
}

function isHttpStart(event) {
  return event.type === "start" && (event.argv[0] === "api" ||
    ["issue", "pr", "run", "repo"].includes(event.argv[0]) ||
    event.argv[0] === "auth" && event.argv[1] === "status");
}

function assertRestored(result, exitCode = 0) {
  assert.equal(result.exitCode, exitCode);
  assert.equal(result.altEnter, 1);
  assert.equal(result.altExit, 1);
  assert.equal(result.liveScreen.lines.at(-1), "");
  assert.equal(result.afterRestore.visible, "");
}

async function assertIdentityChildStopped(t, box) {
  const request = box.read().events.find((event) => event.type === "start" && event.argv.includes("user"));
  assert.ok(request, "test did not start a delayed identity HTTP request");
  const isAlive = () => {
    try { process.kill(request.pid, 0); return true; }
    catch (error) { if (error.code === "ESRCH") return false; throw error; }
  };
  t.after(() => { if (isAlive()) process.kill(request.pid, "SIGKILL"); });
  const deadline = Date.now() + 1000;
  while (isAlive() && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 25));
  assert.equal(isAlive(), false, "shutdown left the identity HTTP child running");
  assert.equal(box.read().events.filter(isHttpStart).length, 1, "unverified identity admitted additional work");
}

test("ID-05: a discoverable live legacy lease requires restart and starts no GitHub work", (t) => {
  const box = fixture(t);
  const legacy = JSON.parse(readFileSync(LEGACY_FIXTURE, "utf8"));
  const lease = legacyLease(box.now, box.now + 60_000);
  legacy.leases[lease.id] = lease.value;
  box.seed(legacy);
  const original = readFileSync(box.legacyPath, "utf8");
  const result = runPane(box);
  assertRestored(result);
  assert.equal(box.read().events.filter(isHttpStart).length, 0);
  assert.match(result.finalFrame.lines.join("\n"), /restart|stop.*old|older.*pane/i);
  assert.equal(readFileSync(box.legacyPath, "utf8"), original, "migration changed legacy evidence");
});

test("ID-05: expired legacy leases do not forgive started uncertainty or a future hold", (t) => {
  const box = fixture(t);
  const legacy = JSON.parse(readFileSync(LEGACY_FIXTURE, "utf8"));
  const lease = legacyLease(box.now, box.now - 1);
  legacy.leases[lease.id] = lease.value;
  const resetMs = box.now + 60_000;
  const epoch = `5000:${resetMs}`;
  legacy.epochs.core = epoch;
  legacy.budgets.core = {
    limit: 5000, remaining: 4500, used: 500, resetMs, observedAt: box.now - 1000,
    blockUntil: box.now + 120_000, blockReason: "secondary-rate-limit", laneNextAt: box.now,
    roundRobinCursor: null, lastExternalFactor: 1, epoch, source: "core-observer",
    factorBaseline: { epoch, used: 500, observedAt: box.now - 1000 }, knownLocalUsed: 0,
  };
  const intentId = randomUUID();
  legacy.reservations[`reservation:${intentId}`] = {
    leaseId: lease.id, intentId, costs: { core: 2, graphql: 0 }, actualCosts: null,
    accountedCosts: { core: 0, graphql: 0 }, notBefore: box.now - 1000,
    status: "started", epochs: { core: epoch, graphql: null }, startedAt: box.now - 1000,
    completedAt: null, outcome: null,
  };
  box.seed(legacy);
  const original = readFileSync(box.legacyPath, "utf8");
  const result = runPane(box);
  assertRestored(result);
  const dataCalls = box.read().events.filter((event) => event.type === "start" &&
    (["issue", "pr", "run"].includes(event.argv[0]) || event.argv.some((arg) => arg.includes("/actions/") || arg.includes("/alerts"))));
  assert.equal(dataCalls.length, 0, "legacy uncertainty permitted new data");
  assert.match(result.finalFrame.lines.join("\n"), /waiting.*legacy quota reset/i,
    "valid legacy uncertainty was mistaken for corrupt state");
  const registry = JSON.parse(readFileSync(join(box.directory, "coordination-v2", "registry.json"), "utf8"));
  assert.equal(registry.migration.activated, false);
  assert.ok(registry.migration.holdUntil >= legacy.budgets.core.blockUntil,
    "migration forgot the secondary deadline beyond the primary reset");
  assert.equal(Object.keys(registry.attempts).length, 0, "migration hold allowed identity bootstrap");
  assert.equal(readFileSync(box.legacyPath, "utf8"), original, "migration discarded old charges or cooldown");
});

test("ID-05: corrupt legacy protocol fails closed without replacing its evidence", (t) => {
  const box = fixture(t);
  const original = "{not-json\n";
  writeFileSync(box.legacyPath, original, { mode: 0o600 });
  const result = runPane(box);
  assertRestored(result);
  assert.equal(box.read().events.filter(isHttpStart).length, 0);
  assert.match(result.finalFrame.lines.join("\n"), /state unavailable|evidence preserved/i);
  assert.equal(readFileSync(box.legacyPath, "utf8"), original);
});

function exerciseAllTabs() {
  const calls = '"$GH_GLANCE_CAPTURE_OUT.calls"';
  const waitForCall = (pattern) => waitForAwk(calls, `index($0, "${pattern}") { ok=1 }`, 200) + "sleep .4; ";
  return waitForCall("/actions/workflows?") + "printf 2; " +
    waitForCall("graphql issues.page") + "printf 3; " +
    waitForCall("graphql pulls.page") + "printf 4; " +
    waitForCall("secret-scanning/alerts") + "printf q";
}

test("ID-08: two real panes serialize all four tabs and control requests through the shared permit", async (t) => {
  const box = fixture(t);
  const results = await Promise.all(Array.from({ length: 2 }, (_, pane) => captureAsync({
    cols: 80, rows: 24, signal: "none", settle: 45, stdin: exerciseAllTabs(),
    args: "--repo acme/widget --refresh 40", configHome: box.root,
    env: { GH_GLANCE_FIXTURE_STATE: box.statePath, GH_GLANCE_FIXTURE_PANE: String(pane) },
  })));
  for (const result of results) {
    assertRestored(result);
    for (const operation of ["/actions/runs?", "graphql issues.page", "graphql pulls.page", "dependabot/alerts", "code-scanning/alerts", "secret-scanning/alerts"]) {
      assert.ok(result.fixtureCalls.some((call) => call.includes(operation)), `pane never acquired ${operation}`);
    }
    assert.equal(result.fixtureCalls.filter((call) => call.startsWith("auth status")).length, 0);
  }
  const events = box.read().events;
  const starts = events.filter(isHttpStart);
  const ends = new Map(events.filter((event) => event.type === "end").map((event) => [event.sequence, event]));
  // Two panes x (identity, GraphQL observer, Actions runs, one Issues page, one
  // Pull requests page, three alert endpoints). It was 15 when Actions made two
  // calls and each list walked to its row cap; the property under test is that
  // every call was serialized, not how many there were.
  assert.ok(starts.length >= 12, `fixture never exercised all tab and control demand: ${starts.length}`);
  assert.ok(starts.some((event) => event.argv.includes("user")), "identity/core observer was not exercised");
  assert.ok(starts.some((event) => event.graphqlOperation === "graphql.observer"), "GraphQL control probe was not exercised");
  // These timestamps are independent server process entry/exit, not permit
  // grant timestamps. Unit seam tests pin the exact 250ms grant interval.
  // Here every operation must finish before the next HTTP operation starts.
  for (let index = 1; index < starts.length; index += 1) {
    const previous = ends.get(starts[index - 1].sequence);
    assert.ok(previous, "HTTP call never completed");
    assert.ok(starts[index].at >= previous.at, "HTTP requests overlapped across panes");
  }
});

test("cold identity verification keeps quit responsive and stops its owned HTTP child", async (t) => {
  const box = fixture(t);
  const state = box.read();
  state.delayByCommand = { "core-observer": 10_000 };
  writeFileSync(box.statePath, JSON.stringify(state), { mode: 0o600 });
  const startedAt = Date.now();
  const result = runPane(box, {
    settle: 6,
    stdin: waitForAwk('"$GH_GLANCE_CAPTURE_OUT.calls"', 'index($0, "api -i user") { ok=1 }', 40) + "sleep .2; printf q",
  });
  const elapsed = Date.now() - startedAt;
  assertRestored(result);
  await assertIdentityChildStopped(t, box);
  assert.ok(elapsed < 5000, `quit waited ${elapsed}ms for network identity verification`);
});

test("SIGTERM during cold identity verification restores the terminal and stops its HTTP child", async (t) => {
  const box = fixture(t);
  const state = box.read();
  state.delayByCommand = { "core-observer": 10_000 };
  writeFileSync(box.statePath, JSON.stringify(state), { mode: 0o600 });
  const startedAt = Date.now();
  const result = runPane(box, { signal: "TERM", settle: 2, stdin: "" });
  assertRestored(result, 143);
  await assertIdentityChildStopped(t, box);
  assert.ok(Date.now() - startedAt < 5000, "SIGTERM waited for network identity verification");
});

test("quit during cold identity completion lock contention stays prompt and preserves uncertainty", async (t) => {
  const box = fixture(t);
  const state = box.read();
  state.delayByCommand = { "core-observer": 10_000 };
  writeFileSync(box.statePath, JSON.stringify(state), { mode: 0o600 });
  const marker = join(box.root, "registry-held");
  const registryPath = join(box.directory, "coordination-v2", "registry.json");
  const lockPath = `${registryPath}.lock`;
  const owner = JSON.stringify({ pid: process.pid, nonce: randomUUID() });
  const startedAt = Date.now();
  const running = captureAsync({
    cols: 80, rows: 24, signal: "none", settle: 8,
    stdin: 'i=0; while [ ! -f "$GH_GLANCE_TEST_REGISTRY_HELD" ] && [ $i -lt 50 ]; do i=$((i + 1)); sleep .1; done; printf q',
    args: "--repo acme/widget --refresh 40", configHome: box.root,
    env: { GH_GLANCE_FIXTURE_STATE: box.statePath, GH_GLANCE_TEST_REGISTRY_HELD: marker },
  });
  void running.catch(() => {});
  try {
    const readyBy = Date.now() + 5000;
    while (!box.read().events.some((event) => event.type === "start" && event.argv.includes("user")) && Date.now() < readyBy) {
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    assert.ok(box.read().events.some((event) => event.type === "start" && event.argv.includes("user")));
    for (;;) {
      try { writeFileSync(lockPath, owner, { flag: "wx", mode: 0o600 }); break; }
      catch (error) {
        if (error.code !== "EEXIST" || Date.now() >= readyBy) throw error;
        await new Promise((resolve) => setTimeout(resolve, 25));
      }
    }
    writeFileSync(marker, "held", { mode: 0o600 });
    const result = await running;
    assertRestored(result);
    await assertIdentityChildStopped(t, box);
    assert.ok(Date.now() - startedAt < 5000, "quit waited for another live registry lock owner");
    assert.equal(readFileSync(lockPath, "utf8"), owner, "shutdown stole a live lock");
    const registry = JSON.parse(readFileSync(registryPath, "utf8"));
    assert.equal(Object.keys(registry.identities).length, 0);
    const attempts = Object.values(registry.attempts);
    assert.equal(attempts.length, 1);
    assert.equal(attempts[0].accounted, false, "shutdown forgave an unsettled identity charge");
    assert.equal(attempts[0].status, "started");
  } finally {
    await running.catch(() => {});
  }
});
