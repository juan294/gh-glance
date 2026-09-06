import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync, unlinkSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import {
  retryIdentityCompletion, createSettlementContext, registerLease, registerIntent, startReservation, settleReservationWithBudgetObservations,
  claimProbe, publishProbe, writeGovernorState, startIdentityControl, settleIdentityControl,
  resolveEffectiveCredential, createIdentityCoordinator, inspectIdentityRegistry,
  identityRegistryRoot, claimIdentityBootstrap, finishIdentityBootstrap, createQuotaScope,
  inspectGovernor, acquireIdentityHttpPermit, releaseIdentityHttpPermit,
} from "../index.mjs";

const NOW = 1_800_000_000_000;
function box(t) {
  const root = mkdtempSync(join(tmpdir(), "glance-identity-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  return { root, pathOptions: { env: { XDG_CONFIG_HOME: root } } };
}
const proof = (id = 1) => ({ body: { id, login: `user-${id}` }, rateLimit: { resource: "core", limit: 5000, used: 1, remaining: 4999, resetMs: NOW + 3_600_000 }, etag: '"identity-v1"' });

test("ID-01 effective credential precedence ignores variable spelling and unrelated hosts", async () => {
  const first = await resolveEffectiveCredential({ host: "github.com", env: { GH_TOKEN: "synthetic-token", GH_ENTERPRISE_TOKEN: "irrelevant" } });
  const second = await resolveEffectiveCredential({ host: "github.com", env: { GITHUB_TOKEN: "synthetic-token" } });
  assert.equal(first.value.credentialKey, second.value.credentialKey);
  const enterprise = await resolveEffectiveCredential({ host: "enterprise.example", env: { GH_TOKEN: "irrelevant", GITHUB_ENTERPRISE_TOKEN: "synthetic-token" } });
  assert.notEqual(first.value.credentialKey, enterprise.value.credentialKey);
  let argv;
  const local = await resolveEffectiveCredential({ host: "github.com", env: {}, runLocalToken: async (args) => { argv = args; return "synthetic-token\n"; } });
  assert.deepEqual(argv, ["auth", "token", "--hostname", "github.com"]);
  assert.equal(local.value.credentialKey, first.value.credentialKey);
  assert.equal(JSON.stringify(local).includes("synthetic-token"), false);
});

test("ID-02 verified same-principal tokens share quota and retain separate access scopes", async (t) => {
  const { pathOptions } = box(t);
  let at = NOW;
  const make = (token) => createIdentityCoordinator({ host: "github.com", pathOptions, env: { GH_TOKEN: token }, now: () => at, requestIdentity: async () => proof() });
  const first = make("synthetic-one");
  assert.equal((await first.refresh()).ok, true);
  at += 250;
  const second = make("synthetic-two");
  assert.equal((await second.refresh()).ok, true);
  assert.equal(first.current().quotaKey, second.current().quotaKey);
  assert.notEqual(first.current().accessKey, second.current().accessKey);
  const ledger = inspectGovernor(createQuotaScope(first.current(), { root: first.root, now: () => at }), at);
  assert.equal(ledger.ok, true);
  assert.equal(Object.keys(ledger.value.reservations).length, 2);
  assert.equal(ledger.value.observers.core.etag, '"identity-v1"');
});

test("ID-07 malformed proof and restart retain rolling allowance and uncertain debt", async (t) => {
  const { pathOptions } = box(t);
  const root = identityRegistryRoot(pathOptions);
  const credentialKey = "a".repeat(64);
  let at = NOW;
  for (let index = 0; index < 3; index += 1) {
    const claim = claimIdentityBootstrap(root, { host: "github.com", credentialKey, now: at });
    assert.equal(claim.ok, true);
    const ended = finishIdentityBootstrap(root, { credentialKey, ...claim.value, response: { body: {} }, now: at });
    assert.equal(ended.ok, false);
    at += 60_000 * 2 ** index;
  }
  const denied = claimIdentityBootstrap(root, { credentialKey, host: "github.com", now: at });
  assert.equal(denied.ok, false);
  assert.equal(denied.retryAt, NOW + 15 * 60_000);
  const state = inspectIdentityRegistry(root, { now: at }).value;
  assert.equal(Object.keys(state.attempts).length, 3);
  assert.equal(Object.values(state.attempts).some((attempt) => attempt.accounted), false);
});

test("ID-06 credential subprocess failures cannot disclose captured stdout or stderr", async () => {
  const result = await resolveEffectiveCredential({ host: "github.com", env: {}, runLocalToken: async () => { throw Object.assign(new Error("secret-raw"), { stdout: "secret-raw", stderr: "secret-raw" }); } });
  assert.deepEqual(result, { ok: false, reason: "credential-unavailable" });
});

test("ID-03 configuration change invalidates the synchronous published identity before resolving", async (t) => {
  const { pathOptions } = box(t);
  const env = { GH_TOKEN: "synthetic-one" };
  const coordinator = createIdentityCoordinator({ host: "github.com", pathOptions, env, now: () => NOW, requestIdentity: async () => proof() });
  assert.equal((await coordinator.refresh()).ok, true);
  env.GH_TOKEN = "synthetic-two";
  assert.equal(coordinator.current(), null);
  assert.equal(readFileSync(join(coordinator.root, "registry.json"), "utf8").includes("synthetic-"), false);
});

test("ID-08 shared transport permit is single-owner and retains start gap", async (t) => {
  const { pathOptions } = box(t);
  let at = NOW;
  const coordinator = createIdentityCoordinator({ host: "github.com", pathOptions, env: { GH_TOKEN: "synthetic-one" }, now: () => at, requestIdentity: async () => proof() });
  await coordinator.refresh();
  at += 250;
  const first = await acquireIdentityHttpPermit(coordinator, { now: () => at });
  assert.ok(first.nonce);
  const inspected = inspectIdentityRegistry(coordinator.root, { now: at }).value;
  assert.equal(inspected.hosts["github.com"].permit.nonce, first.nonce);
  assert.equal(inspected.hosts["github.com"].lastStartedAt, at);
  assert.equal(releaseIdentityHttpPermit(coordinator, first).ok, true);
  assert.equal(inspectIdentityRegistry(coordinator.root).value.hosts["github.com"].permit, null);
});

test("local credential retrieval is cached until configuration revision changes and close fences delayed proof", async (t) => {
  const { pathOptions } = box(t);
  let calls = 0;
  let resolveProof;
  const coordinator = createIdentityCoordinator({ host: "github.com", pathOptions, env: {}, now: () => NOW,
    runLocalToken: async () => { calls += 1; return "synthetic-local"; },
    requestIdentity: () => new Promise((resolve) => { resolveProof = resolve; }) });
  const pending = coordinator.refresh();
  while (!resolveProof) await new Promise((resolve) => setImmediate(resolve));
  assert.equal(coordinator.refresh(), pending);
  coordinator.close();
  resolveProof(proof());
  assert.equal((await pending).ok, false);
  assert.equal(coordinator.current(), null);
  assert.equal(calls, 1);
  assert.equal((await coordinator.refresh()).reason, "closed");
  const cached = createIdentityCoordinator({ host: "github.com", pathOptions: box(t).pathOptions, env: {}, now: () => NOW,
    runLocalToken: async () => { calls += 1; return "synthetic-local"; }, requestIdentity: async () => proof() });
  assert.equal((await cached.refresh()).ok, true);
  assert.equal((await cached.refresh()).ok, true);
  assert.equal(calls, 2);
});

test("bootstrap Retry-After persists without accepting an error body as principal proof", async (t) => {
  const { pathOptions } = box(t);
  const root = identityRegistryRoot(pathOptions);
  const credentialKey = "b".repeat(64);
  const claim = claimIdentityBootstrap(root, { host: "github.com", credentialKey, now: NOW });
  const rejected = finishIdentityBootstrap(root, { credentialKey, ...claim.value, response: { ...proof(), status: 429, retryAfter: "7200" }, now: NOW });
  assert.equal(rejected.ok, false);
  const registry = inspectIdentityRegistry(root, { now: NOW }).value;
  assert.equal(registry.hosts["github.com"].cooldownUntil, NOW + 7_200_000);
  assert.equal(Object.keys(registry.identities).length, 0);
  assert.equal(claimIdentityBootstrap(root, { host: "github.com", credentialKey: "c".repeat(64), now: NOW + 60_000 }).retryAt, NOW + 7_200_000);
});

test("twelve unknown credentials exhaust host allowance and crashed owner does not erase its debit", (t) => {
  const { pathOptions } = box(t);
  const root = identityRegistryRoot(pathOptions);
  for (let index = 0; index < 12; index += 1) {
    const credentialKey = index.toString(16).padStart(64, "0");
    const claim = claimIdentityBootstrap(root, { host: "github.com", credentialKey, now: NOW + index * 250, kill: () => { throw Object.assign(new Error("dead"), { code: "ESRCH" }); } });
    assert.equal(claim.ok, true);
  }
  const denied = claimIdentityBootstrap(root, { host: "github.com", credentialKey: "f".repeat(64), now: NOW + 3000, kill: () => { throw Object.assign(new Error("dead"), { code: "ESRCH" }); } });
  assert.equal(denied.ok, false);
  assert.equal(denied.retryAt, NOW + 900_000);
  assert.equal(Object.keys(inspectIdentityRegistry(root, { now: NOW + 3000 }).value.attempts).length, 12);
});

test("ID-05 pinned legacy v1 core cooldown survives migration inspection without rewriting evidence", async (t) => {
  const { pathOptions } = box(t);
  const coordinator = createIdentityCoordinator({ host: "github.com", pathOptions, env: { GH_TOKEN: "synthetic-one" }, now: () => NOW, requestIdentity: async () => proof() });
  await coordinator.refresh();
  const scope = createQuotaScope(coordinator.current(), { root: coordinator.root, now: () => NOW });
  const legacy = structuredClone(inspectGovernor(scope, NOW).value);
  legacy.version = 1;
  delete legacy.observers;
  legacy.reservations = {};
  for (const budget of Object.values(legacy.budgets)) {
    delete budget.source; delete budget.factorBaseline; delete budget.knownLocalUsed;
  }
  legacy.budgets.core.blockUntil = NOW + 120_000;
  legacy.budgets.core.blockReason = "secondary-rate-limit";
  const path = join(coordinator.root, "..", `rate-governor-v1-${"a".repeat(64)}.json`);
  const raw = JSON.stringify(legacy);
  writeFileSync(path, raw, { mode: 0o600 });
  const denied = claimIdentityBootstrap(coordinator.root, { credentialKey: "c".repeat(64), host: "github.com", now: NOW + 250 });
  assert.equal(denied.reason, "migration-hold");
  assert.equal(denied.retryAt, NOW + 120_000);
  assert.equal(readFileSync(path, "utf8"), raw);
});

test("ID-03 delayed completion settles original started charge while access publication is fenced", async (t) => {
  const { pathOptions } = box(t);
  let at = NOW;
  const env = { GH_TOKEN: "synthetic-one" };
  const coordinator = createIdentityCoordinator({ host: "github.com", pathOptions, env, now: () => at, requestIdentity: async () => proof(env.GH_TOKEN === "synthetic-one" ? 1 : 2) });
  await coordinator.refresh();
  const old = createQuotaScope(coordinator.current(), { root: coordinator.root, now: () => at, identityProvider: coordinator.current });
  const leaseId = randomUUID();
  assert.equal(registerLease(old, { id: leaseId, expiresAt: at + 90_000, floorMs: 5000, activeTab: "actions", phaseSeed: { seed: leaseId, registeredAt: at }, demand: { core: 1, graphql: 0 } }).ok, true);
  const grant = registerIntent(old, { id: randomUUID(), leaseId, tab: "tab:actions-runs", priority: "active", costs: { core: 1, graphql: 0 }, requestedAt: at, expiresAt: at + 90_000 }).value;
  at = grant.notBefore;
  assert.equal(startReservation(old, grant.reservationId, at).value.status, "started");
  const completion = createSettlementContext(old, coordinator);
  env.GH_TOKEN = "synthetic-two";
  at += 250;
  await coordinator.refresh();
  assert.equal(completion.isCurrent(), false);
  assert.equal(settleReservationWithBudgetObservations(completion.scope, leaseId, grant.reservationId, { outcome: "measured-success", actualCosts: { core: 1, graphql: 0 }, observations: [] }, at).ok, true);
  const oldLedger = inspectGovernor(completion.scope, at).value;
  assert.equal(oldLedger.reservations[grant.reservationId].actualCosts.core, 1);
  const current = createQuotaScope(coordinator.current(), { root: coordinator.root, now: () => at });
  assert.equal(inspectGovernor(current, at).value.reservations[grant.reservationId], undefined);
});

test("ID-07 uncertain bootstrap debt transfers once and survives until authoritative epoch recovery", async (t) => {
  const { pathOptions } = box(t);
  const root = identityRegistryRoot(pathOptions);
  const credential = (await resolveEffectiveCredential({ host: "github.com", env: { GH_TOKEN: "synthetic-debt" } })).value;
  const failed = claimIdentityBootstrap(root, { ...credential, now: NOW });
  finishIdentityBootstrap(root, { credentialKey: credential.credentialKey, ...failed.value, now: NOW });
  let at = NOW + 60_000;
  const coordinator = createIdentityCoordinator({ host: "github.com", pathOptions, env: { GH_TOKEN: "synthetic-debt" }, now: () => at, requestIdentity: async () => proof() });
  assert.equal((await coordinator.refresh()).ok, true);
  const scope = createQuotaScope(coordinator.current(), { root, now: () => at });
  at = NOW + 16 * 60_000;
  let ledger = inspectGovernor(scope, at).value;
  assert.equal(ledger.reservations[`reservation:${failed.value.id}`].costs.core, 1);
  assert.equal(ledger.reservations[`reservation:${failed.value.id}`].accountedCosts.core, 0);
  at = NOW + 3_600_003;
  const leaseId = randomUUID();
  registerLease(scope, { id: leaseId, expiresAt: at + 90_000, floorMs: 5000, activeTab: "actions", phaseSeed: { seed: leaseId, registeredAt: at }, demand: { core: 1, graphql: 0 } });
  const claim = claimProbe(scope, leaseId, at);
  assert.equal(claim.value.status, "claimed");
  assert.equal(publishProbe(scope, leaseId, claim.value.nonce, {
    core: { source: "core-observer", budget: { limit: 5000, used: 1, remaining: 4999, resetMs: at + 3_600_000 } },
    graphql: { source: "rate-limit-probe", budget: { limit: 5000, used: 0, remaining: 5000, resetMs: at + 3_600_000 } },
  }, at).ok, true);
  ledger = inspectGovernor(scope, at).value;
  assert.equal(ledger.reservations[`reservation:${failed.value.id}`], undefined);
  assert.equal(inspectIdentityRegistry(root, { now: at }).value.attempts[failed.value.id], undefined);
  assert.equal((await coordinator.refresh()).ok, true);
  assert.equal(inspectGovernor(scope, at).value.reservations[`reservation:${failed.value.id}`], undefined);
  // Persisted application ledgers still use the existing strict validator.
  assert.equal(writeGovernorState(scope.path, ledger).ok, true);
});

test("configuration changes while local token resolution is pending cannot bind the wrong credential revision", async (t) => {
  const { root } = box(t);
  const env = { GH_CONFIG_DIR: root };
  let resolveToken;
  const pending = resolveEffectiveCredential({ host: "github.com", env, runLocalToken: () => new Promise((resolve) => { resolveToken = resolve; }) });
  writeFileSync(join(root, "hosts.yml"), "synthetic new account configuration", { mode: 0o600 });
  resolveToken("synthetic-old-token");
  assert.deepEqual(await pending, { ok: false, reason: "credential-changed" });
});

test("nonce-specific permit completion retries real lock contention without stealing a live owner", async (t) => {
  const { pathOptions } = box(t);
  let at = NOW;
  const coordinator = createIdentityCoordinator({ host: "github.com", pathOptions, env: { GH_TOKEN: "synthetic-one" }, now: () => at, requestIdentity: async () => proof() });
  await coordinator.refresh();
  at += 250;
  const permit = await acquireIdentityHttpPermit(coordinator, { now: () => at });
  const lock = join(coordinator.root, "registry.json.lock");
  writeFileSync(lock, JSON.stringify({ pid: process.pid, nonce: randomUUID() }), { flag: "wx", mode: 0o600 });
  const release = setTimeout(() => unlinkSync(lock), 350);
  t.after(() => clearTimeout(release));
  const result = await retryIdentityCompletion(() => releaseIdentityHttpPermit(coordinator, permit));
  assert.equal(result.ok, true);
  assert.equal(inspectIdentityRegistry(coordinator.root, { now: at }).value.hosts["github.com"].permit, null);
});

test("identity changes during delayed proof cannot persist a mapping under the old credential", async (t) => {
  const { pathOptions } = box(t);
  const env = { GH_TOKEN: "synthetic-before" };
  const old = (await resolveEffectiveCredential({ host: "github.com", env })).value;
  let resolveProof;
  const coordinator = createIdentityCoordinator({ host: "github.com", pathOptions, env, now: () => NOW,
    requestIdentity: () => new Promise((resolve) => { resolveProof = resolve; }) });
  const pending = coordinator.refresh();
  while (!resolveProof) await new Promise((resolve) => setImmediate(resolve));
  env.GH_TOKEN = "synthetic-after";
  resolveProof(proof(2));
  assert.equal((await pending).reason, "stale");
  const state = inspectIdentityRegistry(coordinator.root, { now: NOW }).value;
  assert.equal(state.identities[old.credentialKey], undefined);
  assert.equal(Object.values(state.attempts)[0].accounted, false);
  assert.equal(state.hosts["github.com"].permit, null);
});

test("deferred malformed completion is terminal storage work and does not prevent later refresh", async (t) => {
  const { pathOptions } = box(t);
  const coordinator = createIdentityCoordinator({ host: "github.com", pathOptions, env: { GH_TOKEN: "synthetic-one" }, now: () => NOW, requestIdentity: async () => proof() });
  let completed = 0;
  coordinator.deferCompletion("malformed-proof", () => { completed += 1; return { ok: false, reason: "identity-unavailable" }; });
  assert.equal((await coordinator.refresh()).ok, true);
  assert.equal((await coordinator.refresh()).ok, true);
  assert.equal(completed, 1);
});


test("proof completion rechecks configuration after waiting for the registry lock", async (t) => {
  const { pathOptions } = box(t);
  const env = { GH_TOKEN: "synthetic-before-lock" };
  const old = (await resolveEffectiveCredential({ host: "github.com", env })).value;
  let lock;
  const coordinator = createIdentityCoordinator({ host: "github.com", pathOptions, env, now: () => NOW,
    requestIdentity: async () => {
      lock = join(coordinator.root, "registry.json.lock");
      writeFileSync(lock, JSON.stringify({ pid: process.pid, nonce: randomUUID() }), { flag: "wx", mode: 0o600 });
      setTimeout(() => {
        env.GH_TOKEN = "synthetic-after-lock";
        unlinkSync(lock);
      }, 350);
      return proof();
    } });
  assert.equal((await coordinator.refresh()).reason, "stale");
  const state = inspectIdentityRegistry(coordinator.root, { now: NOW }).value;
  assert.equal(state.identities[old.credentialKey], undefined);
  assert.equal(Object.values(state.attempts)[0].accounted, false);
  assert.equal(state.hosts["github.com"].permit, null);
});

test("known deleted quota ledgers cannot be recreated by control start or settlement", async (t) => {
  const { pathOptions } = box(t);
  const coordinator = createIdentityCoordinator({ host: "github.com", pathOptions, env: { GH_TOKEN: "synthetic-one" }, now: () => NOW, requestIdentity: async () => proof() });
  assert.equal((await coordinator.refresh()).ok, true);
  const control = startIdentityControl(coordinator, NOW + 250);
  assert.equal(control.ok, true);
  const scope = createQuotaScope(coordinator.current(), { root: coordinator.root });
  unlinkSync(scope.path);
  assert.equal(startIdentityControl(coordinator, NOW + 500).reason, "corrupt");
  assert.equal(settleIdentityControl(coordinator, control.value, "", NOW + 500).reason, "corrupt");
  assert.throws(() => readFileSync(scope.path), { code: "ENOENT" });
});

test("a new credential cannot recreate its principal's known deleted ledger during debt transfer", async (t) => {
  const { pathOptions } = box(t);
  const first = createIdentityCoordinator({ host: "github.com", pathOptions, env: { GH_TOKEN: "synthetic-one" }, now: () => NOW, requestIdentity: async () => proof() });
  assert.equal((await first.refresh()).ok, true);
  const scope = createQuotaScope(first.current(), { root: first.root });
  unlinkSync(scope.path);
  const env = { GH_TOKEN: "synthetic-two" };
  const credential = (await resolveEffectiveCredential({ host: "github.com", env })).value;
  const second = createIdentityCoordinator({ host: "github.com", pathOptions, env, now: () => NOW + 250, requestIdentity: async () => proof() });
  assert.equal((await second.refresh()).reason, "corrupt");
  assert.equal(inspectIdentityRegistry(first.root, { now: NOW + 250 }).value.identities[credential.credentialKey], undefined);
  assert.throws(() => readFileSync(scope.path), { code: "ENOENT" });
});


test("a credential revision changed during bootstrap claim lock wait starts no obsolete HTTP request", async (t) => {
  const { pathOptions } = box(t);
  const root = identityRegistryRoot(pathOptions);
  const registryPath = join(root, "registry.json");
  const lock = `${registryPath}.lock`;
  const env = { GH_TOKEN: "synthetic-before-claim" };
  const old = (await resolveEffectiveCredential({ host: "github.com", env })).value;
  let injected = false;
  let requests = 0;
  const coordinator = createIdentityCoordinator({
    host: "github.com", pathOptions, env,
    now: () => {
      // The first registry transaction has completed; contend only the claim.
      if (!injected && existsSync(registryPath)) {
        injected = true;
        writeFileSync(lock, JSON.stringify({ pid: 99_999_999, nonce: randomUUID() }), { flag: "wx", mode: 0o600 });
      }
      return NOW;
    },
    kill: () => {
      env.GH_TOKEN = "synthetic-after-claim";
      unlinkSync(lock);
    },
    requestIdentity: async () => { requests += 1; return proof(2); },
  });
  assert.equal((await coordinator.refresh()).reason, "stale");
  assert.equal(injected, true);
  assert.equal(requests, 0);
  const registry = inspectIdentityRegistry(root, { now: NOW }).value;
  assert.equal(registry.identities[old.credentialKey], undefined);
  assert.equal(registry.hosts["github.com"].permit, null);
  assert.equal(Object.values(registry.attempts)[0].accounted, false);
});

test("startup can resolve cached identity without starting cold proof before the terminal mounts", async (t) => {
  const { pathOptions } = box(t);
  let requests = 0;
  const options = { host: "github.com", pathOptions, env: { GH_TOKEN: "synthetic-startup" }, now: () => NOW,
    requestIdentity: async () => { requests += 1; return proof(); } };
  const cold = createIdentityCoordinator(options);
  assert.equal((await cold.refresh({ allowBootstrap: false })).reason, "identity-unavailable");
  assert.equal(requests, 0);
  assert.equal(Object.keys(inspectIdentityRegistry(cold.root, { now: NOW }).value.attempts).length, 0);
  assert.equal((await cold.refresh()).ok, true);
  assert.equal(requests, 1);
  const warm = createIdentityCoordinator(options);
  assert.equal((await warm.refresh({ allowBootstrap: false })).ok, true);
  assert.equal(requests, 1);
  assert.equal(warm.current().accessKey, cold.current().accessKey);
});

test("closing the identity coordinator aborts in-flight proof and preserves conservative debt", async (t) => {
  const { pathOptions } = box(t);
  let observedSignal;
  const coordinator = createIdentityCoordinator({ host: "github.com", pathOptions,
    env: { GH_TOKEN: "synthetic-abort" }, now: () => NOW,
    requestIdentity: async (_host, { signal }) => {
      observedSignal = signal;
      return new Promise((resolve) => signal.addEventListener("abort", () => resolve(null), { once: true }));
    } });
  const pending = coordinator.refresh();
  while (!observedSignal) await new Promise((resolve) => setImmediate(resolve));
  coordinator.close();
  assert.equal(observedSignal.aborted, true);
  assert.equal((await pending).reason, "stale");
  const registry = inspectIdentityRegistry(coordinator.root, { now: NOW }).value;
  assert.equal(Object.keys(registry.identities).length, 0);
  assert.equal(Object.values(registry.attempts)[0].accounted, false);
  assert.equal(registry.hosts["github.com"].permit, null);
});


test("completion retry stops conservatively when its coordinator closes during contention", async (t) => {
  const { pathOptions } = box(t);
  const coordinator = createIdentityCoordinator({ host: "github.com", pathOptions, env: {} });
  let attempts = 0;
  const result = { ok: false, reason: "busy" };
  const pending = retryIdentityCompletion(() => { attempts += 1; return result; }, {
    shouldRetry: () => !coordinator.isClosed(),
  });
  coordinator.close();
  assert.equal(await pending, result);
  assert.equal(attempts, 1);
  const unwritable = { ok: false, reason: "unwritable" };
  assert.equal(await retryIdentityCompletion(() => { attempts += 1; return unwritable; }, {
    shouldRetry: () => !coordinator.isClosed(),
  }), unwritable);
  assert.equal(attempts, 2, "an already closed coordinator attempts settlement once without retrying");
});

test("a contended registry lock cannot retract a verified identity", async (t) => {
  const { pathOptions } = box(t);
  let at = NOW;
  const coordinator = createIdentityCoordinator({ host: "github.com", pathOptions, env: { GH_TOKEN: "synthetic-one" }, now: () => at, requestIdentity: async () => proof() });
  assert.equal((await coordinator.refresh()).ok, true);
  const verified = coordinator.current();
  assert.ok(verified);
  const lock = join(coordinator.root, "registry.json.lock");
  writeFileSync(lock, JSON.stringify({ pid: process.pid, nonce: randomUUID() }), { flag: "wx", mode: 0o600 });
  t.after(() => { if (existsSync(lock)) unlinkSync(lock); });
  at += 250;
  const contended = await coordinator.refresh();
  assert.equal(contended.ok, false);
  // The lock says the registry was unreadable for 250 ms, not that the account
  // changed. Retracting the identity here retires the lease and clears every
  // retained row and validator, so the recovery round pays full price.
  assert.deepEqual(coordinator.current(), verified);
});

test("permit acquisition waits through registry contention instead of failing the request", async (t) => {
  const { pathOptions } = box(t);
  let at = NOW;
  const coordinator = createIdentityCoordinator({ host: "github.com", pathOptions, env: { GH_TOKEN: "synthetic-one" }, now: () => at, requestIdentity: async () => proof() });
  await coordinator.refresh();
  at += 250;
  const lock = join(coordinator.root, "registry.json.lock");
  writeFileSync(lock, JSON.stringify({ pid: process.pid, nonce: randomUUID() }), { flag: "wx", mode: 0o600 });
  const release = setTimeout(() => { if (existsSync(lock)) unlinkSync(lock); }, 400);
  t.after(() => { clearTimeout(release); if (existsSync(lock)) unlinkSync(lock); });
  const permit = await acquireIdentityHttpPermit(coordinator, { now: () => at });
  assert.ok(permit.nonce);
  assert.equal(releaseIdentityHttpPermit(coordinator, permit).ok, true);
});

test("an unreadable registry is retryable rather than reported as corruption", async (t) => {
  const { pathOptions } = box(t);
  let at = NOW;
  const coordinator = createIdentityCoordinator({ host: "github.com", pathOptions, env: { GH_TOKEN: "synthetic-one" }, now: () => at, requestIdentity: async () => proof() });
  await coordinator.refresh();
  const path = join(coordinator.root, "registry.json");
  rmSync(path);
  mkdirSync(path);
  // corrupt is terminal -- it is not retried and it tells the user their
  // coordination state is unavailable. An I/O error is neither of those things.
  const inspected = inspectIdentityRegistry(coordinator.root, { now: at });
  assert.equal(inspected.ok, false);
  assert.equal(inspected.reason, "unwritable");
});

test("failed bootstraps retire once their window and backoff pass so the registry cannot wedge", (t) => {
  const { pathOptions } = box(t);
  const root = identityRegistryRoot(pathOptions);
  const credentialKey = "b".repeat(64);
  let at = NOW;
  for (let index = 0; index < 3; index += 1) {
    const claim = claimIdentityBootstrap(root, { host: "github.com", credentialKey, now: at });
    assert.equal(claim.ok, true);
    assert.equal(finishIdentityBootstrap(root, { credentialKey, ...claim.value, response: { body: {} }, now: at }).ok, false);
    at += 60_000 * 2 ** index;
  }
  assert.equal(Object.keys(inspectIdentityRegistry(root, { now: at }).value.attempts).length, 3);
  // A bootstrap that never proved a principal owns no ledger receipt, so past
  // its rolling window and its backoff there is nothing left to forgive. These
  // used to accumulate at roughly a thousand a day behind a captive portal or an
  // SSO-blocked org until IDENTITY_MAX_ATTEMPTS wedged bootstrap for good, with
  // deleting registry.json by hand as the only recovery.
  at = NOW + 15 * 60_000 + 180_001;
  const recovered = claimIdentityBootstrap(root, { host: "github.com", credentialKey, now: at });
  assert.equal(recovered.ok, true);
  assert.equal(Object.keys(inspectIdentityRegistry(root, { now: at }).value.attempts).length, 1);
});

test("a permit outliving the request it guards is reclaimed from a live owner", async (t) => {
  const { pathOptions } = box(t);
  let at = NOW;
  const coordinator = createIdentityCoordinator({ host: "github.com", pathOptions, env: { GH_TOKEN: "synthetic-one" }, now: () => at, requestIdentity: async () => proof() });
  await coordinator.refresh();
  at += 250;
  const held = await acquireIdentityHttpPermit(coordinator, { now: () => at });
  assert.ok(held.nonce);
  // The owner is this very process, so the dead-PID check can never reclaim it.
  // Without an age bound one stopped pane holds the single machine-wide permit
  // and every other pane queues behind it forever.
  at += 35_001;
  const next = await acquireIdentityHttpPermit(coordinator, { now: () => at });
  assert.notEqual(next.nonce, held.nonce);
  assert.equal(inspectIdentityRegistry(coordinator.root, { now: at }).value.hosts["github.com"].permit.nonce, next.nonce);
});

test("a receipt orphaned by an interrupted mapping is reclaimed when the credential bootstraps again", async (t) => {
  const { pathOptions } = box(t);
  let at = NOW;
  const first = createIdentityCoordinator({ host: "github.com", pathOptions, env: { GH_TOKEN: "synthetic-one" }, now: () => at, requestIdentity: async () => proof() });
  assert.equal((await first.refresh()).ok, true);
  const scope = createQuotaScope(first.current(), { root: first.root, now: () => at });
  // Written straight to the ledger file, because this is a state no API can
  // produce: exactly what importIdentityDebts leaves behind when a crash lands
  // between its ledger write and the registry transaction recording the
  // mapping -- a charged receipt whose attempt exists nowhere in the registry.
  const disk = JSON.parse(readFileSync(scope.path, "utf8"));
  const template = Object.values(disk.reservations)[0];
  assert.ok(template, "the proof reservation should already be recorded");
  const orphanId = randomUUID();
  disk.reservations[`reservation:${orphanId}`] = {
    ...template, leaseId: orphanId, intentId: orphanId,
    notBefore: NOW - 7_200_000, startedAt: NOW - 7_200_000,
  };
  writeFileSync(scope.path, JSON.stringify(disk), { mode: 0o600 });
  assert.ok(inspectGovernor(scope, at).value.reservations[`reservation:${orphanId}`], "orphan setup failed");
  at += 250;
  const second = createIdentityCoordinator({ host: "github.com", pathOptions, env: { GH_TOKEN: "synthetic-two" }, now: () => at, requestIdentity: async () => proof() });
  assert.equal((await second.refresh()).ok, true);
  assert.equal(first.current().quotaKey, second.current().quotaKey);
  // Otherwise it presents only as a permanently smaller budget, forever.
  assert.equal(inspectGovernor(scope, at).value.reservations[`reservation:${orphanId}`], undefined);
});

test("ID-02 the same verified principal on two hosts stays in separate quota and access scopes", (t) => {
  const { pathOptions } = box(t);
  const root = identityRegistryRoot(pathOptions);
  const map = (host, credentialKey) => {
    const claim = claimIdentityBootstrap(root, { host, credentialKey, now: NOW });
    assert.equal(claim.ok, true);
    const ended = finishIdentityBootstrap(root, { credentialKey, ...claim.value, response: proof(7), now: NOW });
    assert.equal(ended.ok, true);
    return ended.value;
  };
  // Same numeric account ID on two hosts is a different principal, not a shared
  // one: github.com account 7 and an enterprise account 7 are unrelated, and
  // letting them share a ledger would spend one account's budget for the other.
  const dotcom = map("github.com", "c".repeat(64));
  const enterprise = map("enterprise.example", "d".repeat(64));
  assert.equal(dotcom.id, enterprise.id);
  assert.notEqual(dotcom.quotaKey, enterprise.quotaKey);
  assert.notEqual(dotcom.accessKey, enterprise.accessKey);
});

test("ID-05 an unknown legacy protocol version fails closed without rewriting its evidence", (t) => {
  const { pathOptions } = box(t);
  const root = identityRegistryRoot(pathOptions);
  mkdirSync(root, { recursive: true });
  const legacy = join(root, "..", `rate-governor-v1-${"e".repeat(64)}.json`);
  // A version this build has never seen. It cannot be normalized and it cannot
  // be migrated, so the only safe reading is that unknown spend may be
  // outstanding -- never that the file is meaningless and can be ignored.
  const evidence = JSON.stringify({ version: 3, budgets: { core: { limit: 5000, remaining: 10 } } });
  writeFileSync(legacy, evidence, { mode: 0o600 });
  const claimed = claimIdentityBootstrap(root, { host: "github.com", credentialKey: "e".repeat(64), now: NOW });
  assert.equal(claimed.ok, false);
  assert.equal(claimed.reason, "legacy-corrupt");
  assert.equal(readFileSync(legacy, "utf8"), evidence);
  assert.equal(Object.keys(inspectIdentityRegistry(root, { now: NOW }).value.attempts).length, 0);
});
