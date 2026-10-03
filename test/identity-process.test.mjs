import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { promisify } from "node:util";
import { acquireIdentityHttpPermit, createIdentityCoordinator, identityRegistryRoot, inspectIdentityRegistry } from "../index.mjs";

const execute = promisify(execFile);
const MODULE_URL = new URL("../index.mjs", import.meta.url).href;
const COORDINATE = `
  const { createIdentityCoordinator } = await import(process.env.TEST_MODULE_URL);
  const { appendFileSync } = await import('node:fs');
  const coordinator = createIdentityCoordinator({
    host: 'github.com', pathOptions: { env: { XDG_CONFIG_HOME: process.env.TEST_ROOT } },
    requestIdentity: async () => {
      appendFileSync(process.env.TEST_JOURNAL, JSON.stringify({ pid: process.pid, at: Date.now() }) + '\\n');
      await new Promise(resolve => setTimeout(resolve, 150));
      return { body: { id: 42, login: 'fixture-user' }, rateLimit: {
        resource: 'core', limit: 5000, used: 1, remaining: 4999, resetMs: Date.now() + 3600000,
      }, etag: '"process-proof"' };
    },
  });
  const deadline = Date.now() + 20000;
  while (!coordinator.current() && Date.now() < deadline) {
    await coordinator.refresh();
    if (!coordinator.current()) await new Promise(resolve => setTimeout(resolve, 100));
  }
  const current = coordinator.current();
  if (!current) throw new Error('Identity was never established: ' + coordinator.inspect()?.reason);
  process.stdout.write(JSON.stringify({ quotaKey: current.quotaKey, accessKey: current.accessKey }));
  coordinator.close();
`;
const CLAIM_AND_EXIT = `
  const { claimIdentityBootstrap, identityRegistryRoot, resolveEffectiveCredential } = await import(process.env.TEST_MODULE_URL);
  const credential = await resolveEffectiveCredential({ host: 'github.com' });
  const root = identityRegistryRoot({ env: { XDG_CONFIG_HOME: process.env.TEST_ROOT } });
  const claim = claimIdentityBootstrap(root, { credentialKey: credential.value.credentialKey,
    host: 'github.com', now: Number(process.env.TEST_NOW) });
  process.stdout.write(JSON.stringify(claim));
  // Deliberately leave the persisted started receipt and HTTP permit behind.
`;

// Each case gets one absolute outer budget. A child receives only what is left
// of it minus a shutdown margin, so a slow child is terminated while the test
// still has time to report. Teardown waits for every owned child to settle
// before removing the shared state they write to.
const SHUTDOWN_MARGIN_MS = 2_000;

// One number per case: the test timeout, from which the fixture budget is
// derived, so the two cannot drift apart.
const HARNESS_MARGIN_MS = 3_000;
function identityTest(name, timeoutMs, body) {
  test(name, { timeout: timeoutMs }, (t) => body(t, fixture(t, { budgetMs: timeoutMs - HARNESS_MARGIN_MS })));
}

function fixture(t, { budgetMs }) {
  const deadline = Date.now() + budgetMs;
  const root = mkdtempSync(join(tmpdir(), "glance-identity-process-"));
  const children = new Set();
  t.after(async () => {
    await Promise.allSettled(children);
    rmSync(root, { recursive: true, force: true });
  });
  const pathOptions = { env: { XDG_CONFIG_HOME: root } };
  const env = {
    PATH: process.env.PATH, HOME: root, TEST_ROOT: root, TEST_MODULE_URL: MODULE_URL,
    TEST_JOURNAL: join(root, "proofs.ndjson"), GH_TOKEN: "identity-process-private-fixture",
  };
  const run = async (script, extra = {}) => {
    const remaining = deadline - SHUTDOWN_MARGIN_MS - Date.now();
    if (remaining <= 0) throw new Error(`outer budget exhausted before a child could start (${budgetMs} ms)`);
    const child = execute(process.execPath, ["--input-type=module", "--eval", script], {
      env: { ...env, ...extra }, timeout: remaining, killSignal: "SIGKILL", maxBuffer: 1024 * 1024,
    });
    children.add(child.then(() => {}, () => {}));
    const result = await child;
    assert.equal(result.stderr, "");
    assert.equal(result.stdout.includes(env.GH_TOKEN), false);
    return JSON.parse(result.stdout);
  };
  return { root, pathOptions, env, run };
}

