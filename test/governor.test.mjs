import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import {
  chmodSync,
  existsSync,
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
  OPERATION_COSTS,
  GOVERNOR_ACTIVE_PROBE_LEASE_MS,
  GOVERNOR_LEASE_TTL_MS,
  GOVERNOR_MAX_LEASES,
  GOVERNOR_MAX_INTENTS,
  GOVERNOR_MAX_RESERVATIONS,
  GOVERNOR_PROBE_DRAIN_MS,
  GOVERNOR_PROBE_LEASE_MS,
  claimProbe,
  cancelIntent,
  completeReservation,
  createGovernorScope,
  createOpenRequestRegistry,
  createSingleFlightWake,
  createWakeScheduler,
  doctorProbePlan,
  emptyGovernorState,
  failProbeClaim,
  governorControlReady,
  governorDataReady,
  governorControlRetryAt,
  governorHealth,
  governorWakeTimes,
  governorPhaseOffset,
  governorPath,
  governorScopeHash,
  heartbeatLease,
  inspectGovernor,
  maintainControlLease,
  admitGovernorOperation,
  openInBrowser,
  operationCost,
  pendingFailureIsTerminal,
  pollSchedule,
  publishProbe,
  hydrateRateLimitBlockPublication,
  mergeRateLimitBlockPublications,
  rateLimitBlockDecision,
  rateLimitBlockProbeRecovered,
  readIntentDecision,
  recordResourceBlock,
  refreshSharedBudget,
  readSharedBudgetSources,
  registerIntent,
  registerLease,
  releaseGovernorLock,
  releaseLease,
  renewProbeClaim,
  requestManualProbe,
  retryPollAfterAdmissionFailure,
  retryRateLimitBlockPublication,
  runtimeIntentGate,
  runAdmittedOperation,
  resolveFailureContext,
  resolveEffectiveHost,
  startReservation,
  settleReservationWithBudgetObservations,
  tabEpochChanged,
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

function asV1GovernorState(state) {
  const legacy = structuredClone(state);
  legacy.version = 1;
  delete legacy.observers;
  for (const budget of Object.values(legacy.budgets)) {
    delete budget.source;
    delete budget.factorBaseline;
    delete budget.knownLocalUsed;
  }
  for (const reservation of Object.values(legacy.reservations)) delete reservation.accountedCosts;
  return legacy;
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

test("heartbeat publishes active tab and cancellation stops only unstarted work", (t) => {
  const box = sandbox(t);
  const leaseId = randomUUID();
  assert.equal(registerLease(box.scope, lease(leaseId)).ok, true);
  assert.equal(
    heartbeatLease(box.scope, leaseId, { core: 0, graphql: 2 }, NOW + 1, "issues").value.activeTab,
    "issues",
  );
  assert.equal(inspectGovernor(box.scope, NOW + 1).value.leases[leaseId].activeTab, "issues");

  const pendingId = randomUUID();
  assert.equal(registerIntent(box.scope, intent(pendingId, leaseId, NOW + 1)).value.status, "probe");
  assert.equal(cancelIntent(box.scope, pendingId, NOW + 1).value.status, "cancelled");

  publishInitial(box.scope, leaseId, NOW + 1);
  const scheduledId = randomUUID();
  const scheduled = registerIntent(box.scope, intent(scheduledId, leaseId, NOW + 1)).value;
  assert.equal(scheduled.status, "scheduled");
  assert.equal(cancelIntent(box.scope, scheduledId, NOW + 1).value.status, "cancelled");
  assert.equal(inspectGovernor(box.scope, NOW + 1).value.reservations[scheduled.reservationId], undefined);

  const startedId = randomUUID();
  const next = registerIntent(box.scope, intent(startedId, leaseId, NOW + 1)).value;
  assert.equal(startReservation(box.scope, next.reservationId, next.notBefore).value.status, "started");
  assert.equal(cancelIntent(box.scope, startedId, next.notBefore).reason, "stale");
});

test("manual, diagnostic, tab-switch, active, and background requests share one admission seam", (t) => {
  for (const priority of ["manual", "diagnostic", "tab-switch", "active", "background"]) {
    const box = sandbox(t, { authIdentity: `kind-${priority}` });
    const leaseId = randomUUID();
    registerLease(box.scope, lease(leaseId));
    publishInitial(box.scope, leaseId);
    const operation = priority === "diagnostic" ? "doctor:repository" : "failure-context:repository";
    assert.deepEqual(OPERATION_COSTS[operation], { core: 0, graphql: 1 });
    const result = admitGovernorOperation(box.scope, leaseId, operation, priority, NOW);
    assert.ok(["scheduled", "started"].includes(result.value.status), priority);
  }
});

test("an immediate admitted operation revalidates with the post-registration clock", (t) => {
  const box = sandbox(t, { authIdentity: "fresh-operation-start" });
  const epoch = `5000:${NOW + 3_600_000}`;
  let leaseId = randomUUID();
  while (governorPhaseOffset(leaseId, epoch) !== 0) leaseId = randomUUID();
  registerLease(box.scope, lease(leaseId));
  publishInitial(box.scope, leaseId);

  let clock = NOW;
  box.scope.now = () => {
    clock += 1;
    return clock;
  };
  const admitted = admitGovernorOperation(
    box.scope,
    leaseId,
    "open:actions",
    "manual",
    NOW,
  );
  assert.equal(admitted.ok, true);
  assert.equal(admitted.value.status, "started");
});

test("an unsafe admitted operation performs zero calls and independent wakes remain bounded", async (t) => {
  const now = Date.now();
  const box = sandbox(t, { now, authIdentity: "seam-denial" });
  const leaseId = randomUUID();
  registerLease(box.scope, lease(leaseId, now));
  publishInitial(box.scope, leaseId, now, budgets(now, { remaining: 1000 }));
  let calls = 0;
  const denied = await runAdmittedOperation({
    scope: box.scope,
    leaseId,
    operation: "open:actions",
    run: async () => { calls += 1; },
  });
  assert.equal(denied.skipped, true);
  assert.equal(calls, 0);

  const state = inspectGovernor(box.scope, now).value;
  const wakes = governorWakeTimes(state, now, 5000);
  assert.ok(wakes.controlAt > now);
  assert.ok(wakes.dataAt > now);
});

test("failed probes wait for their persisted retry instead of spinning on an old sample", (t) => {
  const box = sandbox(t, { authIdentity: "failed-probe-wake" });
  const leaseId = randomUUID();
  registerLease(box.scope, lease(leaseId, NOW, {
    expiresAt: NOW + BUDGET_PROBE_MS + GOVERNOR_LEASE_TTL_MS,
  }));
  publishInitial(box.scope, leaseId);
  const failedAt = NOW + BUDGET_PROBE_MS + 1;
  box.setNow(failedAt);
  const claim = claimNow(box.scope, leaseId, failedAt);
  assert.equal(failProbeClaim(box.scope, leaseId, claim.value.nonce, failedAt).ok, true);
  const state = inspectGovernor(box.scope, failedAt).value;
  const expected = failedAt + BUDGET_PROBE_MS;
  assert.equal(state.probeOutcome.nextAt, expected);
  const callerWakes = Array.from({ length: 12 }, () =>
    governorWakeTimes(state, failedAt + 10_000, 5000).controlAt);
  assert.deepEqual([...new Set(callerWakes)], [expected]);
  assert.equal(governorWakeTimes(state, failedAt, 5000).controlAt, expected);
});

test("data wakes follow the current lease reservation instead of another pane", () => {
  const state = {
    budgets: {},
    reservations: {
      "reservation:first": {
        leaseId: "lease-a",
        status: "scheduled",
        notBefore: NOW + 100,
      },
      "reservation:second": {
        leaseId: "lease-b",
        status: "scheduled",
        notBefore: NOW + 300,
      },
    },
  };
  assert.equal(governorWakeTimes(state, NOW, 5000).dataAt, NOW + 100);
  assert.equal(governorWakeTimes(state, NOW, 5000, "lease-b").dataAt, NOW + 300);
  assert.equal(governorWakeTimes(state, NOW, 5000, "lease-c").dataAt, Number.POSITIVE_INFINITY);
});

test("bootstrap readiness requires a successful publication and a safe active resource", (t) => {
  const box = sandbox(t, { authIdentity: "bootstrap-readiness" });
  const leaseId = randomUUID();
  registerLease(box.scope, lease(leaseId));
  publishInitial(box.scope, leaseId);
  const snapshot = inspectGovernor(box.scope, NOW);
  assert.equal(governorDataReady({ ok: true, value: {} }, snapshot, "actions", NOW), true);
  assert.equal(
    governorDataReady({ ok: true, value: { status: "waiting" } }, snapshot, "actions", NOW),
    false,
  );
  assert.equal(
    governorControlReady({ ok: true, value: { status: "waiting" } }, snapshot, NOW),
    true,
  );
  const claimed = structuredClone(snapshot);
  claimed.value.probeClaim = { leaseUntil: NOW + 1_000 };
  assert.equal(
    governorControlReady({ ok: true, value: { status: "waiting" } }, claimed, NOW),
    false,
  );
  const failed = structuredClone(snapshot);
  failed.value.probeOutcome = { status: "failed", at: NOW, nextAt: NOW + BUDGET_PROBE_MS };
  assert.equal(
    governorControlReady({ ok: true, value: { status: "waiting" } }, failed, NOW),
    false,
  );
  assert.equal(governorControlReady({ ok: false, reason: "stale" }, snapshot, NOW), false);
  assert.equal(governorDataReady({ ok: false, reason: "stale" }, snapshot, "actions", NOW), false);
  recordResourceBlock(box.scope, "core", NOW + 30_000, "rate-limit");
  const blocked = inspectGovernor(box.scope, NOW);
  assert.equal(governorDataReady({ ok: true, value: {} }, blocked, "actions", NOW), false);
  assert.equal(governorDataReady({ ok: true, value: {} }, blocked, "issues", NOW), true);
  assert.equal(governorControlRetryAt(NOW, 40_000), NOW + 1000);
  assert.equal(governorControlRetryAt(NOW, 500), NOW + 500);
});

test("a new epoch advances only tabs that spend its resource", () => {
  const previous = { core: "core-a", graphql: "graphql-a" };
  assert.equal(tabEpochChanged(previous, { ...previous, core: "core-b" }, "actions"), true);
  assert.equal(tabEpochChanged(previous, { ...previous, core: "core-b" }, "issues"), false);
  assert.equal(tabEpochChanged(previous, { ...previous, graphql: "graphql-b" }, "issues"), true);
  assert.equal(tabEpochChanged(previous, { ...previous, graphql: "graphql-b" }, "actions"), false);
  assert.equal(tabEpochChanged(null, previous, "actions"), false);
});

test("control-only wakes keep a held lease live through the t=120 probe", (t) => {
  const box = sandbox(t, { authIdentity: "held-control-liveness" });
  const leaseId = randomUUID();
  registerLease(box.scope, lease(leaseId));
  publishInitial(box.scope, leaseId, NOW, budgets(NOW, { remaining: 0 }));

  for (const at of [NOW + BUDGET_PROBE_MS, NOW + 2 * BUDGET_PROBE_MS]) {
    box.setNow(at);
    const maintained = maintainControlLease(box.scope, leaseId, 5000, "actions", at);
    assert.equal(maintained.ok, true);
    assert.equal(maintained.value.status, "renewed");
    const claim = claimProbe(box.scope, leaseId, at);
    assert.equal(claim.ok, true);
    assert.equal(claim.value.status, "claimed");
    assert.equal(publishProbe(
      box.scope,
      leaseId,
      claim.value.nonce,
      budgets(at, { remaining: 0, resetMs: NOW + 3_600_000 }),
      at,
    ).ok, true);
    const snapshot = inspectGovernor(box.scope, at).value;
    assert.equal(snapshot.probeOutcome.status, "healthy");
    assert.equal(snapshot.leases[leaseId].expiresAt, at + GOVERNOR_LEASE_TTL_MS);
    assert.deepEqual(snapshot.intents, {});
    assert.deepEqual(snapshot.reservations, {});
  }

  const expiredBox = sandbox(t, { authIdentity: "held-control-reregister" });
  const expiredLeaseId = randomUUID();
  registerLease(expiredBox.scope, lease(expiredLeaseId));
  publishInitial(expiredBox.scope, expiredLeaseId, NOW, budgets(NOW, { remaining: 0 }));
  const late = NOW + 2 * BUDGET_PROBE_MS;
  expiredBox.setNow(late);
  const registered = maintainControlLease(expiredBox.scope, expiredLeaseId, 5000, "actions", late);
  assert.equal(registered.ok, true);
  assert.equal(registered.value.status, "registered");
  assert.equal(claimProbe(expiredBox.scope, expiredLeaseId, late).value.status, "claimed");
});

test("abort and signal outcomes retain each operation's worst-case reservation", async (t) => {
  for (const [name, error] of [
    ["abort", Object.assign(new Error("aborted"), { name: "AbortError" })],
    ["signal", Object.assign(new Error("terminated"), { signal: "SIGTERM" })],
  ]) {
    const at = Date.now();
    const box = sandbox(t, { authIdentity: `worst-case-${name}`, now: at });
    const epoch = `5000:${at + 3_600_000}`;
    let leaseId = randomUUID();
    while (governorPhaseOffset(leaseId, epoch) !== 0) leaseId = randomUUID();
    registerLease(box.scope, lease(leaseId, at));
    publishInitial(box.scope, leaseId, at, budgets(at, { remaining: 1010 }));
    const result = await runAdmittedOperation({
      scope: box.scope,
      leaseId,
      operation: "doctor:security-endpoint",
      run: async () => { throw error; },
    });
    assert.equal(result.ok, false);
    const reservation = inspectGovernor(box.scope, Date.now()).value.reservations[result.reservationId];
    assert.equal(reservation.outcome, name);
    assert.deepEqual(reservation.actualCosts, operationCost("doctor:security-endpoint"));
  }
});

test("every doctor endpoint reserves its declared exact cost", (t) => {
  for (const [index, [name, , operation]] of doctorProbePlan().entries()) {
    const box = sandbox(t, { authIdentity: `doctor-costs-${index}` });
    const leaseId = randomUUID();
    registerLease(box.scope, lease(leaseId));
    publishInitial(box.scope, leaseId);
    const admitted = admitGovernorOperation(box.scope, leaseId, operation, "diagnostic", NOW);
    assert.ok(["scheduled", "started"].includes(admitted.value.status), name);
    const reservation = inspectGovernor(box.scope, NOW).value.reservations[admitted.value.reservationId];
    assert.deepEqual(reservation.costs, operationCost(operation), name);
  }
});

test("unsafe failure context and open requests run no quota call and suppress repeats", async (t) => {
  const box = sandbox(t, { authIdentity: "unsafe-auxiliary" });
  const leaseId = randomUUID();
  registerLease(box.scope, lease(leaseId));
  publishInitial(box.scope, leaseId, NOW, budgets(NOW, { remaining: 1000 }));
  let repoCalls = 0;
  let authCalls = 0;
  const runner = async (args) => {
    if (args[0] === "auth") {
      authCalls += 1;
      return '{"hosts":{}}';
    }
    repoCalls += 1;
    return "{}";
  };
  const governor = { scope: box.scope, leaseId };
  const context = await resolveFailureContext(undefined, governor, { run: runner });
  assert.equal(context.repo.ok, false);
  assert.equal(authCalls, 1);
  assert.equal(repoCalls, 0);

  const registry = createOpenRequestRegistry();
  const first = registry.start("actions:7", ({ signal }) =>
    openInBrowser("actions", { databaseId: 7 }, signal, governor, { run: runner }));
  assert.equal(registry.start("actions:7", async () => {}), null);
  await assert.rejects(first, /API budget paused/);
  assert.equal(repoCalls, 0);
  assert.equal(registry.size(), 0);
});

test("independent wake schedulers clear every pending callback", () => {
  let now = 100;
  let nextId = 0;
  const pending = new Map();
  const cleared = [];
  const scheduler = createWakeScheduler({
    now: () => now,
    set: (run, delay) => {
      const id = ++nextId;
      pending.set(id, { run, delay });
      return id;
    },
    clear: (id) => { cleared.push(id); pending.delete(id); },
  });
  scheduler.arm("control", 200, () => {});
  scheduler.arm("data", 300, () => {});
  scheduler.arm("heartbeat", 400, () => {});
  assert.deepEqual([...pending.values()].map(({ delay }) => delay), [100, 200, 300]);
  assert.equal(scheduler.size(), 3);
  scheduler.clearAll();
  assert.equal(scheduler.size(), 0);
  assert.deepEqual(cleared, [1, 2, 3]);
  now = 500;
});

test("overlapping reset data wakes coalesce and retain the later reservation wake", async () => {
  let releaseFirst;
  const firstPending = new Promise((resolve) => { releaseFirst = resolve; });
  let polls = 0;
  let rearms = 0;
  const wake = createSingleFlightWake(async () => {
    polls += 1;
    if (polls === 1) await firstPending;
  }, () => { rearms += 1; });

  const first = wake();
  await Promise.resolve();
  assert.equal(polls, 1);
  assert.equal(await wake(), false, "the reset peer advanced while the first wake was pending");
  assert.equal(polls, 1);
  assert.equal(rearms, 0);

  releaseFirst();
  assert.equal(await first, true);
  assert.equal(polls, 2, "the overlapping wake was lost after its timer entry fired");
  assert.equal(rearms, 1, "the owning wake did not re-arm from persisted state");
  assert.equal(await wake(), true);
  assert.equal(polls, 3);
  assert.equal(rearms, 2);
});

test("transient contention retains a persisted pending reservation for retry", () => {
  for (const reason of ["busy", "corrupt", "unknown-scope"]) {
    assert.equal(pendingFailureIsTerminal(reason), false, reason);
  }
  assert.equal(pendingFailureIsTerminal("stale"), true);
});

test("unsafe bootstrap tab switches update lease demand without registering intents", (t) => {
  const box = sandbox(t, { authIdentity: "bootstrap-tab-switch" });
  const leaseId = randomUUID();
  assert.equal(registerLease(box.scope, lease(leaseId)).ok, true);
  const tabSwitch = runtimeIntentGate(false);
  assert.deepEqual(tabSwitch, { registerIntent: false, requestProbe: false });
  assert.equal(heartbeatLease(
    box.scope,
    leaseId,
    { core: 0, graphql: 2 },
    NOW,
    "issues",
  ).ok, true);
  const manual = runtimeIntentGate(false, { force: true });
  assert.deepEqual(manual, { registerIntent: false, requestProbe: true });
  const state = inspectGovernor(box.scope, NOW).value;
  assert.equal(state.leases[leaseId].activeTab, "issues");
  assert.deepEqual(state.intents, {});
  assert.deepEqual(state.reservations, {});
  assert.equal(runtimeIntentGate(true).registerIntent, true);
});

test("a due poll retries a pre-persistence admission failure without waiting for the floor", (t) => {
  const box = sandbox(t);
  const leaseId = randomUUID();
  assert.equal(registerLease(box.scope, lease(leaseId)).ok, true);
  publishInitial(box.scope, leaseId);

  const floorMs = 40_000;
  const first = pollSchedule({
    nowMs: NOW,
    floorMs,
    activeKey: "actions",
    activeAt: NOW,
    backgroundAt: NOW + 4 * floorMs,
  });
  assert.deepEqual(first.due, [{ key: "actions", kind: "active" }]);
  assert.equal(Object.keys(inspectGovernor(box.scope, NOW).value.reservations).length, 0);

  const retryAt = governorControlRetryAt(NOW, floorMs);
  const retry = retryPollAfterAdmissionFailure({
    kind: "active",
    retryAt,
    activeAt: first.activeAt,
    backgroundAt: first.backgroundAt,
    backgroundIndex: first.backgroundIndex,
    previousBackgroundIndex: 0,
  });
  assert.equal(retry.activeAt, retryAt);
  assert.ok(retryAt - NOW <= 1_000);

  const second = pollSchedule({
    nowMs: retryAt,
    floorMs,
    activeKey: "actions",
    ...retry,
  });
  assert.deepEqual(second.due, [{ key: "actions", kind: "active" }]);
  const registered = registerIntent(box.scope, intent(randomUUID(), leaseId, retryAt, {
    tab: "actions",
    priority: "active",
    costs: { core: 2, graphql: 0 },
  }));
  assert.equal(registered.ok, true);
  assert.equal(Object.keys(inspectGovernor(box.scope, retryAt).value.reservations).length, 1);

  const duplicate = pollSchedule({
    nowMs: retryAt,
    floorMs,
    activeKey: "actions",
    activeAt: second.activeAt,
    backgroundAt: second.backgroundAt,
    backgroundIndex: second.backgroundIndex,
  });
  assert.deepEqual(duplicate.due, []);
  assert.equal(Object.keys(inspectGovernor(box.scope, retryAt).value.reservations).length, 1);
});

test("rate-limit status is shared only after the block is durably published", () => {
  const resetMs = NOW + 60_000;
  assert.deepEqual(rateLimitBlockDecision([{ ok: true }], resetMs), {
    mode: "paused",
    reason: "rate-limit",
    resetMs,
    coordinationError: false,
    failClosed: false,
  });
  for (const [results, rawReason] of [
    [[], "block-unpublished"],
    [[{ ok: false, reason: "busy" }], "busy"],
    [[{ ok: true }, { ok: false }], "block-unpublished"],
  ]) {
    const decision = rateLimitBlockDecision(results, resetMs);
    assert.equal(decision.mode, "paused");
    assert.equal(decision.coordinationError, true);
    assert.equal(decision.failClosed, true);
    assert.equal(decision.reason, rawReason);
    assert.equal("resetMs" in decision, false);
  }
  assert.equal(rateLimitBlockDecision([{ ok: true }], Number.NaN).failClosed, true);
});

test("a busy block publication stays closed, retries, and reopens only after reset probe", () => {
  const resetMs = NOW + 10_000;
  const oldEpoch = `5000:${resetMs}`;
  const newEpoch = `5000:${resetMs + 60_000}`;
  const pending = {
    key: "actions",
    failedAt: NOW,
    reason: "block-unpublished",
    blocks: [{ resource: "core", resetMs, epoch: oldEpoch }],
  };
  let publications = 0;
  const busy = retryRateLimitBlockPublication(pending, NOW, () => {
    publications += 1;
    return { ok: false, reason: "busy" };
  });
  assert.equal(busy.status, "waiting");
  assert.equal(busy.pending.reason, "busy");
  assert.equal(publications, 1);
  let dataCalls = 0;
  if (!busy.pending) dataCalls += 1;
  assert.equal(dataCalls, 0, "data ran while the shared block write was uncertain");

  const published = retryRateLimitBlockPublication(busy.pending, NOW + 500, () => {
    publications += 1;
    return { ok: true };
  });
  assert.equal(published.status, "published");
  assert.equal(published.decision.reason, "rate-limit");
  assert.equal(publications, 2);
  assert.equal(rateLimitBlockProbeRecovered(pending, {
    budgets: { core: { observedAt: NOW + 1, epoch: newEpoch } },
  }, resetMs - 1), false);
  assert.equal(rateLimitBlockProbeRecovered(pending, {
    budgets: { core: { observedAt: resetMs + 1, epoch: oldEpoch } },
  }, resetMs + 1), false);
  assert.equal(rateLimitBlockProbeRecovered(pending, {
    budgets: { core: { observedAt: resetMs + 1, epoch: newEpoch } },
  }, resetMs + 1), true);
  dataCalls += 1;
  assert.equal(dataCalls, 1, "fresh post-reset evidence did not allow later work");
});

test("cross-resource block failures stay independent and unknown evidence must publish", () => {
  let pendingByResource = mergeRateLimitBlockPublications(new Map(), "actions", [{
    resource: "core",
    resetMs: null,
    epoch: null,
  }], NOW);
  pendingByResource = mergeRateLimitBlockPublications(pendingByResource, "issues", [{
    resource: "graphql",
    resetMs: NOW + 20_000,
    epoch: `5000:${NOW + 20_000}`,
  }], NOW + 1);
  assert.equal(pendingByResource.size, 2);
  assert.equal(pendingByResource.get("core").key, "actions");
  assert.equal(pendingByResource.get("graphql").key, "issues");

  const unknown = pendingByResource.get("core");
  const freshBudget = {
    budgets: { core: {
      observedAt: NOW + 100,
      resetMs: NOW + 30_000,
      epoch: `5000:${NOW + 30_000}`,
    } },
  };
  assert.equal(
    rateLimitBlockProbeRecovered(unknown, freshBudget, NOW + 100),
    false,
    "an unknown prior epoch was treated as a proven reset",
  );
  const derived = hydrateRateLimitBlockPublication(unknown, freshBudget);
  assert.deepEqual(derived.blocks, [{
    resource: "core",
    resetMs: NOW + 30_000,
    epoch: `5000:${NOW + 30_000}`,
  }]);
  const busy = retryRateLimitBlockPublication(
    derived,
    NOW + 100,
    () => ({ ok: false, reason: "busy" }),
  );
  assert.equal(busy.status, "waiting");
  const published = retryRateLimitBlockPublication(
    busy.pending,
    NOW + 200,
    () => ({ ok: true }),
  );
  assert.equal(published.status, "published");
  assert.equal(published.decision.reason, "rate-limit");
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

test("a GraphQL-only minute claim does not poll an exhausted core observer", (t) => {
  const box = sandbox(t, { authIdentity: "probe-resource-cadence" });
  const leaseId = randomUUID();
  registerLease(box.scope, lease(leaseId));
  const resetMs = NOW + 3_600_000;
  publishInitial(box.scope, leaseId, NOW, {
    core: { limit: 5000, used: 5000, remaining: 0, resetMs },
    graphql: { limit: 5000, used: 0, remaining: 5000, resetMs },
  });

  const claim = claimProbe(box.scope, leaseId, NOW + BUDGET_PROBE_MS);
  assert.equal(claim.value.status, "claimed");
  assert.deepEqual(claim.value.resources, ["graphql"]);
  assert.equal(claim.value.coreEtag, null);
  assert.equal(publishProbe(box.scope, leaseId, claim.value.nonce, {
    graphql: {
      source: "rate-limit-probe",
      budget: { limit: 5000, used: 0, remaining: 5000, resetMs },
    },
  }, NOW + BUDGET_PROBE_MS).ok, true);
  const state = inspectGovernor(box.scope, NOW + BUDGET_PROBE_MS).value;
  assert.equal(state.observers.core.nextAt, resetMs + BUDGET_RESET_GRACE_MS);
  assert.equal(state.probeOutcome.status, "healthy");
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

  const inspectionBox = sandbox(t, { authIdentity: "immediate-inspection" });
  const inspectionOwner = randomUUID();
  const inspectionWaiter = randomUUID();
  registerLease(inspectionBox.scope, lease(inspectionOwner));
  registerLease(inspectionBox.scope, lease(inspectionWaiter));
  assert.equal(claimProbe(inspectionBox.scope, inspectionOwner, NOW).value.status, "claimed");
  let waits = 0;
  const observedBudgets = Object.fromEntries(["core", "graphql"].map((resource) => [resource, {
    observedAt: NOW,
  }]));
  const inspected = await refreshSharedBudget(inspectionBox.scope, inspectionWaiter, null, {
    now: () => NOW,
    wait: async () => { waits += 1; },
    inspect: () => ({
      ok: true,
      value: { budgets: observedBudgets, probeOutcome: { status: "healthy" } },
    }),
  });
  assert.equal(inspected.value.status, "published");
  assert.equal(waits, 0);
});

test("slow independent sources renew one claim and spend one core bootstrap", async (t) => {
  const box = sandbox(t, { authIdentity: "slow-independent-sources" });
  const ownerId = randomUUID();
  const waiterId = randomUUID();
  registerLease(box.scope, lease(ownerId));
  registerLease(box.scope, lease(waiterId));
  let clock = NOW;
  let coreBootstraps = 0;
  let competingClaim = null;
  const resetMs = NOW + 3_600_000;
  const refreshed = await refreshSharedBudget(box.scope, ownerId, null, {
    now: () => clock,
    wait: async (ms) => { clock += ms; box.setNow(clock); },
    readBudgets: (signal, host, options) => readSharedBudgetSources(signal, host, {
      ...options,
      readGraphql: async () => {
        clock += 20_000;
        box.setNow(clock);
        return {
          graphql: { limit: 5000, used: 0, remaining: 5000, reset: resetMs / 1000 },
        };
      },
      readCore: async (_signal, _host, etag) => {
        clock += 20_000;
        box.setNow(clock);
        coreBootstraps += 1;
        competingClaim = claimProbe(box.scope, waiterId, clock);
        return {
          budget: { limit: 5000, used: 1, remaining: 4999, resetMs },
          etag: etag ?? '"slow-bootstrap-v1"',
          receivedAt: clock,
        };
      },
    }),
  });
  assert.equal(refreshed.ok, true);
  assert.equal(coreBootstraps, 1);
  assert.equal(competingClaim.value.status, "waiting");
  assert.ok(competingClaim.value.leaseUntil > clock);
  assert.equal(inspectGovernor(box.scope, clock).value.probeClaim, null);
});

test("a probe owner retries nonce-safe renew, publish, and fail mutations without another API read", async (t) => {
  const publishBox = sandbox(t, { authIdentity: "publish-contention" });
  const publishLeaseId = randomUUID();
  registerLease(publishBox.scope, lease(publishLeaseId));
  let clock = NOW;
  let reads = 0;
  let renewAttempts = 0;
  let publishAttempts = 0;
  const published = await refreshSharedBudget(publishBox.scope, publishLeaseId, null, {
    now: () => clock,
    wait: async (ms) => { clock += ms; publishBox.setNow(clock); },
    readBudgets: async () => { reads += 1; return budgets(clock); },
    renew: (...args) => {
      renewAttempts += 1;
      return renewAttempts < 3 ? { ok: false, reason: "busy" } : renewProbeClaim(...args);
    },
    publish: (...args) => {
      publishAttempts += 1;
      return publishAttempts < 3 ? { ok: false, reason: "busy" } : publishProbe(...args);
    },
  });
  assert.equal(published.ok, true);
  assert.equal(renewAttempts, 3);
  assert.equal(reads, 1, "lock contention reran the external rate_limit probe");
  assert.equal(publishAttempts, 3);
  assert.equal(inspectGovernor(publishBox.scope, clock).value.probeClaim, null);

  const failBox = sandbox(t, { authIdentity: "fail-contention" });
  const failLeaseId = randomUUID();
  registerLease(failBox.scope, lease(failLeaseId));
  clock = NOW;
  let failAttempts = 0;
  const failed = await refreshSharedBudget(failBox.scope, failLeaseId, null, {
    now: () => clock,
    wait: async (ms) => { clock += ms; failBox.setNow(clock); },
    readBudgets: async () => null,
    fail: (...args) => {
      failAttempts += 1;
      return failAttempts < 3 ? { ok: false, reason: "busy" } : failProbeClaim(...args);
    },
  });
  assert.equal(failed.reason, "stale");
  assert.equal(failAttempts, 3);
  const failedState = inspectGovernor(failBox.scope, clock).value;
  assert.equal(failedState.probeClaim, null);
  assert.equal(failedState.probeOutcome.status, "failed");
});

test("governor readers and mutators refresh time after a concurrent locked write", (t) => {
  const box = sandbox(t, { authIdentity: "locked-time" });
  const ownerId = randomUUID();
  const laterId = randomUUID();
  registerLease(box.scope, lease(ownerId));
  const claim = claimProbe(box.scope, ownerId, NOW);
  assert.equal(claim.value.status, "claimed");

  // Model a caller that captured NOW before waiting for the lock. By the time
  // it acquires the lock, another process has persisted a lease at the newer
  // shared clock. Both a read and a mutation must validate against that fresh
  // locked time instead of rejecting the valid lease as future-dated.
  const committedAt = NOW + 25;
  box.setNow(committedAt);
  assert.equal(registerLease(box.scope, lease(laterId, committedAt)).ok, true);

  const inspected = inspectGovernor(box.scope, NOW);
  assert.equal(inspected.ok, true);
  assert.deepEqual(Object.keys(inspected.value.leases).sort(), [laterId, ownerId].sort());
  assert.equal(renewProbeClaim(box.scope, ownerId, claim.value.nonce, NOW).ok, true);
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

test("forced refresh keeps a blocked core observer at reset plus grace", (t) => {
  const box = sandbox(t, { authIdentity: "blocked-forced-refresh" });
  const leaseId = randomUUID();
  const resetMs = NOW + 3_600_000;
  registerLease(box.scope, lease(leaseId));
  const published = publishInitial(box.scope, leaseId, NOW, budgets(NOW, { resetMs }));
  assert.equal(recordResourceBlock(box.scope, "core", resetMs, "rate-limit").ok, true);
  assert.equal(requestManualProbe(
    box.scope,
    leaseId,
    published.epochs.core,
    NOW,
    NOW + 1,
  ).ok, true);
  const state = inspectGovernor(box.scope, NOW + 1).value;
  assert.equal(state.observers.core.nextAt, resetMs + BUDGET_RESET_GRACE_MS);
  const earlyClaim = claimProbe(box.scope, leaseId, NOW + 1);
  assert.equal(earlyClaim.value.status, "claimed");
  assert.deepEqual(earlyClaim.value.resources, ["graphql"]);
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

test("a just-created shared-lane grant reports pane count without persisting UI fields", (t) => {
  const box = sandbox(t, { authIdentity: "transient-sharing" });
  const leaseIds = Array.from({ length: 4 }, () => randomUUID());
  for (const leaseId of leaseIds) assert.equal(registerLease(box.scope, lease(leaseId)).ok, true);
  publishInitial(box.scope, leaseIds[0]);

  const first = registerIntent(box.scope, intent(randomUUID(), leaseIds[0], NOW, {
    tab: "security",
    costs: { core: 6, graphql: 0 },
  })).value;
  assert.equal(first.status, "scheduled");
  const second = registerIntent(box.scope, intent(randomUUID(), leaseIds[1])).value;
  assert.equal(second.status, "scheduled");
  assert.equal(second.waitCause, "shared-lane");
  assert.equal(second.sharingCount, 4);
  assert.deepEqual(second.sharingOwnerLeaseIds, [leaseIds[0]]);

  const persisted = inspectGovernor(box.scope, NOW).value.reservations[second.reservationId];
  assert.equal(Object.hasOwn(persisted, "waitCause"), false);
  assert.equal(Object.hasOwn(persisted, "sharingCount"), false);
  assert.equal(Object.hasOwn(persisted, "sharingOwnerLeaseIds"), false);
  const reread = readIntentDecision(box.scope, second.intentId, NOW).value;
  assert.equal(reread.waitCause, undefined, "another process gets a safe false negative");
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
    core: { limit: 5000, remaining: 4950, used: 50, resetMs: resetMs + 1 },
    graphql: { limit: 5000, remaining: 4950, used: 50, resetMs: resetMs + 1 },
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

test("rate_limit publication updates GraphQL but never overwrites authoritative core", (t) => {
  const { scope } = sandbox(t, { authIdentity: "source-precedence" });
  const leaseId = randomUUID();
  registerLease(scope, lease(leaseId));
  publishInitial(scope, leaseId);
  const before = inspectGovernor(scope, NOW).value;
  const claim = claimNow(scope, leaseId, NOW + 1);
  const laterReset = before.budgets.core.resetMs + 1;
  const claimed = inspectGovernor(scope, NOW + 1).value;
  const rejected = publishProbe(scope, leaseId, claim.value.nonce, {
    core: {
      source: "rate-limit-probe",
      budget: { limit: 5000, used: 0, remaining: 5000, resetMs: laterReset },
    },
    graphql: {
      source: "rate-limit-probe",
      budget: { limit: 5000, used: 20, remaining: 4980, resetMs: laterReset },
    },
  }, NOW + 1);
  assert.equal(rejected.reason, "corrupt");
  let state = inspectGovernor(scope, NOW + 1).value;
  assert.deepEqual(state.observers.core, claimed.observers.core);
  assert.deepEqual(state.budgets.graphql, claimed.budgets.graphql);

  const published = publishProbe(scope, leaseId, claim.value.nonce, {
    core: {
      source: "core-observer",
      budget: {
        limit: 5000,
        used: before.budgets.core.used,
        remaining: before.budgets.core.remaining,
        resetMs: before.budgets.core.resetMs,
      },
    },
    graphql: {
      source: "rate-limit-probe",
      budget: { limit: 5000, used: 20, remaining: 4980, resetMs: laterReset },
    },
  }, NOW + 1);
  assert.equal(published.ok, true);
  state = inspectGovernor(scope, NOW + 1).value;
  assert.equal(state.budgets.core.resetMs, before.budgets.core.resetMs);
  assert.equal(state.budgets.core.source, "core-observer");
  assert.equal(state.observers.core.outcome, "healthy");
  assert.equal(state.observers.core.at, NOW + 1);
  assert.equal(state.budgets.graphql.used, 20);
  assert.equal(state.budgets.graphql.source, "rate-limit-probe");
});

test("atomic response settlement applies monotonic headers without clearing owner-only state", (t) => {
  const { scope } = sandbox(t, { authIdentity: "atomic-observation" });
  const leaseId = randomUUID();
  registerLease(scope, lease(leaseId));
  publishInitial(scope, leaseId);
  const initial = inspectGovernor(scope, NOW).value.budgets.core;
  recordResourceBlock(scope, "core", initial.resetMs, "rate-limit");
  requestManualProbe(scope, leaseId, initial.epoch, initial.observedAt, NOW);
  const grant = registerIntent(scope, intent(randomUUID(), leaseId)).value;
  assert.equal(startReservation(scope, grant.reservationId, grant.notBefore).ok, false,
    "a live block must prevent a fresh reservation");

  const openBox = sandbox(t, { authIdentity: "atomic-observation-open" });
  const openLeaseId = randomUUID();
  registerLease(openBox.scope, lease(openLeaseId));
  publishInitial(openBox.scope, openLeaseId);
  const openInitial = inspectGovernor(openBox.scope, NOW).value.budgets.core;
  const openGrant = registerIntent(openBox.scope, intent(randomUUID(), openLeaseId)).value;
  startReservation(openBox.scope, openGrant.reservationId, openGrant.notBefore);
  openBox.setNow(openGrant.notBefore);
  recordResourceBlock(openBox.scope, "core", openInitial.resetMs, "rate-limit");
  requestManualProbe(openBox.scope, openLeaseId, openInitial.epoch, openInitial.observedAt, openGrant.notBefore);
  const settledAt = openGrant.notBefore + 1;
  const settled = settleReservationWithBudgetObservations(
    openBox.scope,
    openLeaseId,
    openGrant.reservationId,
    {
      outcome: "measured-success",
      actualCosts: { core: 1, graphql: 0 },
      observations: [{
        resource: "core",
        limit: 5000,
        used: 1,
        remaining: 4999,
        resetMs: openInitial.resetMs,
        receivedAt: settledAt,
        source: "response-header",
        cost: 1,
      }],
    },
    settledAt,
  );
  assert.equal(settled.ok, true);
  let state = inspectGovernor(openBox.scope, settledAt).value;
  assert.equal(state.budgets.core.used, 1);
  assert.equal(state.budgets.core.source, "response-header");
  assert.equal(state.budgets.core.blockReason, "rate-limit");
  assert.equal(state.manualProbe.satisfiedAt, null);
  assert.deepEqual(state.reservations[openGrant.reservationId].accountedCosts, { core: 1, graphql: 0 });

  const orderBox = sandbox(t, { authIdentity: "atomic-observation-order" });
  const orderLeaseId = randomUUID();
  registerLease(orderBox.scope, lease(orderLeaseId));
  publishInitial(orderBox.scope, orderLeaseId, NOW, budgets(NOW, { remaining: 4999 }));
  const orderInitial = inspectGovernor(orderBox.scope, NOW).value.budgets.core;
  const staleGrant = registerIntent(orderBox.scope, intent(randomUUID(), orderLeaseId)).value;
  startReservation(orderBox.scope, staleGrant.reservationId, staleGrant.notBefore);
  const staleAt = staleGrant.notBefore + 1;
  assert.equal(settleReservationWithBudgetObservations(orderBox.scope, orderLeaseId, staleGrant.reservationId, {
    outcome: "measured-success",
    actualCosts: { core: 1, graphql: 0 },
    observations: [{
      resource: "core", limit: 5000, used: 0, remaining: 5000,
      resetMs: orderInitial.resetMs, receivedAt: staleAt, source: "response-header", cost: 1,
    }],
  }, staleAt).ok, true);
  orderBox.setNow(staleAt);
  state = inspectGovernor(orderBox.scope, staleAt).value;
  assert.equal(state.budgets.core.used, 1, "same-window lower counters are ignored");

  const futureGrant = registerIntent(orderBox.scope, intent(randomUUID(), orderLeaseId, staleAt)).value;
  startReservation(orderBox.scope, futureGrant.reservationId, futureGrant.notBefore);
  orderBox.setNow(futureGrant.notBefore);
  const futureAt = futureGrant.notBefore + 1;
  assert.equal(settleReservationWithBudgetObservations(orderBox.scope, orderLeaseId, futureGrant.reservationId, {
    outcome: "measured-success",
    actualCosts: { core: 1, graphql: 0 },
    observations: [{
      resource: "core", limit: 5000, used: 2, remaining: 4998,
      resetMs: orderInitial.resetMs, receivedAt: futureAt + 1, source: "response-header", cost: 1,
    }],
  }, futureAt).reason, "corrupt");
  assert.equal(inspectGovernor(orderBox.scope, futureAt).value.reservations[futureGrant.reservationId].status, "started");
  assert.equal(settleReservationWithBudgetObservations(
    orderBox.scope,
    randomUUID(),
    futureGrant.reservationId,
    { outcome: "rejected", observations: [] },
    futureAt,
  ).reason, "stale");
  const foreignScope = {
    ...orderBox.scope,
    identityProvider: () => ({ effectiveHost: "github.com", authIdentity: "different-account" }),
  };
  assert.equal(settleReservationWithBudgetObservations(
    foreignScope,
    orderLeaseId,
    futureGrant.reservationId,
    { outcome: "rejected", observations: [] },
    futureAt,
  ).reason, "stale");
});

test("missing and partial response observations partition local cost exactly once", (t) => {
  for (const [suffix, observedCost] of [["missing", 0], ["partial", 1]]) {
    const box = sandbox(t, { authIdentity: `atomic-${suffix}-observation` });
    const leaseId = randomUUID();
    registerLease(box.scope, lease(leaseId));
    publishInitial(box.scope, leaseId);
    const initial = inspectGovernor(box.scope, NOW).value.budgets.core;
    const grant = registerIntent(box.scope, intent(randomUUID(), leaseId)).value;
    startReservation(box.scope, grant.reservationId, grant.notBefore);
    box.setNow(grant.notBefore);
    const settledAt = grant.notBefore + 1;
    const observations = observedCost === 0 ? [] : [{
      resource: "core",
      limit: 5000,
      used: observedCost,
      remaining: 5000 - observedCost,
      resetMs: initial.resetMs,
      receivedAt: settledAt,
      source: "response-header",
      cost: observedCost,
    }];
    assert.equal(settleReservationWithBudgetObservations(box.scope, leaseId, grant.reservationId, {
      outcome: "measured-success",
      actualCosts: { core: 2, graphql: 0 },
      observations,
    }, settledAt).ok, true);
    box.setNow(settledAt);
    let state = inspectGovernor(box.scope, settledAt).value;
    const reservation = state.reservations[grant.reservationId];
    assert.equal(reservation.accountedCosts.core, observedCost);
    assert.equal(state.budgets.core.knownLocalUsed, observedCost);
    assert.equal(
      state.budgets.core.knownLocalUsed + reservation.actualCosts.core - reservation.accountedCosts.core,
      2,
      "accepted header cost plus residual reservation cost must equal measured local cost",
    );

    const probeAt = settledAt + 1;
    const claim = claimNow(box.scope, leaseId, probeAt);
    assert.ok(claim.value.resources.includes("core"));
    const claimedBudgets = {
      core: {
        source: "core-observer",
        budget: { limit: 5000, used: 2, remaining: 4998, resetMs: initial.resetMs },
      },
    };
    if (claim.value.resources.includes("graphql")) {
      claimedBudgets.graphql = {
        source: "rate-limit-probe",
        budget: { limit: 5000, used: 0, remaining: 5000, resetMs: initial.resetMs },
      };
    }
    assert.equal(publishProbe(box.scope, leaseId, claim.value.nonce, claimedBudgets, probeAt).ok, true);
    state = inspectGovernor(box.scope, probeAt).value;
    assert.equal(state.budgets.core.lastExternalFactor, 1);
  }
});

test("response settlement ignores a rewound reset and retains its residual charge", (t) => {
  const box = sandbox(t, { authIdentity: "atomic-rewound-reset" });
  const leaseId = randomUUID();
  registerLease(box.scope, lease(leaseId));
  publishInitial(box.scope, leaseId);
  const initial = inspectGovernor(box.scope, NOW).value.budgets.core;
  const grant = registerIntent(box.scope, intent(randomUUID(), leaseId)).value;
  startReservation(box.scope, grant.reservationId, grant.notBefore);
  box.setNow(grant.notBefore);
  const settledAt = grant.notBefore + 1;
  assert.equal(settleReservationWithBudgetObservations(box.scope, leaseId, grant.reservationId, {
    outcome: "measured-success",
    actualCosts: { core: 2, graphql: 0 },
    observations: [{
      resource: "core",
      limit: 5000,
      used: 2,
      remaining: 4998,
      resetMs: initial.resetMs - 1_000,
      receivedAt: settledAt,
      source: "response-header",
      cost: 2,
    }],
  }, settledAt).ok, true);
  const state = inspectGovernor(box.scope, settledAt).value;
  assert.equal(state.budgets.core.resetMs, initial.resetMs);
  assert.equal(state.budgets.core.used, initial.used);
  assert.equal(state.budgets.core.knownLocalUsed, 0);
  assert.equal(state.reservations[grant.reservationId].accountedCosts.core, 0);
  assert.equal(state.reservations[grant.reservationId].actualCosts.core, 2);
});

test("response settlement cannot advance the core epoch ahead of the claimed observer", (t) => {
  const box = sandbox(t, { authIdentity: "endpoint-epoch-ownership" });
  const leaseId = randomUUID();
  registerLease(box.scope, lease(leaseId));
  publishInitial(box.scope, leaseId);
  const initial = inspectGovernor(box.scope, NOW).value.budgets.core;
  const grant = registerIntent(box.scope, intent(randomUUID(), leaseId)).value;
  startReservation(box.scope, grant.reservationId, grant.notBefore);
  box.setNow(grant.notBefore);
  const settledAt = grant.notBefore + 1;
  recordResourceBlock(box.scope, "core", settledAt + 60_000, "rate-limit");
  requestManualProbe(box.scope, leaseId, initial.epoch, initial.observedAt, grant.notBefore);

  const endpointResetMs = initial.resetMs + 3_600_000;
  assert.equal(settleReservationWithBudgetObservations(box.scope, leaseId, grant.reservationId, {
    outcome: "measured-success",
    actualCosts: { core: 1, graphql: 0 },
    observations: [{
      resource: "core", limit: 5000, used: 1, remaining: 4999,
      resetMs: endpointResetMs, receivedAt: settledAt, source: "response-header", cost: 1,
    }],
  }, settledAt).ok, true);
  let state = inspectGovernor(box.scope, settledAt).value;
  assert.equal(state.budgets.core.epoch, initial.epoch);
  assert.equal(state.budgets.core.resetMs, initial.resetMs);
  assert.equal(state.budgets.core.used, initial.used);
  assert.equal(state.budgets.core.source, "core-observer");
  assert.equal(state.budgets.core.knownLocalUsed, 0);
  assert.equal(state.budgets.core.blockReason, "rate-limit");
  assert.equal(state.manualProbe.satisfiedAt, null);
  assert.equal(state.reservations[grant.reservationId].accountedCosts.core, 0);
  assert.equal(state.reservations[grant.reservationId].actualCosts.core, 1);

  const ownerAt = settledAt + 1;
  box.setNow(ownerAt);
  const claim = claimNow(box.scope, leaseId, ownerAt);
  const ownerResetMs = initial.resetMs + 1_800_000;
  assert.equal(publishProbe(
    box.scope,
    leaseId,
    claim.value.nonce,
    budgets(ownerAt, { remaining: 4999, resetMs: ownerResetMs }),
    ownerAt,
  ).ok, true);
  state = inspectGovernor(box.scope, ownerAt).value;
  assert.equal(state.budgets.core.resetMs, ownerResetMs);
  assert.equal(state.budgets.core.source, "core-observer");
  assert.equal(state.budgets.core.blockUntil, null);
  assert.equal(state.manualProbe, null);
});

test("response settlement rejects claimed-source labels", (t) => {
  for (const source of ["core-observer", "rate-limit-probe"]) {
    const box = sandbox(t, { authIdentity: `settlement-source-${source}` });
    const leaseId = randomUUID();
    registerLease(box.scope, lease(leaseId));
    publishInitial(box.scope, leaseId);
    const initial = inspectGovernor(box.scope, NOW).value.budgets.core;
    const grant = registerIntent(box.scope, intent(randomUUID(), leaseId)).value;
    startReservation(box.scope, grant.reservationId, grant.notBefore);
    box.setNow(grant.notBefore);
    const settledAt = grant.notBefore + 1;
    assert.equal(settleReservationWithBudgetObservations(box.scope, leaseId, grant.reservationId, {
      outcome: "measured-success",
      actualCosts: { core: 1, graphql: 0 },
      observations: [{
        resource: "core", limit: 5000, used: 1, remaining: 4999,
        resetMs: initial.resetMs, receivedAt: settledAt, source, cost: 1,
      }],
    }, settledAt).reason, "corrupt");
    assert.equal(
      inspectGovernor(box.scope, settledAt).value.reservations[grant.reservationId].status,
      "started",
    );
  }
});

test("v1 governor state migrates in place without retaining its core probe sample", (t) => {
  const { scope } = sandbox(t, { authIdentity: "v1-migration" });
  const leaseId = randomUUID();
  registerLease(scope, lease(leaseId));
  publishInitial(scope, leaseId);
  writeGovernorState(scope.path, asV1GovernorState(inspectGovernor(scope, NOW).value));
  const migrated = inspectGovernor(scope, NOW);
  assert.equal(migrated.ok, true);
  assert.equal(migrated.value.version, 2);
  assert.equal(migrated.value.budgets.core, undefined);
  assert.equal(migrated.value.epochs.core, null);
  assert.equal(migrated.value.budgets.graphql.source, "rate-limit-probe");
  assert.equal(migrated.value.observers.core.etag, null);
  assert.equal(scope.path, governorPath(scope.hash, { env: { XDG_CONFIG_HOME: dirname(dirname(scope.path)) } }));
  const persisted = JSON.parse(readFileSync(scope.path, "utf8"));
  assert.equal(persisted.version, 2);
  assert.equal(persisted.budgets.core, undefined);
  assert.equal(existsSync(`${scope.path}.lock`), false);
  assert.deepEqual(
    readdirSync(dirname(scope.path)).filter((name) => name.includes(".tmp")),
    [],
    "the same-path atomic migration must not leave a temporary artifact",
  );
});

test("a mutating v1 migration persists its v2 result at the same path before unlock", (t) => {
  const box = sandbox(t, { authIdentity: "v1-mutation" });
  const leaseId = randomUUID();
  registerLease(box.scope, lease(leaseId));
  publishInitial(box.scope, leaseId);
  writeGovernorState(box.scope.path, asV1GovernorState(inspectGovernor(box.scope, NOW).value));

  const at = NOW + 1;
  box.setNow(at);
  const heartbeat = heartbeatLease(box.scope, leaseId, { core: 0, graphql: 2 }, at, "issues");
  assert.equal(heartbeat.ok, true);
  assert.equal(heartbeat.value.activeTab, "issues");
  const persisted = JSON.parse(readFileSync(box.scope.path, "utf8"));
  assert.equal(persisted.version, 2);
  assert.equal(persisted.budgets.core, undefined);
  assert.equal(persisted.leases[leaseId].activeTab, "issues");
  assert.equal(
    box.scope.path,
    governorPath(box.scope.hash, { env: { XDG_CONFIG_HOME: dirname(dirname(box.scope.path)) } }),
  );
  assert.equal(existsSync(`${box.scope.path}.lock`), false);
  assert.deepEqual(
    readdirSync(dirname(box.scope.path)).filter((name) => name.includes(".tmp")),
    [],
    "the mutating same-path migration must not leave a temporary artifact",
  );
});

test("schema, bounds, corrupt data, and future timestamps fail closed", (t) => {
  const { scope } = sandbox(t);
  mkdirSync(dirname(scope.path), { recursive: true, mode: 0o700 });
  writeFileSync(scope.path, "{", { mode: 0o600 });
  assert.equal(inspectGovernor(scope, NOW).reason, "corrupt");

  const wrongVersion = emptyGovernorState();
  wrongVersion.version = 3;
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
    accountedCosts: { core: 0, graphql: 0 },
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
      accountedCosts: { core: 0, graphql: 0 },
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
      accountedCosts: { core: 0, graphql: 0 },
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

test("twelve worker settlements preserve counters and account their accepted reservations", async (t) => {
  const box = sandbox(t, { authIdentity: "atomic-settlement-workers" });
  const leaseId = randomUUID();
  registerLease(box.scope, lease(leaseId));
  publishInitial(box.scope, leaseId);
  const grants = [];
  let currentAt = NOW;
  for (let index = 0; index < 12; index += 1) {
    const grant = registerIntent(box.scope, intent(randomUUID(), leaseId, currentAt)).value;
    grants.push(grant);
    assert.equal(startReservation(box.scope, grant.reservationId, grant.notBefore).ok, true);
    currentAt = grant.notBefore;
    box.setNow(currentAt);
  }
  const settlementAt = Math.max(...grants.map((grant) => grant.notBefore)) + 1;
  const resetMs = inspectGovernor(box.scope, settlementAt).value.budgets.core.resetMs;
  const results = await Promise.all(grants.map((grant, index) => worker({
    root: box.root,
    host: "github.com",
    authIdentity: "atomic-settlement-workers",
    now: settlementAt,
    operation: "settleReservationWithBudgetObservations",
    leaseId,
    reservationId: grant.reservationId,
    completion: {
      outcome: "measured-success",
      actualCosts: { core: 2, graphql: 0 },
      observations: [{
        resource: "core",
        limit: 5000,
        used: (index + 1) * 2,
        remaining: 5000 - (index + 1) * 2,
        resetMs,
        receivedAt: settlementAt,
        source: "response-header",
        cost: 2,
      }],
    },
  })));
  assert.ok(results.every((result) => result.ok), JSON.stringify(results));
  const state = inspectGovernor(box.scope, settlementAt).value;
  assert.equal(state.budgets.core.used, 24);
  assert.equal(state.budgets.core.knownLocalUsed, 24);
  assert.equal(Object.values(state.reservations).reduce(
    (total, reservation) => total + reservation.accountedCosts.core,
    0,
  ), 24);
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
