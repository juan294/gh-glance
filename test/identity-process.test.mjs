import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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

function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), "glance-identity-process-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const pathOptions = { env: { XDG_CONFIG_HOME: root } };
  const env = {
    PATH: process.env.PATH, HOME: root, TEST_ROOT: root, TEST_MODULE_URL: MODULE_URL,
    TEST_JOURNAL: join(root, "proofs.ndjson"), GH_TOKEN: "identity-process-private-fixture",
  };
  const run = async (script, extra = {}) => {
    const result = await execute(process.execPath, ["--input-type=module", "--eval", script], {
      env: { ...env, ...extra }, timeout: 30_000, maxBuffer: 1024 * 1024,
    });
    assert.equal(result.stderr, "");
    assert.equal(result.stdout.includes(env.GH_TOKEN), false);
    return JSON.parse(result.stdout);
  };
  return { root, pathOptions, env, run };
}

test("ID-04: twelve independent processes publish one identity proof and mapping", { timeout: 40_000 }, async (t) => {
  const box = fixture(t);
  const identities = await Promise.all(Array.from({ length: 12 }, (_, index) => box.run(COORDINATE, {
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

test("ID-07: dead process owners cannot replenish the host bootstrap allowance", { timeout: 40_000 }, async (t) => {
  const box = fixture(t);
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

test("ID-07: fresh processes using one credential retain its three-attempt allowance", { timeout: 20_000 }, async (t) => {
  const box = fixture(t);
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

test("ID-05: reappearing legacy leases pause an already active identity", async (t) => {
  const box = fixture(t);
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
  assert.equal(after.hosts["github.com"].permit, null);
});
