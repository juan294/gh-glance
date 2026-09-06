import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import {
  BUDGET_RESET_GRACE_MS, BUDGET_SNAPSHOT_TTL_MS,
  resolveEffectiveCredential, identityRegistryRoot, claimIdentityBootstrap,
  finishIdentityBootstrap, createQuotaScope, writeGovernorState,
} from "../../../index.mjs";

const host = "github.com";
// Explicit synthetic credential: no local auth/config lookup or real HTTP.
const credential = await resolveEffectiveCredential({ host, env: { GH_TOKEN: "fixture-keyring-token" } });
assert.equal(credential.ok, true);

export function seedKnownHeldIdentity(root, state, now = Date.now()) {
  assert.equal(state.core.remaining, 0);
  // A known account already has an absolute reset epoch. Anchor the fixture
  // and its later resetSequence to that same setup instant, not a second clock
  // started by the first live probe after process startup.
  if (state.anchorAtFirstProbe === true) {
    state.createdAt = now;
    state.anchorAtFirstProbe = false;
    for (const resource of ["core", "graphql"]) {
      if (!Number.isFinite(state[resource]?.resetOffsetMs)) continue;
      state[resource] = { ...state[resource], resetMs: now + state[resource].resetOffsetMs };
      delete state[resource].resetOffsetMs;
    }
  }
  const core = state.core;
  const registryRoot = identityRegistryRoot({ env: { XDG_CONFIG_HOME: root } });
  const resetMs = Math.floor((Number.isFinite(core.resetOffsetMs) ? now + core.resetOffsetMs : core.resetMs) / 1000) * 1000;
  const budget = { resource: "core", limit: core.limit, used: core.used, remaining: core.remaining, resetMs };
  const user = { id: 1, login: "octocat" };
  // Match gh-state's validator for the unchanged default /user representation.
  const etag = `"fixture-${createHash("sha256").update(JSON.stringify(user)).digest("hex").slice(0, 16)}"`;
  const proofAt = now - BUDGET_SNAPSHOT_TTL_MS - 1000;
  const claim = claimIdentityBootstrap(registryRoot, { credentialKey: credential.value.credentialKey, host, now: proofAt });
  assert.equal(claim.ok, true, JSON.stringify(claim));
  const finished = finishIdentityBootstrap(registryRoot, {
    credentialKey: credential.value.credentialKey, ...claim.value, now: proofAt,
    response: { status: 200, body: user, rateLimit: budget, etag },
  });
  assert.equal(finished.ok, true, JSON.stringify(finished));
  const scope = createQuotaScope(finished.value, { root: registryRoot });
  const ledger = JSON.parse(readFileSync(scope.path, "utf8"));
  // This scenario begins with an already verified principal and a current held
  // snapshot. Retain its historical proof receipt/allowance exactly; only the
  // fixture's current core observation is fresh. GraphQL still needs the first
  // live probe, whose HTTP counts and reset anchoring remain under test.
  // The current snapshot includes the prior exhausted /user 403 evidence
  // these hold scenarios start from; manual refresh must preserve that hold.
  ledger.budgets.core.blockUntil = resetMs;
  ledger.budgets.core.blockReason = "rate-limit";
  ledger.budgets.core.observedAt = now;
  ledger.budgets.core.factorBaseline.observedAt = now;
  ledger.observers.core.at = now;
  ledger.observers.core.nextAt = resetMs + BUDGET_RESET_GRACE_MS;
  assert.equal(writeGovernorState(scope.path, ledger).ok, true);
  return scope;
}
