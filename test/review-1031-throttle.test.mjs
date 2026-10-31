// Regression tests for the 2026-10-31 review findings on rate-limit recovery
// and governor admission: RT-02 (#164), PC-05/RT-03 (#169) and PC-08 (#174).
// Every test runs against temporary directories and fixture responses only.
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { EventEmitter } from "node:events";
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
  createGovernorScope, registerLease, registerIntent, claimProbe, publishProbe,
  requestManualProbe, inspectGovernor, startReservation, readIntentDecision, GOVERNOR_LEASE_TTL_MS,
  fetchSecurity, secondaryThrottleEvidence,
  createIdentityCoordinator, acquireIdentityHttpPermit, releaseIdentityHttpPermit, inspectIdentityRegistry,
  retryThrottledTransport, retryPausedTransport, createQuotaScope, refreshSharedBudget, runGh, THROTTLE_PAUSE_AFTER,
  createCollectorAcquisitionRuntime, normalizeCollectorConfig,
} from "../index.mjs";

const NOW = 1_800_000_000_000;
const HOUR = 3_600_000;

function governorFixture(t, { clock = { at: NOW }, demand = { core: 1, graphql: 0 } } = {}) {
  const root = mkdtempSync(join(tmpdir(), "glance-review-1031-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const scope = createGovernorScope({
    effectiveHost: "github.com", authIdentity: "review-1031", env: { XDG_CONFIG_HOME: root },
    now: () => clock.at,
  }).value;
  const leaseId = randomUUID();
  assert.equal(registerLease(scope, {
    id: leaseId, expiresAt: NOW + GOVERNOR_LEASE_TTL_MS, floorMs: 5_000, activeTab: "actions",
    phaseSeed: { seed: leaseId, registeredAt: NOW }, demand,
  }, NOW).ok, true);
  const budget = { limit: 5000, remaining: 5000, used: 0, resetMs: NOW + HOUR };
  for (const resource of ["core", "graphql"]) {
    const claim = claimProbe(scope, leaseId, NOW, resource);
    assert.equal(claim.value?.status, "claimed");
    assert.equal(publishProbe(scope, leaseId, claim.value.nonce,
      { core: { ...budget }, graphql: { ...budget } }, NOW, resource).ok, true);
  }
  return { root, scope, leaseId, clock };
}

test("PC-05: a core-only reservation with fresh core data does not wait behind a GraphQL observer claim", (t) => {
  const { scope, leaseId } = governorFixture(t);
  const intentId = randomUUID();
  const grant = registerIntent(scope, {
    id: intentId, leaseId, tab: "actions", priority: "active", costs: { core: 1, graphql: 0 },
    requestedAt: NOW, expiresAt: NOW + GOVERNOR_LEASE_TTL_MS,
  }).value;
  assert.equal(grant.status, "scheduled");
  const graphqlEpoch = inspectGovernor(scope, NOW + 1).value.budgets.graphql.epoch;
  assert.equal(requestManualProbe(scope, leaseId, graphqlEpoch, NOW + 1, NOW + 1).ok, true);
  const graphqlClaim = claimProbe(scope, leaseId, NOW + 1, "graphql");
  assert.equal(graphqlClaim.value?.status, "claimed");
  const state = inspectGovernor(scope, NOW + 1).value;
  assert.equal(state.probeClaims.core, null, "the fixture must hold only a GraphQL claim");
  assert.equal(state.observers.core.outcome, "healthy");
  const at = Math.max(grant.notBefore, NOW + 1);
  const started = startReservation(scope, grant.reservationId, at);
  assert.equal(started.ok, true);
  assert.notEqual(started.value.reason, "probe",
    "an unrelated GraphQL observer claim deferred a core-only start");
  assert.equal(started.value.status, "started");
});

