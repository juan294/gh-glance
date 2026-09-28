import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync, unlinkSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import {
  retryIdentityCompletion, createSettlementContext, registerLease, registerIntent, startReservation, settleReservationWithBudgetObservations,
  claimProbe, publishProbe, writeGovernorState, startIdentityControl, settleIdentityControl,
  writeGovernorQuotaState,
  resolveEffectiveCredential, createIdentityCoordinator, inspectIdentityRegistry,
  identityRegistryRoot, claimIdentityBootstrap, finishIdentityBootstrap, createQuotaScope,
  inspectGovernor, acquireIdentityHttpPermit, releaseIdentityHttpPermit,
  runAdmittedOperation, runGh, pauseOperation,
  recoveryCause, presentRecovery,
  GOVERNOR_PROBE_LEASE_MS,
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
  assert.equal(Object.keys(ledger.value.reservations).length, 0);
  assert.equal(ledger.value.debt.core.unresolvedUnits, 0,
    "two proven identity requests do not leave uncertain quota debt");
  assert.equal(ledger.value.observers.core.etag, '"identity-v1"');
});

test("a core observer rejected before spawn releases its control receipt without HTTP", async (t) => {
  const { pathOptions } = box(t);
  let at = NOW;
  const coordinator = createIdentityCoordinator({ host: "github.com", pathOptions,
    env: { GH_TOKEN: "observer-pre-spawn" }, now: () => at,
    requestIdentity: async () => proof() });
  t.after(() => coordinator.close());
  assert.equal((await coordinator.refresh()).ok, true);
  at += 1_000;
  const scope = { ...createQuotaScope(coordinator.current(), { root: coordinator.root, now: () => at }),
    identityCoordinator: coordinator, accessKey: coordinator.current().accessKey };
  const leaseId = randomUUID();
  assert.equal(registerLease(scope, { id: leaseId, expiresAt: at + 60_000,
    floorMs: 5_000, activeTab: "actions", phaseSeed: { seed: leaseId, registeredAt: at },
    demand: { core: 1, graphql: 0 } }, at).ok, true);
  const undoPause = pauseOperation("budget-core-observer", Date.now() + 10_000);
  t.after(undoPause);
  let http = 0;
  const result = await runAdmittedOperation({
    scope, leaseId, operation: "budget-core-observer", now: () => at,
    waitMs: 5_000, wait: async (ms) => { at += ms + 1; return true; },
    run: () => runGh(["api", "user"], { operation: "budget-core-observer",
      execute: () => { http += 1; return Promise.resolve({ stdout: "{}" }); } }),
  });
  assert.equal(result.ok, false);
  assert.equal(http, 0);
  const ledger = inspectGovernor(scope, at).value;
  assert.equal(ledger.controlReceipts.core, null);
  assert.equal(ledger.debt.core.unresolvedUnits, 0);
  assert.equal(ledger.reservations[result.reservationId].actualCosts.core, 0);
  const attempts = Object.values(inspectIdentityRegistry(coordinator.root, { now: at }).value.attempts);
  assert.ok(attempts.some((attempt) => attempt.status === "finished" && attempt.accounted));
});

test("a failed closed core observer keeps its cost and frees the retry slot", async (t) => {
  const { pathOptions } = box(t);
  const coordinator = createIdentityCoordinator({ host: "github.com", pathOptions,
    env: { GH_TOKEN: "failed-core-control" }, now: () => NOW,
    requestIdentity: async () => proof() });
  t.after(() => coordinator.close());
  assert.equal((await coordinator.refresh()).ok, true);
  const firstAt = NOW + 1_000;
  const first = startIdentityControl(coordinator, firstAt);
  assert.equal(first.ok, true);
  const scope = createQuotaScope(coordinator.current(), { root: coordinator.root });
  const started = inspectGovernor(scope, firstAt).value;
  started.controlReceipts.core.receipt.dispatches = [{ sequence: 1,
    operation: "budget-core-observer", costs: { core: 1, graphql: 0 }, issuedAt: firstAt,
    terminalAt: firstAt + 1, childPid: process.pid, childBirth: null, neverStarted: false }];
  assert.equal(writeGovernorQuotaState(scope.path, started, firstAt + 1).ok, true);
  const settled = settleIdentityControl(coordinator, first.value, "", firstAt + 1);
  assert.equal(settled.ok, true);
  const ledger = inspectGovernor(scope, firstAt + 1).value;
  assert.equal(ledger.controlReceipts.core, null);
  assert.equal(ledger.debt.core.unresolvedUnits + ledger.debt.core.quiescentUnits, 1);
  const retry = startIdentityControl(coordinator, firstAt + 60_001);
  assert.equal(retry.ok, true);
});

