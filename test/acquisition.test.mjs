import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, unlinkSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import {
  ACQUISITION_CLAIM_TTL_MS,
  ACQUISITION_STARTED_DEADLINE_MS,
  ACQUISITION_HEARTBEAT_MS,
  ACQUISITION_MAX_BYTES,
  ACQUISITION_MAX_ENTITIES,
  ACQUISITION_MAX_LIVE_TARGETS,
  ACQUISITION_MAX_SUBSCRIPTIONS,
  ACQUISITION_STORE_VERSION,
  GOVERNOR_LEASE_TTL_MS,
  GOVERNOR_LOCK_ORPHAN_MS,
  acquisitionQueryKey,
  acquisitionDiagnostics,
  acquisitionRequestMetrics,
  acquisitionStorePath,
  actionsRunsArgs,
  actionsWorkflowsArgs,
  claimProbe,
  claimGovernorLock,
  cancelCoordinatedPending,
  cancelIntent,
  coalescedAcquisitionIntentMatches,
  createAcquisitionEngine,
  createGovernorScope,
  fetchActions,
  fetchSecurity,
  fetchGraphqlList,
  frozenGovernorScope,
  pendingAcquisitionMatches,
  ghApi,
  inspectGovernor,
  loadAcquisitionStore,
  publishProbe,
  publishStagedEntities,
  registerIntent,
  registerLease,
  runStartedAcquisitionTransport,
  withFileLock,
  startReservation,
  stagedAcquisitionPublicationView,
  setRuntimeAcquisitionHold,
} from "../index.mjs";

const NOW = 1_800_000_000_000;
const ACCESS = "a".repeat(64);

function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), "gh-glance-acquisition-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  let now = NOW;
  const options = {
    pathOptions: { env: { XDG_CONFIG_HOME: root } },
    now: () => now,
    setNow: (value) => { now = value; },
  };
  return options;
}

function memoryStorage() {
  let state = {
    version: ACQUISITION_STORE_VERSION,
    producerEpoch: "00000000-0000-4000-8000-000000000010",
    subscriptions: {},
    queries: {},
    aliases: {},
  };
  let failure = null;
  let afterFailure = null;
  let transactionCount = 0;
  let writeCount = 0;
  const scheduledFailures = new Map();
  return {
    failNext(reason) { failure = reason; },
    failAfterNext(reason) { afterFailure = reason; },
    failOnTransaction(number, reason) { scheduledFailures.set(number, reason); },
    counts() { return { transactions: transactionCount, writes: writeCount }; },
    load() { return { ok: true, value: structuredClone(state) }; },
    transact(operation) {
      transactionCount += 1;
      if (scheduledFailures.has(transactionCount)) {
        const reason = scheduledFailures.get(transactionCount);
        scheduledFailures.delete(transactionCount);
        return { ok: false, reason };
      }
      if (failure) {
        const reason = failure;
        failure = null;
        return { ok: false, reason };
      }
      const next = structuredClone(state);
      const result = operation(next);
      if (result?.ok === false) return result;
      if (afterFailure) {
        const reason = afterFailure;
        afterFailure = null;
        return { ok: false, reason };
      }
      if (result?.changed !== false) {
        state = next;
        writeCount += 1;
      }
      return { ok: true, value: result?.value, state };
    },
  };
}

function query(repositoryId = "R_widget", resource = "actions", overrides = {}) {
  return {
    host: "github.com",
    repositoryId,
    repository: `acme/${repositoryId.slice(2)}`,
    accessKey: ACCESS,
    targetKey: `github.com\0${repositoryId}`,
    resource,
    queryVersion: 1,
    filters: {},
    pageSize: resource === "actions" ? 60 : 50,
    cursorGeneration: "first",
    ...overrides,
  };
}

function snapshot(title, { at = NOW, etag = '"runs-v1"' } = {}) {
  const body = JSON.stringify([{ databaseId: 1, displayTitle: title }]);
  return {
    rows: [{ databaseId: 1, displayTitle: title, workflowName: "CI", number: 1,
      headBranch: "develop", status: "completed", conclusion: "success",
      startedAt: "2026-09-05T00:00:00Z", updatedAt: "2026-09-05T00:01:00Z",
      url: "https://github.com/acme/widget/actions/runs/1" }],
    pageInfo: null,
    raw: body,
    entities: [{ key: "actions\0runs", etag, body }],
    lastSuccessAt: at,
    lastChangedAt: at,
    nextDueAt: at + 5_000,
    hold: null,
    capabilities: {},
    meta: { at, truncated: false },
    securityNotes: [],
    securityBlind: false,
  };
}

test("SHARE-03: query identity partitions repository, access, version, and cursor", () => {
  const base = query();
  const key = acquisitionQueryKey(base);
  assert.equal(key, acquisitionQueryKey({ ...base, filters: {} }));
  for (const changed of [
    { repositoryId: "R_other" },
    { host: "tenant.example" },
    { accessKey: "b".repeat(64) },
    { queryVersion: 2 },
    { cursorGeneration: "second" },
  ]) assert.notEqual(key, acquisitionQueryKey({ ...base, ...changed }));
});

test("SHARE-05: checked acquisition start fences every injected transport call", async (t) => {
  for (const reason of ["busy", "stale", "fenced"]) {
    const box = fixture(t);
    const storage = memoryStorage();
    let calls = 0;
    const engine = createAcquisitionEngine({
      ...box,
      storage,
      transport: async () => {
        calls += 1;
        return snapshot(`must not run for ${reason}`);
      },
    });
    t.after(() => engine.close());
    const subscribed = engine.subscribe(query(`R_start_${reason}`), { active: true, floorMs: 5_000 });
    storage.failOnTransaction(3, reason);
    storage.failOnTransaction(4, "busy");
    const result = await engine.refresh(subscribed.value.id);
    assert.equal(result.reason, reason);
    assert.equal(calls, 0, reason);
    const retried = await engine.refresh(subscribed.value.id);
    assert.equal(retried.ok, true, reason);
    assert.equal(retried.value.role, "producer", reason);
    assert.equal(retried.value.snapshot.rows[0].displayTitle, `must not run for ${reason}`);
    assert.equal(calls, 1, `${reason} must retry once without wedging the durable claim`);
  }
});

test("SHARE-08: metadata polling and unchanged demand do not read or rewrite snapshot payloads", async (t) => {
  const box = fixture(t);
  let tick = null;
  const engine = createAcquisitionEngine({
    ...box,
    setInterval: (run) => { tick = run; return { unref() {} }; },
    clearInterval: () => {},
  });
  t.after(() => engine.close());
  const subscribed = engine.subscribe(query(), { active: true, floorMs: 5_000 });
  await engine.refresh(subscribed.value.id, { acquire: async () => snapshot("payload sentinel") });

  const coordinationPath = acquisitionStorePath(box.pathOptions);
  const coordination = readFileSync(coordinationPath, "utf8");
  assert.equal(coordination.includes("payload sentinel"), false);
  const payloadRoot = `${coordinationPath}.snapshots`;
  const [artifact] = readdirSync(payloadRoot);
  const artifactPath = join(payloadRoot, artifact);
  const payload = readFileSync(artifactPath, "utf8");
  assert.equal(payload.includes("payload sentinel"), true);
  assert.equal(Object.hasOwn(JSON.parse(payload), "raw"), false,
    "the bounded digest replaces the duplicate raw row serialization");
  writeFileSync(artifactPath, "not-json\n");
  const artifactMtime = statSync(artifactPath).mtimeMs;

  tick();
  assert.equal(engine.updateDemand(subscribed.value.id,
    { active: true, floorMs: 5_000 }).ok, true);
  box.setNow(NOW + ACQUISITION_HEARTBEAT_MS + 1);
  tick();
  assert.equal(statSync(artifactPath).mtimeMs, artifactMtime,
    "heartbeat and unchanged demand never rewrite payload artifacts");
});

test("SHARE-08: unchanged demand and fresh follower refresh are mutation-free", async (t) => {
  const box = fixture(t);
  const storage = memoryStorage();
  const engine = createAcquisitionEngine({ ...box, storage });
  t.after(() => engine.close());
  const subscribed = engine.subscribe(query(), { active: true, floorMs: 5_000 });
  await engine.refresh(subscribed.value.id, { acquire: async () => snapshot("stable") });
  const before = storage.counts().writes;
  assert.equal(engine.updateDemand(subscribed.value.id,
    { active: true, floorMs: 5_000 }).ok, true);
  const followed = await engine.refresh(subscribed.value.id);
  assert.equal(followed.value.role, "follower");
  assert.equal(storage.counts().writes, before);
});

test("SHARE-03: admitted database identity remaps explicit and inferred slug subscriptions", async (t) => {
  const box = fixture(t);
  const explicit = createAcquisitionEngine(box);
  const inferred = createAcquisitionEngine(box);
  t.after(() => { explicit.close(); inferred.close(); });
  const first = explicit.subscribe(query(), { active: true, floorMs: 5_000 });
  const second = inferred.subscribe(query(), { active: false, floorMs: 40_000 });
  const acquired = await explicit.refresh(first.value.id, {
    acquire: async () => ({ ...snapshot("canonical"),
      repositoryIdentity: { id: "R_CANONICAL", nameWithOwner: "Acme/Widget" } }),
  });
  assert.equal(acquired.ok, true);
  const followed = inferred.inspect(second.value.id);
  assert.equal(followed.value.query.repositoryId, "R_CANONICAL");
  assert.equal(followed.value.snapshot.rows[0].displayTitle, "canonical");
  const restarted = createAcquisitionEngine(box);
  t.after(() => restarted.close());
  const resumed = restarted.subscribe(query(), { active: true, floorMs: 5_000 });
  assert.equal(resumed.value.queryKey, followed.value.query.queryKey);
  assert.equal(resumed.value.snapshot.rows[0].displayTitle, "canonical");
});

test("SHARE-03: a later Actions subscriber joins its live slug claim after Issues learns the ID", async (t) => {
  const box = fixture(t);
  const first = createAcquisitionEngine(box);
  const issueEngine = createAcquisitionEngine(box);
  const later = createAcquisitionEngine(box);
  t.after(() => { first.close(); issueEngine.close(); later.close(); });
  const actionsQuery = query("slug:acme/widget", "actions", {
    repository: "acme/widget", targetKey: "target-widget",
  });
  const issuesQuery = query("slug:acme/widget", "issues", {
    repository: "acme/widget", targetKey: "target-widget",
  });
  const original = first.subscribe(actionsQuery, { active: true, floorMs: 5_000 });
  const owned = await first.refresh(original.value.id);
  assert.equal(owned.value.role, "producer");
  assert.equal((await first.refresh(original.value.id, { started: owned.value })).value.status,
    "started");

  const issueSubscription = issueEngine.subscribe(issuesQuery, { active: true, floorMs: 5_000 });
  const observed = await issueEngine.refresh(issueSubscription.value.id, {
    acquire: async () => ({ ...snapshot("identity"), rows: [], entities: [], raw: "[]",
      repositoryIdentity: { id: "R_acme_widget", nameWithOwner: "acme/widget" } }),
  });
  assert.equal(observed.ok, true);
  const joined = later.subscribe(actionsQuery, { active: true, floorMs: 5_000 });
  assert.equal(joined.value.queryKey, original.value.queryKey);
  const followed = await later.refresh(joined.value.id);
  assert.equal(followed.value.role, "follower");
  const stored = loadAcquisitionStore(acquisitionStorePath(box.pathOptions));
  assert.equal(Object.values(stored.value.queries).filter(({ query: record }) =>
    record.resource === "actions" && record.repository === "acme/widget").length, 1);
  assert.equal(stored.value.queries[original.value.queryKey].claim.nonce, owned.value.nonce);
  assert.equal(stored.value.queries[original.value.queryKey].claim.started, true);
});