test("PC-05: a reservation that charges GraphQL still waits behind the GraphQL observer claim", (t) => {
  const { scope, leaseId } = governorFixture(t, { demand: { core: 0, graphql: 2 } });
  const grant = registerIntent(scope, {
    id: randomUUID(), leaseId, tab: "prs", priority: "active", costs: { core: 0, graphql: 2 },
    requestedAt: NOW, expiresAt: NOW + GOVERNOR_LEASE_TTL_MS,
  });
  assert.equal(grant.value?.status, "scheduled", JSON.stringify(grant));
  const graphqlEpoch = inspectGovernor(scope, NOW + 1).value.budgets.graphql.epoch;
  assert.equal(requestManualProbe(scope, leaseId, graphqlEpoch, NOW + 1, NOW + 1).ok, true);
  const graphqlClaim = claimProbe(scope, leaseId, NOW + 1, "graphql");
  assert.equal(graphqlClaim.value?.status, "claimed");
  const at = Math.max(grant.value.notBefore, NOW + 1);
  const started = startReservation(scope, grant.value.reservationId, at);
  assert.equal(started.value?.status, "waiting");
  assert.equal(started.value.reason, "probe");
  assert.equal(started.value.notBefore, graphqlClaim.value.leaseUntil);
});

function ledgerIdentity(scope) {
  const info = statSync(scope.path);
  return { ino: info.ino, mtimeMs: info.mtimeMs, revision: JSON.parse(readFileSync(scope.path, "utf8")).revision,
    bytes: readFileSync(scope.path, "utf8") };
}

test("PC-08: no-op governor waits leave the ledger file untouched", (t) => {
  const { scope, leaseId } = governorFixture(t);
  const intentId = randomUUID();
  const grant = registerIntent(scope, {
    id: intentId, leaseId, tab: "actions", priority: "active", costs: { core: 1, graphql: 0 },
    requestedAt: NOW, expiresAt: NOW + GOVERNOR_LEASE_TTL_MS,
  }).value;
  assert.equal(grant.status, "scheduled");
  const graphqlEpoch = inspectGovernor(scope, NOW + 1).value.budgets.graphql.epoch;
  assert.equal(requestManualProbe(scope, leaseId, graphqlEpoch, NOW + 1, NOW + 1).ok, true);
  assert.equal(claimProbe(scope, leaseId, NOW + 1, "graphql").value?.status, "claimed");
  const at = NOW + 2;

  const beforeWait = ledgerIdentity(scope);
  const waiting = claimProbe(scope, leaseId, at, "graphql");
  assert.equal(waiting.ok, true);
  assert.notEqual(waiting.value.status, "claimed", "the fixture must exercise the waiting path");
  const afterWait = ledgerIdentity(scope);
  assert.equal(afterWait.revision, beforeWait.revision, "a waiting claimProbe bumped the revision");
  assert.equal(afterWait.ino, beforeWait.ino, "a waiting claimProbe replaced the ledger inode");
  assert.equal(afterWait.bytes, beforeWait.bytes);

  const first = readIntentDecision(scope, intentId, at, null);
  const second = readIntentDecision(scope, intentId, at, null);
  assert.equal(first.ok, true);
  assert.equal(second.value?.status, first.value?.status);
  const afterReads = ledgerIdentity(scope);
  assert.equal(afterReads.revision, beforeWait.revision, "readIntentDecision bumped the revision");
  assert.equal(afterReads.ino, beforeWait.ino, "readIntentDecision replaced the ledger inode");
  assert.equal(afterReads.mtimeMs, beforeWait.mtimeMs);
});

test("PC-08: a governor mutation that changes state still commits a new revision", (t) => {
  const { scope, leaseId } = governorFixture(t);
  const before = ledgerIdentity(scope);
  const graphqlEpoch = inspectGovernor(scope, NOW + 1).value.budgets.graphql.epoch;
  assert.equal(requestManualProbe(scope, leaseId, graphqlEpoch, NOW + 1, NOW + 1).ok, true);
  const after = ledgerIdentity(scope);
  assert.equal(after.revision, before.revision + 1);
  assert.notEqual(after.bytes, before.bytes);
});

// gh api -i puts the status line and headers on stdout and the message on stderr.
function ghFailure(stderr, stdout = "") {
  return Object.assign(new Error(stderr), { stderr, stdout });
}
const SECONDARY_STDERR = "gh: You have exceeded a secondary rate limit. Please wait a few minutes before you try again. (HTTP 403)";
const SECONDARY_429 = ghFailure("gh: API rate limit exceeded (HTTP 429)",
  "HTTP/2.0 429 Too Many Requests\nretry-after: 60\n\n{}");
