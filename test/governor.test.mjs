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
  BUDGET_PROBE_MS,
  BUDGET_RESET_GRACE_MS,
  GOVERNOR_ACTIVE_PROBE_LEASE_MS,
  GOVERNOR_LEASE_TTL_MS,
  GOVERNOR_MAX_LEASES,
  GOVERNOR_MAX_INTENTS,
  GOVERNOR_MAX_RESERVATIONS,
  GOVERNOR_PROBE_DRAIN_MS,
  GOVERNOR_PROBE_LEASE_MS,
  claimProbe,
  completeReservation,
  createGovernorScope,
  emptyGovernorState,
  governorHealth,
  governorPhaseOffset,
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

function makeProbeDue(scope, leaseId, now) {
  const state = inspectGovernor(scope, now).value;
  const resource = state.budgets.core ?? state.budgets.graphql;
  assert.ok(resource, "a manual probe needs a published budget epoch");
  assert.equal(requestManualProbe(scope, leaseId, resource.epoch, now, now).ok, true);
}

function claimNow(scope, leaseId, now) {
  makeProbeDue(scope, leaseId, now);
  const claim = claimProbe(scope, leaseId, now);
  assert.equal(claim.value.status, "claimed");
  return claim;
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
  const reconcile = claimNow(scope, leaseId, reconcileAt);
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

test("pending intents coalesce while persisted priorities compete", (t) => {
  const box = sandbox(t, { authIdentity: "coalescing" });
  const backgroundLeaseId = randomUUID();
  const activeLeaseId = randomUUID();
  registerLease(box.scope, lease(backgroundLeaseId));
  registerLease(box.scope, lease(activeLeaseId));
  publishInitial(box.scope, backgroundLeaseId);
  assert.equal(recordResourceBlock(box.scope, "core", NOW + 1, "rate-limit").ok, true);

  const backgroundId = randomUUID();
  const background = registerIntent(box.scope, intent(backgroundId, backgroundLeaseId, NOW, {
    priority: "background",
  }));
  assert.equal(background.value.status, "paused");
  const duplicate = registerIntent(box.scope, intent(randomUUID(), backgroundLeaseId, NOW, {
    priority: "background",
  }));
  assert.deepEqual(duplicate.value, {
    status: "pending",
    intentId: backgroundId,
    coalesced: true,
  });

  const activeId = randomUUID();
  const active = registerIntent(box.scope, intent(activeId, activeLeaseId));
  assert.equal(active.value.status, "paused");
  const pending = inspectGovernor(box.scope, NOW).value.intents;
  assert.equal(Object.keys(pending).length, 2);
  assert.equal(pending[backgroundId].priority, "background");
  assert.equal(pending[activeId].priority, "active");

  box.setNow(NOW + 1);
  const claim = claimNow(box.scope, backgroundLeaseId, NOW + 1);
  assert.equal(publishProbe(box.scope, backgroundLeaseId, claim.value.nonce, budgets(NOW + 1, {
    resetMs: NOW + 3_600_000,
  }), NOW + 1).ok, true);
  const scheduled = inspectGovernor(box.scope, NOW + 1).value.reservations;
  const activeReservation = Object.values(scheduled).find((reservation) => reservation.intentId === activeId);
  const backgroundReservation = Object.values(scheduled).find((reservation) => reservation.intentId === backgroundId);
  assert.ok(activeReservation.notBefore < backgroundReservation.notBefore);
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
  const deadClaim = claimNow(box.scope, deadId, NOW + 20_001);
  publishProbe(box.scope, deadId, deadClaim.value.nonce, budgets(NOW + 20_001), NOW + 20_001);
  const started = registerIntent(box.scope, intent(randomUUID(), deadId, NOW + 20_001)).value;
  startReservation(box.scope, started.reservationId, started.notBefore);
  box.setNow(NOW + 20_001 + GOVERNOR_LEASE_TTL_MS + 1);
  const state = inspectGovernor(box.scope, box.now()).value;
  assert.equal(state.leases[deadId], undefined);
  assert.equal(state.reservations[started.reservationId].status, "started");
});

test("a lease migrates into a new auth scope without sharing old state", (t) => {
  const box = sandbox(t, { authIdentity: "cleanup-only" });
  let identity = { effectiveHost: "github.com", authIdentity: "auth-before" };
  const original = createGovernorScope({
    ...identity,
    identityProvider: () => identity,
    env: { XDG_CONFIG_HOME: box.root },
    now: () => NOW,
  }).value;
  const leaseId = randomUUID();
  assert.equal(registerLease(original, lease(leaseId)).ok, true);
  assert.equal(releaseLease(original, leaseId).ok, true);

  identity = { effectiveHost: "github.com", authIdentity: "auth-after" };
  assert.equal(heartbeatLease(original, leaseId, { core: 2, graphql: 0 }, NOW).reason, "stale");
  const migrated = createGovernorScope({
    ...identity,
    identityProvider: () => identity,
    env: { XDG_CONFIG_HOME: box.root },
    now: () => NOW,
  }).value;
  assert.equal(registerLease(migrated, lease(leaseId)).ok, true);
  const oldClosedScope = createGovernorScope({
    effectiveHost: "github.com",
    authIdentity: "auth-before",
    env: { XDG_CONFIG_HOME: box.root },
    now: () => NOW,
  }).value;
  assert.equal(Object.keys(inspectGovernor(oldClosedScope, NOW).value.leases).length, 0);
  assert.deepEqual(Object.keys(inspectGovernor(migrated, NOW).value.leases), [leaseId]);
  assert.notEqual(original.path, migrated.path);
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
  const takeoverAt = NOW + GOVERNOR_PROBE_LEASE_MS + 1;
  const takeover = claimProbe(box.scope, second, takeoverAt);
  assert.equal(takeover.value.status, "claimed");
  assert.notEqual(takeover.value.nonce, claim.value.nonce);
});

test("probe cadence is shared while manual demand and reset make it due sooner", (t) => {
  const box = sandbox(t, { authIdentity: "probe-cadence" });
  const leaseIds = [randomUUID(), randomUUID(), randomUUID()];
  for (const leaseId of leaseIds) registerLease(box.scope, lease(leaseId));
  publishInitial(box.scope, leaseIds[0]);

  const expectedNextAt = NOW + BUDGET_PROBE_MS;
  for (const leaseId of leaseIds) {
    assert.deepEqual(claimProbe(box.scope, leaseId, NOW + 1).value, {
      status: "waiting",
      nextAt: expectedNextAt,
    });
  }
  makeProbeDue(box.scope, leaseIds[1], NOW + 2);
  const manualWinner = claimProbe(box.scope, leaseIds[1], NOW + 2);
  assert.equal(manualWinner.value.status, "claimed");
  for (const leaseId of [leaseIds[0], leaseIds[2]]) {
    assert.equal(claimProbe(box.scope, leaseId, NOW + 2).value.status, "waiting");
  }

  const resetBox = sandbox(t, { authIdentity: "probe-reset" });
  const resetLeaseId = randomUUID();
  const resetAt = NOW + 10_000;
  registerLease(resetBox.scope, lease(resetLeaseId));
  publishInitial(resetBox.scope, resetLeaseId, NOW, budgets(NOW, { resetMs: resetAt }));
  assert.deepEqual(claimProbe(
    resetBox.scope,
    resetLeaseId,
    resetAt + BUDGET_RESET_GRACE_MS - 1,
  ).value, {
    status: "waiting",
    nextAt: resetAt + BUDGET_RESET_GRACE_MS,
  });
  assert.equal(claimProbe(
    resetBox.scope,
    resetLeaseId,
    resetAt + BUDGET_RESET_GRACE_MS,
  ).value.status, "claimed");
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

  makeProbeDue(scope, leaseId, NOW + 1);
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

  const malformedBox = sandbox(t, { authIdentity: "auth-malformed" });
  const malformedLeaseId = randomUUID();
  registerLease(malformedBox.scope, lease(malformedLeaseId));
  const malformed = await refreshSharedBudget(malformedBox.scope, malformedLeaseId, null, {
    now: () => NOW,
    readBudgets: async () => ({ core: null, graphql: null }),
  });
  assert.equal(malformed.reason, "corrupt");
  const malformedState = inspectGovernor(malformedBox.scope, NOW).value;
  assert.equal(malformedState.probeClaim, null);
  assert.equal(malformedState.probeOutcome.status, "failed");

  const routedBox = sandbox(t, { host: "tenant.ghe.com", authIdentity: "host-route" });
  const routedLeaseId = randomUUID();
  registerLease(routedBox.scope, lease(routedLeaseId));
  let routedHost = null;
  assert.equal((await refreshSharedBudget(routedBox.scope, routedLeaseId, null, {
    now: () => NOW,
    readBudgets: async (_signal, host) => { routedHost = host; return budgets(); },
  })).ok, true);
  assert.equal(routedHost, "tenant.ghe.com");
});

test("probe drain and renewal failures release only their own barrier", async (t) => {
  const drainBox = sandbox(t, { authIdentity: "drain-failure" });
  const drainLeaseId = randomUUID();
  registerLease(drainBox.scope, lease(drainLeaseId));
  publishInitial(drainBox.scope, drainLeaseId);
  const grant = registerIntent(drainBox.scope, intent(randomUUID(), drainLeaseId)).value;
  startReservation(drainBox.scope, grant.reservationId, grant.notBefore);
  makeProbeDue(drainBox.scope, drainLeaseId, grant.notBefore + 1);
  let readAfterDrainFailure = false;
  const drainFailure = await refreshSharedBudget(drainBox.scope, drainLeaseId, null, {
    now: () => grant.notBefore + 1,
    inspect: () => ({ ok: false, reason: "busy" }),
    readBudgets: async () => { readAfterDrainFailure = true; return budgets(); },
  });
  assert.equal(drainFailure.reason, "busy");
  assert.equal(readAfterDrainFailure, false);
  const drained = inspectGovernor(drainBox.scope, grant.notBefore + 1).value;
  assert.equal(drained.probeClaim, null);
  assert.equal(drained.probeOutcome.status, "failed");

  const renewalBox = sandbox(t, { authIdentity: "renewal-failure" });
  const renewalLeaseId = randomUUID();
  registerLease(renewalBox.scope, lease(renewalLeaseId));
  const renewalFailure = await refreshSharedBudget(renewalBox.scope, renewalLeaseId, null, {
    now: () => NOW,
    renew: () => ({ ok: false, reason: "stale" }),
  });
  assert.equal(renewalFailure.reason, "stale");
  assert.equal(inspectGovernor(renewalBox.scope, NOW).value.probeClaim, null);

  const successorBox = sandbox(t, { authIdentity: "renewal-successor" });
  const formerOwnerId = randomUUID();
  const successorId = randomUUID();
  registerLease(successorBox.scope, lease(formerOwnerId));
  registerLease(successorBox.scope, lease(successorId));
  let clock = NOW;
  let successorClaim;
  const superseded = await refreshSharedBudget(successorBox.scope, formerOwnerId, null, {
    now: () => clock,
    renew: () => {
      clock = NOW + GOVERNOR_PROBE_LEASE_MS + 1;
      successorClaim = claimProbe(successorBox.scope, successorId, clock);
      return { ok: false, reason: "stale" };
    },
  });
  assert.equal(superseded.reason, "stale");
  assert.equal(successorClaim.value.status, "claimed");
  assert.equal(inspectGovernor(successorBox.scope, clock).value.probeClaim.nonce, successorClaim.value.nonce);
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
  const resetClaim = claimNow(scope, leaseId, NOW + 2);
  publishProbe(scope, leaseId, resetClaim.value.nonce, budgets(NOW + 2, { remaining: 5000, resetMs: resetAt + 3_600_000 }), NOW + 2);
  assert.equal(inspectGovernor(scope, NOW + 2).value.manualProbe, null);
});

test("successful probes preserve live same-epoch blocks and clear proven ones", (t) => {
  const box = sandbox(t, { authIdentity: "block-persistence" });
  const leaseId = randomUUID();
  const resetMs = NOW + 3_600_000;
  registerLease(box.scope, lease(leaseId));
  publishInitial(box.scope, leaseId, NOW, budgets(NOW, { resetMs }));

  const blockUntil = NOW + 30_000;
  assert.equal(recordResourceBlock(box.scope, "core", blockUntil, "rate-limit").ok, true);
  const sameEpochClaim = claimNow(box.scope, leaseId, NOW + 1);
  assert.equal(publishProbe(box.scope, leaseId, sameEpochClaim.value.nonce, budgets(NOW + 1, {
    resetMs,
  }), NOW + 1).ok, true);
  let state = inspectGovernor(box.scope, NOW + 1).value;
  assert.equal(state.budgets.core.blockUntil, blockUntil);
  assert.equal(state.budgets.core.blockReason, "rate-limit");
  assert.equal(registerIntent(box.scope, intent(randomUUID(), leaseId, NOW + 1)).value.reason, "rate-limit");

  box.setNow(blockUntil);
  const expiredClaim = claimNow(box.scope, leaseId, blockUntil);
  assert.equal(publishProbe(box.scope, leaseId, expiredClaim.value.nonce, budgets(blockUntil, {
    resetMs,
  }), blockUntil).ok, true);
  state = inspectGovernor(box.scope, blockUntil).value;
  assert.equal(state.budgets.core.blockUntil, null);
  assert.equal(state.budgets.core.blockReason, null);

  const secondBlockUntil = blockUntil + 30_000;
  assert.equal(recordResourceBlock(box.scope, "core", secondBlockUntil, "abuse-limit").ok, true);
  const resetClaim = claimNow(box.scope, leaseId, blockUntil + 1);
  assert.equal(publishProbe(box.scope, leaseId, resetClaim.value.nonce, budgets(blockUntil + 1, {
    resetMs: resetMs + 3_600_000,
  }), blockUntil + 1).ok, true);
  state = inspectGovernor(box.scope, blockUntil + 1).value;
  assert.equal(state.budgets.core.blockUntil, null);
  assert.equal(state.budgets.core.blockReason, null);
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

test("planned reservations revalidate expiry, epoch, probe barrier, and capacity", (t) => {
  function planned(authIdentity, remaining = 5000) {
    const box = sandbox(t, { authIdentity });
    const leaseId = randomUUID();
    registerLease(box.scope, lease(leaseId));
    publishInitial(box.scope, leaseId, NOW, budgets(NOW, { remaining }));
    const grant = registerIntent(box.scope, intent(randomUUID(), leaseId)).value;
    assert.equal(grant.status, "scheduled");
    return { ...box, leaseId, grant };
  }

  const expiring = planned("expiry");
  assert.equal(
    startReservation(expiring.scope, expiring.grant.reservationId, NOW + GOVERNOR_LEASE_TTL_MS).reason,
    "stale",
  );
  assert.equal(
    inspectGovernor(expiring.scope, NOW + GOVERNOR_LEASE_TTL_MS).value.reservations[expiring.grant.reservationId],
    undefined,
  );

  const epoch = planned("epoch");
  const epochClaim = claimNow(epoch.scope, epoch.leaseId, NOW + 1);
  assert.equal(publishProbe(epoch.scope, epoch.leaseId, epochClaim.value.nonce, budgets(NOW + 1, {
    resetMs: NOW + 7_200_000,
  }), NOW + 1).ok, true);
  assert.equal(startReservation(epoch.scope, epoch.grant.reservationId, epoch.grant.notBefore).reason, "stale");

  const barrier = planned("barrier");
  claimNow(barrier.scope, barrier.leaseId, NOW + 1);
  const barred = startReservation(barrier.scope, barrier.grant.reservationId, barrier.grant.notBefore);
  assert.equal(barred.value.status, "waiting");
  assert.equal(barred.value.reason, "probe");
  assert.equal(
    inspectGovernor(barrier.scope, barrier.grant.notBefore).value.reservations[barrier.grant.reservationId].status,
    "scheduled",
  );

  const capacity = planned("capacity");
  const capacityClaim = claimNow(capacity.scope, capacity.leaseId, NOW + 1);
  assert.equal(publishProbe(capacity.scope, capacity.leaseId, capacityClaim.value.nonce, budgets(NOW + 1, {
    remaining: 1001,
  }), NOW + 1).ok, true);
  assert.equal(startReservation(capacity.scope, capacity.grant.reservationId, capacity.grant.notBefore).reason, "stale");
});

test("start re-resolves current scope while the governor lock is held", (t) => {
  const box = sandbox(t);
  const leaseId = randomUUID();
  registerLease(box.scope, lease(leaseId));
  publishInitial(box.scope, leaseId);
  const grant = registerIntent(box.scope, intent(randomUUID(), leaseId)).value;
  let checks = 0;
  const drifting = createGovernorScope({
    effectiveHost: "github.com",
    authIdentity: "auth-a",
    identityProvider: () => {
      checks += 1;
      return { effectiveHost: "github.com", authIdentity: checks === 1 ? "auth-a" : "auth-b" };
    },
    env: { XDG_CONFIG_HOME: box.root },
    now: () => grant.notBefore,
  }).value;
  assert.equal(startReservation(drifting, grant.reservationId, grant.notBefore).reason, "stale");
  assert.equal(checks, 2, "scope must be checked before and after lock acquisition");
  assert.equal(inspectGovernor(box.scope, grant.notBefore).value.reservations[grant.reservationId].status, "scheduled");
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
  const claim = claimNow(scope, leaseId, claimAt);

  assert.equal(publishProbe(scope, leaseId, claim.value.nonce, budgets(claimAt), claimAt + 1).ok, true);
  assert.equal(inspectGovernor(scope, claimAt + 1).value.reservations[before.reservationId], undefined);

  const overlap = registerIntent(scope, intent(randomUUID(), leaseId, claimAt + 1)).value;
  startReservation(scope, overlap.reservationId, overlap.notBefore);
  const overlapClaim = claimNow(scope, leaseId, overlap.notBefore + 1);
  completeReservation(scope, overlap.reservationId, { outcome: "timeout", actualCost: { core: 0, graphql: 0 } }, overlap.notBefore + 2);
  publishProbe(scope, leaseId, overlapClaim.value.nonce, budgets(overlap.notBefore + 2), overlap.notBefore + 2);
  assert.equal(inspectGovernor(scope, overlap.notBefore + 2).value.reservations[overlap.reservationId].status, "completed");

  const sameMillisecond = registerIntent(scope, intent(randomUUID(), leaseId, overlap.notBefore + 3)).value;
  startReservation(scope, sameMillisecond.reservationId, sameMillisecond.notBefore);
  const sameClaimAt = sameMillisecond.notBefore + 1;
  const sameClaim = claimNow(scope, leaseId, sameClaimAt);
  completeReservation(scope, sameMillisecond.reservationId, {
    outcome: "measured-success",
    actualCost: { core: 2, graphql: 0 },
  }, sameClaimAt);
  publishProbe(scope, leaseId, sameClaim.value.nonce, budgets(sameClaimAt + 1), sameClaimAt + 1);
  assert.equal(
    inspectGovernor(scope, sameClaimAt + 1).value.reservations[sameMillisecond.reservationId].status,
    "completed",
    "same-millisecond completion order is uncertain and must stay charged",
  );
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
  const claim = claimNow(scope, leaseId, claimAt);
  const resetBudgets = {
    core: { limit: 5000, remaining: 4950, used: 50, resetMs },
    graphql: { limit: 5000, remaining: 4950, used: 50, resetMs },
  };
  const published = publishProbe(scope, leaseId, claim.value.nonce, resetBudgets, claimAt);
  assert.notEqual(published.value.epochs.core, first.epochs.core);
  const carried = inspectGovernor(scope, claimAt).value.reservations[grant.reservationId];
  assert.equal(carried.status, "started");
  assert.equal(carried.epochs.core, first.epochs.core);

  const rollbackGrant = registerIntent(scope, intent(randomUUID(), leaseId, claimAt)).value;
  assert.equal(rollbackGrant.status, "scheduled");
  assert.equal(rollbackGrant.epochs.core, published.value.epochs.core);
  assert.equal(startReservation(scope, rollbackGrant.reservationId, rollbackGrant.notBefore).value.status, "started");
});

test("a near-timeout request drain renews one probe claimant without takeover", async (t) => {
  const { scope } = sandbox(t, { authIdentity: "near-timeout" });
  const ownerId = randomUUID();
  const waiterId = randomUUID();
  registerLease(scope, lease(ownerId));
  registerLease(scope, lease(waiterId));
  publishInitial(scope, ownerId);
  const grant = registerIntent(scope, intent(randomUUID(), ownerId)).value;
  assert.equal(startReservation(scope, grant.reservationId, grant.notBefore).value.status, "started");

  let clock = grant.notBefore + 1;
  let waits = 0;
  makeProbeDue(scope, ownerId, clock);
  let probeReads = 0;
  const refreshed = await refreshSharedBudget(scope, ownerId, null, {
    now: () => clock,
    wait: async (ms) => { waits += 1; clock += ms; },
    readBudgets: async () => {
      probeReads += 1;
      const takeover = claimProbe(scope, waiterId, clock);
      assert.equal(takeover.value.status, "waiting");
      assert.ok(takeover.value.leaseUntil > clock);
      return budgets(clock);
    },
  });

  assert.equal(refreshed.ok, true);
  assert.equal(probeReads, 1);
  assert.equal(waits, GOVERNOR_PROBE_DRAIN_MS / 100);
  assert.equal(clock, grant.notBefore + 1 + GOVERNOR_PROBE_DRAIN_MS);
  const state = inspectGovernor(scope, clock).value;
  assert.equal(state.probeClaim, null);
  assert.equal(state.reservations[grant.reservationId].status, "started");
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
  const claim = claimNow(scope, leaseId, claimAt);
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

  const mismatched = emptyGovernorState();
  const mismatchedLeaseId = randomUUID();
  const mismatchedLease = lease(mismatchedLeaseId);
  delete mismatchedLease.id;
  mismatched.leases[mismatchedLeaseId] = mismatchedLease;
  const intendedIntentId = randomUUID();
  const differentIntentId = randomUUID();
  const mismatchedReservationId = `reservation:${differentIntentId}`;
  mismatched.reservations[mismatchedReservationId] = {
    leaseId: mismatchedLeaseId,
    intentId: intendedIntentId,
    costs: { core: 2, graphql: 0 },
    actualCosts: null,
    notBefore: NOW,
    status: "scheduled",
    epochs: { core: null, graphql: null },
    startedAt: null,
    completedAt: null,
    outcome: null,
  };
  writeGovernorState(scope.path, mismatched);
  assert.equal(inspectGovernor(scope, NOW).reason, "corrupt");
  assert.equal(registerIntent(scope, intent(intendedIntentId, mismatchedLeaseId)).reason, "corrupt");
  assert.deepEqual(Object.keys(JSON.parse(readFileSync(scope.path, "utf8")).reservations), [
    mismatchedReservationId,
  ]);

  const oversized = emptyGovernorState();
  for (let index = 0; index < GOVERNOR_MAX_LEASES + 1; index += 1) {
    const id = randomUUID();
    const value = lease(id);
    delete value.id;
    oversized.leases[id] = value;
  }
  writeGovernorState(scope.path, oversized);
  assert.equal(inspectGovernor(scope, NOW).reason, "corrupt");

  const oversizedIntents = emptyGovernorState();
  const leaseId = randomUUID();
  const leaseValue = lease(leaseId);
  delete leaseValue.id;
  oversizedIntents.leases[leaseId] = leaseValue;
  for (let index = 0; index < GOVERNOR_MAX_INTENTS + 1; index += 1) {
    oversizedIntents.intents[randomUUID()] = {
      leaseId,
      tab: "actions",
      priority: "active",
      costs: { core: 2, graphql: 0 },
      requestedAt: NOW,
      expiresAt: NOW + GOVERNOR_LEASE_TTL_MS,
    };
  }
  writeGovernorState(scope.path, oversizedIntents);
  assert.equal(inspectGovernor(scope, NOW).reason, "corrupt");

  const oversizedReservations = emptyGovernorState();
  oversizedReservations.leases[leaseId] = leaseValue;
  for (let index = 0; index < GOVERNOR_MAX_RESERVATIONS + 1; index += 1) {
    const intentId = randomUUID();
    oversizedReservations.reservations[`reservation:${intentId}`] = {
      leaseId,
      intentId,
      costs: { core: 2, graphql: 0 },
      actualCosts: null,
      notBefore: NOW,
      status: "started",
      epochs: { core: null, graphql: null },
      startedAt: NOW,
      completedAt: null,
      outcome: null,
    };
  }
  writeGovernorState(scope.path, oversizedReservations);
  assert.equal(inspectGovernor(scope, NOW).reason, "corrupt");
});

test("the 511th and 512th reservations never create a ghost lane grant", (t) => {
  const { scope } = sandbox(t, { authIdentity: "reservation-cap" });
  const leaseId = randomUUID();
  registerLease(scope, lease(leaseId));
  publishInitial(scope, leaseId);
  const state = inspectGovernor(scope, NOW).value;
  for (let index = 0; index < GOVERNOR_MAX_RESERVATIONS - 1; index += 1) {
    const intentId = randomUUID();
    state.reservations[`reservation:${intentId}`] = {
      leaseId,
      intentId,
      costs: { core: 0, graphql: 0 },
      actualCosts: { core: 0, graphql: 0 },
      notBefore: NOW,
      status: "completed",
      epochs: { core: null, graphql: null },
      startedAt: NOW,
      completedAt: NOW,
      outcome: "measured-success",
    };
  }
  assert.equal(writeGovernorState(scope.path, state).ok, true);

  const firstIntentId = randomUUID();
  const finalGrant = registerIntent(scope, intent(firstIntentId, leaseId)).value;
  assert.equal(finalGrant.status, "scheduled");
  let capped = inspectGovernor(scope, NOW).value;
  assert.equal(Object.keys(capped.reservations).length, GOVERNOR_MAX_RESERVATIONS);
  const laneAtCap = capped.budgets.core.laneNextAt;
  const cursorAtCap = capped.budgets.core.roundRobinCursor;

  const pendingIntentId = randomUUID();
  const pending = registerIntent(scope, intent(pendingIntentId, leaseId)).value;
  assert.equal(pending.status, "pending");
  capped = inspectGovernor(scope, NOW).value;
  assert.equal(Object.keys(capped.reservations).length, GOVERNOR_MAX_RESERVATIONS);
  assert.equal(capped.intents[pendingIntentId].leaseId, leaseId);
  assert.equal(capped.budgets.core.laneNextAt, laneAtCap);
  assert.equal(capped.budgets.core.roundRobinCursor, cursorAtCap);
});

test("atomic storage is private and persisted JSON excludes identity and process data", (t) => {
  const { scope, root } = sandbox(t, { host: "tenant.ghe.com", authIdentity: "secret-login-token" });
  const leaseId = randomUUID();
  registerLease(scope, lease(leaseId));
  publishInitial(scope, leaseId);
  const raw = readFileSync(scope.path, "utf8");
  assert.equal(raw.endsWith("\n"), true);
  assert.equal(raw.includes("\n "), false, "governor JSON stays compact inside the lock");
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
  const artifactModes = {};
  const observeArtifact = (kind, path) => {
    artifactModes[kind] = statSync(path).mode & 0o777;
  };
  assert.equal(withGovernorLock(scope, () => ({ ok: true, value: "created" }), {
    observeArtifact,
  }).value, "created");
  assert.equal(artifactModes.canonical, 0o600);

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
    observeArtifact,
  });
  assert.equal(recovered.value, "recovered");
  assert.equal(artifactModes.recovery, 0o600);
  assert.equal(artifactModes.quarantine, 0o600);
  assert.equal(readdirSync(dirname(scope.path)).some((name) => name.includes("quarantine")), false);

  writeFileSync(lockPath, JSON.stringify({ pid: process.pid, nonce: randomUUID() }), { mode: 0o600 });
  const permissionUnknown = withGovernorLock(scope, () => ({ ok: true }), {
    waitMs: 0,
    kill: () => { const error = new Error("unknown"); error.code = "EPERM"; throw error; },
  });
  assert.equal(permissionUnknown.reason, "busy");

  releaseGovernorLock(lockPath, JSON.parse(readFileSync(lockPath, "utf8")).nonce);
  const abandoned = { pid: 999_999_999, nonce: randomUUID() };
  const successor = { pid: process.pid, nonce: randomUUID() };
  writeFileSync(lockPath, JSON.stringify(abandoned), { mode: 0o600 });
  let firstProbe = true;
  const raced = withGovernorLock(scope, () => ({ ok: true }), {
    waitMs: 0,
    kill: () => {
      if (firstProbe) {
        firstProbe = false;
        writeFileSync(lockPath, JSON.stringify(successor));
        const error = new Error("dead");
        error.code = "ESRCH";
        throw error;
      }
      return undefined;
    },
  });
  assert.equal(raced.reason, "busy");
  assert.deepEqual(JSON.parse(readFileSync(lockPath, "utf8")), successor);
});

test("concurrent dead-owner recovery preserves successor unlock ownership", async (t) => {
  const box = sandbox(t, { authIdentity: "lock-race" });
  mkdirSync(dirname(box.scope.path), { recursive: true, mode: 0o700 });
  const lockPath = `${box.scope.path}.lock`;
  const abandonedNonce = randomUUID();
  writeFileSync(lockPath, JSON.stringify({ pid: 999_999_999, nonce: abandonedNonce }), { mode: 0o600 });
  const base = {
    root: box.root,
    host: "github.com",
    authIdentity: "lock-race",
    now: NOW,
    operation: "inspectGovernor",
  };
  const recovered = await Promise.all(Array.from({ length: 12 }, () => worker(base)));
  assert.ok(recovered.every((result) => result.ok), JSON.stringify(recovered));
  assert.deepEqual(
    readdirSync(dirname(box.scope.path)).filter((name) => name.includes(".lock")),
    [],
  );

  const staleRecoveryNonce = randomUUID();
  const staleRecoveryPath = `${lockPath}.recovery-${staleRecoveryNonce}`;
  writeFileSync(staleRecoveryPath, JSON.stringify({
    pid: 999_999_999,
    nonce: staleRecoveryNonce,
  }), { mode: 0o600 });
  assert.equal(withGovernorLock(
    box.scope,
    () => ({ ok: true, value: "stale recovery removed" }),
    { waitMs: 100 },
  ).value, "stale recovery removed");
  assert.equal(readdirSync(dirname(box.scope.path)).some(
    (name) => join(dirname(box.scope.path), name) === staleRecoveryPath,
  ), false);

  const successorNonce = randomUUID();
  writeFileSync(lockPath, JSON.stringify({ pid: process.pid, nonce: successorNonce }), { mode: 0o600 });
  assert.equal(releaseGovernorLock(lockPath, abandonedNonce), false);
  assert.equal(JSON.parse(readFileSync(lockPath, "utf8")).nonce, successorNonce);
  assert.equal(releaseGovernorLock(lockPath, successorNonce), true);
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
  const firstResetMs = NOW + 3_600_000;
  const resetAt = firstResetMs + 1;
  const secondResetMs = resetAt + 3_600_000;
  const firstEpoch = `5000:${firstResetMs}`;
  const secondEpoch = `5000:${secondResetMs}`;
  let leaseIds;
  do {
    leaseIds = Array.from({ length: 12 }, () => randomUUID());
  } while (
    leaseIds.slice().sort((left, right) => governorPhaseOffset(left, firstEpoch) - governorPhaseOffset(right, firstEpoch)).join() ===
    leaseIds.slice().sort((left, right) => governorPhaseOffset(left, secondEpoch) - governorPhaseOffset(right, secondEpoch)).join()
  );
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

  for (let round = 1; round <= 2; round += 1) {
    const roundAt = NOW + round * 2 - 1;
    const releaseAt = roundAt + 1;
    box.setNow(roundAt);
    assert.equal(recordResourceBlock(box.scope, "core", releaseAt, "rate-limit").ok, true);
    const queued = await Promise.all(leaseIds.map((leaseId) => worker({
      ...base,
      now: roundAt,
      operation: "registerIntent",
      payload: intent(randomUUID(), leaseId, roundAt),
    })));
    assert.ok(queued.every((result) => result.value?.status === "paused"), JSON.stringify(queued));
    const roundClaim = claimNow(box.scope, leaseIds[0], releaseAt);
    assert.equal(publishProbe(box.scope, leaseIds[0], roundClaim.value.nonce, budgets(roundAt, {
      resetMs: firstResetMs,
    }), releaseAt).ok, true);
  }

  const progressedAt = NOW + 4;
  const progressed = inspectGovernor(box.scope, progressedAt).value;
  assert.equal(Object.keys(progressed.reservations).length, 36);
  const perLease = Object.values(progressed.reservations).reduce((counts, reservation) => {
    counts[reservation.leaseId] = (counts[reservation.leaseId] ?? 0) + 1;
    return counts;
  }, {});
  assert.ok(leaseIds.every((leaseId) => perLease[leaseId] === 3), JSON.stringify(perLease));
  assert.ok(Object.values(progressed.reservations).reduce(
    (sum, reservation) => sum + reservation.costs.core,
    0,
  ) <= 4000);

  const otherHost = createGovernorScope({
    effectiveHost: "tenant.ghe.com",
    authIdentity: "auth-a",
    env: { XDG_CONFIG_HOME: box.root },
    now: () => NOW,
  }).value;
  assert.equal(Object.keys(inspectGovernor(otherHost, NOW).value.leases).length, 0);
  const otherAuth = await worker({
    ...base,
    authIdentity: "auth-b",
    operation: "inspectGovernor",
  });
  assert.equal(Object.keys(otherAuth.value.leases).length, 0);

  const released = await Promise.all(leaseIds.map((leaseId) => worker({
    ...base,
    now: progressedAt,
    operation: "releaseLease",
    leaseId,
  })));
  assert.ok(released.every((result) => result.ok), JSON.stringify(released));
  assert.equal(Object.keys(inspectGovernor(box.scope, progressedAt).value.reservations).length, 0);

  const resetBase = { ...base, now: resetAt };
  const resetLeases = leaseIds.map((leaseId) => lease(leaseId, resetAt));
  const resetRegistrations = await Promise.all(resetLeases.map((value) => worker({
    ...resetBase,
    operation: "register-claim",
    lease: value,
  })));
  assert.equal(resetRegistrations.filter((result) => result.claim?.value?.status === "claimed").length, 1);
  assert.equal(resetRegistrations.filter((result) => result.claim?.value?.status === "waiting").length, 11);
  const resetWinnerIndex = resetRegistrations.findIndex((result) => result.claim?.value?.status === "claimed");
  const resetWinner = resetRegistrations[resetWinnerIndex].claim.value;
  assert.equal(publishProbe(
    box.scope,
    leaseIds[resetWinnerIndex],
    resetWinner.nonce,
    budgets(resetAt, { resetMs: secondResetMs }),
    resetAt,
  ).ok, true);

  const resetScheduled = await Promise.all(resetLeases.map((value) => worker({
    ...resetBase,
    operation: "registerIntent",
    payload: intent(randomUUID(), value.id, resetAt),
  })));
  assert.ok(resetScheduled.every((result) => result.value?.status === "scheduled"), JSON.stringify(resetScheduled));
  const resetState = inspectGovernor(box.scope, resetAt).value;
  assert.equal(resetState.epochs.core, secondEpoch);
  const firstPhaseOrder = leaseIds.slice().sort(
    (left, right) => governorPhaseOffset(left, firstEpoch) - governorPhaseOffset(right, firstEpoch),
  );
  const secondPhaseOrder = leaseIds.slice().sort(
    (left, right) => governorPhaseOffset(left, secondEpoch) - governorPhaseOffset(right, secondEpoch),
  );
  assert.notDeepEqual(secondPhaseOrder, firstPhaseOrder);
  for (const reservation of Object.values(resetState.reservations)) {
    assert.ok(reservation.notBefore >= resetAt + governorPhaseOffset(reservation.leaseId, secondEpoch));
  }

  const resetReservationIds = resetScheduled.map((result) => result.value.reservationId);
  const earliest = Math.min(...Object.values(resetState.reservations).map((reservation) => reservation.notBefore));
  const starts = await Promise.all(resetReservationIds.map((reservationId) => worker({
    ...resetBase,
    now: earliest,
    operation: "startReservation",
    reservationId,
  })));
  assert.equal(starts.filter((result) => result.value?.status === "started").length, 1);
  assert.equal(starts.filter((result) => result.value?.status === "waiting").length, 11);
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