test("SHARE-03: legacy split aliases converge after their subscriptions retire", async (t) => {
  const box = fixture(t);
  const slugEngine = createAcquisitionEngine(box);
  const canonicalEngine = createAcquisitionEngine(box);
  const issueEngine = createAcquisitionEngine(box);
  const follower = createAcquisitionEngine(box);
  t.after(() => { slugEngine.close(); canonicalEngine.close(); issueEngine.close(); follower.close(); });
  const slug = query("slug:acme/widget", "actions", {
    repository: "acme/widget", targetKey: "target-widget",
  });
  const canonical = { ...slug, repositoryId: "R_acme_widget" };
  const original = slugEngine.subscribe(slug, { active: true, floorMs: 5_000 });
  assert.equal((await slugEngine.refresh(original.value.id, {
    acquire: async () => snapshot("slug"),
  })).ok, true);
  box.setNow(NOW + 100);
  const second = canonicalEngine.subscribe(canonical, { active: false, floorMs: 5_000 });
  assert.equal((await canonicalEngine.refresh(second.value.id, {
    acquire: async () => snapshot("canonical", { at: NOW + 100 }),
  })).ok, true);
  const issue = issueEngine.subscribe(query("slug:acme/widget", "issues", {
    repository: "acme/widget", targetKey: "target-widget",
  }), { active: true, floorMs: 5_000 });
  assert.equal((await issueEngine.refresh(issue.value.id, {
    acquire: async () => ({ ...snapshot("identity", { at: NOW + 100 }),
      rows: [], entities: [], raw: "[]",
      repositoryIdentity: { id: "R_acme_widget", nameWithOwner: "acme/widget" } }),
  })).ok, true);

  const joined = follower.subscribe(slug, { active: true, floorMs: 5_000 });
  assert.equal(joined.value.aliasConflict, true);
  assert.ok([original.value.queryKey, second.value.queryKey].includes(joined.value.queryKey));
  let stored = loadAcquisitionStore(acquisitionStorePath(box.pathOptions));
  assert.equal(Object.values(stored.value.queries).filter(({ query: record }) =>
    record.resource === "actions" && record.repository === "acme/widget").length, 2);

  assert.equal(slugEngine.unsubscribe(original.value.id).ok, true);
  assert.equal(canonicalEngine.unsubscribe(second.value.id).ok, true);
  assert.equal(issueEngine.unsubscribe(issue.value.id).ok, true);
  assert.equal(follower.unsubscribe(joined.value.id).ok, true);
  const resumed = follower.subscribe(slug, { active: true, floorMs: 5_000 });
  assert.equal(resumed.value.aliasConflict, false);
  assert.equal(resumed.value.queryKey, second.value.queryKey);
  assert.equal(resumed.value.snapshot.rows[0].displayTitle, "canonical");
  stored = loadAcquisitionStore(acquisitionStorePath(box.pathOptions));
  const actions = Object.values(stored.value.queries).filter(({ query: record }) =>
    record.resource === "actions" && record.repository === "acme/widget");
  assert.equal(actions.length, 1);
  assert.equal(actions[0].generation, 1);
  assert.equal(actions[0].snapshot.queryKey, second.value.queryKey);
  assert.equal(follower.unsubscribe(resumed.value.id).ok, true);
  follower.close();
  const reopened = createAcquisitionEngine(box);
  t.after(() => reopened.close());
  const readback = reopened.subscribe(slug, { active: true, floorMs: 5_000 }, null,
    { resumeFreshSnapshot: true });
  assert.equal(readback.value.queryKey, second.value.queryKey);
  assert.equal(readback.value.snapshot.rows[0].displayTitle, "canonical");
});

test("SHARE-03: concurrent old and new slugs merge into one canonical generation across restart", async (t) => {
  const box = fixture(t);
  const oldEngine = createAcquisitionEngine(box);
  const newEngine = createAcquisitionEngine(box);
  const waitingEngine = createAcquisitionEngine(box);
  t.after(() => { oldEngine.close(); newEngine.close(); waitingEngine.close(); });
  const oldQuery = query("slug:acme/old", "actions", {
    repository: "acme/old",
    targetKey: "github.com\0slug:acme/old",
  });
  const newQuery = query("slug:acme/new", "actions", {
    repository: "acme/new",
    targetKey: "github.com\0slug:acme/new",
  });
  const oldSubscription = oldEngine.subscribe(oldQuery, { active: true, floorMs: 5_000 });
  const newSubscription = newEngine.subscribe(newQuery, { active: true, floorMs: 5_000 });
  const oldClaim = await oldEngine.refresh(oldSubscription.value.id);
  const newClaim = await newEngine.refresh(newSubscription.value.id);
  const waitingSubscription = waitingEngine.subscribe(oldQuery, { active: true, floorMs: 5_000 });
  await waitingEngine.refresh(waitingSubscription.value.id);
  box.setNow(NOW + 25);
  const identity = { id: "R_CANONICAL", nameWithOwner: "acme/new" };

  const first = await newEngine.refresh(newSubscription.value.id, {
    claim: { ...newClaim.value, accessKey: ACCESS },
    publish: { ...snapshot("new slug"), repositoryIdentity: identity },
  });
  const second = await oldEngine.refresh(oldSubscription.value.id, {
    claim: { ...oldClaim.value, accessKey: ACCESS },
    publish: { ...snapshot("old slug completion", { at: NOW + 1 }), repositoryIdentity: identity },
  });

  assert.equal(first.ok, true);
  assert.equal(second.ok, true);
  const oldView = oldEngine.inspect(oldSubscription.value.id);
  const newView = newEngine.inspect(newSubscription.value.id);
  assert.equal(oldView.value.queryKey, newView.value.queryKey);
  assert.equal(oldView.value.generation, 2);
  assert.equal(oldView.value.snapshot.rows[0].displayTitle, "old slug completion");
  const stored = loadAcquisitionStore(acquisitionStorePath(box.pathOptions));
  assert.equal(Object.keys(stored.value.queries).length, 1);
  assert.equal(stored.value.subscriptions[waitingSubscription.value.id].waitingGeneration, null);
  assert.ok(stored.value.metrics.queueWaitMs >= 25);

  const restarted = createAcquisitionEngine(box);
  t.after(() => restarted.close());
  const resumedOld = restarted.subscribe(oldQuery, { active: true, floorMs: 5_000 });
  const resumedNew = restarted.subscribe(newQuery, { active: true, floorMs: 5_000 });
  assert.equal(resumedOld.value.queryKey, resumedNew.value.queryKey);
  assert.equal(resumedOld.value.snapshot.rows[0].displayTitle, "old slug completion");
});

test("SHARE-03/05: failed canonical merge write retries with the original durable claim", async (t) => {
  const box = fixture(t);
  const storage = memoryStorage();
  const ticks = [];
  const options = {
    ...box,
    storage,
    setInterval: (run) => { ticks.push(run); return { unref() {} }; },
    clearInterval: () => {},
  };
  const oldEngine = createAcquisitionEngine(options);
  const newEngine = createAcquisitionEngine(options);
  t.after(() => { oldEngine.close(); newEngine.close(); });
  const oldQuery = query("slug:acme/old", "actions", {
    repository: "acme/old",
    targetKey: "github.com\0slug:acme/old",
  });
  const newQuery = query("slug:acme/new", "actions", {
    repository: "acme/new",
    targetKey: "github.com\0slug:acme/new",
  });
  const oldSubscription = oldEngine.subscribe(oldQuery, { active: true, floorMs: 5_000 });
  const newSubscription = newEngine.subscribe(newQuery, { active: true, floorMs: 5_000 });
  const oldClaim = await oldEngine.refresh(oldSubscription.value.id);
  const newClaim = await newEngine.refresh(newSubscription.value.id);
  const identity = { id: "R_CANONICAL", nameWithOwner: "acme/new" };
  await newEngine.refresh(newSubscription.value.id, {
    claim: { ...newClaim.value, accessKey: ACCESS },
    publish: { ...snapshot("new slug"), repositoryIdentity: identity },
  });
  storage.failAfterNext("unwritable");
  const failed = await oldEngine.refresh(oldSubscription.value.id, {
    claim: { ...oldClaim.value, accessKey: ACCESS },
    publish: { ...snapshot("retried old slug", { at: NOW + 1 }), repositoryIdentity: identity },
  });
  assert.equal(failed.reason, "unwritable");
  box.setNow(NOW + ACQUISITION_HEARTBEAT_MS + 1);
  ticks.forEach((run) => run());
  const merged = oldEngine.inspect(oldSubscription.value.id);
  assert.equal(merged.value.generation, 2);
  assert.equal(merged.value.snapshot.rows[0].displayTitle, "retried old slug");
});

test("SHARE-01/07: duplicate subscribers elect one producer and followers consume its generation", async (t) => {
  const box = fixture(t);
  const engines = Array.from({ length: 12 }, () => createAcquisitionEngine(box));
  t.after(() => engines.forEach((engine) => engine.close()));
  const subscriptions = engines.map((engine) => engine.subscribe(query(), { active: true, floorMs: 5_000 }));
  assert.ok(subscriptions.every((value) => value.ok));

  let calls = 0;
  const outcomes = await Promise.all(subscriptions.map((subscription, index) =>
    engines[index].refresh(subscription.value.id, {
      acquire: async () => { calls += 1; return snapshot("shared"); },
    })));

  assert.equal(calls, 1);
  assert.equal(outcomes.filter((value) => value.value?.role === "producer").length, 1);
  const stored = loadAcquisitionStore(acquisitionStorePath(box.pathOptions));
  const record = Object.values(stored.value.queries)[0];
  assert.equal(record.generation, 1);
  assert.equal(record.snapshot.rows[0].displayTitle, "shared");
  assert.equal(Object.keys(stored.value.subscriptions).length, 12);
});

test("SHARE-01: publication satisfies every subscriber in the pre-claim demand cohort", async (t) => {
  const box = fixture(t);
  const engines = Array.from({ length: 4 }, () => createAcquisitionEngine(box));
  t.after(() => engines.forEach((engine) => engine.close()));
  const cohort = engines.slice(0, 3).map((engine) =>
    engine.subscribe(query(), { active: true, floorMs: 5_000 }));
  assert.ok(cohort.every((value) => value.ok));

  let calls = 0;
  const published = await engines[1].refresh(cohort[1].value.id, {
    acquire: async () => { calls += 1; return snapshot("cohort generation"); },
  });
  assert.equal(published.value.role, "producer");

  for (const [index, subscription] of [cohort[0], cohort[2]].entries()) {
    const delayed = await engines[index * 2].refresh(subscription.value.id, {
      acquire: async () => { calls += 1; return snapshot("duplicate generation"); },
    });
    assert.equal(delayed.value.role, "follower", `delayed cohort subscriber ${index}`);
    assert.equal(delayed.value.snapshot.rows[0].displayTitle, "cohort generation");
  }
  assert.equal(calls, 1, "a delayed pre-claim subscriber produced a second generation");

  const joined = engines[3].subscribe(query(), { active: true, floorMs: 5_000 });
  const next = await engines[3].refresh(joined.value.id, {
    acquire: async () => { calls += 1; return snapshot("late join generation"); },
  });
  assert.equal(next.value.role, "producer", "a post-publication subscriber did not request a new generation");
  assert.equal(next.value.snapshot.generation, 2);
  assert.equal(calls, 2);
});

test("SHARE-07: replacing deferred work cancels its governor intent and acquisition claim together", () => {
  const calls = [];
  assert.equal(cancelCoordinatedPending({ intentId: "intent", acquisition: { id: "sub" } }, {
    cancelGovernor: (id) => calls.push(["governor", id]),
    cancelAcquisition: (claim) => calls.push(["acquisition", claim.id]),
  }), true);
  assert.deepEqual(calls, [["governor", "intent"], ["acquisition", "sub"]]);
  assert.equal(cancelCoordinatedPending(null, {}), false);
});

test("SHARE-02/07: aggregate demand takes active priority and the largest page request", async (t) => {
  const box = fixture(t);
  const first = createAcquisitionEngine(box);
  const second = createAcquisitionEngine(box);
  t.after(() => { first.close(); second.close(); });
  const quiet = first.subscribe(query(), { active: false, floorMs: 40_000, pages: 1 });
  const active = second.subscribe(query(), { active: true, floorMs: 5_000, pages: 3 });
  const claimed = await first.refresh(quiet.value.id);
  assert.deepEqual(claimed.value.demand, { active: true, floorMs: 5_000, pages: 3 });
  await first.refresh(quiet.value.id, { cancel: {
    nonce: claimed.value.nonce,
    generation: claimed.value.generation,
  } });
  second.updateDemand(active.value.id, { active: false, floorMs: 30_000, pages: 1 });
  const next = await first.refresh(quiet.value.id);
  assert.deepEqual(next.value.demand, { active: false, floorMs: 30_000, pages: 1 });
});

