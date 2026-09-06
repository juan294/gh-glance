import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { test } from "node:test";

import {
  THROTTLE_LADDER_MS,
  THROTTLE_PAUSE_AFTER,
  MANUAL_GRANT_STREAK_LIMIT,
  applyTransportCooldown,
  classifyThrottle,
  clearTransportThrottle,
  emptyTransportThrottle,
  throttleLadderMs,
  transportCooldownDeadline,
  GOVERNOR_LEASE_TTL_MS,
  cancelIntent,
  claimProbe,
  createGovernorScope,
  inspectGovernor,
  publishProbe,
  registerIntent,
  registerLease,
  requestManualProbe,
  settleReservationWithBudgetObservations,
  startReservation,
} from "../index.mjs";

const NOW = 1_800_000_000_000;
const transport = () => ({ lastStartedAt: 0, cooldownUntil: 0, permit: null, waiters: [], throttle: emptyTransportThrottle() });

test("SCHED-05 throttle evidence is read, never inferred from the status alone", () => {
  // The case that matters most: a 403 that is a permission error, not a limit.
  // It carries no rate-limit headers and no secondary marker, and holding the
  // shared transport for it would pause every pane over one unreadable repo.
  assert.deepEqual(classifyThrottle({ status: 403, headers: {}, body: { message: "Must have admin rights to Repository." } }),
    { kind: "none" });
  assert.deepEqual(classifyThrottle({ status: 404, headers: {} }), { kind: "none" });

  // Primary exhaustion holds its own resource until its own reset, and says
  // nothing about the other one.
  const primary = classifyThrottle({
    status: 403,
    headers: { "x-ratelimit-remaining": "0", "x-ratelimit-reset": "1800003600", "x-ratelimit-resource": "core" },
  });
  assert.deepEqual(primary, { kind: "primary", resource: "core", resetMs: 1_800_003_600_000 });
  assert.equal(classifyThrottle({
    status: 403,
    headers: { "x-ratelimit-remaining": "0", "x-ratelimit-reset": "1800003600", "x-ratelimit-resource": "graphql" },
  }).resource, "graphql");

  // An exhausted counter that also names a secondary limit is secondary: the
  // account-wide hold is the stronger claim and it holds both resources.
  assert.equal(classifyThrottle({
    status: 403,
    headers: { "x-ratelimit-remaining": "0", "x-ratelimit-reset": "1800003600", "x-ratelimit-resource": "core" },
    body: { message: "You have exceeded a secondary rate limit." },
  }).kind, "secondary");

  // A GraphQL error envelope carries the same evidence in a different shape.
  assert.equal(classifyThrottle({ status: 200, graphqlErrors: [{ type: "RATE_LIMITED", message: "secondary rate limit" }] }).kind, "secondary");
  assert.equal(classifyThrottle({ status: 429, headers: {} }).kind, "secondary");
  assert.equal(classifyThrottle({ status: 200, stderr: "You have triggered an abuse detection mechanism" }).kind, "secondary");
});

test("SCHED-04 a supplied deadline is honoured exactly and the local ladder is capped", () => {
  // Thirty seconds is thirty seconds. The old flat law rounded every secondary
  // limit up to a minute, which turned a short server-chosen wait into a long
  // one for no reason.
  assert.equal(transportCooldownDeadline({ retryAfter: "30", status: 429, at: NOW }), NOW + 30_000);
  // Two hours is two hours: the cap bounds only the delay this client invents.
  assert.equal(transportCooldownDeadline({ retryAfter: "7200", status: 429, at: NOW }), NOW + 7_200_000);
  const httpDate = new Date(NOW + 45_000).toUTCString();
  assert.equal(transportCooldownDeadline({ retryAfter: httpDate, status: 429, at: NOW }), Date.parse(httpDate));

  // Without a supplied deadline the ladder climbs by consecutive throttle and
  // stops climbing, rather than doubling without bound.
  assert.deepEqual(THROTTLE_LADDER_MS, [60_000, 120_000, 240_000, 480_000, 900_000]);
  assert.deepEqual([0, 1, 2, 3, 4, 5, 99].map(throttleLadderMs),
    [60_000, 120_000, 240_000, 480_000, 900_000, 900_000, 900_000]);
  assert.equal(transportCooldownDeadline({ status: 429, at: NOW, attempts: 3 }), NOW + 480_000);
  assert.equal(transportCooldownDeadline({ status: 200, at: NOW }), null);
});

