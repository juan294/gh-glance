import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { test } from "node:test";

import {
  THROTTLE_LADDER_MS,
  THROTTLE_PAUSE_AFTER,
  applyTransportCooldown,
  classifyThrottle,
  clearTransportThrottle,
  emptyTransportThrottle,
  throttleLadderMs,
  transportCooldownDeadline,
  GOVERNOR_LEASE_TTL_MS,
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