test("SHARE-02/03: distinct repositories publish independently", async (t) => {
  const box = fixture(t);
  const engines = Array.from({ length: 10 }, () => createAcquisitionEngine(box));
  t.after(() => engines.forEach((engine) => engine.close()));
  await Promise.all(engines.map(async (engine, index) => {
    const subscribed = engine.subscribe(query(`R_repo_${index}`), { active: true, floorMs: 5_000 });
    const result = await engine.refresh(subscribed.value.id, {
      acquire: async () => snapshot(`repository ${index}`),
    });
    assert.equal(result.value.role, "producer");
  }));
  const stored = loadAcquisitionStore(acquisitionStorePath(box.pathOptions));
  assert.equal(Object.keys(stored.value.queries).length, 10);
});

test("SHARE-02: a slow target does not delay an unrelated target publication", async (t) => {
  const box = fixture(t);
  const slowEngine = createAcquisitionEngine(box);
  const fastEngine = createAcquisitionEngine(box);
  t.after(() => { slowEngine.close(); fastEngine.close(); });
  const slow = slowEngine.subscribe(query("R_slow"), { active: true, floorMs: 5_000 });
  const fast = fastEngine.subscribe(query("R_fast"), { active: true, floorMs: 5_000 });
  let releaseSlow;
  const slowResult = slowEngine.refresh(slow.value.id, {
    acquire: () => new Promise((resolve) => { releaseSlow = resolve; }),
  });
  const fastResult = await fastEngine.refresh(fast.value.id, {
    acquire: async () => snapshot("fast target"),
  });
  assert.equal(fastResult.value.snapshot.rows[0].displayTitle, "fast target");
  assert.equal(slowEngine.inspect(slow.value.id).value.snapshot, null);
  releaseSlow(snapshot("slow target"));
  assert.equal((await slowResult).value.snapshot.rows[0].displayTitle, "slow target");
});

test("SHARE-07: join, leave, and resize retain one producer while demand remains", async (t) => {
  const box = fixture(t);
  const producer = createAcquisitionEngine(box);
  const follower = createAcquisitionEngine(box);
  t.after(() => { producer.close(); follower.close(); });
  const owned = producer.subscribe(query(), { active: true, floorMs: 5_000, pages: 1 });
  const joined = follower.subscribe(query(), { active: true, floorMs: 5_000, pages: 1 });
  let release;
  let calls = 0;
  const work = producer.refresh(owned.value.id, {
    acquire: () => {
      calls += 1;
      return new Promise((resolve) => { release = resolve; });
    },
  });
  const coalesced = await follower.refresh(joined.value.id, {
    acquire: async () => { calls += 1; return snapshot("duplicate"); },
  });
  assert.equal(coalesced.value.role, "follower");
  assert.equal(follower.updateDemand(joined.value.id,
    { active: true, floorMs: 5_000, pages: 3 }).ok, true);
  assert.equal(producer.unsubscribe(owned.value.id).ok, true);
  release(snapshot("survived leave"));
  assert.equal((await work).ok, true);
  const delivered = follower.inspect(joined.value.id);
  assert.equal(delivered.value.snapshot.rows[0].displayTitle, "survived leave");
  assert.equal(calls, 1);
  box.setNow(NOW + 5_001);
  const resized = await follower.refresh(joined.value.id);
  assert.deepEqual(resized.value.demand, { active: true, floorMs: 5_000, pages: 3 });
});

test("SHARE-07: busy unsubscribe detaches stale scope callbacks and retries durable cleanup", async (t) => {
  const box = fixture(t);
  let tick = null;
  const deliveries = [];
  const switching = createAcquisitionEngine({
    ...box,
    setInterval: (run) => { tick = run; return { unref() {} }; },
    clearInterval: () => {},
  });
  const oldQuery = query("R_old", "actions", {
    repository: "acme/old",
    targetKey: "github.com\0R_old",
  });
  const old = switching.subscribe(oldQuery, { active: true, floorMs: 5_000 },
    (value) => deliveries.push(value.rows[0].displayTitle));
  await switching.refresh(old.value.id, { acquire: async () => snapshot("old initial") });
  deliveries.length = 0;
  const stalePublisher = createAcquisitionEngine(box);
  const stale = stalePublisher.subscribe(oldQuery, { active: true, floorMs: 5_000 });
  const retiringClaim = await switching.refresh(old.value.id, { force: true });
  assert.equal(retiringClaim.value.role, "producer");

  const lockPath = `${switching.path}.lock`;
  writeFileSync(lockPath, JSON.stringify({
    pid: process.pid,
    nonce: "00000000-0000-4000-8000-000000000003",
  }));
  assert.equal(switching.unsubscribe(old.value.id).reason, "busy");
  unlinkSync(lockPath);

  const replacement = switching.subscribe({
    ...query("R_new"),
    repository: "acme/new",
    accessKey: "b".repeat(64),
    targetKey: "github.com\0R_new",
  }, { active: true, floorMs: 5_000 });
  assert.equal(replacement.ok, true);

  box.setNow(NOW + ACQUISITION_HEARTBEAT_MS + 1);
  tick();
  const cancelled = await switching.refresh(old.value.id, { cancel: {
    nonce: retiringClaim.value.nonce,
    generation: retiringClaim.value.generation,
  } });
  assert.equal(cancelled.ok, true);
  await stalePublisher.refresh(stale.value.id, {
    force: true,
    acquire: async () => snapshot("old partition update", { at: box.now() }),
  });
  switching.inspect();
  assert.deepEqual(deliveries, [], "the retired scope callback received a stale partition update");

  const stored = loadAcquisitionStore(acquisitionStorePath(box.pathOptions));
  assert.equal(Object.hasOwn(stored.value.subscriptions, old.value.id), false);
  assert.equal(Object.hasOwn(stored.value.subscriptions, replacement.value.id), true);
  switching.close();
  stalePublisher.close();
});

test("SHARE-07: close keeps retry responsibility after an indeterminate unsubscribe", (t) => {
  const box = fixture(t);
  let tick = null;
  const engine = createAcquisitionEngine({
    ...box,
    setInterval: (run) => { tick = run; return { unref() {} }; },
    clearInterval: () => {},
  });
  const subscribed = engine.subscribe(query(), { active: true, floorMs: 5_000 });
  const lockPath = `${engine.path}.lock`;
  writeFileSync(lockPath, JSON.stringify({
    pid: process.pid,
    nonce: "00000000-0000-4000-8000-000000000004",
  }));
  engine.close();
  unlinkSync(lockPath);
  box.setNow(NOW + ACQUISITION_HEARTBEAT_MS + 1);
  tick();
  const stored = loadAcquisitionStore(acquisitionStorePath(box.pathOptions));
  assert.equal(Object.hasOwn(stored.value.subscriptions, subscribed.value.id), false);
});

test("SHARE-04/08: restart retains the validated row and paired validator without rate authority", async (t) => {
  const box = fixture(t);
  const first = createAcquisitionEngine(box);
  const subscription = first.subscribe(query(), { active: true, floorMs: 5_000 });
  await first.refresh(subscription.value.id, { acquire: async () => snapshot("restart") });
  first.close();

  const second = createAcquisitionEngine(box);
  t.after(() => second.close());
  const resumed = second.subscribe(query(), { active: true, floorMs: 5_000 });
  assert.equal(resumed.value.snapshot.rows[0].displayTitle, "restart");
  assert.deepEqual(resumed.value.snapshot.entities, [{
    key: "actions\0runs",
    etag: '"runs-v1"',
    body: JSON.stringify([{ databaseId: 1, displayTitle: "restart" }]),
  }]);
  assert.equal(Object.hasOwn(resumed.value.snapshot, "rateLimit"), false);
});

test("SHARE-04: restarted acquisition sends the retained ETag and a 304 advances only source success", async (t) => {
  const box = fixture(t);
  const path = actionsRunsArgs()[0];
  const first = createAcquisitionEngine(box);
  const initial = snapshot("restart conditional");
  initial.entities = [{ key: `actions\0${path}`, etag: '"restart-etag"', body: initial.raw }];
  const subscription = first.subscribe(query(), { active: true, floorMs: 5_000 });
  await first.refresh(subscription.value.id, { acquire: async () => initial });
  first.close();

  box.setNow(NOW + 5_001);
  const restarted = createAcquisitionEngine(box);
  t.after(() => restarted.close());
  const resumed = restarted.subscribe(query(), { active: true, floorMs: 5_000 });
  const refreshed = await restarted.refresh(resumed.value.id, {
    force: true,
    acquire: async ({ snapshot: retained }) => {
      const entities = new Map(retained.entities.map((entity) => [entity.key, {
        etag: entity.etag,
        body: entity.body,
      }]));
      const fetched = await fetchActions(undefined, {
        entities,
        previousRaw: retained.raw,
        request: async (_args, { etag }) => {
          assert.equal(etag, '"restart-etag"');
          return { status: 304, body: null, etag, rateLimit: null };
        },
      });
      return {
        ...retained,
        rows: fetched.parse(),
        raw: fetched.raw,
        lastSuccessAt: box.now(),
        nextDueAt: box.now() + 5_000,
        meta: { ...retained.meta, at: box.now() },
      };
    },
  });
  assert.equal(refreshed.ok, true, JSON.stringify(refreshed));
  assert.equal(refreshed.value.snapshot.lastSuccessAt, box.now());
  assert.equal(refreshed.value.snapshot.lastChangedAt, NOW);
});

test("SHARE-04/08: unchanged publication advances success without changing content time", async (t) => {
  const box = fixture(t);
  const engine = createAcquisitionEngine(box);
  t.after(() => engine.close());
  const subscribed = engine.subscribe(query(), { active: true, floorMs: 5_000 });
  await engine.refresh(subscribed.value.id, { acquire: async () => snapshot("quiet") });
  box.setNow(NOW + 5_001);
  const second = await engine.refresh(subscribed.value.id, {
    acquire: async () => snapshot("quiet", { at: box.now() }),
  });
  assert.equal(second.value.snapshot.lastSuccessAt, box.now());
  assert.equal(second.value.snapshot.lastChangedAt, NOW);
});

test("OBS-01/03/04: diagnostics reconcile measured cost, sharing, freshness, and hold", async (t) => {
  const box = fixture(t);
  const storage = memoryStorage();
  const producer = createAcquisitionEngine({ ...box, storage, pid: 101, kill: () => {} });
  const follower = createAcquisitionEngine({ ...box, storage, pid: 102, kill: () => {} });
  t.after(() => { producer.close(); follower.close(); });
  const owned = producer.subscribe(query(), { active: true, floorMs: 5_000 });
  const joined = follower.subscribe(query(), { active: true, floorMs: 5_000 });
  const claim = await producer.refresh(owned.value.id);
  await producer.refresh(owned.value.id, { started: claim.value });
  box.setNow(NOW + 100);
  const waiting = await follower.refresh(joined.value.id);
  assert.equal(waiting.value.role, "follower");
  await follower.refresh(joined.value.id);
  assert.equal(producer.recordMetrics({ observerCalls: 1 }).ok, true);
  box.setNow(NOW + 500);
  const published = await producer.refresh(owned.value.id, {
    claim: { ...claim.value, accessKey: ACCESS },
    publish: {
      ...snapshot("measured"),
      requestMetrics: {
        httpRequests: 5,
        rest200: 2,
        rest304: 1,
        coreUnits: 2,
        graphqlUnits: 7,
      },
    },
  });
  assert.equal(published.ok, true, JSON.stringify(published));
  const diagnostic = acquisitionDiagnostics(storage.load().value, {
    source: "standalone",
    nowMs: box.now(),
  });
  assert.deepEqual(diagnostic.metrics, {
    httpRequests: 5,
    rest200: 2,
    rest304: 1,
    coreUnits: 2,
    graphqlUnits: 7,
    failedRequests: 0,
    uncertainCoreUnits: 0,
    uncertainGraphqlUnits: 0,
    observerCalls: 1,
    cacheHits: 0,
    joinedFollowers: 1,
    queueWaitMs: 400,
  });
  assert.equal(diagnostic.source, "standalone");
  assert.equal(diagnostic.activeQueries, 1);
  assert.equal(diagnostic.activeSubscribers, 2);
  assert.equal(diagnostic.queries[0].lastSuccessAt, NOW);
  assert.equal(diagnostic.queries[0].lastChangedAt, NOW);
  assert.equal(diagnostic.queries[0].coalescedConsumers, 2);
  assert.equal(diagnostic.queries[0].hold, null);
});