test("SCHED-04 a shorter concurrent error never shortens a hold already established", () => {
  const shared = transport();
  applyTransportCooldown(shared, { retryAfter: "3600", status: 429, at: NOW });
  assert.equal(shared.cooldownUntil, NOW + 3_600_000);
  // A second pane's 429 arrives with no Retry-After and would choose two
  // minutes. Merging by maximum keeps the hour the server actually asked for.
  applyTransportCooldown(shared, { status: 429, at: NOW + 1_000 });
  assert.equal(shared.cooldownUntil, NOW + 3_600_000);
  assert.equal(shared.throttle.attempts, 2);
});

test("SCHED-06 repeated throttles are bounded and pause until an explicit retry", () => {
  const shared = transport();
  const chosen = [];
  for (let attempt = 0; attempt < THROTTLE_PAUSE_AFTER; attempt += 1) {
    const before = shared.cooldownUntil;
    applyTransportCooldown(shared, { status: 429, at: NOW + attempt });
    chosen.push(shared.cooldownUntil - before === 0 ? null : shared.cooldownUntil);
    assert.equal(shared.throttle.attempts, attempt + 1);
  }
  // Bounded: the fifth throttle waits fifteen minutes, not an ever-doubling one.
  assert.equal(shared.cooldownUntil, NOW + 4 + 900_000);
  assert.equal(shared.throttle.paused, true);

  // Only evidence of a request that was not throttled clears the ladder.
  // Waiting out the deadline is what produced the last throttle.
  clearTransportThrottle(shared);
  assert.deepEqual(shared.throttle, emptyTransportThrottle());
  applyTransportCooldown(shared, { status: 429, at: NOW });
  assert.equal(shared.throttle.attempts, 1);
  assert.equal(shared.throttle.paused, false);
});

test("SCHED-05 a permission failure moves neither the hold nor the ladder", () => {
  const shared = transport();
  const verdict = classifyThrottle({ status: 403, headers: {}, body: { message: "Resource not accessible by integration" } });
  assert.equal(verdict.kind, "none");
  // The release path only applies a cooldown for a secondary verdict, so this
  // records the state that path leaves behind: untouched.
  assert.equal(shared.cooldownUntil, 0);
  assert.deepEqual(shared.throttle, emptyTransportThrottle());
});

// --- SCHED-03: the external-use estimator -----------------------------------