test("a crashed core observer retains its issued charge when a later claim starts", async (t) => {
  const { pathOptions } = box(t);
  const coordinator = createIdentityCoordinator({ host: "github.com", pathOptions,
    env: { GH_TOKEN: "crashed-core-control" }, now: () => NOW,
    requestIdentity: async () => proof() });
  t.after(() => coordinator.close());
  assert.equal((await coordinator.refresh()).ok, true);
  const firstAt = NOW + 1_000;
  const first = startIdentityControl(coordinator, firstAt);
  assert.equal(first.ok, true);
  const scope = createQuotaScope(coordinator.current(), { root: coordinator.root });
  const issued = inspectGovernor(scope, firstAt).value;
  issued.controlReceipts.core.receipt.dispatches = [{ sequence: 1,
    operation: "budget-core-observer", costs: { core: 1, graphql: 0 }, issuedAt: firstAt,
    terminalAt: null, childPid: process.pid, childBirth: null, neverStarted: false }];
  assert.equal(writeGovernorQuotaState(scope.path, issued, firstAt).ok, true);
  const takeoverAt = firstAt + GOVERNOR_PROBE_LEASE_MS + 1;
  const second = startIdentityControl(coordinator, takeoverAt);
  assert.equal(second.ok, true);
  assert.notEqual(second.value.id, first.value.id);
  const ledger = inspectGovernor(scope, takeoverAt).value;
  assert.equal(ledger.debt.core.unresolvedUnits, 1);
  assert.equal(ledger.controlReceipts.core.intentId, second.value.id);
  assert.equal(settleIdentityControl(coordinator, first.value, "", takeoverAt).reason, "stale");
});

