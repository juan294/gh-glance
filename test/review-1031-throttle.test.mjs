// Regression tests for the 2026-10-31 review findings on rate-limit recovery
// and governor admission: RT-02 (#164), PC-05/RT-03 (#169) and PC-08 (#174).
// Every test runs against temporary directories and fixture responses only.
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
  createGovernorScope, registerLease, registerIntent, claimProbe, publishProbe,
  requestManualProbe, inspectGovernor, startReservation, readIntentDecision, GOVERNOR_LEASE_TTL_MS,
  fetchSecurity, secondaryThrottleEvidence,
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