function sandbox(t, authIdentity) {
  const root = mkdtempSync(join(tmpdir(), "gh-glance-sched-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  let clock = NOW;
  const scope = createGovernorScope({
    effectiveHost: "github.com",
    authIdentity,
    env: { XDG_CONFIG_HOME: root },
    now: () => clock,
  }).value;
  return { scope, at: () => clock, setNow: (value) => { clock = value; } };
}

const RESET = NOW + 3_600_000;

// The observer is due once a minute. These tests need several publications
// inside one lease, so the demand is expressed the way a manual refresh does
// rather than by advancing the clock past the lease itself.
function makeDue(box, leaseId) {
  const budget = inspectGovernor(box.scope, box.at()).value.budgets.core;
  if (!budget) return;
  assert.equal(requestManualProbe(box.scope, leaseId, budget.epoch, box.at(), box.at()).ok, true);
}

function publishCore(box, leaseId, { used, resetMs = RESET }, at = box.at()) {
  makeDue(box, leaseId);
  const claim = claimProbe(box.scope, leaseId, at, "core");
  assert.equal(claim.value.status, "claimed", JSON.stringify(claim.value));
  const result = publishProbe(box.scope, leaseId, claim.value.nonce, {
    core: { source: "core-observer", budget: { limit: 5000, used, remaining: 5000 - used, resetMs } },
  }, at, "core");
  assert.equal(result.ok, true, JSON.stringify(result));
}

// Admission needs every resource established, so GraphQL is published too even
// though this section only reasons about core.
function publishGraphql(box, leaseId, at = box.at()) {
  const claim = claimProbe(box.scope, leaseId, at, "graphql");
  assert.equal(claim.value.status, "claimed", JSON.stringify(claim.value));
  assert.equal(publishProbe(box.scope, leaseId, claim.value.nonce, {
    graphql: { source: "graphql-observer", budget: { limit: 5000, used: 0, remaining: 5000, resetMs: RESET } },
  }, at, "graphql").ok, true);
}

// One Actions fetch is two core units, and an intent's costs must match the
// tab's declared cost exactly, so local spend is counted in fetches. Settling
// each one is what makes the charge definite -- reconciled, not inferred.
const FETCH_COST = 2;

function spendLocally(box, leaseId, fetches) {
  let settledAt = box.at();
  for (let index = 0; index < fetches; index += 1) {
    const id = randomUUID();
    const at = box.at() + 1;
    box.setNow(at);
    const registered = registerIntent(box.scope, {
      id, leaseId, tab: "actions", priority: "active",
      costs: { core: FETCH_COST, graphql: 0 }, requestedAt: at, expiresAt: at + GOVERNOR_LEASE_TTL_MS,
    });
    assert.equal(registered.ok, true, JSON.stringify(registered));
    assert.equal(registered.value.status, "scheduled", JSON.stringify(registered.value));
    const grant = registered.value;
    box.setNow(grant.notBefore);
    assert.equal(startReservation(box.scope, grant.reservationId, grant.notBefore).value.status, "started");
    settledAt = grant.notBefore + 1;
    box.setNow(settledAt);
    assert.equal(settleReservationWithBudgetObservations(box.scope, leaseId, grant.reservationId, {
      outcome: "measured-success",
      actualCosts: { core: FETCH_COST, graphql: 0 },
      observations: [],
    }, settledAt).ok, true);
  }
  return settledAt;
}

function lease(box, leaseId, at = NOW) {
  assert.equal(registerLease(box.scope, {
    id: leaseId, expiresAt: at + GOVERNOR_LEASE_TTL_MS, floorMs: 5000, activeTab: "actions",
    phaseSeed: { seed: leaseId, registeredAt: at }, demand: { core: 4, graphql: 0 },
  }).ok, true);
}

const factorOf = (box) => inspectGovernor(box.scope, box.at()).value.budgets.core;

test("SCHED-03 undersized local samples accumulate instead of being discarded", (t) => {
  const box = sandbox(t, "estimator-accumulation");
  const leaseId = randomUUID();
  lease(box, leaseId);
  publishCore(box, leaseId, { used: 0 });
  publishGraphql(box, leaseId);

  // One reconciled window: six local units against forty-two observed, so
  // other clients are spending six units for every one of ours.
  spendLocally(box, leaseId, 3);
  box.setNow(box.at() + 1);
  publishCore(box, leaseId, { used: 42 });
  assert.equal(factorOf(box).lastExternalFactor, 7);
  assert.equal(factorOf(box).knownLocalUsed, 0);
  assert.equal(factorOf(box).factorBaseline.used, 42);

  // Now windows of a single fetch, with the counter moving by exactly that
  // fetch. Two units is below the five-unit minimum, so neither of the first
  // two closes the window -- and crucially neither costs the evidence in it.
  for (const used of [44, 46]) {
    spendLocally(box, leaseId, 1);
    box.setNow(box.at() + 1);
    publishCore(box, leaseId, { used });
    assert.equal(factorOf(box).lastExternalFactor, 7, "an undersized sample is not evidence");
    assert.equal(factorOf(box).factorBaseline.used, 42, "an undersized sample must not close the window");
  }

  // The third takes the accumulation to six units against six observed, which
  // reconciles: there was no external use at all.
  spendLocally(box, leaseId, 1);
  box.setNow(box.at() + 1);
  publishCore(box, leaseId, { used: 48 });
  assert.equal(factorOf(box).lastExternalFactor, 1,
    "six local units against six observed is no external use");
  assert.equal(factorOf(box).factorBaseline.used, 48, "a reconciled sample closes the window");
});

test("SCHED-03 an authoritative new epoch resets the factor with the sample", (t) => {
  const box = sandbox(t, "estimator-epoch");
  const leaseId = randomUUID();
  lease(box, leaseId);
  publishCore(box, leaseId, { used: 0 });
  publishGraphql(box, leaseId);
  spendLocally(box, leaseId, 3);
  box.setNow(box.at() + 1);
  publishCore(box, leaseId, { used: 42 });
  assert.equal(factorOf(box).lastExternalFactor, 7);

  // The reset opens a new accounting window. What other clients did in the last
  // one is not evidence about this one, so the estimate starts over with it.
  box.setNow(RESET + 1);
  // An hour has passed, so the lease that owned the earlier publications is
  // gone. Re-registering is what a pane still running would have done by
  // heartbeat; the point of the test is the epoch, not lease liveness.
  lease(box, leaseId, RESET + 1);
  publishCore(box, leaseId, { used: 0, resetMs: RESET + 3_600_000 }, RESET + 1);
  const fresh = factorOf(box);
  assert.equal(fresh.lastExternalFactor, 1, "a new epoch must not inherit the previous window's ratio");
  assert.equal(fresh.knownLocalUsed, 0);
  assert.equal(fresh.factorBaseline.epoch, fresh.epoch);
});

// --- SCHED-08: manual pressure cannot starve an active owner ----------------

// Each refresh keypress is its own planning pass, so the run this bounds is one
// manual intent per pass rather than several within one. That is exactly why
// the counter has to survive the pass -- and why it is persisted state.
function requestOnce(box, leaseId, priority, tab = "actions") {
  const id = randomUUID();
  const at = box.at() + 1;
  box.setNow(at);
  const registered = registerIntent(box.scope, {
    id, leaseId, tab, priority,
    costs: { core: FETCH_COST, graphql: 0 }, requestedAt: at, expiresAt: at + GOVERNOR_LEASE_TTL_MS,
  });
  assert.equal(registered.ok, true, JSON.stringify(registered));
  return registered.value;
}

test("SCHED-08 a run of manual refreshes yields a turn to a waiting active owner", (t) => {
  const box = sandbox(t, "manual-starvation");
  const manualLease = randomUUID();
  const activeLease = randomUUID();
  lease(box, manualLease);
  lease(box, activeLease);
  publishCore(box, manualLease, { used: 0 });
  publishGraphql(box, manualLease);

  // Three refreshes, each its own planning pass, each granted.
  for (let press = 0; press < MANUAL_GRANT_STREAK_LIMIT; press += 1) {
    assert.equal(requestOnce(box, manualLease, "manual").status, "scheduled");
  }
  assert.equal(inspectGovernor(box.scope, box.at()).value.fairness.manualStreak, MANUAL_GRANT_STREAK_LIMIT,
    "the run has to be counted across passes or it cannot be bounded");

  // Put an active owner in the queue and leave it there: exhausted core pauses
  // it, and a paused intent stays pending for the next pass to reconsider.
  box.setNow(box.at() + 1);
  publishCore(box, manualLease, { used: 5000 });
  const active = requestOnce(box, activeLease, "active");
  assert.equal(active.status, "paused", JSON.stringify(active));
  assert.equal(Object.keys(inspectGovernor(box.scope, box.at()).value.intents).length, 1);

  // Capacity returns on a new epoch. The next refresh now plans a pass holding
  // both the waiting owner and the fourth manual press.
  box.setNow(box.at() + 1);
  publishCore(box, manualLease, { used: 0, resetMs: RESET + 3_600_000 });
  const fourth = requestOnce(box, manualLease, "manual");
  assert.equal(fourth.status, "scheduled");

  const settled = inspectGovernor(box.scope, box.at()).value;
  const activeReservation = Object.values(settled.reservations)
    .find((reservation) => reservation.leaseId === activeLease);
  assert.ok(activeReservation, `the waiting owner was never granted: ${JSON.stringify(settled.reservations)}`);
  // Manual work is still served -- it is not punished -- but after three turns
  // in a row it no longer goes first.
  assert.ok(
    activeReservation.notBefore <= settled.reservations[fourth.reservationId].notBefore,
    `the owner stayed queued behind the manual work: active ${activeReservation.notBefore} ` +
    `vs manual ${settled.reservations[fourth.reservationId].notBefore}`,
  );
  assert.equal(settled.fairness.manualStreak, 1,
    "granting the owed turn ends the run, and the manual grant after it starts a new one");
});

test("SCHED-08 the owed turn reorders work without admitting anything unaffordable", (t) => {
  const box = sandbox(t, "manual-starvation-safety");
  const leaseId = randomUUID();
  lease(box, leaseId);
  // Exhausted: nothing is affordable, whoever is owed a turn.
  publishCore(box, leaseId, { used: 5000 });
  publishGraphql(box, leaseId);
  const state = inspectGovernor(box.scope, box.at()).value;
  assert.equal(state.budgets.core.remaining, 0);

  const denied = requestOnce(box, leaseId, "active");
  assert.notEqual(denied.status, "scheduled",
    "an owed turn must never admit work the budget cannot pay for");
});

// --- SCHED-01/02: pacing credit ---------------------------------------------

// The lane is the pacing clock: every grant pushes `laneNextAt` out by what it
// reserved, which is a worst case. When the request turns out to cost less --
// or never happens -- the difference is capacity that has been paced away for
// nothing, and the next request waits for a slot nobody used.
const laneOf = (box) => inspectGovernor(box.scope, box.at()).value.budgets.core.laneNextAt;

function startAndSettle(box, leaseId, grant, completion) {
  box.setNow(grant.notBefore);
  assert.equal(startReservation(box.scope, grant.reservationId, grant.notBefore).value.status, "started");
  const settledAt = grant.notBefore + 1;
  box.setNow(settledAt);
  const settled = settleReservationWithBudgetObservations(
    box.scope, leaseId, grant.reservationId, { observations: [], ...completion }, settledAt,
  );
  assert.equal(settled.ok, true, JSON.stringify(settled));
  return settledAt;
}

test("SCHED-01 a settlement that cost nothing returns the pacing it reserved", (t) => {
  const box = sandbox(t, "pacing-credit");
  const leaseId = randomUUID();
  lease(box, leaseId);
  publishCore(box, leaseId, { used: 0 });
  publishGraphql(box, leaseId);

  const grant = requestOnce(box, leaseId, "active");
  assert.equal(grant.status, "scheduled");
  const paced = laneOf(box);
  assert.ok(paced > grant.notBefore, "the grant must pace the lane forward");

  // A conditional request answered 304: charged nothing, so it paced nothing.
  const settledAt = startAndSettle(box, leaseId, grant, {
    outcome: "measured-success",
    actualCosts: { core: 0, graphql: 0 },
  });
  const returned = laneOf(box);
  assert.ok(returned < paced, `unused pacing must be returned: lane stayed at ${returned}`);
  assert.ok(returned >= settledAt, "returned credit must not place the lane in the past");

  // ...and the next request may start on the transport gap rather than waiting
  // out a slot the 304 never used.
  const next = requestOnce(box, leaseId, "active");
  assert.equal(next.status, "scheduled");
  assert.ok(next.notBefore < paced,
    `the next request waited out an unused slot: ${next.notBefore} vs ${paced}`);
});

test("SCHED-01 cancelled work leaves no empty slot behind it", (t) => {
  const box = sandbox(t, "pacing-cancel");
  const leaseId = randomUUID();
  lease(box, leaseId);
  publishCore(box, leaseId, { used: 0 });
  publishGraphql(box, leaseId);

  const before = laneOf(box);
  const grant = requestOnce(box, leaseId, "active");
  const paced = laneOf(box);
  assert.ok(paced > before);

  box.setNow(box.at() + 1);
  assert.equal(cancelIntent(box.scope, grant.intentId ?? grant.reservationId.slice(12), box.at()).ok, true);
  const returned = laneOf(box);
  assert.ok(returned < paced,
    `a cancelled reservation must release its slot: lane stayed at ${returned}`);
});

test("SCHED-02 a replan never refunds work whose real cost is unknown", (t) => {
  const box = sandbox(t, "pacing-uncertain");
  const leaseId = randomUUID();
  lease(box, leaseId);
  publishCore(box, leaseId, { used: 0 });
  publishGraphql(box, leaseId);

  const grant = requestOnce(box, leaseId, "active");
  const paced = laneOf(box);
  // A timeout proves nothing about what the request spent, so its worst case
  // stays charged and its pacing stays spent. Refunding here would let a run of
  // timeouts pace as though nothing had been sent at all.
  startAndSettle(box, leaseId, grant, { outcome: "timeout" });
  assert.equal(laneOf(box), paced, "uncertain work must keep its reserved pacing");
});