test("OBS-01: cached subscribers are cache hits, not joined producer followers", async (t) => {
  const box = fixture(t);
  const engine = createAcquisitionEngine(box);
  t.after(() => engine.close());
  const producer = engine.subscribe(query(), { active: true, floorMs: 5_000 });
  await engine.refresh(producer.value.id, { acquire: async () => snapshot("cached") });
  const cached = engine.subscribe(query(), { active: true, floorMs: 5_000 });
  assert.equal(cached.ok, true);
  const metrics = engine.diagnostics().value.metrics;
  assert.equal(metrics.cacheHits, 1);
  assert.equal(metrics.joinedFollowers, 0);
});

test("OBS-01: failed requests preserve last-good data and only release proven cost", async (t) => {
  const box = fixture(t);
  const engine = createAcquisitionEngine(box);
  t.after(() => engine.close());
  const subscription = engine.subscribe(query(), { active: true, floorMs: 5_000 });
  await engine.refresh(subscription.value.id, { acquire: async () => snapshot("last good") });
  box.setNow(NOW + 5_001);
  const first = await engine.refresh(subscription.value.id, { force: true });
  await engine.refresh(subscription.value.id, { started: first.value });
  const failed = await engine.refresh(subscription.value.id, {
    claim: { ...first.value, accessKey: ACCESS },
    failure: { hold: "primary", requestMetrics: { httpRequests: 1, failedRequests: 1 } },
  });
  assert.equal(failed.ok, true);
  assert.equal(engine.inspect(subscription.value.id).value.snapshot.rows[0].displayTitle, "last good");
  let diagnostic = engine.diagnostics().value;
  assert.equal(diagnostic.metrics.httpRequests, 1);
  assert.equal(diagnostic.metrics.failedRequests, 1);
  assert.equal(diagnostic.metrics.uncertainCoreUnits, 1);
  assert.equal(diagnostic.queries[0].hold, "primary");

  const second = await engine.refresh(subscription.value.id, { force: true });
  await engine.refresh(subscription.value.id, { started: second.value });
  await engine.refresh(subscription.value.id, {
    claim: { ...second.value, accessKey: ACCESS },
    failure: {
      hold: "secondary",
      requestMetrics: { httpRequests: 1, failedRequests: 1, coreUnits: 1 },
    },
  });
  diagnostic = engine.diagnostics().value;
  assert.equal(diagnostic.metrics.httpRequests, 2);
  assert.equal(diagnostic.metrics.failedRequests, 2);
  assert.equal(diagnostic.metrics.coreUnits, 1);
  assert.equal(diagnostic.metrics.uncertainCoreUnits, 1);
  assert.equal(diagnostic.queries[0].hold, "secondary");
});

test("OBS-01: authoritative observer evidence retires bounded uncertainty by access and epoch", async (t) => {
  const box = fixture(t);
  const engine = createAcquisitionEngine(box);
  t.after(() => engine.close());
  const accessA = engine.subscribe(query("R_receipt", "actions", { accessKey: "a".repeat(64) }),
    { active: true, floorMs: 5_000 });
  const accessB = engine.subscribe(query("R_receipt", "actions", { accessKey: "b".repeat(64) }),
    { active: true, floorMs: 5_000 });
  for (const [index, subscribed] of [accessA, accessB].entries()) {
    const claim = await engine.refresh(subscribed.value.id, { force: true });
    const accessKey = index === 0 ? "a".repeat(64) : "b".repeat(64);
    await engine.refresh(subscribed.value.id, { started: {
      ...claim.value,
      receipt: { reservationId: `reservation:${index}`, accessKey, epochs: { core: "core:one" } },
    } });
    await engine.refresh(subscribed.value.id, {
      claim: { ...claim.value, accessKey },
      failure: { hold: "disconnected", requestMetrics: { httpRequests: 1, failedRequests: 1 } },
    });
  }
  assert.equal(engine.diagnostics().value.metrics.uncertainCoreUnits, 2);
  assert.equal(engine.reconcileUncertainty("a".repeat(64), {
    core: { epoch: "core:one", observedAt: NOW - 1 },
  }).ok, true);
  assert.equal(engine.diagnostics().value.metrics.uncertainCoreUnits, 2);
  box.setNow(NOW + 1);
  engine.reconcileUncertainty("a".repeat(64), {
    core: { epoch: "core:one", observedAt: box.now() },
  });
  assert.equal(engine.diagnostics().value.metrics.uncertainCoreUnits, 1);
  engine.reconcileUncertainty("b".repeat(64), {
    core: { epoch: "core:two", observedAt: NOW - 1 },
  });
  assert.equal(engine.diagnostics().value.metrics.uncertainCoreUnits, 0);
  assert.deepEqual(loadAcquisitionStore(acquisitionStorePath(box.pathOptions)).value.uncertainReceipts, {});
});

test("OBS-01: production fetch seams reconcile 200, 304, GraphQL, and failed HTTP", async (t) => {
  const box = fixture(t);
  const engine = createAcquisitionEngine(box);
  t.after(() => engine.close());
  const entities = new Map();
  const actionBody = snapshot("production metrics").raw;
  const first = await fetchActions(undefined, {
    entities,
    request: async () => ({ status: 200, body: actionBody, etag: '"runs-v1"', rateLimit: null }),
  });
  publishStagedEntities(entities, first.stagedEntities, "changed");
  const second = await fetchActions(undefined, {
    entities,
    previousRaw: first.raw,
    request: async (_args, { etag }) => ({ status: 304, body: "", etag, rateLimit: null }),
  });
  const graphql = await fetchGraphqlList("issues", (node) => ({ number: node.number }), {
    fetchPage: async () => ({
      ok: true,
      status: 200,
      observedCost: 2,
      overrun: false,
      observations: [{ resource: "graphql", limit: 5_000, used: 2, remaining: 4_998,
        resetMs: NOW + 3_600_000, source: "response-header", receivedAt: NOW, cost: 2 }],
      data: {
        repository: {
          issues: {
            totalCount: 1,
            pageInfo: { hasNextPage: false, endCursor: null },
            nodes: [{ number: 7 }],
          },
        },
      },
    }),
  });
  for (const result of [first, second, graphql]) {
    assert.equal(engine.recordMetrics(acquisitionRequestMetrics(result)).ok, true);
  }

  const failedResponse = async (statusText) => {
    try {
      await fetchActions(undefined, {
        request: (args, options) => ghApi(args, {
          ...options,
          run: async () => {
            const error = new Error(statusText);
            error.httpStarted = true;
            error.stdout = statusText.startsWith("HTTP/") ? `${statusText}\r\n\r\nfailed` : "";
            throw error;
          },
        }),
      });
    } catch (error) {
      return error;
    }
    assert.fail("failed request unexpectedly resolved");
  };
  const subscription = engine.subscribe(query(), { active: true, floorMs: 5_000 });
  for (const error of [
    await failedResponse("HTTP/1.1 403 Forbidden"),
    await failedResponse("HTTP/1.1 429 Too Many Requests"),
    await failedResponse("HTTP/1.1 503 Service Unavailable"),
    await failedResponse("socket closed"),
  ]) {
    assert.equal(Object.hasOwn(error.requestMetrics, "coreUnits"), false);
    const claim = await engine.refresh(subscription.value.id, { force: true });
    await engine.refresh(subscription.value.id, { started: claim.value });
    await engine.refresh(subscription.value.id, {
      claim: { ...claim.value, accessKey: ACCESS },
      failure: { hold: "primary", requestMetrics: error.requestMetrics },
    });
  }
  const metrics = engine.diagnostics().value.metrics;
  assert.deepEqual(metrics, {
    httpRequests: 7,
    rest200: 1,
    rest304: 1,
    coreUnits: 1,
    graphqlUnits: 2,
    uncertainCoreUnits: 4,
    uncertainGraphqlUnits: 0,
    failedRequests: 4,
    observerCalls: 0,
    cacheHits: 0,
    joinedFollowers: 0,
    queueWaitMs: 0,
  });
});

test("OBS-01: Actions catalog metrics include mixed and failed admitted requests", async () => {
  const runsBody = JSON.stringify([{ databaseId: 1, displayTitle: "CI", workflowName: "",
    workflowId: 10, number: 1, headBranch: "develop", status: "completed", conclusion: "success",
    startedAt: "2026-09-05T00:00:00Z", updatedAt: "2026-09-05T00:01:00Z", url: "" }]);
  const workflowPath = actionsWorkflowsArgs()[0];
  const entities = new Map([[`actions\0${workflowPath}`, {
    etag: '"catalog"', body: JSON.stringify([{ id: 10, name: "Checks" }]),
  }]]);
  const mixed = await fetchActions(undefined, {
    entities,
    governor: { scope: {}, leaseId: "lease" },
    request: async (args) => args[0] === workflowPath
      ? { status: 304, body: "", etag: '"catalog"', rateLimit: null }
      : { status: 200, body: runsBody, etag: '"runs"', rateLimit: null },
    admit: async ({ run }) => ({ ok: true, value: await run(undefined), reservationId: "reservation:catalog" }),
  });
  assert.equal(mixed.restSpent, 1, "the tab reservation settles only the runs request");
  assert.deepEqual(acquisitionRequestMetrics(mixed), {
    httpRequests: 2, rest200: 1, rest304: 1, coreUnits: 1, failedRequests: 0,
  });

  const failed = await fetchActions(undefined, {
    governor: { scope: {}, leaseId: "lease" },
    request: async (args) => {
      if (args[0] !== workflowPath) return { status: 200, body: runsBody, etag: '"runs"', rateLimit: null };
      throw Object.assign(new Error("socket closed"), {
        requestMetrics: { httpRequests: 1, failedRequests: 1 },
      });
    },
    admit: async ({ run }) => {
      try { return { ok: true, value: await run(undefined), reservationId: "reservation:catalog" }; }
      catch (error) { return { ok: false, error, reservationId: "reservation:catalog" }; }
    },
  });
  assert.deepEqual(acquisitionRequestMetrics(failed), {
    httpRequests: 2, rest200: 1, rest304: 0, coreUnits: 1, failedRequests: 1,
  });
});

test("OBS-01: mixed Security endpoints retain only failed request uncertainty", async (t) => {
  const sources = [
    { key: "security-ok", name: "Security ok", path: "ok", priorityQueries: [], jq: ".",
      unavailable: "unavailable", map: (row) => row },
    { key: "security-failed", name: "Security failed", path: "failed", priorityQueries: [], jq: ".",
      unavailable: "unavailable", map: (row) => row },
  ];
  const result = await fetchSecurity(null, {
    sources,
    request: async ({ args }) => {
      if (args[0] === "ok") return {
        status: 200,
        body: "[]",
        staged: null,
        observations: [],
        requestMetrics: { httpRequests: 1, rest200: 1, coreUnits: 1, failedRequests: 0 },
      };
      throw Object.assign(new Error("socket closed"), {
        httpStarted: true,
        requestMetrics: { httpRequests: 1, failedRequests: 1 },
      });
    },
  });
  assert.deepEqual(result.requestMetrics, {
    httpRequests: 2,
    rest200: 1,
    coreUnits: 1,
    failedRequests: 1,
    uncertainCoreUnits: 1,
  });

  const box = fixture(t);
  const engine = createAcquisitionEngine(box);
  t.after(() => engine.close());
  const subscribed = engine.subscribe(query("R_security", "security"),
    { active: true, floorMs: 5_000 });
  const claim = await engine.refresh(subscribed.value.id, { force: true });
  await engine.refresh(subscribed.value.id, { started: {
    ...claim.value,
    receipt: {
      reservationId: "reservation:security",
      accessKey: ACCESS,
      epochs: { core: "core:security" },
    },
  } });
  await engine.refresh(subscribed.value.id, {
    claim: { ...claim.value, accessKey: ACCESS },
    failure: { hold: "primary", requestMetrics: result.requestMetrics },
  });
  const metrics = engine.diagnostics().value.metrics;
  assert.equal(metrics.httpRequests, 2);
  assert.equal(metrics.rest200, 1);
  assert.equal(metrics.coreUnits, 1);
  assert.equal(metrics.failedRequests, 1);
  assert.equal(metrics.uncertainCoreUnits, 1);
});