test("an invalid control ETag cannot replace a valid quota ledger", async (t) => {
  const { pathOptions } = box(t);
  const first = createIdentityCoordinator({ host: "github.com", pathOptions,
    env: { GH_TOKEN: "valid-etag-credential" }, now: () => NOW,
    requestIdentity: async () => proof() });
  t.after(() => first.close());
  assert.equal((await first.refresh()).ok, true);
  const scope = createQuotaScope(first.current(), { root: first.root, now: () => NOW });
  const before = readFileSync(scope.path);
  const invalid = structuredClone(inspectGovernor(scope, NOW).value);
  invalid.observers.core.etag = "x".repeat(600);
  const rejected = writeGovernorQuotaState(scope.path, invalid, NOW);
  assert.equal(rejected.ok, false);
  assert.equal(rejected.reason, "corrupt");
  assert.deepEqual(readFileSync(scope.path), before);
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
  const current = structuredClone(inspectGovernor(scope, NOW).value);
  for (const budget of Object.values(current.budgets)) {
    delete budget.source; delete budget.factorBaseline; delete budget.knownLocalUsed;
  }
  current.budgets.core.blockUntil = NOW + 120_000;
  current.budgets.core.blockReason = "secondary-rate-limit";
  // The v1 document is spelled out rather than derived from the current one:
  // one claim covering both resources, a separately shaped probeOutcome and no
  // per-resource observers. Deriving it would let it silently track whatever
  // shape the governor writes today, which is the opposite of pinning it.
  const legacy = {
    version: 1,
    epochs: current.epochs,
    budgets: current.budgets,
    probeClaim: null,
    probeOutcome: { status: "idle", at: 0, nextAt: 0 },
    leases: {},
    intents: {},
    reservations: {},
    manualProbe: null,
  };
  const path = join(coordinator.root, "..", `rate-governor-v1-${"a".repeat(64)}.json`);
  const raw = JSON.stringify(legacy);
  writeFileSync(path, raw, { mode: 0o600 });
  const denied = claimIdentityBootstrap(coordinator.root, { credentialKey: "c".repeat(64), host: "github.com", now: NOW + 250 });
  assert.equal(denied.reason, "migration-hold");
  assert.equal(denied.retryAt, NOW + 120_000);
  const waiting = createIdentityCoordinator({ host: "github.com", pathOptions,
    env: { GH_TOKEN: "synthetic-other" }, now: () => NOW + 250,
    requestIdentity: async () => proof() });
  const waited = await waiting.refresh();
  assert.equal(waited.reason, "migration-hold");
  assert.equal(waiting.inspect().retryAt, denied.retryAt);
  const visible = presentRecovery(recoveryCause({ reason: waited.reason, resource: "core",
    at: NOW + 250, retryAt: waiting.inspect().retryAt }), { nowMs: NOW + 250, cols: 80 });
  assert.match(visible.join(" "), /Wait for the older quota reset.*next/i);
  assert.doesNotMatch(visible.join(" "), /Restart older/);
  waiting.close();
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

test("ID-07 uncertain bootstrap debt transfers once and survives epoch refresh without quiescence", async (t) => {
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
  assert.equal(ledger.debt.core.unresolvedUnits, 1);
  assert.equal(ledger.debt.core.unresolvedCount, 1);
  at = NOW + 3_600_003;
  const leaseId = randomUUID();
  registerLease(scope, { id: leaseId, expiresAt: at + 90_000, floorMs: 5000, activeTab: "actions", phaseSeed: { seed: leaseId, registeredAt: at }, demand: { core: 1, graphql: 0 } });
  const claim = claimProbe(scope, leaseId, at, "core");
  assert.equal(claim.value.status, "claimed");
  assert.equal(publishProbe(scope, leaseId, claim.value.nonce, {
    core: { source: "core-observer", budget: { limit: 5000, used: 1, remaining: 4999, resetMs: at + 3_600_000 } },
    graphql: { source: "graphql-observer", budget: { limit: 5000, used: 0, remaining: 5000, resetMs: at + 3_600_000 } },
  }, at, "core").ok, true);
  ledger = inspectGovernor(scope, at).value;
  assert.equal(ledger.debt.core.unresolvedUnits, 1,
    "a fresh observer cannot prove that an old child is quiescent");
  assert.equal(inspectIdentityRegistry(root, { now: at }).value.attempts[failed.value.id], undefined);
  assert.equal((await coordinator.refresh()).ok, true);
  assert.equal(inspectGovernor(scope, at).value.debt.core.unresolvedUnits, 1);
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

test("a quota import marker prevents double charge when registry persistence is replayed", async (t) => {
  const { pathOptions } = box(t);
  let at = NOW;
  const first = createIdentityCoordinator({ host: "github.com", pathOptions, env: { GH_TOKEN: "synthetic-one" }, now: () => at, requestIdentity: async () => proof() });
  assert.equal((await first.refresh()).ok, true);
  const scope = createQuotaScope(first.current(), { root: first.root, now: () => at });
  const secondCredential = (await resolveEffectiveCredential({ host: "github.com",
    env: { GH_TOKEN: "synthetic-two" } })).value;
  at += 250;
  const failed = claimIdentityBootstrap(first.root, { ...secondCredential, now: at });
  assert.equal(failed.ok, true);
  assert.equal(finishIdentityBootstrap(first.root, { credentialKey: secondCredential.credentialKey,
    ...failed.value, now: at }).ok, false);
  at += 120_000;
  const successful = claimIdentityBootstrap(first.root, { ...secondCredential, now: at });
  assert.equal(successful.ok, true);
  assert.equal(finishIdentityBootstrap(first.root, { credentialKey: secondCredential.credentialKey,
    ...successful.value, response: proof(), now: at }).ok, true);
  const before = inspectGovernor(scope, at).value;
  assert.equal(before.debt.core.unresolvedUnits, 1);
  assert.equal(before.importMarkers[failed.value.id], true);

  // Recreate the quota-write/registry-write crash boundary. The quota marker
  // survived, while the registry attempt still appears unimported.
  const registryPath = join(first.root, "registry.json");
  const registry = JSON.parse(readFileSync(registryPath, "utf8"));
  registry.attempts[failed.value.id].imported = false;
  registry.attempts[failed.value.id].quotaKey = null;
  writeFileSync(registryPath, `${JSON.stringify(registry)}\n`, { mode: 0o600 });
  at += 1;
  assert.equal(finishIdentityBootstrap(first.root, { credentialKey: secondCredential.credentialKey,
    ...successful.value, response: proof(), now: at }).ok, true);
  const after = inspectGovernor(scope, at).value;
  assert.equal(after.debt.core.unresolvedUnits, 1, "replay cannot add a second charge");
  assert.equal(inspectIdentityRegistry(first.root, { now: at }).value.attempts[failed.value.id].imported, true);
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

test("ID-05 a v1 ledger with uncertain GraphQL charges clears once its window is past", async (t) => {
  const { pathOptions } = box(t);
  const coordinator = createIdentityCoordinator({ host: "github.com", pathOptions, env: { GH_TOKEN: "synthetic-one" }, now: () => NOW, requestIdentity: async () => proof() });
  await coordinator.refresh();
  // Both windows ended hours ago, which is the whole point: there is nothing
  // left to wait for. Written in the v1 shape by hand -- v1 budgets predate
  // source, factorBaseline and knownLocalUsed.
  const ended = NOW - 4 * 3_600_000;
  const v1Budget = (resetMs) => ({
    limit: 5000, remaining: 4000, used: 1000, resetMs, observedAt: NOW - 5 * 3_600_000,
    blockUntil: null, blockReason: null, laneNextAt: NOW - 5 * 3_600_000,
    roundRobinCursor: null, lastExternalFactor: 1, epoch: `5000:${resetMs}`,
  });
  const current = {
    epochs: { core: `5000:${ended}`, graphql: `5000:${ended}` },
    budgets: { core: v1Budget(ended), graphql: v1Budget(ended) },
  };
  const leaseId = randomUUID();
  const legacy = {
    version: 1,
    epochs: current.epochs,
    budgets: current.budgets,
    probeClaim: null,
    probeOutcome: { status: "idle", at: 0, nextAt: 0 },
    leases: {},
    intents: {},
    // An uncertain charge against GraphQL. v1 migration drops both budgets, and
    // only core was ever reconstructed, so this asked a budget that no longer
    // existed for its reset and got legacy-unresolved -- a hold with no deadline,
    // which never cleared on any later launch.
    reservations: {
      [`reservation:${leaseId}`]: {
        leaseId, intentId: leaseId, costs: { core: 0, graphql: 2 },
        actualCosts: null, accountedCosts: { core: 0, graphql: 0 },
        notBefore: NOW - 5 * 3_600_000, status: "started",
        epochs: { core: null, graphql: null },
        startedAt: NOW - 5 * 3_600_000, completedAt: null, outcome: null,
      },
    },
    manualProbe: null,
  };
  writeFileSync(join(coordinator.root, "..", `rate-governor-v1-${"d".repeat(64)}.json`),
    JSON.stringify(legacy), { mode: 0o600 });

  const claimed = claimIdentityBootstrap(coordinator.root, { credentialKey: "e".repeat(64), host: "github.com", now: NOW + 250 });
  assert.notEqual(claimed.reason, "legacy-unresolved",
    "a past window must not hold admission open-endedly");
  assert.notEqual(claimed.reason, "migration-hold",
    `the window ended hours ago: retryAt ${claimed.retryAt}`);
});

test("ID-06 a ledger with no budget for a charged resource dates the charge by its own epoch", async (t) => {
  const { pathOptions } = box(t);
  const coordinator = createIdentityCoordinator({ host: "github.com", pathOptions, env: { GH_TOKEN: "synthetic-one" }, now: () => NOW, requestIdentity: async () => proof() });
  await coordinator.refresh();
  // A v2 file whose panes only ever observed GraphQL: a graphql budget, no
  // core budget at all, and started reservations that charged core anyway.
  // Neither the migrated view nor the raw file has a core reset to wait for,
  // but every reservation names the core epoch it was admitted against, and
  // that window ended hours ago.
  const ended = NOW - 4 * 3_600_000;
  const leaseId = randomUUID();
  const legacy = {
    version: 2,
    epochs: { core: null, graphql: `5000:${ended}` },
    budgets: {
      graphql: {
        limit: 5000, remaining: 5000, used: 0, resetMs: ended, observedAt: NOW - 5 * 3_600_000,
        blockUntil: null, blockReason: null, laneNextAt: NOW - 5 * 3_600_000, roundRobinCursor: null,
        lastExternalFactor: 1, epoch: `5000:${ended}`, source: "rate-limit-probe",
        factorBaseline: { epoch: `5000:${ended}`, used: 0, observedAt: NOW - 5 * 3_600_000 }, knownLocalUsed: 0,
      },
    },
    // The pre-split observer shape a real 0.12 file carries; without it the
    // v2 reader rejects the document and the fixture stops being that file.
    observers: { core: { etag: null, outcome: "idle", at: 0, nextAt: 0 } },
    probeClaim: null,
    probeOutcome: { status: "idle", at: 0, nextAt: 0 },
    leases: {},
    intents: {},
    reservations: {
      [`reservation:${leaseId}`]: {
        leaseId, intentId: leaseId, costs: { core: 2, graphql: 0 },
        actualCosts: null, accountedCosts: { core: 0, graphql: 0 },
        notBefore: NOW - 5 * 3_600_000, status: "started",
        epochs: { core: `5000:${ended}`, graphql: null },
        startedAt: NOW - 5 * 3_600_000, completedAt: null, outcome: null,
      },
    },
    manualProbe: null,
  };
  writeFileSync(join(coordinator.root, "..", `rate-governor-v1-${"f".repeat(64)}.json`),
    JSON.stringify(legacy), { mode: 0o600 });

  const claimed = claimIdentityBootstrap(coordinator.root, { credentialKey: "e".repeat(64), host: "github.com", now: NOW + 250 });
  assert.notEqual(claimed.reason, "legacy-unresolved",
    "a reservation that names its own epoch is not undated");
  assert.notEqual(claimed.reason, "migration-hold",
    `the reservation's window ended hours ago: retryAt ${claimed.retryAt}`);
});