// Like Promise.all, but waits for every sibling and reports the first failure
// with the count and messages of the others, instead of abandoning siblings
// that are still writing into shared state.
async function allSiblings(promises) {
  const results = await Promise.allSettled(promises);
  const failures = results.filter((result) => result.status === "rejected").map((result) => result.reason);
  if (failures.length === 0) return results.map((result) => result.value);
  const [first, ...others] = failures;
  if (others.length > 0) {
    first.message += `\n(${others.length} sibling failure(s): ${others.map((error) => error.message.split("\n")[0]).join("; ")})`;
  }
  throw first;
}

identityTest("ID-04: twelve independent processes publish one identity proof and mapping", 40_000, async (t, box) => {
  const identities = await allSiblings(Array.from({ length: 12 }, (_, index) => box.run(COORDINATE, {
    ...(index % 2 ? { GH_TOKEN: undefined, GITHUB_TOKEN: box.env.GH_TOKEN } : {}),
    GH_ENTERPRISE_TOKEN: `unused-enterprise-fixture-${index}`,
  })));
  assert.equal(new Set(identities.map((identity) => identity.quotaKey)).size, 1);
  assert.equal(new Set(identities.map((identity) => identity.accessKey)).size, 1);
  const proofs = readFileSync(box.env.TEST_JOURNAL, "utf8").trim().split("\n").map(JSON.parse);
  assert.equal(proofs.length, 1, "new processes duplicated the identity request");
  const registryRoot = identityRegistryRoot(box.pathOptions);
  const registry = inspectIdentityRegistry(registryRoot).value;
  assert.equal(Object.keys(registry.identities).length, 1);
  assert.equal(Object.keys(registry.attempts).length, 1);
  assert.equal(readFileSync(join(registryRoot, "registry.json"), "utf8").includes(box.env.GH_TOKEN), false);
});

identityTest("ID-07: dead process owners cannot replenish the host bootstrap allowance", 40_000, async (t, box) => {
  const now = Date.now();
  for (let index = 0; index < 13; index += 1) {
    const claim = await box.run(CLAIM_AND_EXIT, {
      GH_TOKEN: `identity-process-private-${index}`, TEST_NOW: String(now + index * 300),
    });
    assert.equal(claim.ok, index < 12, `host claim ${index + 1}`);
    if (index === 12) assert.equal(claim.retryAt, now + 15 * 60_000);
  }
  const registry = inspectIdentityRegistry(identityRegistryRoot(box.pathOptions)).value;
  assert.equal(Object.keys(registry.attempts).length, 12);
  assert.ok(Object.values(registry.attempts).every((attempt) => !attempt.accounted));
  assert.equal(JSON.stringify(registry).includes("identity-process-private-"), false);
});

identityTest("ID-07: fresh processes using one credential retain its three-attempt allowance", 20_000, async (t, box) => {
  const now = Date.now();
  for (const [index, offset] of [0, 60_000, 180_000, 420_000].entries()) {
    const claim = await box.run(CLAIM_AND_EXIT, { TEST_NOW: String(now + offset) });
    assert.equal(claim.ok, index < 3);
    if (index === 3) assert.equal(claim.retryAt, now + 15 * 60_000);
  }
  const registry = inspectIdentityRegistry(identityRegistryRoot(box.pathOptions)).value;
  assert.equal(Object.keys(registry.attempts).length, 3);
  assert.ok(Object.values(registry.attempts).every((attempt) => !attempt.accounted && !attempt.imported));
});