test("OBS-01: invalid Security JSON counts its received 200 exactly once", async () => {
  const source = {
    key: "security-invalid-json",
    name: "Security invalid JSON",
    path: "invalid-json",
    priorityQueries: [],
    jq: ".",
    unavailable: "unavailable",
    map: (row) => row,
  };
  const result = await fetchSecurity(null, {
    sources: [source],
    request: async () => ({
      status: 200,
      body: "not-json",
      staged: null,
      observations: [],
      requestMetrics: { httpRequests: 1, rest200: 1, coreUnits: 1, failedRequests: 0 },
    }),
  });
  assert.deepEqual(result.requestMetrics, {
    httpRequests: 1,
    rest200: 1,
    coreUnits: 1,
    failedRequests: 0,
  });
  assert.equal(result.httpRequests, 1);
  assert.equal(result.rest200, 1);
  assert.equal(result.failedRequests, 0);
  assert.equal(result.parse().unusable, true);
});

test("OBS-03: persisted and derived holds use acquisition state", async (t) => {
  const box = fixture(t);
  const owner = createAcquisitionEngine(box);
  const follower = createAcquisitionEngine(box);
  t.after(() => { owner.close(); follower.close(); });
  const subscribed = owner.subscribe(query(), { active: true, floorMs: 5_000 });
  for (const reason of ["observer", "primary", "secondary", "disconnected"]) {
    assert.equal(owner.setHold(subscribed.value.id, reason).ok, true);
    assert.equal(owner.diagnostics().value.queries[0].hold, reason);
  }
  assert.equal(owner.setHold(subscribed.value.id, null).ok, true);
  await owner.refresh(subscribed.value.id, { acquire: async () => snapshot("cache-only") });
  box.setNow(NOW + 5_001);
  const joined = follower.subscribe(query(), { active: true, floorMs: 5_000 });
  const claim = await owner.refresh(subscribed.value.id, { force: true });
  await follower.refresh(joined.value.id);
  assert.equal(owner.diagnostics().value.queries[0].hold, "shared-wait");
  await owner.refresh(subscribed.value.id, { cancel: claim.value });
  assert.equal(owner.setHold(subscribed.value.id, "observer").ok, true);
  assert.equal(owner.unsubscribe(subscribed.value.id).ok, true);
  assert.equal(follower.unsubscribe(joined.value.id).ok, true);
  const cached = owner.diagnostics().value;
  assert.equal(cached.activeQueries, 0);
  assert.equal(cached.activeSubscribers, 0);
  assert.equal(cached.queries[0].hold, "cache-only");
});

test("OBS-03: runtime holds target one access partition and clear on cached follower recovery", async (t) => {
  const box = fixture(t);
  const runtime = createAcquisitionEngine(box);
  t.after(() => runtime.close());
  const accessA = runtime.subscribe(query("R_widget", "actions", { accessKey: "a".repeat(64) }),
    { active: true, floorMs: 5_000 });
  const accessB = runtime.subscribe(query("R_widget", "actions", { accessKey: "b".repeat(64) }),
    { active: true, floorMs: 5_000 });
  await runtime.refresh(accessA.value.id, { acquire: async () => snapshot("access A") });
  await runtime.refresh(accessB.value.id, { acquire: async () => snapshot("access B") });

  const current = new Map([["actions", accessA.value]]);
  assert.equal(setRuntimeAcquisitionHold(runtime, current, "actions", "observer", "a".repeat(64)).ok, true);
  let diagnostics = runtime.diagnostics().value.queries;
  assert.equal(diagnostics.find((item) => item.resource === "actions" && item.hold === "observer")?.hold,
    "observer");
  assert.equal(diagnostics.filter((item) => item.hold === "observer").length, 1);

  assert.equal(setRuntimeAcquisitionHold(runtime, current, "actions", null, "a".repeat(64)).ok, true);
  assert.equal(setRuntimeAcquisitionHold(
    runtime,
    new Map([["issues", accessA.value]]),
    "issues",
    "primary",
    "a".repeat(64),
  ).reason, "stale-access");
  current.set("actions", accessB.value);
  assert.equal(setRuntimeAcquisitionHold(runtime, current, "actions", "primary", null).reason,
    "stale-access");
  assert.equal(setRuntimeAcquisitionHold(runtime, current, "actions", "primary", "a".repeat(64)).reason,
    "stale-access");
  assert.equal(setRuntimeAcquisitionHold(runtime, current, "actions", "primary", "b".repeat(64)).ok, true);
  diagnostics = runtime.diagnostics().value.queries;
  assert.equal(diagnostics.filter((item) => item.hold === "primary").length, 1);
  assert.equal(runtime.inspect(accessA.value.id).value.hold, null);

  const reused = await runtime.refresh(accessB.value.id);
  assert.equal(reused.value.role, "follower");
  assert.equal(reused.value.reason, "fresh");
  assert.equal(setRuntimeAcquisitionHold(runtime, current, "actions", null, "b".repeat(64)).ok, true);
  assert.equal(runtime.inspect(accessB.value.id).value.hold, null);
  diagnostics = runtime.diagnostics().value.queries;
  assert.equal(diagnostics.some((item) => item.hold === "observer" || item.hold === "primary"), false);
});

test("SHARE-05: a suspended live owner is not stolen, but a confirmed dead owner is fenced", async (t) => {
  const box = fixture(t);
  const owner = createAcquisitionEngine({ ...box, pid: 111, kill: () => {} });
  const follower = createAcquisitionEngine({ ...box, pid: 222, kill: (pid) => {
    if (pid === 111 || pid === 222) return;
    throw Object.assign(new Error("dead"), { code: "ESRCH" });
  } });
  t.after(() => { owner.close(); follower.close(); });
  const owned = owner.subscribe(query(), { active: true, floorMs: 5_000 });
  const followed = follower.subscribe(query(), { active: true, floorMs: 5_000 });
  const claim = await owner.refresh(owned.value.id);
  assert.equal(claim.value.role, "producer");
  const started = await owner.refresh(owned.value.id, { started: {
    nonce: claim.value.nonce,
    generation: claim.value.generation,
  } });
  assert.equal(started.ok, true);
  assert.equal(owner.inspect(owned.value.id).value.claim.started, true);
  box.setNow(NOW + ACQUISITION_CLAIM_TTL_MS + 1);
  const held = await follower.refresh(followed.value.id);
  assert.equal(held.value.role, "follower");
  assert.equal(held.value.reason, "owner-live");

  const deadFollower = createAcquisitionEngine({ ...box, pid: 333, kill: (pid) => {
    if (pid === 111) throw Object.assign(new Error("dead"), { code: "ESRCH" });
    if (pid === 333) return;
  } });
  t.after(() => deadFollower.close());
  const deadSub = deadFollower.subscribe(query(), { active: true, floorMs: 5_000 });
  const takeover = await deadFollower.refresh(deadSub.value.id, { acquire: async () => snapshot("takeover", { at: box.now() }) });
  assert.equal(takeover.value.role, "producer");
  assert.equal(takeover.value.snapshot.rows[0].displayTitle, "takeover");
});

test("SHARE-05: heartbeats cannot extend a live owner's unstarted claim past 180 seconds", async (t) => {
  const box = fixture(t);
  let beat;
  const options = { ...box, kill: () => {}, setInterval: (run) => { beat ??= run; return { unref() {} }; },
    clearInterval: () => {} };
  const owner = createAcquisitionEngine({ ...options, pid: 111 });
  const follower = createAcquisitionEngine({ ...options, pid: 222 });
  t.after(() => { owner.close(); follower.close(); });
  const a = owner.subscribe(query(), { active: true, floorMs: 5_000 });
  const b = follower.subscribe(query(), { active: true, floorMs: 5_000 });
  const first = await owner.refresh(a.value.id);
  for (let elapsed = 10_000; elapsed < 180_000; elapsed += 10_000) {
    box.setNow(NOW + elapsed);
    beat();
  }
  assert.equal((await follower.refresh(b.value.id)).value.role, "follower");
  box.setNow(NOW + 180_000);
  const second = await follower.refresh(b.value.id);
  assert.equal(second.value.role, "producer");
  assert.notEqual(second.value.nonce, first.value.nonce);
  assert.equal((await owner.refresh(a.value.id, { started: first.value })).reason, "stale");
});

test("SHARE-05: repeated start accepts only the exact receipt and authorizes one dispatch", async (t) => {
  const box = fixture(t);
  const engine = createAcquisitionEngine(box);
  t.after(() => engine.close());
  const sub = engine.subscribe(query(), { active: true, floorMs: 5_000 });
  const claim = (await engine.refresh(sub.value.id)).value;
  const receipt = { reservationId: "reservation:one", accessKey: ACCESS, epochs: { core: "core:one" } };
  const first = await engine.refresh(sub.value.id, { started: { ...claim, receipt } });
  assert.equal(first.value.status, "started");
  const repeated = await engine.refresh(sub.value.id, { started: { ...claim, receipt } });
  assert.equal(repeated.value.status, "already-started");
  const other = await engine.refresh(sub.value.id, { started: { ...claim, receipt: {
    ...receipt, reservationId: "reservation:two" } } });
  assert.equal(other.reason, "receipt-mismatch");
  const differentEpoch = await engine.refresh(sub.value.id, { started: { ...claim, receipt: {
    ...receipt, epochs: { core: "core:two" } } } });
  assert.equal(differentEpoch.reason, "receipt-mismatch");
  let dispatches = 0;
  const repeatedDispatch = await runStartedAcquisitionTransport(
    () => engine.refresh(sub.value.id, { started: { ...claim, receipt } }),
    () => { dispatches += 1; return "dispatched"; });
  assert.equal(repeatedDispatch.reason, "already-started");
  assert.equal(dispatches, 0);
});

test("SHARE-04/05: staged publication carries changed validators, page info, and 304 cadence", () => {
  const key = "issues\0page:one";
  const local = new Map([[key, { etag: '"old"', body: "old" }]]);
  const changed = stagedAcquisitionPublicationView({
    entities: local,
    stagedEntities: new Map([[key, { etag: '"new"', body: "new" }]]),
    transitionKind: "changed",
    pageState: { pages: 1, hasNextPage: false },
    loadedPages: 2,
    hasNextPage: true,
    unchangedCount: 2,
  });
  assert.equal(local.get(key).etag, '"old"', "publication must leave local cache untouched until fenced");
  assert.equal(changed.entities.get(key).etag, '"new"');
  assert.deepEqual(changed.pageState, { pages: 2, hasNextPage: true });
  assert.equal(changed.unchangedCount, 0);
  const notModified = stagedAcquisitionPublicationView({
    entities: changed.entities,
    stagedEntities: new Map(),
    transitionKind: "unchanged",
    pageState: changed.pageState,
    loadedPages: 2,
    hasNextPage: true,
    unchangedCount: 1,
  });
  assert.equal(notModified.entities.get(key).etag, '"new"');
  assert.deepEqual(notModified.pageState, { pages: 2, hasNextPage: true });
  assert.equal(notModified.unchangedCount, 2);
});

test("SHARE-07: a coalesced governor intent is adopted only for its exact local claim and scope", () => {
  const scope = { accessKey: ACCESS, hash: "quota:one" };
  const acquisition = { claim: { nonce: "nonce:one", generation: 1, accessKey: ACCESS } };
  const existing = { intentId: "intent:old", acquisition, cleanupScope: scope };
  const decision = { intentId: "intent:old", status: "pending", coalesced: true };
  assert.equal(coalescedAcquisitionIntentMatches(existing, decision, acquisition, scope), true);
  assert.equal(coalescedAcquisitionIntentMatches(existing, { ...decision, intentId: "intent:new" },
    acquisition, scope), false);
  assert.equal(coalescedAcquisitionIntentMatches(existing, decision, {
    claim: { ...acquisition.claim, nonce: "nonce:other" },
  }, scope), false);
  assert.equal(coalescedAcquisitionIntentMatches(existing, decision, acquisition,
    { ...scope, hash: "quota:other" }), false);
  assert.equal(coalescedAcquisitionIntentMatches({ ...existing, cleanupPending: true },
    decision, acquisition, scope), false);
});