const PRIMARY_STRUCTURED = ghFailure("gh: API rate limit exceeded for user ID 1. (HTTP 403)",
  `HTTP/2.0 403 Forbidden\nx-ratelimit-remaining: 0\nx-ratelimit-reset: ${Math.floor((NOW + HOUR) / 1000)}\nx-ratelimit-resource: core\n\n{}`);
const PRIMARY_STDERR_ONLY = ghFailure("HTTP 403: API rate limit exceeded");

test("RT-02a: only throttle evidence classified as secondary is kept out of primary resource blocks", () => {
  assert.equal(secondaryThrottleEvidence(ghFailure(SECONDARY_STDERR)), true);
  assert.equal(secondaryThrottleEvidence(SECONDARY_429), true);
  const paused = Object.assign(new Error("Paused after repeated rate limits; refresh to retry"),
    { coordinationReason: "throttle-paused" });
  assert.equal(secondaryThrottleEvidence(paused), true);
  assert.equal(secondaryThrottleEvidence(PRIMARY_STRUCTURED), false);
  assert.equal(secondaryThrottleEvidence(PRIMARY_STDERR_ONLY), false,
    "stderr-only primary text must keep the existing primary block");
});

for (const [name, error, expected] of [
  ["a secondary-limit message", ghFailure(SECONDARY_STDERR), false],
  ["a 429 with Retry-After", SECONDARY_429, false],
  ["structured primary exhaustion", PRIMARY_STRUCTURED, true],
  ["stderr-only primary text", PRIMARY_STDERR_ONLY, true],
]) {
  test(`RT-02a: Security publishes a primary block only for primary evidence: ${name}`, async () => {
    const result = await fetchSecurity(new AbortController().signal, {
      force: true,
      request: async () => { throw error; },
    });
    assert.equal(result.rateLimited, expected);
  });
}

async function transportFixture(t) {
  const root = mkdtempSync(join(tmpdir(), "glance-review-1031-transport-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const coordinator = createIdentityCoordinator({
    host: "github.com", pathOptions: { env: { XDG_CONFIG_HOME: root } }, env: { GH_TOKEN: "synthetic-review" },
    now: () => NOW,
    requestIdentity: async () => ({ body: { id: 1, login: "fixture" }, rateLimit: {
      resource: "core", limit: 5000, used: 1, remaining: 4999, resetMs: NOW + HOUR,
    } }),
  });
  assert.equal((await coordinator.refresh()).ok, true);
  t.after(() => coordinator.close());
  const read = (at) => inspectIdentityRegistry(coordinator.root, { now: at }).value.hosts["github.com"];
  return { coordinator, read };
}

function throttled(retryAfter) {
  return Object.assign(new Error("secondary"), {
    stdout: `HTTP/2.0 403 Forbidden\nretry-after: ${retryAfter}\n\n{}`,
    stderr: "gh: You have exceeded a secondary rate limit (HTTP 403)",
  });
}

// Five real throttled responses, each admitted once the previous cooldown ends.
// Returns the time of the last response and its server-supplied deadline.
async function throttleFiveTimes(coordinator, read, lastRetryAfter) {
  let at = NOW + 250;
  for (let index = 0; index < THROTTLE_PAUSE_AFTER; index += 1) {
    const permit = await acquireIdentityHttpPermit(coordinator, { now: () => at });
    const retryAfter = index === THROTTLE_PAUSE_AFTER - 1 ? lastRetryAfter : 60;
    assert.equal(releaseIdentityHttpPermit(coordinator, permit, throttled(retryAfter), at + 1).ok, true);
    if (index < THROTTLE_PAUSE_AFTER - 1) at = read(at + 1).cooldownUntil + 1;
  }
  const host = read(at + 1);
  assert.equal(host.throttle.paused, true);
  assert.equal(host.throttle.attempts, THROTTLE_PAUSE_AFTER);
  assert.equal(host.cooldownUntil, at + 1 + lastRetryAfter * 1000);
  await assert.rejects(acquireIdentityHttpPermit(coordinator, { now: () => at + 2 }),
    (error) => error.coordinationReason === "throttle-paused");
  return { lastAt: at + 1, cooldownUntil: host.cooldownUntil };
}

