// Regression tests for the 2026-10-31 review findings on rate-limit recovery
// and governor admission: RT-02 (#164), PC-05/RT-03 (#169) and PC-08 (#174).
// Every test runs against temporary directories and fixture responses only.
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
  createGovernorScope, registerLease, registerIntent, claimProbe, publishProbe,
  requestManualProbe, inspectGovernor, startReservation, GOVERNOR_LEASE_TTL_MS,
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