test("SHARE-07: cleanup retry is terminal after unsubscribe removed the same claim", async (t) => {
  const box = fixture(t);
  const engine = createAcquisitionEngine(box);
  t.after(() => engine.close());
  const sub = engine.subscribe(query(), { active: true, floorMs: 5_000 });
  const claim = (await engine.refresh(sub.value.id)).value;
  assert.equal(engine.unsubscribe(sub.value.id).ok, true);
  assert.equal((await engine.refresh(sub.value.id, { cancel: claim })).reason, "stale");
  assert.equal(Object.values(loadAcquisitionStore(engine.path).value.queries)[0].claim, null);
});

test("SHARE-07: pending replay rejects a replaced same-account query before its slot starts", () => {
  const pending = { acquisition: { id: "subscription:one", queryKey: "query:one",
    claim: { accessKey: ACCESS } } };
  const subscription = { id: "subscription:one", requestedKey: "query:one" };
  assert.equal(pendingAcquisitionMatches(pending, subscription, "query:one", ACCESS), true);
  assert.equal(pendingAcquisitionMatches(pending, { ...subscription, id: "subscription:two" },
    "query:one", ACCESS), false);
  assert.equal(pendingAcquisitionMatches(pending, subscription, "query:two", ACCESS), false);
  assert.equal(pendingAcquisitionMatches(pending, subscription, "query:one", "b".repeat(64)), false);
});

test("SHARE-07: old-account cleanup uses its frozen ledger after identity changes", (t) => {
  const box = fixture(t);
  let current = { effectiveHost: "github.com", authIdentity: "old" };
  const live = createGovernorScope({ effectiveHost: "github.com", authIdentity: "old",
    identityProvider: () => current, now: box.now, env: box.pathOptions.env }).value;
  const frozen = frozenGovernorScope(live);
  assert.equal(frozen.identityProvider, null);
  const leaseId = randomUUID();
  assert.equal(registerLease(live, { id: leaseId, expiresAt: NOW + GOVERNOR_LEASE_TTL_MS,
    floorMs: 5_000, activeTab: "actions", phaseSeed: { seed: leaseId, registeredAt: NOW },
    demand: { core: 1, graphql: 0 } }).ok, true);
  const intentId = randomUUID();
  assert.equal(registerIntent(live, { id: intentId, leaseId, tab: "actions", priority: "active",
    costs: { core: 1, graphql: 0 }, requestedAt: NOW,
    expiresAt: NOW + GOVERNOR_LEASE_TTL_MS }).ok, true);
  current = { effectiveHost: "github.com", authIdentity: "new" };
  assert.equal(cancelIntent(live, intentId, NOW).reason, "stale");
  assert.equal(cancelIntent(frozen, intentId, NOW).value.status, "cancelled");
});

test("SHARE-07: cross-query coalescing cancels the old intent before a fresh claim binds", async (t) => {
  const box = fixture(t);
  const scope = createGovernorScope({ effectiveHost: "github.com", authIdentity: "coalesced-query",
    now: box.now, env: box.pathOptions.env }).value;
  const leaseId = randomUUID();
  assert.equal(registerLease(scope, { id: leaseId, expiresAt: NOW + GOVERNOR_LEASE_TTL_MS,
    floorMs: 5_000, activeTab: "actions", phaseSeed: { seed: leaseId, registeredAt: NOW },
    demand: { core: 1, graphql: 0 } }).ok, true);
  const engine = createAcquisitionEngine(box);
  t.after(() => engine.close());
  const oldSub = engine.subscribe(query("R_old"), { active: true, floorMs: 5_000 });
  const newSub = engine.subscribe(query("R_new"), { active: true, floorMs: 5_000 });
  const oldClaim = (await engine.refresh(oldSub.value.id)).value;
  const newClaim = (await engine.refresh(newSub.value.id)).value;
  const oldId = randomUUID();
  const newId = randomUUID();
  const request = (id) => ({ id, leaseId, tab: "actions", priority: "active",
    costs: { core: 1, graphql: 0 }, requestedAt: NOW,
    expiresAt: NOW + GOVERNOR_LEASE_TTL_MS });
  assert.equal(registerIntent(scope, request(oldId)).ok, true);
  const duplicate = registerIntent(scope, request(newId));
  assert.equal(duplicate.value.coalesced, true);
  assert.equal(duplicate.value.intentId, oldId);
  const localOld = { intentId: oldId,
    acquisition: { claim: { ...oldClaim, accessKey: ACCESS } },
    cleanupScope: frozenGovernorScope(scope) };
  assert.equal(coalescedAcquisitionIntentMatches(localOld, duplicate.value,
    { claim: { ...newClaim, accessKey: ACCESS } }, scope), false);
  assert.equal(cancelIntent(scope, duplicate.value.intentId, NOW).value.status, "cancelled");
  const fresh = registerIntent(scope, request(newId));
  assert.equal(fresh.ok, true);
  assert.equal(fresh.value.intentId, newId);
});

test("SHARE-05/07: a started governor slot remains charged after claim takeover beats markStarted", async (t) => {
  const box = fixture(t);
  const scope = createGovernorScope({ effectiveHost: "github.com", authIdentity: "start-race",
    now: box.now, env: box.pathOptions.env }).value;
  const leaseId = randomUUID();
  assert.equal(registerLease(scope, { id: leaseId, expiresAt: NOW + GOVERNOR_LEASE_TTL_MS,
    floorMs: 5_000, activeTab: "actions", phaseSeed: { seed: leaseId, registeredAt: NOW },
    demand: { core: 1, graphql: 0 } }).ok, true);
  const budgets = { core: { limit: 5_000, used: 0, remaining: 5_000, resetMs: NOW + 3_600_000 },
    graphql: { limit: 5_000, used: 0, remaining: 5_000, resetMs: NOW + 3_600_000 } };
  for (const resource of ["core", "graphql"]) {
    const probe = claimProbe(scope, leaseId, NOW, resource);
    assert.equal(publishProbe(scope, leaseId, probe.value.nonce, budgets, NOW, resource).ok, true);
  }
  const owner = createAcquisitionEngine({ ...box, pid: 111, kill: () => {} });
  const follower = createAcquisitionEngine({ ...box, pid: 222, kill: () => {} });
  t.after(() => { owner.close(); follower.close(); });
  const a = owner.subscribe(query(), { active: true, floorMs: 5_000 });
  const b = follower.subscribe(query(), { active: true, floorMs: 5_000 });
  const claim = (await owner.refresh(a.value.id)).value;
  const intentId = randomUUID();
  const decision = registerIntent(scope, { id: intentId, leaseId, tab: "actions", priority: "active",
    costs: { core: 1, graphql: 0 }, requestedAt: NOW,
    expiresAt: NOW + GOVERNOR_LEASE_TTL_MS }).value;
  assert.equal(decision.status, "scheduled");
  assert.equal(startReservation(scope, decision.reservationId, decision.notBefore).value.status, "started");
  box.setNow(NOW + 180_000);
  assert.equal((await follower.refresh(b.value.id)).value.role, "producer");
  assert.equal((await owner.refresh(a.value.id, { started: { ...claim,
    receipt: { reservationId: decision.reservationId, accessKey: ACCESS,
      epochs: { core: "core:old" } } } })).reason, "stale");
  assert.equal(inspectGovernor(scope, NOW + 180_000).value.reservations[decision.reservationId].status,
    "started");
});

test("SHARE-07: failed two-store cleanup retries exact intent and claim", async (t) => {
  const box = fixture(t);
  const scope = createGovernorScope({ effectiveHost: "github.com", authIdentity: "cleanup-retry",
    now: box.now, env: box.pathOptions.env }).value;
  const leaseId = randomUUID();
  assert.equal(registerLease(scope, { id: leaseId, expiresAt: NOW + GOVERNOR_LEASE_TTL_MS,
    floorMs: 5_000, activeTab: "actions", phaseSeed: { seed: leaseId, registeredAt: NOW },
    demand: { core: 1, graphql: 0 } }).ok, true);
  const intentId = randomUUID();
  assert.equal(registerIntent(scope, { id: intentId, leaseId, tab: "actions", priority: "active",
    costs: { core: 1, graphql: 0 }, requestedAt: NOW,
    expiresAt: NOW + GOVERNOR_LEASE_TTL_MS }).ok, true);
  const storage = memoryStorage();
  const engine = createAcquisitionEngine({ ...box, storage });
  t.after(() => engine.close());
  const sub = engine.subscribe(query(), { active: true, floorMs: 5_000 });
  const claim = (await engine.refresh(sub.value.id)).value;
  const governorLock = `${scope.path}.lock`;
  writeFileSync(governorLock, JSON.stringify({ pid: process.pid, nonce: randomUUID() }), { mode: 0o600 });
  assert.equal(cancelIntent(scope, intentId, NOW).reason, "busy");
  storage.failNext("busy");
  assert.equal((await engine.refresh(sub.value.id, { cancel: claim })).reason, "busy");
  unlinkSync(governorLock);
  assert.equal(cancelIntent(scope, intentId, NOW).value.status, "cancelled");
  assert.equal((await engine.refresh(sub.value.id, { cancel: claim })).ok, true);
  assert.equal(engine.inspect(sub.value.id).value.claim, null);
});

test("SHARE-05: a started live claim has a finite deadline and keeps uncertain receipt debt", async (t) => {
  const box = fixture(t);
  const owner = createAcquisitionEngine({ ...box, pid: 111, kill: () => {} });
  const follower = createAcquisitionEngine({ ...box, pid: 222, kill: () => {} });
  t.after(() => { owner.close(); follower.close(); });
  const a = owner.subscribe(query(), { active: true, floorMs: 5_000 });
  const b = follower.subscribe(query(), { active: true, floorMs: 5_000 });
  const first = (await owner.refresh(a.value.id)).value;
  const receipt = { reservationId: "reservation:old", accessKey: ACCESS,
    epochs: { core: "core:old" } };
  assert.equal((await owner.refresh(a.value.id, { started: { ...first, receipt } })).value.status, "started");
  box.setNow(NOW + ACQUISITION_STARTED_DEADLINE_MS - 1);
  assert.equal((await follower.refresh(b.value.id)).value.role, "follower");
  box.setNow(NOW + ACQUISITION_STARTED_DEADLINE_MS);
  const next = (await follower.refresh(b.value.id)).value;
  assert.equal(next.role, "producer");
  assert.equal(owner.currentClaim(a.value.id, { ...first, receipt }).reason, "stale");
  const denied = await owner.refresh(a.value.id, { claim: { ...first, accessKey: ACCESS },
    publish: snapshot("old") });
  assert.equal(denied.reason, "stale");
  assert.equal(owner.inspect(a.value.id).value.snapshot, null);
  const saved = loadAcquisitionStore(owner.path).value;
  assert.equal(saved.uncertainReceipts["reservation:old:core"].reservationId, "reservation:old");
  assert.equal((await follower.refresh(b.value.id, { started: {
    ...next, receipt: { reservationId: "reservation:new", accessKey: ACCESS,
      epochs: { core: "core:old" } },
  } })).value.status, "started");
});

test("SHARE-05: an overbound started producer cannot publish without a follower takeover", async (t) => {
  const box = fixture(t);
  const engine = createAcquisitionEngine(box);
  t.after(() => engine.close());
  const sub = engine.subscribe(query(), { active: true, floorMs: 5_000 });
  const claim = (await engine.refresh(sub.value.id)).value;
  const receipt = { reservationId: "reservation:overbound", accessKey: ACCESS,
    epochs: { core: "core:one" } };
  assert.equal((await engine.refresh(sub.value.id, { started: { ...claim, receipt } })).ok, true);
  box.setNow(NOW + ACQUISITION_STARTED_DEADLINE_MS - 1);
  assert.equal(engine.currentClaim(sub.value.id, { ...claim, receipt }).ok, true);
  box.setNow(NOW + ACQUISITION_STARTED_DEADLINE_MS);
  assert.equal(engine.currentClaim(sub.value.id, { ...claim, receipt }).reason, "stale");
  const late = await engine.refresh(sub.value.id, { claim: { ...claim, accessKey: ACCESS },
    publish: snapshot("late") });
  assert.equal(late.reason, "stale");
  assert.equal(engine.inspect(sub.value.id).value.snapshot, null);
  const saved = loadAcquisitionStore(engine.path).value;
  assert.equal(Object.values(saved.queries)[0].claim, null);
  assert.equal(saved.uncertainReceipts["reservation:overbound:core"].units, 1);
});