test("RT-02b: the explicit retry clears the pause without shortening a Retry-After deadline", async (t) => {
  const { coordinator, read } = await transportFixture(t);
  const { lastAt, cooldownUntil } = await throttleFiveTimes(coordinator, read, 7200);
  const pressedAt = lastAt + 10_000;
  const resumed = retryThrottledTransport(coordinator.root, "github.com", { now: () => pressedAt });
  assert.equal(resumed.value.resumed, true);
  const host = read(pressedAt);
  assert.equal(host.throttle.paused, false);
  assert.equal(host.throttle.attempts, 0);
  assert.equal(host.cooldownUntil, cooldownUntil, "the retry shortened the server's Retry-After deadline");
  await assert.rejects(acquireIdentityHttpPermit(coordinator, { now: () => pressedAt }),
    (error) => error.coordinationReason === "transport-busy", "the Retry-After hold must still apply");
});

test("RT-02b: pressing r resumes a paused transport once, for one pane", async (t) => {
  const { coordinator, read } = await transportFixture(t);
  const { lastAt, cooldownUntil } = await throttleFiveTimes(coordinator, read, 60);
  const pressedAt = cooldownUntil + 1_000;
  assert.equal(retryPausedTransport(coordinator, { now: () => pressedAt }).value.resumed, true);
  assert.equal(retryPausedTransport(coordinator, { now: () => pressedAt }).value.resumed, false,
    "a second simultaneous press must not elect a second recovery");
  assert.equal(read(pressedAt).cooldownUntil, cooldownUntil);
  assert.ok(lastAt < pressedAt);
  const permit = await acquireIdentityHttpPermit(coordinator, { now: () => pressedAt });
  assert.equal(releaseIdentityHttpPermit(coordinator, permit, null, pressedAt + 100).ok, true);
  assert.equal(read(pressedAt + 100).throttle.attempts, 0);
});

function observerScope(coordinator, clock) {
  return {
    ...createQuotaScope(coordinator.current(), { root: coordinator.root, now: () => clock.at }),
    identityCoordinator: coordinator, accessKey: coordinator.current().accessKey,
  };
}

// The real control path: refreshSharedBudget elects one pane through the core
// observer claim, and only that pane runs the budget-core-observer request.
async function runCoreObserver(scope, clock) {
  let executions = 0;
  const leaseId = randomUUID();
  assert.equal(registerLease(scope, { id: leaseId, expiresAt: clock.at + 60_000, floorMs: 5_000,
    activeTab: "actions", phaseSeed: { seed: leaseId, registeredAt: clock.at },
    demand: { core: 1, graphql: 0 } }, clock.at).ok, true);
  const execute = () => {
    executions += 1;
    const child = new EventEmitter();
    child.pid = process.pid;
    const pending = Promise.resolve({ stdout: "{}" });
    pending.child = child;
    queueMicrotask(() => child.emit("close", 0));
    return pending;
  };
  const result = await refreshSharedBudget(scope, leaseId, new AbortController().signal, {
    now: () => clock.at,
    wait: async (ms) => { clock.at += ms; },
    readBudgets: async (_signal, _host, { resources }) => {
      if (!resources.includes("core")) return null;
      await runGh(["api", "user"], { operation: "budget-core-observer", execute });
      return { core: { budget: { resource: "core", limit: 5000, used: 1, remaining: 4999,
        resetMs: clock.at + HOUR }, etag: null, receivedAt: clock.at } };
    },
  });
  return { result, executions };
}

test("RT-02b: a primary reset lets the elected core observer recover a paused transport", async (t) => {
  const { coordinator, read } = await transportFixture(t);
  const clock = { at: NOW };
  const scope = observerScope(coordinator, clock);
  const resetAt = inspectGovernor(scope, NOW).value.budgets.core?.resetMs;
  assert.ok(Number.isFinite(resetAt), "the fixture must hold a sampled core reset");
  const { lastAt } = await throttleFiveTimes(coordinator, read, 60);
  assert.ok(lastAt < resetAt);

  clock.at = resetAt - 1_000;
  const early = await runCoreObserver(scope, clock);
  assert.equal(early.executions, 0);
  assert.equal(read(clock.at).throttle.paused, true, "the observer recovered before the reset");

  clock.at = resetAt + 1_000;
  await assert.rejects(acquireIdentityHttpPermit(coordinator, { now: () => clock.at }),
    (error) => error.coordinationReason === "throttle-paused",
    "data requests must not elect themselves to recover");
  const observed = await runCoreObserver(scope, clock);
  assert.equal(observed.executions, 1, JSON.stringify(observed.result));
  assert.equal(read(clock.at).throttle.paused, false);
});

