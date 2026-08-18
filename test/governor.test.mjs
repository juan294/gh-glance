import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { test } from "node:test";

import {
  BUDGET_SNAPSHOT_TTL_MS,
  GOVERNOR_ACTIVE_PROBE_LEASE_MS,
  GOVERNOR_LEASE_TTL_MS,
  GOVERNOR_MAX_LEASES,
  GOVERNOR_PROBE_LEASE_MS,
  claimProbe,
  completeReservation,
  createGovernorScope,
  emptyGovernorState,
  governorHealth,
  governorPath,
  governorScopeHash,
  heartbeatLease,
  inspectGovernor,
  publishProbe,
  readIntentDecision,
  recordResourceBlock,
  refreshSharedBudget,
  registerIntent,
  registerLease,
  releaseGovernorLock,
  releaseLease,
  renewProbeClaim,
  requestManualProbe,
  resolveEffectiveHost,
  startReservation,
  withGovernorLock,
  writeGovernorState,
} from "../index.mjs";

const execFileAsync = promisify(execFile);
const HERE = dirname(fileURLToPath(import.meta.url));
const WORKER = join(HERE, "fixtures", "governor-worker.mjs");
const NOW = 1_800_000_000_000;

function sandbox(t, { host = "github.com", authIdentity = "auth-a", now = NOW } = {}) {
  const root = mkdtempSync(join(tmpdir(), "gh-glance-governor-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  let clock = now;
  const scopeResult = createGovernorScope({
    effectiveHost: host,
    authIdentity,
    env: { XDG_CONFIG_HOME: root },
    now: () => clock,
  });
  assert.equal(scopeResult.ok, true);
  return {
    root,
    scope: scopeResult.value,
    now: () => clock,
    setNow: (value) => { clock = value; },
  };
}

function lease(id, now = NOW, overrides = {}) {
  return {
    id,
    expiresAt: now + GOVERNOR_LEASE_TTL_MS,
    floorMs: 5000,
    activeTab: "actions",
    phaseSeed: { seed: id, registeredAt: now },
    demand: { core: 2, graphql: 0 },
    ...overrides,
  };
}

function budgets(now = NOW, { remaining = 5000, resetMs = now + 3_600_000 } = {}) {
  return {
    core: { limit: 5000, remaining, used: 5000 - remaining, resetMs },
    graphql: { limit: 5000, remaining, used: 5000 - remaining, resetMs },
  };
}

function publishInitial(scope, leaseId, now = NOW, values = budgets(now)) {
  const claim = claimProbe(scope, leaseId, now);
  assert.equal(claim.ok, true);
  assert.equal(claim.value.status, "claimed");
  const published = publishProbe(scope, leaseId, claim.value.nonce, values, now);
  assert.equal(published.ok, true);
  return published.value;
}

function intent(id, leaseId, now = NOW, overrides = {}) {
  return {
    id,
    leaseId,
    tab: "actions",
    priority: "active",
    costs: { core: 2, graphql: 0 },
    requestedAt: now,
    expiresAt: now + GOVERNOR_LEASE_TTL_MS,
    ...overrides,
  };
}

async function worker(command) {
  const { stdout } = await execFileAsync(process.execPath, [WORKER, JSON.stringify(command)], {
    maxBuffer: 4 * 1024 * 1024,
  });
  return JSON.parse(stdout.trim().split("\n").at(-1));
}

function spawnReady(command, t) {
  const child = spawn(process.execPath, [WORKER, JSON.stringify(command)], {
    stdio: ["ignore", "pipe", "pipe"],
  });
  t.after(() => { if (child.exitCode === null) child.kill("SIGKILL"); });
  const ready = new Promise((resolve, reject) => {
    let buffered = "";
    child.stdout.on("data", (chunk) => {
      buffered += chunk;
      const newline = buffered.indexOf("\n");
      if (newline < 0) return;
      const line = buffered.slice(0, newline);
      try { resolve(JSON.parse(line)); } catch (error) { reject(error); }
    });
    child.once("error", reject);
    child.once("exit", (code) => {
      if (!buffered.includes("\n")) reject(new Error(`worker exited before ready: ${code}`));
    });
  });
  return { child, ready };
}

test("scope paths are stable, isolated, and never contain raw identities", (t) => {
  const { root } = sandbox(t);
  const first = governorScopeHash("github.com", "auth-a");
  assert.equal(first, governorScopeHash("github.com", "auth-a"));
  assert.notEqual(first, governorScopeHash("tenant.ghe.com", "auth-a"));
  assert.notEqual(first, governorScopeHash("github.com", "auth-b"));
  const path = governorPath(first, { env: { XDG_CONFIG_HOME: root } });
  assert.match(path, /rate-governor-v1-[0-9a-f]{64}\.json$/);
  assert.ok(!path.includes("github.com"));
  assert.ok(!path.includes("auth-a"));
  assert.equal(createGovernorScope({ effectiveHost: null, authIdentity: "auth-a" }).reason, "unknown-host");
  assert.equal(resolveEffectiveHost({ remoteUrls: ["git@a.example.com:o/r", "git@b.example.com:o/r"] }), null);
});

test("lease, probe, intent, reservation, completion, and reconciliation form one protocol", (t) => {
  const { scope } = sandbox(t);
  const leaseId = randomUUID();
  assert.equal(registerLease(scope, lease(leaseId)).ok, true);

  const firstClaim = claimProbe(scope, leaseId, NOW);
  assert.equal(firstClaim.value.status, "claimed");
  assert.equal(claimProbe(scope, leaseId, NOW).value.status, "waiting");
  assert.equal(publishProbe(scope, leaseId, randomUUID(), budgets(), NOW).reason, "stale");
  assert.equal(publishProbe(scope, leaseId, firstClaim.value.nonce, budgets(), NOW).ok, true);

  const intentId = randomUUID();
  const registered = registerIntent(scope, intent(intentId, leaseId));
  assert.equal(registered.ok, true);
  assert.equal(registered.value.status, "scheduled");
  const reservationId = registered.value.reservationId;
  assert.deepEqual(registered.value.costs, { core: 2, graphql: 0 });
  assert.equal(readIntentDecision(scope, intentId, NOW).value.reservationId, reservationId);
  assert.equal(startReservation(scope, reservationId, registered.value.notBefore - 1).value.status, "waiting");
  assert.equal(startReservation(scope, reservationId, registered.value.notBefore).value.status, "started");
  const completed = completeReservation(scope, reservationId, {
    outcome: "measured-success",
    actualCost: { core: 1, graphql: 0 },
  }, registered.value.notBefore + 1);
  assert.deepEqual(completed.value.actualCosts, { core: 1, graphql: 0 });

  const reconcileAt = registered.value.notBefore + 2;
  const reconcile = claimProbe(scope, leaseId, reconcileAt);
  assert.equal(reconcile.value.status, "claimed");
  assert.equal(publishProbe(scope, leaseId, reconcile.value.nonce, budgets(reconcileAt), reconcileAt).ok, true);
  assert.equal(inspectGovernor(scope, reconcileAt).value.reservations[reservationId], undefined);

  const auxiliaryId = randomUUID();
  const auxiliary = registerIntent(scope, intent(auxiliaryId, leaseId, reconcileAt, {
    tab: "failure-context:repository",
    priority: "diagnostic",
    costs: { core: 0, graphql: 1 },
  }));
  assert.equal(auxiliary.value.status, "scheduled");
  assert.equal(registerIntent(scope, intent(randomUUID(), leaseId, reconcileAt, {
    tab: "open:actions",
    costs: { core: 1, graphql: 0 },
  })).reason, "corrupt");
});

test("only measured success can reduce the worst-case reservation", (t) => {
  const { scope } = sandbox(t);
  const leaseId = randomUUID();
  registerLease(scope, lease(leaseId));
  publishInitial(scope, leaseId, NOW, budgets(NOW, { remaining: 1007 }));
  const intentId = randomUUID();
  const scheduled = registerIntent(scope, intent(intentId, leaseId, NOW, {
    tab: "security",
    costs: { core: 6, graphql: 0 },
  })).value;
  startReservation(scope, scheduled.reservationId, scheduled.notBefore);
  const rejected = completeReservation(scope, scheduled.reservationId, {
    outcome: "rejected",
    actualCost: { core: 0, graphql: 0 },
  }, scheduled.notBefore + 1);
  assert.deepEqual(rejected.value.actualCosts, { core: 6, graphql: 0 });
  assert.equal(registerIntent(scope, intent(randomUUID(), leaseId, scheduled.notBefore + 1)).value.status, "paused");

  const measuredBox = sandbox(t, { authIdentity: "auth-measured" });
  const measuredLeaseId = randomUUID();
  registerLease(measuredBox.scope, lease(measuredLeaseId));
  publishInitial(measuredBox.scope, measuredLeaseId, NOW, budgets(NOW, { remaining: 1007 }));
  const measuredGrant = registerIntent(measuredBox.scope, intent(randomUUID(), measuredLeaseId, NOW, {
    tab: "security",
    costs: { core: 6, graphql: 0 },
  })).value;
  startReservation(measuredBox.scope, measuredGrant.reservationId, measuredGrant.notBefore);
  completeReservation(measuredBox.scope, measuredGrant.reservationId, {
    outcome: "measured-success",
    actualCost: { core: 1, graphql: 0 },
  }, measuredGrant.notBefore + 1);
  assert.equal(registerIntent(measuredBox.scope, intent(randomUUID(), measuredLeaseId, measuredGrant.notBefore + 1)).value.status, "scheduled");
});

test("heartbeats extend leases while release and expiry prune only unstarted work", (t) => {
  const box = sandbox(t);
  const leaseId = randomUUID();
  registerLease(box.scope, lease(leaseId));
  assert.equal(heartbeatLease(box.scope, leaseId, { core: 0, graphql: 2 }, NOW + 20_000).value.expiresAt, NOW + 20_000 + GOVERNOR_LEASE_TTL_MS);
  box.setNow(NOW + 20_000);
  publishInitial(box.scope, leaseId, NOW + 20_000, budgets(NOW + 20_000));
  const pendingId = randomUUID();
  const grant = registerIntent(box.scope, intent(pendingId, leaseId, NOW + 20_000)).value;
  assert.equal(releaseLease(box.scope, leaseId).ok, true);
  assert.equal(inspectGovernor(box.scope, NOW + 20_001).value.reservations[grant.reservationId], undefined);

  const deadId = randomUUID();
  registerLease(box.scope, lease(deadId, NOW + 20_001));
  const deadClaim = claimProbe(box.scope, deadId, NOW + 20_001);
  publishProbe(box.scope, deadId, deadClaim.value.nonce, budgets(NOW + 20_001), NOW + 20_001);
  const started = registerIntent(box.scope, intent(randomUUID(), deadId, NOW + 20_001)).value;
  startReservation(box.scope, started.reservationId, started.notBefore);
  box.setNow(NOW + 20_001 + GOVERNOR_LEASE_TTL_MS + 1);
  const state = inspectGovernor(box.scope, box.now()).value;
  assert.equal(state.leases[deadId], undefined);
  assert.equal(state.reservations[started.reservationId].status, "started");
});

test("probe barriers, nonce renewal, and expired claimant takeover are bounded", (t) => {
  const box = sandbox(t);
  const first = randomUUID();
  const second = randomUUID();
  registerLease(box.scope, lease(first));
  registerLease(box.scope, lease(second));
  const claim = claimProbe(box.scope, first, NOW);
  assert.equal(renewProbeClaim(box.scope, first, claim.value.nonce, NOW + 29_999).value.leaseUntil, NOW + 29_999 + GOVERNOR_ACTIVE_PROBE_LEASE_MS);
  assert.equal(claimProbe(box.scope, second, NOW + 60_000).value.status, "waiting");
  const takeoverAt = NOW + 29_999 + GOVERNOR_ACTIVE_PROBE_LEASE_MS + 1;
  const takeover = claimProbe(box.scope, second, takeoverAt);
  assert.equal(takeover.value.status, "claimed");
  assert.notEqual(takeover.value.nonce, claim.value.nonce);
});

test("the shared probe wrapper publishes once and failed probes pause only background work", async (t) => {
  const { scope } = sandbox(t);
  const leaseId = randomUUID();
  registerLease(scope, lease(leaseId));
  let reads = 0;
  const refreshed = await refreshSharedBudget(scope, leaseId, null, {
    now: () => NOW,
    readBudgets: async () => { reads += 1; return budgets(); },
  });
  assert.equal(refreshed.ok, true);
  assert.equal(reads, 1);

  const failed = await refreshSharedBudget(scope, leaseId, null, {
    now: () => NOW + 1,
    readBudgets: async () => null,
  });
  assert.equal(failed.reason, "stale");
  assert.equal(inspectGovernor(scope, NOW + 1).value.probeOutcome.status, "failed");

  const background = registerIntent(scope, intent(randomUUID(), leaseId, NOW + 1, {
    priority: "background",
  }));
  assert.equal(background.value.status, "paused");
  assert.equal(background.value.reason, "probe-failed");
  const active = registerIntent(scope, intent(randomUUID(), leaseId, NOW + 1, {
    tab: "issues",
    costs: { core: 0, graphql: 2 },
  }));
  assert.equal(active.value.status, "scheduled");
});

test("manual probe demand coalesces until reset changes the epoch", (t) => {
  const { scope } = sandbox(t);
  const leaseId = randomUUID();
  registerLease(scope, lease(leaseId));
  const first = publishInitial(scope, leaseId, NOW, budgets(NOW, { remaining: 1000 }));
  const epoch = first.epochs.core;
  const initial = requestManualProbe(scope, leaseId, epoch, NOW, NOW);
  const repeated = requestManualProbe(scope, leaseId, epoch, NOW, NOW);
  assert.equal(initial.value.status, "pending");
  assert.equal(repeated.value.status, "pending");

  const claim = claimProbe(scope, leaseId, NOW + 1);
  publishProbe(scope, leaseId, claim.value.nonce, budgets(NOW + 1, {
    remaining: 1000,
    resetMs: NOW + 3_600_000,
  }), NOW + 1);
  assert.equal(requestManualProbe(scope, leaseId, epoch, NOW, NOW + 1).value.status, "satisfied");

  const resetAt = NOW + 3_600_000;
  const resetClaim = claimProbe(scope, leaseId, NOW + 2);
  publishProbe(scope, leaseId, resetClaim.value.nonce, budgets(NOW + 2, { remaining: 5000, resetMs: resetAt + 3_600_000 }), NOW + 2);
  assert.equal(inspectGovernor(scope, NOW + 2).value.manualProbe, null);
});

test("planned-to-start revalidation fails closed after stale budget, block, or scope migration", (t) => {
  const box = sandbox(t);
  const leaseId = randomUUID();
  registerLease(box.scope, lease(leaseId));
  publishInitial(box.scope, leaseId);
  const staleGrant = registerIntent(box.scope, intent(randomUUID(), leaseId)).value;
  assert.equal(startReservation(box.scope, staleGrant.reservationId, NOW + BUDGET_SNAPSHOT_TTL_MS + 1).reason, "stale");
  assert.equal(inspectGovernor(box.scope, NOW + BUDGET_SNAPSHOT_TTL_MS + 1).value.reservations[staleGrant.reservationId], undefined);

  const freshAt = NOW + BUDGET_SNAPSHOT_TTL_MS + 2;
  box.setNow(freshAt);
  heartbeatLease(box.scope, leaseId, { core: 2, graphql: 0 }, freshAt);
  const claim = claimProbe(box.scope, leaseId, freshAt);
  publishProbe(box.scope, leaseId, claim.value.nonce, budgets(freshAt), freshAt);
  const blockedGrant = registerIntent(box.scope, intent(randomUUID(), leaseId, freshAt)).value;
  recordResourceBlock(box.scope, "core", freshAt + 60_000, "rate-limit");
  assert.equal(startReservation(box.scope, blockedGrant.reservationId, blockedGrant.notBefore).reason, "stale");

  let identity = { effectiveHost: "github.com", authIdentity: "auth-a" };
  const migrated = createGovernorScope({
    ...identity,
    identityProvider: () => identity,
    env: { XDG_CONFIG_HOME: box.root },
    now: () => freshAt,
  }).value;
  identity = { effectiveHost: "github.com", authIdentity: "auth-b" };
  assert.equal(inspectGovernor(migrated, freshAt).reason, "stale");
});

test("probe watermark retires only completions whose ordering is certain", (t) => {
  const { scope } = sandbox(t);
  const leaseId = randomUUID();
  registerLease(scope, lease(leaseId));
  publishInitial(scope, leaseId);

  const before = registerIntent(scope, intent(randomUUID(), leaseId)).value;
  startReservation(scope, before.reservationId, before.notBefore);
  completeReservation(scope, before.reservationId, { outcome: "measured-success", actualCost: { core: 2, graphql: 0 } }, before.notBefore + 1);
  const claimAt = before.notBefore + 2;
  const claim = claimProbe(scope, leaseId, claimAt);

  assert.equal(publishProbe(scope, leaseId, claim.value.nonce, budgets(claimAt), claimAt + 1).ok, true);
  assert.equal(inspectGovernor(scope, claimAt + 1).value.reservations[before.reservationId], undefined);

  const overlap = registerIntent(scope, intent(randomUUID(), leaseId, claimAt + 1)).value;
  startReservation(scope, overlap.reservationId, overlap.notBefore);
  const overlapClaim = claimProbe(scope, leaseId, overlap.notBefore + 1);
  completeReservation(scope, overlap.reservationId, { outcome: "timeout", actualCost: { core: 0, graphql: 0 } }, overlap.notBefore + 2);
  publishProbe(scope, leaseId, overlapClaim.value.nonce, budgets(overlap.notBefore + 2), overlap.notBefore + 2);
  assert.equal(inspectGovernor(scope, overlap.notBefore + 2).value.reservations[overlap.reservationId].status, "completed");
});

test("a used-counter reset starts a new epoch and carries a straddling request", (t) => {
  const { scope } = sandbox(t);
  const leaseId = randomUUID();
  registerLease(scope, lease(leaseId));
  const resetMs = NOW + 3_600_000;
  const first = publishInitial(scope, leaseId, NOW, budgets(NOW, { remaining: 4900, resetMs }));
  const grant = registerIntent(scope, intent(randomUUID(), leaseId)).value;
  startReservation(scope, grant.reservationId, grant.notBefore);

  const claimAt = grant.notBefore + 1;
  const claim = claimProbe(scope, leaseId, claimAt);
  const resetBudgets = {
    core: { limit: 5000, remaining: 4950, used: 50, resetMs },
    graphql: { limit: 5000, remaining: 4950, used: 50, resetMs },
  };
  const published = publishProbe(scope, leaseId, claim.value.nonce, resetBudgets, claimAt);
  assert.notEqual(published.value.epochs.core, first.epochs.core);
  const carried = inspectGovernor(scope, claimAt).value.reservations[grant.reservationId];
  assert.equal(carried.status, "started");
  assert.equal(carried.epochs.core, first.epochs.core);
});

test("clean probe samples persist the shared external-spend factor", (t) => {
  const { scope } = sandbox(t);
  const leaseId = randomUUID();
  registerLease(scope, lease(leaseId));
  publishInitial(scope, leaseId);
  const security = registerIntent(scope, intent(randomUUID(), leaseId, NOW, {
    tab: "security",
    costs: { core: 6, graphql: 0 },
  })).value;
  startReservation(scope, security.reservationId, security.notBefore);
  completeReservation(scope, security.reservationId, {
    outcome: "measured-success",
    actualCost: { core: 6, graphql: 0 },
  }, security.notBefore + 1);
  const claimAt = security.notBefore + 2;
  const claim = claimProbe(scope, leaseId, claimAt);
  const next = budgets(claimAt, { resetMs: NOW + 3_600_000 });
  next.core.used = 12;
  next.core.remaining = 4988;
  publishProbe(scope, leaseId, claim.value.nonce, next, claimAt);
  assert.equal(inspectGovernor(scope, claimAt).value.budgets.core.lastExternalFactor, 2);
});

test("schema, bounds, corrupt data, and future timestamps fail closed", (t) => {
  const { scope } = sandbox(t);
  mkdirSync(dirname(scope.path), { recursive: true, mode: 0o700 });
  writeFileSync(scope.path, "{", { mode: 0o600 });
  assert.equal(inspectGovernor(scope, NOW).reason, "corrupt");

  const wrongVersion = emptyGovernorState();
  wrongVersion.version = 2;
  writeGovernorState(scope.path, wrongVersion);
  assert.equal(inspectGovernor(scope, NOW).reason, "corrupt");

  const future = emptyGovernorState();
  future.probeOutcome.nextAt = NOW + 25 * 60 * 60 * 1000;
  writeGovernorState(scope.path, future);
  assert.equal(inspectGovernor(scope, NOW).reason, "corrupt");

  const oversized = emptyGovernorState();
  for (let index = 0; index < GOVERNOR_MAX_LEASES + 1; index += 1) {
    const id = randomUUID();
    const value = lease(id);
    delete value.id;
    oversized.leases[id] = value;
  }
  writeGovernorState(scope.path, oversized);
  assert.equal(inspectGovernor(scope, NOW).reason, "corrupt");
});

test("atomic storage is private and persisted JSON excludes identity and process data", (t) => {
  const { scope, root } = sandbox(t, { host: "tenant.ghe.com", authIdentity: "secret-login-token" });
  const leaseId = randomUUID();
  registerLease(scope, lease(leaseId));
  publishInitial(scope, leaseId);
  const raw = readFileSync(scope.path, "utf8");
  assert.equal(statSync(scope.path).mode & 0o777, 0o600);
  assert.equal(statSync(dirname(scope.path)).mode & 0o777, 0o700);
  for (const forbidden of ["tenant.ghe.com", "secret-login-token", process.cwd(), String(process.pid), "owner/repo", "title"]) {
    assert.ok(!raw.includes(forbidden), forbidden);
  }
  assert.deepEqual(readdirSync(join(root, "gh-glance")).filter((name) => name.includes(".tmp")), []);
});

test("lock ownership is live-PID conservative and dead owners are quarantined", (t) => {
  const { scope } = sandbox(t);
  mkdirSync(dirname(scope.path), { recursive: true, mode: 0o700 });
  const lockPath = `${scope.path}.lock`;
  const liveNonce = randomUUID();
  writeFileSync(lockPath, JSON.stringify({ pid: process.pid, nonce: liveNonce }), { mode: 0o600 });
  assert.equal(withGovernorLock(scope, () => ({ ok: true }), { waitMs: 0 }).reason, "busy");
  assert.equal(releaseGovernorLock(lockPath, randomUUID()), false);
  assert.equal(readFileSync(lockPath, "utf8").includes(liveNonce), true);
  assert.equal(releaseGovernorLock(lockPath, liveNonce), true);

  const deadNonce = randomUUID();
  writeFileSync(lockPath, JSON.stringify({ pid: 999_999_999, nonce: deadNonce }), { mode: 0o600 });
  const recovered = withGovernorLock(scope, () => ({ ok: true, value: "recovered" }), {
    waitMs: 0,
    kill: () => { const error = new Error("dead"); error.code = "ESRCH"; throw error; },
  });
  assert.equal(recovered.value, "recovered");
  assert.equal(readdirSync(dirname(scope.path)).some((name) => name.includes("quarantine")), false);

  writeFileSync(lockPath, JSON.stringify({ pid: process.pid, nonce: randomUUID() }), { mode: 0o600 });
  const permissionUnknown = withGovernorLock(scope, () => ({ ok: true }), {
    waitMs: 0,
    kill: () => { const error = new Error("unknown"); error.code = "EPERM"; throw error; },
  });
  assert.equal(permissionUnknown.reason, "busy");
});

test("unwritable storage returns a fail-closed result", (t) => {
  const root = mkdtempSync(join(tmpdir(), "gh-glance-governor-blocked-"));
  t.after(() => {
    try { chmodSync(root, 0o700); } catch { /* cleanup below is exact */ }
    rmSync(root, { recursive: true, force: true });
  });
  const occupied = join(root, "occupied");
  writeFileSync(occupied, "not a directory");
  const scope = createGovernorScope({
    effectiveHost: "github.com",
    authIdentity: "auth-a",
    env: { XDG_CONFIG_HOME: occupied },
    now: () => NOW,
  }).value;
  assert.equal(registerLease(scope, lease(randomUUID())).reason, "unwritable");
});

test("twelve real workers share one probe, preserve state, pace grants, and isolate scopes", async (t) => {
  const box = sandbox(t);
  const leaseIds = Array.from({ length: 12 }, () => randomUUID());
  const base = { root: box.root, host: "github.com", authIdentity: "auth-a", now: NOW };
  const registrations = await Promise.all(leaseIds.map((leaseId) => worker({
    ...base,
    operation: "register-claim",
    lease: lease(leaseId),
  })));
  assert.equal(registrations.filter((result) => result.claim?.value?.status === "claimed").length, 1);
  assert.equal(registrations.filter((result) => result.claim?.value?.status === "waiting").length, 11);
  assert.equal(inspectGovernor(box.scope, NOW).value && Object.keys(inspectGovernor(box.scope, NOW).value.leases).length, 12);

  const winnerIndex = registrations.findIndex((result) => result.claim?.value?.status === "claimed");
  const winner = registrations[winnerIndex].claim.value;
  assert.equal(publishProbe(box.scope, leaseIds[winnerIndex], winner.nonce, budgets(), NOW).ok, true);

  const intentIds = leaseIds.map(() => randomUUID());
  const scheduled = await Promise.all(leaseIds.map((leaseId, index) => worker({
    ...base,
    operation: "register-intent",
    lease: lease(leaseId),
    intent: intent(intentIds[index], leaseId),
  })));
  assert.ok(
    scheduled.every((result) => result.intent?.ok && result.intent.value.status === "scheduled"),
    JSON.stringify(scheduled),
  );
  const state = inspectGovernor(box.scope, NOW).value;
  assert.equal(Object.keys(state.reservations).length, 12);
  assert.equal(new Set(Object.keys(state.reservations)).size, 12);
  assert.ok(Object.values(state.reservations).reduce((sum, reservation) => sum + reservation.costs.core, 0) <= 4000);
  const slots = Object.values(state.reservations).map((reservation) => reservation.notBefore);
  assert.equal(new Set(slots).size, 12, "the shared lane must stagger equal-priority workers");
  assert.ok(leaseIds.includes(state.budgets.core.roundRobinCursor));

  const otherHost = createGovernorScope({
    effectiveHost: "tenant.ghe.com",
    authIdentity: "auth-a",
    env: { XDG_CONFIG_HOME: box.root },
    now: () => NOW,
  }).value;
  assert.equal(Object.keys(inspectGovernor(otherHost, NOW).value.leases).length, 0);
});

test("real probe and request owner crashes recover without releasing uncertain cost", async (t) => {
  const probeBox = sandbox(t);
  const ownerId = randomUUID();
  const waiterId = randomUUID();
  const base = { root: probeBox.root, host: "github.com", authIdentity: "auth-a", now: NOW };
  const probeOwner = spawnReady({
    ...base,
    operation: "claim-hold",
    lease: lease(ownerId),
    holdMs: 10_000,
  }, t);
  const claimed = await probeOwner.ready;
  assert.equal(claimed.claim.value.status, "claimed");
  probeOwner.child.kill("SIGKILL");
  await new Promise((resolve) => probeOwner.child.once("exit", resolve));
  registerLease(probeBox.scope, lease(waiterId));
  assert.equal(claimProbe(probeBox.scope, waiterId, NOW + GOVERNOR_PROBE_LEASE_MS - 1).value.status, "waiting");
  assert.equal(claimProbe(probeBox.scope, waiterId, NOW + GOVERNOR_PROBE_LEASE_MS + 1).value.status, "claimed");

  const requestBox = sandbox(t, { authIdentity: "auth-request" });
  const requestLeaseId = randomUUID();
  registerLease(requestBox.scope, lease(requestLeaseId));
  publishInitial(requestBox.scope, requestLeaseId);
  const grant = registerIntent(requestBox.scope, intent(randomUUID(), requestLeaseId)).value;
  const requestOwner = spawnReady({
    root: requestBox.root,
    host: "github.com",
    authIdentity: "auth-request",
    now: grant.notBefore,
    operation: "start-hold",
    reservationId: grant.reservationId,
    holdMs: 10_000,
  }, t);
  const started = await requestOwner.ready;
  assert.equal(started.started.value.status, "started");
  requestOwner.child.kill("SIGKILL");
  await new Promise((resolve) => requestOwner.child.once("exit", resolve));
  const afterExpiry = NOW + GOVERNOR_LEASE_TTL_MS + 1;
  const state = inspectGovernor(requestBox.scope, afterExpiry).value;
  assert.equal(state.leases[requestLeaseId], undefined);
  assert.equal(state.reservations[grant.reservationId].status, "started");
});

test("a suspended real lock owner is never replaced and a killed owner recovers", async (t) => {
  const box = sandbox(t);
  const command = JSON.stringify({
    root: box.root,
    host: "github.com",
    authIdentity: "auth-a",
    now: NOW,
    operation: "hold-lock",
    holdMs: 10_000,
  });
  const child = spawn(process.execPath, [WORKER, command], { stdio: ["ignore", "pipe", "pipe"] });
  t.after(() => { if (child.exitCode === null) child.kill("SIGKILL"); });
  await new Promise((resolve, reject) => {
    child.stdout.once("data", (chunk) => chunk.toString().includes("ready") ? resolve() : reject(new Error("worker did not lock")));
    child.once("error", reject);
  });
  child.kill("SIGSTOP");
  assert.equal(withGovernorLock(box.scope, () => ({ ok: true }), { waitMs: 10 }).reason, "busy");
  child.kill("SIGKILL");
  await new Promise((resolve) => child.once("exit", resolve));
  assert.equal(withGovernorLock(box.scope, () => ({ ok: true, value: "recovered" }), { waitMs: 100 }).value, "recovered");
});

test("governor health is redacted and discriminates stale, waiting, blocked, and healthy", (t) => {
  const { scope } = sandbox(t);
  assert.equal(governorHealth(inspectGovernor(scope, NOW), NOW).status, "stale");
  const leaseId = randomUUID();
  registerLease(scope, lease(leaseId));
  assert.equal(claimProbe(scope, leaseId, NOW).value.status, "claimed");
  assert.equal(governorHealth(inspectGovernor(scope, NOW), NOW).status, "waiting for probe");
  const claim = inspectGovernor(scope, NOW).value.probeClaim;
  publishProbe(scope, leaseId, claim.nonce, budgets(), NOW);
  assert.equal(governorHealth(inspectGovernor(scope, NOW), NOW).status, "healthy");
  recordResourceBlock(scope, "core", NOW + 60_000, "rate-limit");
  const health = governorHealth(inspectGovernor(scope, NOW), NOW);
  assert.equal(health.status, "blocked");
  assert.deepEqual(Object.keys(health).sort(), ["leases", "resources", "status"]);
});