test("SHARE-05: takeover after a durable start leaves the dead owner's governor cost uncertain", async (t) => {
  const box = fixture(t);
  const scope = createGovernorScope({
    effectiveHost: "github.com",
    authIdentity: "phase-6-crash-after-start",
    env: box.pathOptions.env,
    now: box.now,
  }).value;
  const leaseId = randomUUID();
  assert.equal(registerLease(scope, {
    id: leaseId,
    expiresAt: NOW + GOVERNOR_LEASE_TTL_MS,
    floorMs: 5_000,
    activeTab: "actions",
    phaseSeed: { seed: leaseId, registeredAt: NOW },
    demand: { core: 1, graphql: 0 },
  }).ok, true);
  const budgets = {
    core: { limit: 5_000, used: 0, remaining: 5_000, resetMs: NOW + 3_600_000 },
    graphql: { limit: 5_000, used: 0, remaining: 5_000, resetMs: NOW + 3_600_000 },
  };
  for (const resource of ["core", "graphql"]) {
    const probe = claimProbe(scope, leaseId, NOW, resource);
    assert.equal(publishProbe(scope, leaseId, probe.value.nonce, budgets, NOW, resource).ok, true);
  }
  const intentId = randomUUID();
  const grant = registerIntent(scope, {
    id: intentId,
    leaseId,
    tab: "actions",
    priority: "active",
    costs: { core: 1, graphql: 0 },
    requestedAt: NOW,
    expiresAt: NOW + GOVERNOR_LEASE_TTL_MS,
  }).value;
  assert.equal(startReservation(scope, grant.reservationId, grant.notBefore).value.status, "started");

  const owner = createAcquisitionEngine({ ...box, pid: 711, kill: () => {} });
  t.after(() => owner.close());
  const owned = owner.subscribe(query(), { active: true, floorMs: 5_000 });
  const claim = await owner.refresh(owned.value.id);
  assert.equal((await owner.refresh(owned.value.id, { started: claim.value })).ok, true);
  box.setNow(NOW + ACQUISITION_CLAIM_TTL_MS + 1);
  const successor = createAcquisitionEngine({ ...box, pid: 712, kill: (pid) => {
    if (pid === 711) throw Object.assign(new Error("dead"), { code: "ESRCH" });
  } });
  t.after(() => successor.close());
  const subscribed = successor.subscribe(query(), { active: true, floorMs: 5_000 });
  const takeover = await successor.refresh(subscribed.value.id, {
    acquire: async () => snapshot("after crash", { at: box.now() }),
  });
  assert.equal(takeover.ok, true);
  const governor = inspectGovernor(scope, box.now()).value;
  const retained = governor.reservations[grant.reservationId];
  assert.equal(retained.status, "started");
  assert.deepEqual(retained.costs, { core: 1, graphql: 0 });
  assert.equal(retained.actualCosts, null);
  assert.deepEqual(retained.accountedCosts, { core: 0, graphql: 0 });
  assert.equal(retained.outcome, null);
});

test("SHARE-05: delayed publication is nonce fenced and malformed data cancels its claim", async (t) => {
  const box = fixture(t);
  const engine = createAcquisitionEngine(box);
  t.after(() => engine.close());
  const subscribed = engine.subscribe(query(), { active: true, floorMs: 5_000 });
  await engine.refresh(subscribed.value.id, { acquire: async () => snapshot("last good") });
  box.setNow(NOW + 5_001);
  const claimed = await engine.refresh(subscribed.value.id, { force: true });
  await engine.refresh(subscribed.value.id, { started: claimed.value });

  const stale = await engine.refresh(subscribed.value.id, {
    publish: snapshot("stale"),
    claim: { nonce: "00000000-0000-4000-8000-000000000000", generation: claimed.value.generation,
      accessKey: query().accessKey },
  });
  assert.equal(stale.reason, "stale");

  const invalid = await engine.refresh(subscribed.value.id, {
    publish: { ...snapshot("unsafe"), entities: [{ key: "bad", etag: "", body: "unchecked" }],
      requestMetrics: { httpRequests: 1, rest200: 1, coreUnits: 1, failedRequests: 0 } },
    claim: { nonce: claimed.value.nonce, generation: claimed.value.generation, accessKey: query().accessKey },
  });
  assert.equal(invalid.reason, "invalid");
  const record = engine.inspect(subscribed.value.id).value;
  assert.equal(record.claim, null);
  assert.equal(record.snapshot.rows[0].displayTitle, "last good");
  const metrics = engine.diagnostics().value.metrics;
  assert.equal(metrics.httpRequests, 1);
  assert.equal(metrics.coreUnits, 1);
  assert.equal(metrics.failedRequests, 1);
  assert.equal(metrics.uncertainCoreUnits, 0);
});

test("SHARE-05: a busy publication keeps ownership and retries without wedging a live owner", async (t) => {
  const box = fixture(t);
  let tick = null;
  const engine = createAcquisitionEngine({
    ...box,
    setInterval: (run) => { tick = run; return { unref() {} }; },
    clearInterval: () => {},
  });
  t.after(() => engine.close());
  const subscribed = engine.subscribe(query(), { active: true, floorMs: 5_000 });
  const claimed = await engine.refresh(subscribed.value.id);
  const lockPath = `${engine.path}.lock`;
  writeFileSync(lockPath, JSON.stringify({
    pid: process.pid,
    nonce: "00000000-0000-4000-8000-000000000001",
  }));
  const blocked = await engine.refresh(subscribed.value.id, {
    claim: { nonce: claimed.value.nonce, generation: claimed.value.generation, accessKey: ACCESS },
    publish: snapshot("retry me"),
  });
  assert.equal(blocked.reason, "busy");
  unlinkSync(lockPath);
  box.setNow(NOW + ACQUISITION_HEARTBEAT_MS + 1);
  tick();
  assert.equal(engine.inspect(subscribed.value.id).value.snapshot.rows[0].displayTitle, "retry me");
});

test("SHARE-05: indeterminate publication failures retain the nonce until retry or fencing", async (t) => {
  for (const reason of ["busy", "unwritable", "corrupt", "stale", "collision"]) {
    const box = fixture(t);
    const storage = memoryStorage();
    let tick = null;
    const engine = createAcquisitionEngine({
      ...box,
      storage,
      setInterval: (run) => { tick = run; return { unref() {} }; },
      clearInterval: () => {},
    });
    const subscribed = engine.subscribe(query(), { active: true, floorMs: 5_000 });
    const claimed = await engine.refresh(subscribed.value.id);
    storage.failNext(reason);
    const blocked = await engine.refresh(subscribed.value.id, {
      claim: { nonce: claimed.value.nonce, generation: claimed.value.generation, accessKey: ACCESS },
      publish: snapshot(`retried ${reason}`),
    });
    assert.equal(blocked.reason, reason);
    box.setNow(NOW + ACQUISITION_HEARTBEAT_MS + 1);
    tick();
    assert.equal(engine.inspect(subscribed.value.id).value.snapshot.rows[0].displayTitle,
      `retried ${reason}`);
    engine.close();
  }
});

test("SHARE-05: failed transport cleanup retries cancellation before another live-owner refresh", async (t) => {
  const box = fixture(t);
  let tick = null;
  const engine = createAcquisitionEngine({
    ...box,
    setInterval: (run) => { tick = run; return { unref() {} }; },
    clearInterval: () => {},
  });
  t.after(() => engine.close());
  const subscribed = engine.subscribe(query(), { active: true, floorMs: 5_000 });
  const lockPath = `${engine.path}.lock`;
  await assert.rejects(engine.refresh(subscribed.value.id, {
    acquire: async () => {
      writeFileSync(lockPath, JSON.stringify({
        pid: process.pid,
        nonce: "00000000-0000-4000-8000-000000000002",
      }));
      throw new Error("transport failed");
    },
  }), /transport failed/);
  unlinkSync(lockPath);
  box.setNow(NOW + ACQUISITION_HEARTBEAT_MS + 1);
  tick();
  const retried = await engine.refresh(subscribed.value.id);
  assert.equal(retried.value.role, "producer");
});

test("SHARE-05: indeterminate transport cleanup failures retain ownership until cancellation retries", async (t) => {
  for (const reason of ["busy", "unwritable", "corrupt", "stale", "collision"]) {
    const box = fixture(t);
    const storage = memoryStorage();
    let tick = null;
    const engine = createAcquisitionEngine({
      ...box,
      storage,
      setInterval: (run) => { tick = run; return { unref() {} }; },
      clearInterval: () => {},
    });
    const subscribed = engine.subscribe(query(), { active: true, floorMs: 5_000 });
    await assert.rejects(engine.refresh(subscribed.value.id, {
      acquire: async () => {
        storage.failNext(reason);
        throw new Error(`transport ${reason}`);
      },
    }), new RegExp(`transport ${reason}`));
    box.setNow(NOW + ACQUISITION_HEARTBEAT_MS + 1);
    tick();
    const retried = await engine.refresh(subscribed.value.id);
    assert.equal(retried.value.role, "producer", reason);
    await engine.refresh(subscribed.value.id, { cancel: {
      nonce: retried.value.nonce,
      generation: retried.value.generation,
    } });
    engine.close();
  }
});

test("SHARE-05/08: persisted entities are bounded sanitized projections", async (t) => {
  const box = fixture(t);
  const engine = createAcquisitionEngine(box);
  t.after(() => engine.close());
  const subscribed = engine.subscribe(query(), { active: true, floorMs: 5_000 });
  const unsafe = snapshot("unsafe\u001b[31m title");
  unsafe.entities[0].body = JSON.stringify([{ title: "unsafe\u001b[31m body" }]);
  const published = await engine.refresh(subscribed.value.id, { acquire: async () => unsafe });
  assert.equal(published.ok, true);
  const disk = readFileSync(acquisitionStorePath(box.pathOptions), "utf8");
  assert.equal(disk.includes("\u001b"), false);
  assert.equal(published.value.snapshot.rows[0].displayTitle, "unsafe [31m title");
  assert.equal(JSON.parse(published.value.snapshot.entities[0].body)[0].title, "unsafe [31m body");
});

test("SHARE-03/05: capability evidence is schema checked and access partitioned", async (t) => {
  const box = fixture(t);
  const engine = createAcquisitionEngine(box);
  t.after(() => engine.close());
  const securityQuery = query("R_widget", "security", { pageSize: 100 });
  const subscribed = engine.subscribe(securityQuery, { active: true, floorMs: 5_000 });
  const at = box.now();
  const security = {
    rows: [{ id: "dependabot-1", kind: "Dependabot", severity: "high", title: "upgrade",
      detail: "package", createdAt: "2026-09-05T00:00:00Z" }],
    pageInfo: { loadedPages: 1, hasNextPage: false },
    raw: "ignored",
    entities: [{ key: "security\0dependabot", etag: "\"alerts-v1\"", body: "[]" }],
    lastSuccessAt: at,
    lastChangedAt: at,
    nextDueAt: at + 5_000,
    hold: null,
    capabilities: { dependabot: { verdict: "unavailable", until: at + 60_000, step: 0,
      note: "Dependabot alerts: unavailable" } },
    meta: { at, truncated: false },
    securityNotes: ["Dependabot alerts: unavailable"],
    securityBlind: false,
  };
  const published = await engine.refresh(subscribed.value.id, { acquire: async () => security });
  assert.equal(published.ok, true);
  assert.equal(published.value.snapshot.capabilities.dependabot.verdict, "unavailable");
  const otherAccess = createAcquisitionEngine(box);
  t.after(() => otherAccess.close());
  const isolated = otherAccess.subscribe({ ...securityQuery, accessKey: "b".repeat(64) },
    { active: true, floorMs: 5_000 });
  assert.equal(isolated.value.snapshot, null);
});

test("SHARE-05/06: unwritable storage denies ownership without a polling fallback", (t) => {
  const box = fixture(t);
  const blockedRoot = join(box.pathOptions.env.XDG_CONFIG_HOME, "blocked");
  writeFileSync(blockedRoot, "not a directory\n");
  const engine = createAcquisitionEngine({ pathOptions: { env: { XDG_CONFIG_HOME: blockedRoot } } });
  t.after(() => engine.close());
  assert.equal(engine.subscribe(query(), { active: true, floorMs: 5_000 }).reason, "unwritable");
});