test("RT-02b: reset recovery keeps the Retry-After deadline and recovers once per window", async (t) => {
  const { coordinator, read } = await transportFixture(t);
  const clock = { at: NOW };
  const scope = observerScope(coordinator, clock);
  const resetAt = inspectGovernor(scope, NOW).value.budgets.core?.resetMs;
  assert.ok(Number.isFinite(resetAt));
  const { cooldownUntil } = await throttleFiveTimes(coordinator, read, 7200);
  assert.ok(cooldownUntil > resetAt + 60_000, "the fixture must hold a deadline beyond the reset");

  clock.at = resetAt + 1_000;
  const observed = await runCoreObserver(scope, clock);
  assert.equal(observed.executions, 0, "the observer started inside the server's Retry-After hold");
  const host = read(clock.at);
  assert.equal(host.throttle.paused, false);
  assert.equal(host.throttle.attempts, 0);
  assert.equal(host.cooldownUntil, cooldownUntil, "reset recovery shortened the Retry-After deadline");

  // Throttled again after the reset: the same reset cannot elect a second recovery.
  assert.equal(retryThrottledTransport(coordinator.root, "github.com",
    { now: () => clock.at, resetAt }).value.resumed, false);
  const registry = join(coordinator.root, "registry.json");
  const state = JSON.parse(readFileSync(registry, "utf8"));
  state.hosts["github.com"].throttle = { attempts: THROTTLE_PAUSE_AFTER, lastAt: clock.at, paused: true };
  writeFileSync(registry, JSON.stringify(state));
  assert.equal(retryThrottledTransport(coordinator.root, "github.com",
    { now: () => clock.at + 1, resetAt }).value.resumed, false);
  assert.equal(read(clock.at + 1).throttle.paused, true);
});

test("RT-02b: a collector refresh resumes its provider's paused transport", async (t) => {
  const { coordinator, read } = await transportFixture(t);
  const { cooldownUntil } = await throttleFiveTimes(coordinator, read, 7200);
  const root = mkdtempSync(join(tmpdir(), "glance-review-1031-collector-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const config = normalizeCollectorConfig({
    version: 1,
    providers: { personal: { type: "gh", host: "github.com" } },
    targets: [{ host: "github.com", repo: "acme/widget", provider: "personal" }],
  });
  const runtime = createCollectorAcquisitionRuntime({
    config,
    pathOptions: { env: { XDG_CONFIG_HOME: root }, platform: "linux" },
    setTimeout(run, delay) { return { run, delay, unref() {} }; },
    clearTimeout() {},
    setInterval() { return { unref() {} }; },
    clearInterval() {},
    resolveProvider: async () => ({ identity: coordinator.current(), scope: { identityCoordinator: coordinator } }),
    resolveTargetIdentity: async () => ({ id: "R_1", nameWithOwner: "acme/widget" }),
    async produce() { throw new Error("fixture producer"); },
  });
  t.after(() => runtime.close());
  const handle = runtime.subscribe({
    target: config.targets[0], resource: "actions",
    demand: { active: false, background: false, floorMs: 5_000, pages: 1 },
    onSnapshot() {}, onHold() {},
  });
  const deadline = Date.now() + 2_000;
  while (handle.inspect().status === "initializing") {
    assert.ok(Date.now() < deadline, "the collector subscription did not initialize");
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  assert.equal(read(Date.now()).throttle.paused, true, "initialization alone must not resume the transport");
  await handle.refresh(false);
  const host = read(Date.now());
  assert.equal(host.throttle.paused, false, "the collector refresh did not resume the transport");
  assert.equal(host.cooldownUntil, cooldownUntil);
});
