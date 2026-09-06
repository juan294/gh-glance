import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
  acquireIdentityHttpPermit, releaseIdentityHttpPermit, createIdentityCoordinator,
  inspectIdentityRegistry, claimIdentityBootstrap, createQuotaScope,
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
async function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), "glance-transport-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const env = { GH_TOKEN: "synthetic-fifo" };
  const coordinator = createIdentityCoordinator({
    host: "github.com", pathOptions: { env: { XDG_CONFIG_HOME: root } }, env, now: () => NOW,
    requestIdentity: async () => ({ body: { id: 1, login: "fixture" }, rateLimit: {
      resource: "core", limit: 5000, used: 1, remaining: 4999, resetMs: NOW + 3_600_000,
    } }),
  });
  assert.equal((await coordinator.refresh()).ok, true);
  t.after(() => coordinator.close());
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
  assert.equal(read().permit, null);
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
  const { coordinator, read } = await fixture(t);
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
  assert.equal(read().permit.nonce, live.nonce);
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
  const { coordinator } = await fixture(t);
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
  assert.equal(inspected.value.hosts["github.com"].permit.nonce, live.nonce);
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
  assert.equal(observed.hosts["github.com"].permit, null);
  host.waiters[0].deadline = NOW + 30_001;
  writeFileSync(path, JSON.stringify(state));
  assert.equal(inspectIdentityRegistry(coordinator.root, { now: NOW }).reason, "corrupt");
  observed = JSON.parse(readFileSync(path, "utf8"));
  assert.equal(observed.hosts["github.com"].waiters[0].deadline, NOW + 30_001);
});

for (const exit of ["timeout", "credential change"]) {
  test(`${exit} removes only the queued call and preserves the live permit`, async (t) => {
    const { coordinator, env, read } = await fixture(t);
    const live = await acquireIdentityHttpPermit(coordinator, { now: () => NOW + 250 });
    let at = NOW + 250;
    const pending = acquireIdentityHttpPermit(coordinator, { now: () => at });
    const rejected = assert.rejects(pending, exit === "timeout" ? /Shared HTTP/ : /Credential changed/);
    await until(() => read().waiters.length === 1);
    if (exit === "timeout") at += 30_000;
    else env.GH_TOKEN = "synthetic-replacement";
    await rejected;
    assert.equal(read(at).waiters.length, 0);
    assert.equal(read(at).permit.nonce, live.nonce);
    assert.equal(readFileSync(join(coordinator.root, "registry.json"), "utf8").includes("synthetic-"), false);
  });
}

test("the FIFO head still waits for the shared secondary cooldown", async (t) => {
  const { coordinator, read } = await fixture(t);
  const path = join(coordinator.root, "registry.json");
  const state = JSON.parse(readFileSync(path, "utf8"));
  state.hosts["github.com"].cooldownUntil = NOW + 1000;
  writeFileSync(path, JSON.stringify(state));
  let at = NOW + 250;
  const pending = acquireIdentityHttpPermit(coordinator, { now: () => at });
  await until(() => read().waiters.length === 1);
  assert.equal(read().permit, null);
  at = NOW + 1000;
  const permit = await pending;
  assert.equal(read().lastStartedAt, NOW + 1000);
  releaseIdentityHttpPermit(coordinator, permit);
});