identityTest("ID-05: reappearing legacy leases pause an already active identity", 10_000, async (t, box) => {
  let now = Date.now();
  const coordinator = createIdentityCoordinator({
    host: "github.com", pathOptions: box.pathOptions, env: box.env, now: () => now,
    requestIdentity: async () => ({ status: 200, body: { id: 42, login: "fixture-user" },
      rateLimit: { resource: "core", limit: 5000, used: 1, remaining: 4999, resetMs: now + 3_600_000 },
    }),
  });
  assert.equal((await coordinator.refresh()).ok, true);
  const before = inspectIdentityRegistry(coordinator.root).value;
  assert.equal(before.migration.activated, true);
  const legacy = JSON.parse(readFileSync(new URL("./fixtures/legacy-governor-v2.json", import.meta.url), "utf8"));
  const id = randomUUID();
  legacy.leases[id] = { expiresAt: now + 60_000, floorMs: 5000, activeTab: "actions",
    phaseSeed: { seed: id, registeredAt: now }, demand: { core: 2, graphql: 0 } };
  const legacyPath = join(box.root, "gh-glance", `rate-governor-v1-${"b".repeat(64)}.json`);
  const serialized = JSON.stringify(legacy);
  writeFileSync(legacyPath, serialized, { mode: 0o600 });
  now += 250;
  await assert.rejects(acquireIdentityHttpPermit(coordinator, { now: () => now }), /Restart required/);
  assert.equal(readFileSync(legacyPath, "utf8"), serialized);
  const after = inspectIdentityRegistry(coordinator.root).value;
  assert.equal(after.hosts["github.com"].lastStartedAt, before.hosts["github.com"].lastStartedAt);
  assert.equal(after.hosts["github.com"].permits.length, 0);
});