test("SHARE-05: an aged empty acquisition lock is recovered without losing metadata", (t) => {
  const box = fixture(t);
  const engine = createAcquisitionEngine(box);
  t.after(() => engine.close());
  assert.equal(engine.subscribe(query(), { active: true, floorMs: 5_000 }).ok, true);
  const path = acquisitionStorePath(box.pathOptions);
  const before = readFileSync(path, "utf8");
  const lockPath = `${path}.lock`;
  writeFileSync(lockPath, "", { mode: 0o600 });
  const aged = new Date(Date.now() - GOVERNOR_LOCK_ORPHAN_MS - 1_000);
  utimesSync(lockPath, aged, aged);
  assert.equal(engine.subscribe(query("R_after_orphan"), { active: true, floorMs: 5_000 }).ok, true);
  assert.equal(existsSync(lockPath), false);
  const previousId = Object.keys(JSON.parse(before).subscriptions)[0];
  assert.deepEqual(JSON.parse(readFileSync(path, "utf8")).subscriptions[previousId],
    JSON.parse(before).subscriptions[previousId]);
  assert.equal(Object.keys(JSON.parse(readFileSync(path, "utf8")).subscriptions).length, 2);
});

test("SHARE-05: young unreadable locks and live or unknown owners remain protected", (t) => {
  const box = fixture(t);
  const engine = createAcquisitionEngine(box);
  t.after(() => engine.close());
  assert.equal(engine.subscribe(query(), { active: true, floorMs: 5_000 }).ok, true);
  const lockPath = `${engine.path}.lock`;
  for (const record of ["", "{\"pid\":4"]) {
    writeFileSync(lockPath, record, { mode: 0o600 });
    assert.equal(engine.subscribe(query("R_young"), { active: true, floorMs: 5_000 }).reason, "busy");
    assert.equal(readFileSync(lockPath, "utf8"), record);
    unlinkSync(lockPath);
  }
  const owner = { pid: process.pid, nonce: randomUUID() };
  writeFileSync(lockPath, JSON.stringify(owner), { mode: 0o600 });
  const aged = new Date(Date.now() - 10 * GOVERNOR_LOCK_ORPHAN_MS);
  utimesSync(lockPath, aged, aged);
  assert.equal(engine.subscribe(query("R_live"), { active: true, floorMs: 5_000 }).reason, "busy");
  assert.deepEqual(JSON.parse(readFileSync(lockPath, "utf8")), owner);
  unlinkSync(lockPath);

  const unknown = createAcquisitionEngine({ ...box, kill: () => {
    throw Object.assign(new Error("unavailable"), { code: "EPERM" });
  } });
  t.after(() => unknown.close());
  writeFileSync(lockPath, JSON.stringify({ pid: 999_999_999, nonce: randomUUID() }), { mode: 0o600 });
  assert.equal(unknown.subscribe(query("R_unknown"), { active: true, floorMs: 5_000 }).reason, "busy");
  assert.equal(existsSync(lockPath), true);
});

test("SHARE-05: aged partial records, dead owners, and stale recovery markers are reclaimed", (t) => {
  const box = fixture(t);
  const engine = createAcquisitionEngine(box);
  t.after(() => engine.close());
  assert.equal(engine.subscribe(query(), { active: true, floorMs: 5_000 }).ok, true);
  const lockPath = `${engine.path}.lock`;
  const age = (path) => {
    const aged = new Date(Date.now() - GOVERNOR_LOCK_ORPHAN_MS - 1_000);
    utimesSync(path, aged, aged);
  };
  writeFileSync(lockPath, "{\"pid\":4", { mode: 0o600 });
  age(lockPath);
  assert.equal(engine.subscribe(query("R_partial"), { active: true, floorMs: 5_000 }).ok, true);
  assert.equal(existsSync(lockPath), false);
  writeFileSync(lockPath, JSON.stringify({ pid: 999_999_999, nonce: randomUUID() }), { mode: 0o600 });
  assert.equal(engine.subscribe(query("R_dead"), { active: true, floorMs: 5_000 }).ok, true);
  assert.equal(existsSync(lockPath), false);
  const staleMarker = `${lockPath}.recovery-${randomUUID()}`;
  writeFileSync(staleMarker, "", { mode: 0o600 });
  assert.equal(engine.subscribe(query("R_marker_young"), { active: true, floorMs: 5_000 }).reason, "busy");
  age(staleMarker);
  assert.equal(engine.subscribe(query("R_marker_old"), { active: true, floorMs: 5_000 }).ok, true);
  assert.equal(existsSync(staleMarker), false);
  assert.equal(loadAcquisitionStore(engine.path).ok, true);
});

test("SHARE-05: failed owner-record creation leaves no lock and a live marker blocks recovery", (t) => {
  const box = fixture(t);
  const engine = createAcquisitionEngine(box);
  t.after(() => engine.close());
  assert.equal(engine.subscribe(query(), { active: true, floorMs: 5_000 }).ok, true);
  const lockPath = `${engine.path}.lock`;
  assert.equal(claimGovernorLock(lockPath, { pid: process.pid, nonce: 1n }), "failed");
  assert.equal(existsSync(lockPath), false);
  const markerPath = `${lockPath}.recovery-${randomUUID()}`;
  writeFileSync(markerPath, JSON.stringify({ pid: process.pid, nonce: randomUUID() }), { mode: 0o600 });
  const aged = new Date(Date.now() - 10 * GOVERNOR_LOCK_ORPHAN_MS);
  utimesSync(markerPath, aged, aged);
  assert.equal(engine.subscribe(query("R_live_marker"), { active: true, floorMs: 5_000 }).reason, "busy");
  assert.equal(existsSync(markerPath), true);
});

test("SHARE-05: recovery marker preserves a successor that replaces a dead lock", (t) => {
  const box = fixture(t);
  const engine = createAcquisitionEngine(box);
  t.after(() => engine.close());
  assert.equal(engine.subscribe(query(), { active: true, floorMs: 5_000 }).ok, true);
  const lockPath = `${engine.path}.lock`;
  const abandoned = { pid: 999_999_999, nonce: randomUUID() };
  const successor = { pid: process.pid, nonce: randomUUID() };
  writeFileSync(lockPath, JSON.stringify(abandoned), { mode: 0o600 });
  let entered = false;
  const raced = withFileLock(lockPath, () => { entered = true; return { ok: true }; }, {
    waitMs: 0,
    observeArtifact: (kind) => {
      if (kind === "recovery") writeFileSync(lockPath, JSON.stringify(successor));
    },
  });
  assert.equal(raced.reason, "busy");
  assert.equal(entered, false);
  assert.deepEqual(JSON.parse(readFileSync(lockPath, "utf8")), successor);
});

test("SHARE-05: a stalled creator cannot enter after its empty lock is reclaimed", (t) => {
  const box = fixture(t);
  const engine = createAcquisitionEngine(box);
  t.after(() => engine.close());
  assert.equal(engine.subscribe(query(), { active: true, floorMs: 5_000 }).ok, true);
  const lockPath = `${engine.path}.lock`;
  const successor = { pid: process.pid, nonce: randomUUID() };
  let recoveryEntered = false;
  let stalled = false;
  const staleNonce = randomUUID();
  const stalledOwner = {
    pid: process.pid,
    get nonce() {
      if (stalled) return staleNonce;
      stalled = true;
      const aged = new Date(Date.now() - GOVERNOR_LOCK_ORPHAN_MS - 1_000);
      utimesSync(lockPath, aged, aged);
      const recovered = withFileLock(lockPath, () => {
        recoveryEntered = true;
        return { ok: true };
      }, { waitMs: 0 });
      assert.equal(recovered.ok, true);
      writeFileSync(lockPath, JSON.stringify(successor), { mode: 0o600 });
      return staleNonce;
    },
  };
  assert.equal(claimGovernorLock(lockPath, stalledOwner), "held");
  assert.equal(recoveryEntered, true);
  assert.deepEqual(JSON.parse(readFileSync(lockPath, "utf8")), successor);
});

test("SHARE-05/06: malformed pairs and hard subscription caps fail closed", (t) => {
  const box = fixture(t);
  const engine = createAcquisitionEngine(box);
  t.after(() => engine.close());
  for (let index = 0; index < ACQUISITION_MAX_SUBSCRIPTIONS; index += 1) {
    const result = engine.subscribe(query(`R_${index % ACQUISITION_MAX_LIVE_TARGETS}`),
      { active: true, floorMs: 5_000 });
    assert.equal(result.ok, true, `subscription ${index}`);
  }
  assert.equal(engine.subscribe(query("R_overflow"), { active: true, floorMs: 5_000 }).reason, "capacity");
  assert.ok(ACQUISITION_MAX_ENTITIES >= 512);
  assert.ok(ACQUISITION_MAX_BYTES >= 32 * 1024 * 1024);
  const disk = readFileSync(acquisitionStorePath(box.pathOptions), "utf8");
  assert.equal(disk.includes(ACCESS), true, "private access partition remains inside private storage");
});

test("SHARE-06: inactive least-recently-used targets are evicted before live targets", async (t) => {
  const box = fixture(t);
  let firstKey;
  for (let index = 0; index < ACQUISITION_MAX_LIVE_TARGETS + 1; index += 1) {
    box.setNow(NOW + index * 10_000);
    const engine = createAcquisitionEngine(box);
    const subscribed = engine.subscribe(query(`R_lru_${index}`), { active: true, floorMs: 5_000 });
    firstKey ??= subscribed.value.queryKey;
    const refreshed = await engine.refresh(subscribed.value.id, {
      acquire: async () => snapshot(`lru ${index}`, { at: box.now() }),
    });
    assert.equal(refreshed.ok, true);
    engine.close();
  }
  const stored = loadAcquisitionStore(acquisitionStorePath(box.pathOptions));
  assert.equal(new Set(Object.values(stored.value.queries).map((entry) => entry.query.targetKey)).size,
    ACQUISITION_MAX_LIVE_TARGETS);
  assert.equal(Object.hasOwn(stored.value.queries, firstKey), false);
});

test("SHARE-05/06: expired dead subscribers are reaped before the hard cap is applied", (t) => {
  const box = fixture(t);
  const crashed = [];
  for (let index = 0; index < ACQUISITION_MAX_SUBSCRIPTIONS; index += 1) {
    const engine = createAcquisitionEngine({ ...box, pid: 10_000 + index, kill: () => {} });
    crashed.push(engine);
    assert.equal(engine.subscribe(query(`R_${index % ACQUISITION_MAX_LIVE_TARGETS}`),
      { active: true, floorMs: 5_000 }).ok, true);
  }
  box.setNow(NOW + ACQUISITION_CLAIM_TTL_MS + 1);
  const survivor = createAcquisitionEngine({ ...box, pid: 20_000, kill: (pid) => {
    if (pid !== 20_000) throw Object.assign(new Error("dead"), { code: "ESRCH" });
  } });
  t.after(() => {
    survivor.close();
    // Do not close the simulated crashed engines before the assertion; cleanup
    // after the replacement has proven stale leases did not exhaust capacity.
    crashed.forEach((engine) => engine.close());
  });
  assert.equal(survivor.subscribe(query("R_recovered"), { active: true, floorMs: 5_000 }).ok, true);
  const stored = loadAcquisitionStore(acquisitionStorePath(box.pathOptions));
  assert.equal(Object.keys(stored.value.subscriptions).length, 1);
});

test("SHARE-06: the 513th query evicts atomically instead of writing an unreadable store", (t) => {
  const box = fixture(t);
  for (let index = 1; index <= ACQUISITION_MAX_ENTITIES + 1; index += 1) {
    const engine = createAcquisitionEngine(box);
    const subscribed = engine.subscribe(query("R_same", "actions", { queryVersion: index }),
      { active: false, floorMs: 5_000 });
    assert.equal(subscribed.ok, true, `query ${index}`);
    engine.close();
  }
  const stored = loadAcquisitionStore(acquisitionStorePath(box.pathOptions));
  assert.equal(stored.ok, true);
  assert.equal(Object.keys(stored.value.queries).length, ACQUISITION_MAX_ENTITIES);
});
