import assert from "node:assert/strict";
import fs from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { EventEmitter } from "node:events";
import { randomUUID } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
  acquireIdentityHttpPermit, releaseIdentityHttpPermit, createIdentityCoordinator,
  inspectIdentityRegistry, claimIdentityBootstrap, createQuotaScope,
  requestFailureRecoveryCode, acquisitionFailureHold,
  requestFailureRecovery, recoveryCause, shouldClearRecoveryCause,
  registerLease, runAdmittedOperation, runGh, inspectGovernor, doctorCachedQuotaScope,
} from "../index.mjs";

const NOW = 1_800_000_000_000;
const pause = () => new Promise((resolve) => setTimeout(resolve, 5));
async function until(predicate) {
  const deadline = performance.now() + 2000;
  while (!predicate()) {
    assert.ok(performance.now() < deadline, "transport evidence did not arrive");
    await pause();
  }
}
async function fixture(t, { occupied = false } = {}) {
  const root = mkdtempSync(join(tmpdir(), "glance-transport-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const env = { GH_TOKEN: "synthetic-fifo" };
  const coordinator = createIdentityCoordinator({
    host: "github.com", pathOptions: { env: { XDG_CONFIG_HOME: root } }, env, now: () => occupied ? NOW - 1_000 : NOW,
    requestIdentity: async () => ({ body: { id: 1, login: "fixture" }, rateLimit: {
      resource: "core", limit: 5000, used: 1, remaining: 4999, resetMs: NOW + 3_600_000,
    } }),
  });
  assert.equal((await coordinator.refresh()).ok, true);
  t.after(() => coordinator.close());
  if (occupied) {
    for (const at of [NOW - 750, NOW - 500]) {
      await acquireIdentityHttpPermit(coordinator, { now: () => at });
    }
  }
  const read = (now = NOW) => inspectIdentityRegistry(coordinator.root, { now }).value.hosts["github.com"];
  return { coordinator, env, read };
}

test("HTTP FIFO keeps an earlier call ahead when a later caller polls the open gap first", async (t) => {
  const { coordinator, read } = await fixture(t);
  let firstAt = NOW;
  const first = acquireIdentityHttpPermit(coordinator, { now: () => firstAt });
  await until(() => read().waiters.length === 1);
  let laterStarted = false;
  const later = acquireIdentityHttpPermit(coordinator, { now: () => NOW + 500 })
    .then((permit) => { laterStarted = true; return permit; });
  await until(() => read().waiters.length === 2);
  assert.equal(laterStarted, false, "later ready caller passed the earlier waiter");
  assert.equal(read().permits.length, 0);
  firstAt = NOW + 250;
  const firstPermit = await first;
  assert.equal(laterStarted, false);
  assert.equal(releaseIdentityHttpPermit(coordinator, firstPermit).ok, true);
  const laterPermit = await later;
  assert.notEqual(laterPermit.nonce, firstPermit.nonce);
  assert.equal(read().waiters.length, 0);
  releaseIdentityHttpPermit(coordinator, laterPermit);
});

test("aborting one queued call retains its sibling, the live permit, and bootstrap ordering", async (t) => {
  const { coordinator, read } = await fixture(t, { occupied: true });
  const live = await acquireIdentityHttpPermit(coordinator, { now: () => NOW + 250 });
  const abort = new AbortController();
  const cancelled = acquireIdentityHttpPermit(coordinator, { now: () => NOW + 500, signal: abort.signal });
  const rejected = assert.rejects(cancelled, /cancelled/);
  await until(() => read().waiters.length === 1);
  const survivor = acquireIdentityHttpPermit(coordinator, { now: () => NOW + 500 });
  await until(() => read().waiters.length === 2);
  const survivorNonce = read().waiters[1].nonce;
  abort.abort();
  await rejected;
  assert.deepEqual(read().waiters.map((waiter) => waiter.nonce), [survivorNonce]);
  assert.equal(read().permits.at(-1).nonce, live.nonce);
  releaseIdentityHttpPermit(coordinator, live);
  const bootstrap = claimIdentityBootstrap(coordinator.root, {
    credentialKey: "a".repeat(64), host: "github.com", now: NOW + 500,
  });
  assert.equal(bootstrap.reason, "identity-busy");
  const permit = await survivor;
  assert.equal(permit.nonce, survivorNonce);
  releaseIdentityHttpPermit(coordinator, permit);
});

test("dead and expired waiters retire without clearing a live permit or quota evidence", async (t) => {
  const { coordinator } = await fixture(t, { occupied: true });
  const live = await acquireIdentityHttpPermit(coordinator, { now: () => NOW + 250 });
  const path = join(coordinator.root, "registry.json");
  const state = JSON.parse(readFileSync(path, "utf8"));
  const waiters = [
    { pid: 1234567, nonce: randomUUID(), queuedAt: NOW, deadline: NOW + 30_000 },
    { pid: process.pid, nonce: randomUUID(), queuedAt: NOW - 30_000, deadline: NOW },
    { pid: process.pid, nonce: randomUUID(), queuedAt: NOW, deadline: NOW + 30_000 },
  ];
  state.hosts["github.com"].waiters = waiters;
  writeFileSync(path, JSON.stringify(state));
  const quota = createQuotaScope(coordinator.current(), { root: coordinator.root });
  const before = readFileSync(quota.path, "utf8");
  const inspected = inspectIdentityRegistry(coordinator.root, { now: NOW + 250, kill: (pid) => {
    if (pid === 1234567) throw Object.assign(new Error("dead fixture"), { code: "ESRCH" });
  } });
  assert.equal(inspected.ok, true);
  assert.deepEqual(inspected.value.hosts["github.com"].waiters, [waiters[2]]);
  assert.equal(inspected.value.hosts["github.com"].permits.at(-1).nonce, live.nonce);
  assert.equal(readFileSync(quota.path, "utf8"), before);
});

test("queue capacity and malformed waiter state fail closed without taking a permit", async (t) => {
  const { coordinator } = await fixture(t);
  const path = join(coordinator.root, "registry.json");
  const state = JSON.parse(readFileSync(path, "utf8"));
  const host = state.hosts["github.com"];
  host.waiters = Array.from({ length: 128 }, () => ({
    pid: process.pid, nonce: randomUUID(), queuedAt: NOW, deadline: NOW + 30_000,
  }));
  writeFileSync(path, JSON.stringify(state));
  await assert.rejects(acquireIdentityHttpPermit(coordinator, { now: () => NOW + 250 }));
  let observed = JSON.parse(readFileSync(path, "utf8"));
  assert.equal(observed.hosts["github.com"].waiters.length, 128);
  assert.equal(observed.hosts["github.com"].permits.length, 0);
  host.waiters[0].deadline = NOW + 30_001;
  writeFileSync(path, JSON.stringify(state));
  assert.equal(inspectIdentityRegistry(coordinator.root, { now: NOW }).reason, "corrupt");
  observed = JSON.parse(readFileSync(path, "utf8"));
  assert.equal(observed.hosts["github.com"].waiters[0].deadline, NOW + 30_001);
});

for (const exit of ["timeout", "credential change"]) {
  test(`${exit} removes only the queued call and preserves the live permit`, async (t) => {
    const { coordinator, env, read } = await fixture(t, { occupied: true });
    const live = await acquireIdentityHttpPermit(coordinator, { now: () => NOW + 250 });
    let at = NOW + 250;
    const pending = acquireIdentityHttpPermit(coordinator, { now: () => at });
    const rejected = assert.rejects(pending, exit === "timeout" ? /Shared HTTP/ : /Credential changed/);
    await until(() => read().waiters.length === 1);
    if (exit === "timeout") at += 30_000;
    else env.GH_TOKEN = "synthetic-replacement";
    await rejected;
    assert.equal(read(at).waiters.length, 0);
    assert.equal(read(at).permits.at(-1).nonce, live.nonce);
    assert.equal(readFileSync(join(coordinator.root, "registry.json"), "utf8").includes("synthetic-"), false);
  });
}

for (const [boundary, elapsedMs] of [["elapsed deadline", 30_000], ["retry deadline", 29_975]]) {
  test(`HTTP permit ${boundary} preserves its local coordination cause`, async (t) => {
    const { coordinator, read } = await fixture(t, { occupied: true });
    const live = await acquireIdentityHttpPermit(coordinator, { now: () => NOW + 250 });
    const quota = createQuotaScope(coordinator.current(), { root: coordinator.root });
    const quotaBefore = readFileSync(quota.path, "utf8");
    const queuedAt = NOW + 500;
    let at = queuedAt;
    let waits = 0;
    let failure;
    await assert.rejects(acquireIdentityHttpPermit(coordinator, {
      now: () => at,
      wait: async () => { waits += 1; at = queuedAt + elapsedMs; },
    }), (error) => { failure = error; return true; });
    assert.equal(waits, 1);
    assert.equal(read(at).waiters.length, 0);
    assert.equal(read(at).permits.at(-1).nonce, live.nonce);
    assert.equal(readFileSync(quota.path, "utf8"), quotaBefore);
    assert.equal(failure.coordinationReason, "transport-busy");
    assert.equal(requestFailureRecoveryCode(failure, "other"), "transport-busy");
    assert.equal(acquisitionFailureHold(failure), "coordination");
    const recovery = requestFailureRecovery(failure, "other");
    const cause = recoveryCause({ ...recovery, resource: "core", tab: "actions", at });
    assert.equal(cause.origin, "coordination");
    assert.equal(shouldClearRecoveryCause(cause, { sourceSuccess: false, tab: "security" }), true,
      "shared coordination recovery must clear without an Actions source success");
  });
}

test("HTTP permit throttle pause retains its rate-limit cause", async (t) => {
  const { coordinator } = await fixture(t);
  const path = join(coordinator.root, "registry.json");
  const state = JSON.parse(readFileSync(path, "utf8"));
  state.hosts["github.com"].throttle = { attempts: 5, lastAt: NOW, paused: true };
  state.hosts["github.com"].cooldownUntil = NOW + 60_000;
  writeFileSync(path, JSON.stringify(state));
  let failure;
  await assert.rejects(acquireIdentityHttpPermit(coordinator, { now: () => NOW + 250 }),
    (error) => { failure = error; return true; });
  assert.equal(requestFailureRecoveryCode(failure, "other"), "throttle-paused");
  assert.equal(acquisitionFailureHold(failure), "secondary");
  const cause = recoveryCause({ ...requestFailureRecovery(failure, "other"), resource: "core", tab: "actions" });
  assert.equal(cause.origin, "source");
  assert.equal(shouldClearRecoveryCause(cause, { sourceSuccess: false, tab: "security" }), false);
});

test("HTTP permit cause classification ignores message text and unknown reason fields", () => {
  for (const error of [new Error("connect ECONNRESET"),
    new Error("Shared HTTP request or cooldown in progress"),
    Object.assign(new Error("network failed"), { coordinationReason: "unrecognized" })]) {
    assert.equal(requestFailureRecoveryCode(error, "other"), "network-outage");
    assert.equal(acquisitionFailureHold(error), "disconnected");
    const cause = recoveryCause({ ...requestFailureRecovery(error, "other"), resource: "core", tab: "actions" });
    assert.equal(cause.origin, "source");
    assert.equal(shouldClearRecoveryCause(cause, { sourceSuccess: true, tab: "security" }), false);
    assert.equal(shouldClearRecoveryCause(cause, { sourceSuccess: true, tab: "actions" }), true);
  }
  const interrupted = Object.assign(new Error("request interrupted"), { httpStarted: true });
  assert.equal(requestFailureRecoveryCode(interrupted, "other"), "interrupted-request");
  const limited = new Error("secondary rate limit");
  assert.equal(requestFailureRecoveryCode(limited, "rate-limited"), "rate-limited");
  assert.equal(acquisitionFailureHold(limited), "secondary");
});

test("the FIFO head still waits for the shared secondary cooldown", async (t) => {
  const { coordinator, read } = await fixture(t);
  const path = join(coordinator.root, "registry.json");
  const state = JSON.parse(readFileSync(path, "utf8"));
  state.hosts["github.com"].cooldownUntil = NOW + 1000;
  writeFileSync(path, JSON.stringify(state));
  let at = NOW + 250;
  const pending = acquireIdentityHttpPermit(coordinator, { now: () => at });
  await until(() => read().waiters.length === 1);
  assert.equal(read().permits.length, 0);
  at = NOW + 1000;
  const permit = await pending;
  assert.equal(read().lastStartedAt, NOW + 1000);
  releaseIdentityHttpPermit(coordinator, permit);
});

test("admitted HTTP queue retains FIFO position beyond a child timeout within its operation deadline", async (t) => {
  const { coordinator, read } = await fixture(t, { occupied: true });
  const live = await acquireIdentityHttpPermit(coordinator, { now: () => NOW + 250 });
  const quota = createQuotaScope(coordinator.current(), { root: coordinator.root });
  const before = readFileSync(quota.path, "utf8");
  let at = NOW + 500;
  let queuedNonce;
  let renewed = false;
  const permit = await acquireIdentityHttpPermit(coordinator, {
    now: () => at,
    operationDeadline: NOW + 60_000,
    wait: async () => {
      const waiter = read(at).waiters[0];
      queuedNonce ??= waiter.nonce;
      assert.equal(waiter.nonce, queuedNonce, "queue renewal changed FIFO identity");
      assert.ok(waiter.deadline - waiter.queuedAt <= 30_000,
        "persisted waiter must remain readable by the existing registry protocol");
      renewed ||= waiter.queuedAt > NOW + 500;
      at += 1_000;
      if (at >= NOW + 31_500) assert.equal(releaseIdentityHttpPermit(coordinator, live).ok, true);
    },
  });
  assert.equal(at, NOW + 31_500);
  assert.equal(permit.nonce, queuedNonce);
  assert.equal(renewed, true);
  assert.equal(read(at).waiters.length, 0);
  assert.equal(readFileSync(quota.path, "utf8"), before, "waiting must not alter quota");
  releaseIdentityHttpPermit(coordinator, permit);
});

test("admitted HTTP queue respects a sooner immutable operation deadline", async (t) => {
  const { coordinator, read } = await fixture(t, { occupied: true });
  const live = await acquireIdentityHttpPermit(coordinator, { now: () => NOW + 250 });
  let at = NOW + 500;
  await assert.rejects(acquireIdentityHttpPermit(coordinator, {
    now: () => at,
    operationDeadline: NOW + 2_500,
    wait: async () => { at += 1_000; },
  }), (error) => error.coordinationReason === "transport-busy");
  assert.equal(at, NOW + 2_500);
  assert.equal(read(at).permits.at(-1).nonce, live.nonce);
  assert.equal(read(at).waiters.length, 0);
});

for (const operation of ["tab:actions-runs", "budget-core-observer"]) {
  test(`runGh binds the queue deadline only for admitted data: ${operation}`, async (t) => {
    const { coordinator } = await fixture(t, { occupied: true });
    let at = NOW + 1_000;
    const live = await acquireIdentityHttpPermit(coordinator, { now: () => at });
    let requestQueuedAt;
    const scope = {
      ...createQuotaScope(coordinator.current(), { root: coordinator.root, now: () => at }),
      identityCoordinator: coordinator,
      accessKey: coordinator.current().accessKey,
      httpWait: async () => {
        requestQueuedAt ??= at;
        at += 1_000;
        if (at - requestQueuedAt >= 31_000) releaseIdentityHttpPermit(coordinator, live);
      },
    };
    const leaseId = randomUUID();
    assert.equal(registerLease(scope, { id: leaseId, expiresAt: at + 60_000,
      floorMs: 5_000, activeTab: "actions", phaseSeed: { seed: leaseId, registeredAt: at },
      demand: { core: 1, graphql: 0 } }, at).ok, true);
    let executions = 0;
    const result = await runAdmittedOperation({ scope, leaseId, operation, now: () => at,
      waitMs: 5_000, wait: async (ms) => { at += ms + 1; return true; },
      run: () => runGh(["api", "user"], { operation, execute: (_command, _args, options) => {
        executions += 1;
        assert.equal(options.timeout, 30_000, "queue waiting must not extend an HTTP child's timeout");
        const child = new EventEmitter();
        child.pid = process.pid;
        const pending = Promise.resolve({ stdout: "{}" });
        pending.child = child;
        queueMicrotask(() => child.emit("close", 0));
        return pending;
      } }),
    });
    if (operation === "tab:actions-runs") {
      assert.equal(result.ok, true, result.error?.message);
      assert.equal(executions, 1);
      const reservation = inspectGovernor(scope, at).value.reservations[result.reservationId];
      assert.equal(reservation.receipt.dispatches.length, 1);
      assert.equal(reservation.receipt.dispatches[0].terminalAt, at);
    } else {
      assert.equal(result.ok, false);
      assert.equal(result.error.coordinationReason, "transport-busy");
      assert.equal(executions, 0, "control must keep its own shorter queue bound");
      assert.equal(at - requestQueuedAt, 30_000);
    }
  });
}

test("shared HTTP pool admits three spaced requests and queues the fourth", async (t) => {
  const { coordinator, read } = await fixture(t);
  let at = NOW + 250;
  const held = [];
  for (let index = 0; index < 3; index += 1) {
    held.push(await acquireIdentityHttpPermit(coordinator, { now: () => at,
      wait: async () => { throw new Error("a free concurrent slot was serialized"); } }));
    at += 250;
  }
  assert.equal(read(at).permits.length, 3);
  const pending = acquireIdentityHttpPermit(coordinator, { now: () => at });
  await until(() => read(at).waiters.length === 1);
  assert.equal(read(at).permits.length, 3);
  releaseIdentityHttpPermit(coordinator, held[1], null, at);
  const fourth = await pending;
  assert.deepEqual(read(at).permits.map(({ nonce }) => nonce), [held[0].nonce, held[2].nonce, fourth.nonce]);
  for (const permit of [...held, fourth]) releaseIdentityHttpPermit(coordinator, permit, null, at);
});

test("concurrent success and duplicate settlement cannot erase or inflate newer throttle", async (t) => {
  const { coordinator, read } = await fixture(t);
  const first = await acquireIdentityHttpPermit(coordinator, { now: () => NOW + 250 });
  const second = await acquireIdentityHttpPermit(coordinator, { now: () => NOW + 500,
    wait: async () => { throw new Error("second request was serialized"); } });
  const error = Object.assign(new Error("secondary"), {
    stdout: "HTTP/2.0 429 Too Many Requests\nretry-after: 60\n\n{}", stderr: "secondary rate limit",
  });
  releaseIdentityHttpPermit(coordinator, second, error, NOW + 750);
  releaseIdentityHttpPermit(coordinator, first, null, NOW + 1_000);
  releaseIdentityHttpPermit(coordinator, second, error, NOW + 1_250);
  assert.equal(read(NOW + 1_250).throttle.attempts, 1);
  assert.equal(read(NOW + 1_250).cooldownUntil, NOW + 60_750);
  const later = await acquireIdentityHttpPermit(coordinator, { now: () => NOW + 61_000 });
  releaseIdentityHttpPermit(coordinator, later, null, NOW + 61_100);
  assert.equal(read(NOW + 61_100).throttle.attempts, 0);
});

function writeLegacyRegistry(coordinator, permit = null) {
  const path = join(coordinator.root, "registry.json");
  const state = JSON.parse(readFileSync(path, "utf8"));
  state.version = 1;
  for (const transport of Object.values(state.hosts)) {
    delete transport.permits;
    transport.permit = permit;
  }
  writeFileSync(path, JSON.stringify(state));
  return { path, state };
}

test("v1 live transport drains without rewriting state and its cooldown survives migration", async (t) => {
  const { coordinator } = await fixture(t);
  const held = { pid: process.pid, nonce: randomUUID(), startedAt: NOW };
  const { path, state } = writeLegacyRegistry(coordinator, held);
  const before = readFileSync(path, "utf8");
  const quota = createQuotaScope(coordinator.current(), { root: coordinator.root });
  const quotaBefore = readFileSync(quota.path, "utf8");
  assert.equal(inspectIdentityRegistry(coordinator.root, { now: NOW + 40_000 }).reason, "busy",
    "elapsed time cannot discard a live legacy owner's pending throttle response");
  assert.equal(readFileSync(path, "utf8"), before);
  assert.equal((await coordinator.refresh()).reason, "busy");
  assert.ok(coordinator.current(), "migration contention discarded the current identity");
  // State produced atomically by the legacy release, including a real hold.
  const host = state.hosts["github.com"];
  host.permit = null;
  host.cooldownUntil = NOW + 120_000;
  host.throttle = { attempts: 2, lastAt: NOW + 40_000, paused: false };
  host.waiters = [{ pid: process.pid, nonce: randomUUID(), queuedAt: NOW + 40_000, deadline: NOW + 70_000 }];
  writeFileSync(path, JSON.stringify(state));
  const migrated = inspectIdentityRegistry(coordinator.root, { now: NOW + 40_001 });
  assert.equal(migrated.ok, true);
  assert.equal(migrated.value.version, 2);
  const actual = migrated.value.hosts["github.com"];
  assert.equal(actual.cooldownUntil, host.cooldownUntil);
  assert.deepEqual(actual.throttle, host.throttle);
  assert.deepEqual(actual.waiters, host.waiters);
  assert.deepEqual(migrated.value.identities, state.identities);
  assert.deepEqual(migrated.value.attempts, state.attempts);
  assert.equal(readFileSync(quota.path, "utf8"), quotaBefore);
});

test("dead legacy owner retains one quarantine slot while bootstrap and two data slots recover", async (t) => {
  const { coordinator, read } = await fixture(t);
  const held = { pid: 99_999_999, nonce: randomUUID(), startedAt: NOW - 60_000 };
  writeLegacyRegistry(coordinator, held);
  const migrated = inspectIdentityRegistry(coordinator.root, { now: NOW,
    kill: () => { throw Object.assign(new Error("dead"), { code: "ESRCH" }); } });
  assert.equal(migrated.ok, true);
  assert.equal(read().permits[0].kind, "legacy");
  const bootstrap = claimIdentityBootstrap(coordinator.root, {
    credentialKey: "a".repeat(64), host: "github.com", now: NOW + 250,
  });
  assert.equal(bootstrap.ok, true);
  let at = NOW + 500;
  const queued = acquireIdentityHttpPermit(coordinator, { now: () => at });
  await until(() => read(at).waiters.length === 1);
  assert.equal(read(at).permits.length, 2, "data overlapped an exclusive bootstrap");
  releaseIdentityHttpPermit(coordinator, { ...bootstrap.value, host: "github.com" }, null, at);
  const first = await queued;
  at += 250;
  const second = await acquireIdentityHttpPermit(coordinator, { now: () => at });
  assert.equal(read(at).permits.length, 3);
  assert.equal(read(at).permits[0].nonce, held.nonce);
  releaseIdentityHttpPermit(coordinator, first, null, at);
  releaseIdentityHttpPermit(coordinator, second, null, at);
  assert.equal(read(at).permits.length, 1);
  assert.equal(readFileSync(join(coordinator.root, "registry.json"), "utf8").includes("synthetic-"), false);
});

test("malformed and future registry versions cannot migrate or replace evidence", async (t) => {
  const { coordinator } = await fixture(t);
  const { path, state } = writeLegacyRegistry(coordinator);
  for (const broken of [{ ...state, version: 3 }, { ...state, unexpected: true }]) {
    const bytes = JSON.stringify(broken);
    writeFileSync(path, bytes);
    assert.equal(inspectIdentityRegistry(coordinator.root, { now: NOW }).reason, "corrupt");
    assert.equal(readFileSync(path, "utf8"), bytes);
  }
});

test("a late throttle survives permit expiry and completion replay is idempotent", async (t) => {
  const { coordinator, read } = await fixture(t);
  const old = await acquireIdentityHttpPermit(coordinator, { now: () => NOW + 250 });
  const replacement = await acquireIdentityHttpPermit(coordinator, { now: () => NOW + 35_251 });
  const error = Object.assign(new Error("rate limited"), {
    stdout: "HTTP/2.0 429 Too Many Requests\nretry-after: 120\n\n{}", stderr: "secondary rate limit",
  });
  releaseIdentityHttpPermit(coordinator, old, error, NOW + 36_000);
  releaseIdentityHttpPermit(coordinator, old, error, NOW + 37_000);
  assert.equal(read(NOW + 37_000).cooldownUntil, NOW + 156_000);
  assert.equal(read(NOW + 37_000).throttle.attempts, 1);
  assert.equal(read(NOW + 37_000).permits[0].nonce, replacement.nonce);
  releaseIdentityHttpPermit(coordinator, replacement, null, NOW + 38_000);
  assert.equal(read(NOW + 38_000).throttle.attempts, 1);
});

test("read-only doctor understands a healthy unmigrated v1 registry without writing", async (t) => {
  const { coordinator } = await fixture(t);
  const { path } = writeLegacyRegistry(coordinator);
  const before = readFileSync(path, "utf8");
  const inspected = doctorCachedQuotaScope("github.com", { root: coordinator.root, nowMs: NOW });
  assert.equal(inspected.ok, true, inspected.reason);
  assert.equal(inspected.quotaKey, coordinator.current().quotaKey);
  assert.equal(readFileSync(path, "utf8"), before);
});

test("a committed registry replacement cannot report a failure from redundant chmod", async (t) => {
  const { coordinator, read } = await fixture(t);
  const permit = await acquireIdentityHttpPermit(coordinator, { now: () => NOW + 250 });
  const path = join(coordinator.root, "registry.json");
  const originalChmod = fs.chmodSync;
  fs.chmodSync = (target, ...args) => {
    if (target === path) throw Object.assign(new Error("post-commit chmod denied"), { code: "EACCES" });
    return originalChmod(target, ...args);
  };
  syncBuiltinESMExports();
  try {
    const error = Object.assign(new Error("secondary"), { stdout: "HTTP/2.0 429 Limited\nretry-after: 60\n\n{}" });
    assert.equal(releaseIdentityHttpPermit(coordinator, permit, error, NOW + 500).ok, true);
    assert.equal(releaseIdentityHttpPermit(coordinator, permit, error, NOW + 1_000).ok, true);
    assert.equal(read(NOW + 1_000).throttle.attempts, 1);
    assert.equal(fs.statSync(path).mode & 0o777, 0o600);
  } finally {
    fs.chmodSync = originalChmod;
    syncBuiltinESMExports();
  }
});

test("renewed FIFO waiters retain order when one of three occupied slots opens", async (t) => {
  const { coordinator, read } = await fixture(t, { occupied: true });
  const held = await acquireIdentityHttpPermit(coordinator, { now: () => NOW + 250 });
  let at = NOW + 500;
  const first = acquireIdentityHttpPermit(coordinator, { now: () => at, operationDeadline: NOW + 60_000 });
  await until(() => read(at).waiters.length === 1);
  const later = acquireIdentityHttpPermit(coordinator, { now: () => at, operationDeadline: NOW + 60_000 });
  await until(() => read(at).waiters.length === 2);
  const order = read(at).waiters.map((waiter) => waiter.nonce);
  at = NOW + 16_000;
  await until(() => read(at).waiters.every((waiter) => waiter.queuedAt === at));
  at = NOW + 31_500;
  await until(() => read(at).waiters.every((waiter) => waiter.queuedAt === at));
  assert.deepEqual(read(at).waiters.map((waiter) => waiter.nonce), order);
  releaseIdentityHttpPermit(coordinator, held, null, at);
  const firstPermit = await first;
  assert.equal(firstPermit.nonce, order[0]);
  assert.deepEqual(read(at).waiters.map((waiter) => waiter.nonce), [order[1]]);
  releaseIdentityHttpPermit(coordinator, firstPermit, null, at);
  at += 250;
  const laterPermit = await later;
  assert.equal(laterPermit.nonce, order[1]);
  releaseIdentityHttpPermit(coordinator, laterPermit, null, at);
});

test("a later request in the same operation cannot renew its absolute queue deadline", async (t) => {
  const { coordinator } = await fixture(t);
  let at = NOW + 1_000;
  const scope = { ...createQuotaScope(coordinator.current(), { root: coordinator.root, now: () => at }),
    identityCoordinator: coordinator, accessKey: coordinator.current().accessKey };
  const leaseId = randomUUID();
  registerLease(scope, { id: leaseId, expiresAt: at + 300_000, floorMs: 5_000, activeTab: "actions",
    phaseSeed: { seed: leaseId, registeredAt: at }, demand: { core: 1, graphql: 0 } }, at);
  let dispatched = 0;
  const execute = () => {
    dispatched += 1;
    const child = new EventEmitter();
    child.pid = process.pid;
    const pending = Promise.resolve({ stdout: "{}" });
    pending.child = child;
    queueMicrotask(() => child.emit("close", 0));
    return pending;
  };
  const result = await runAdmittedOperation({ scope, leaseId, operation: "tab:actions-runs", now: () => at,
    waitMs: 5_000, wait: async (ms) => { at += ms + 1; return true; },
    run: async () => {
      await runGh(["api", "user"], { operation: "tab:actions-runs", execute });
      at += 200_000;
      await assert.rejects(runGh(["api", "user"], { operation: "tab:actions-runs", execute }),
        (error) => error.coordinationReason === "transport-busy");
      return "deadline remained fixed";
    },
  });
  assert.equal(result.ok, false);
  assert.equal(result.error.message, "API receipt settlement compacted",
    "the expired operation retains its existing conservative settlement result");
  assert.equal(dispatched, 1);
});