identityTest("independent processes share three HTTP slots and the host start gap", 70_000, async (t, box) => {
  await box.run(COORDINATE);
  const lockPath = join(identityRegistryRoot(box.pathOptions), "registry.json.lock");
  writeFileSync(lockPath, JSON.stringify({ pid: process.pid, nonce: randomUUID() }), { flag: "wx", mode: 0o600 });
  const readinessPath = join(box.root, "readiness.ndjson");
  const script = `
    const { createIdentityCoordinator, acquireIdentityHttpPermit, releaseIdentityHttpPermit,
      inspectIdentityRegistry, retryIdentityCompletion } = await import(process.env.TEST_MODULE_URL);
    const { appendFileSync } = await import('node:fs');
    const coordinator = createIdentityCoordinator({ host: 'github.com',
      pathOptions: { env: { XDG_CONFIG_HOME: process.env.TEST_ROOT } } });
    const refreshed = await coordinator.refresh({ allowBootstrap: false });
    appendFileSync(process.env.TEST_READINESS, JSON.stringify({ pid: process.pid, reason: refreshed.reason }) + '\\n');
    let identity = refreshed;
    const deadline = Date.now() + 5000;
    while (!identity.ok && ['busy', 'unwritable'].includes(identity.reason) && Date.now() < deadline) {
      await new Promise(resolve => setTimeout(resolve, 50));
      identity = await coordinator.refresh({ allowBootstrap: false });
    }
    if (!identity.ok) throw new Error('missing identity: ' + identity.reason);
    const permit = await acquireIdentityHttpPermit(coordinator);
    const inspected = await retryIdentityCompletion(() => inspectIdentityRegistry(coordinator.root), { timeoutMs: 5000 });
    if (!inspected.ok) throw new Error('inspection failed: ' + inspected.reason);
    const held = inspected.value.hosts['github.com'].permits
      .find(item => item.nonce === permit.nonce);
    appendFileSync(process.env.TEST_JOURNAL, JSON.stringify({ type: 'start', nonce: permit.nonce,
      at: Date.now(), grantedAt: held.startedAt }) + '\\n');
    await new Promise(resolve => setTimeout(resolve, 1000));
    appendFileSync(process.env.TEST_JOURNAL, JSON.stringify({ type: 'end', nonce: permit.nonce,
      at: Date.now() }) + '\\n');
    const released = await retryIdentityCompletion(() => releaseIdentityHttpPermit(coordinator, permit), { timeoutMs: 5000 });
    if (!released.ok) throw new Error('release failed: ' + released.reason);
    coordinator.close();
    process.stdout.write(JSON.stringify({ nonce: permit.nonce }));
  `;
  const children = Promise.allSettled(Array.from({ length: 8 }, () => box.run(script, { TEST_READINESS: readinessPath })));
  let results;
  try {
    const deadline = Date.now() + 5_000;
    while ((!existsSync(readinessPath) || readFileSync(readinessPath, "utf8").trim().split("\n").length < 8) && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    const readiness = readFileSync(readinessPath, "utf8").trim().split("\n").map(JSON.parse);
    assert.equal(readiness.length, 8, "all children must encounter the live registry owner");
    assert.equal(new Set(readiness.map((item) => item.pid)).size, 8);
    assert.ok(readiness.every((item) => item.reason === "busy"));
  } finally {
    unlinkSync(lockPath);
    results = await children;
  }
  assert.deepEqual(results.filter((result) => result.status === "rejected").map((result) => result.reason.message), []);
  const events = readFileSync(box.env.TEST_JOURNAL, "utf8").trim().split("\n").map(JSON.parse)
    .filter((event) => event.type);
  let active = 0;
  let peak = 0;
  for (const event of events) {
    active += event.type === "start" ? 1 : -1;
    peak = Math.max(peak, active);
    assert.ok(active >= 0 && active <= 3, "shared capacity exceeded across processes");
  }
  assert.equal(active, 0);
  assert.equal(peak, 3, "independent requests remained serialized");
  const starts = events.filter((event) => event.type === "start").sort((a, b) => a.grantedAt - b.grantedAt);
  assert.equal(starts.length, 8);
  for (let index = 1; index < starts.length; index += 1) {
    assert.ok(starts[index].grantedAt - starts[index - 1].grantedAt >= 250);
  }
});

// Fixture ownership (G05). A fake context collects the teardown so each case
// can observe ordering between child completion and state removal.
function ownedContext() {
  const hooks = [];
  return { after: (fn) => hooks.push(fn), teardown: async () => { for (const fn of hooks) await fn(); } };
}

const SLOW_WRITER = `
  const { writeFileSync } = await import('node:fs');
  await new Promise(resolve => setTimeout(resolve, 800));
  writeFileSync(process.env.TEST_ROOT + '/sibling-finished', 'yes');
  process.stdout.write('{}');
`;

test("FIXTURE-G05: an early sibling failure still waits for every child before removing state", { timeout: 20_000 }, async () => {
  const context = ownedContext();
  const box = fixture(context, { budgetMs: 15_000 });
  const outcome = allSiblings([box.run("throw new Error('planted early failure')"), box.run(SLOW_WRITER)]);
  await assert.rejects(outcome, /planted early failure/);
  const finishedBeforeTeardown = existsSync(join(box.root, "sibling-finished"));
  await context.teardown();
  assert.equal(finishedBeforeTeardown, true, "allSiblings must not reject before the slow sibling settles");
  assert.equal(existsSync(box.root), false, "teardown removes owned state after the children");
});

test("FIXTURE-G05: a child longer than the remaining budget is stopped inside the case budget", { timeout: 20_000 }, async () => {
  const context = ownedContext();
  const box = fixture(context, { budgetMs: 2_500 });
  const started = Date.now();
  await assert.rejects(box.run("await new Promise(resolve => setTimeout(resolve, 30000));"),
    (error) => error.killed === true);
  assert.ok(Date.now() - started < 2_500, `child outlived the outer budget: ${Date.now() - started} ms`);
  await context.teardown();
  await assert.rejects(box.run("process.stdout.write('{}')"), /outer budget exhausted/);
});

test("FIXTURE-G05: sibling failures are reported with the first failure", { timeout: 20_000 }, async () => {
  const context = ownedContext();
  const box = fixture(context, { budgetMs: 15_000 });
  await assert.rejects(allSiblings([box.run("throw new Error('first')"),
    new Promise((_, reject) => setTimeout(() => reject(new Error("second")), 200))]),
  (error) => /first/.test(error.message) && /1 sibling failure\(s\): second/.test(error.message));
  await context.teardown();
});
