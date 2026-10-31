// Regression tests for the 2026-10-31 performance, caching and real-time
// review: unchanged detection (#166, #167), Security freshness truth (#168),
// the collector display clock (#171) and the inferred cache key (#172).
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import {
  ALERT_SOURCES,
  POLL_QUIET_MS,
  adoptedAcquisitionRaw,
  clearForcedBackoffAfterStart,
  collectorPublicationFromResult,
  createCollectorAcquisitionRuntime,
  createCollectorSourceAgeTracker,
  dashboardCacheTarget,
  fetchGraphqlList,
  fetchSecurity,
  loadDashboardCache,
  normalizeCollectorConfig,
  pollResultTransition,
  saveDashboardCache,
} from "../index.mjs";

const CONFIG = {
  version: 1,
  providers: { personal: { type: "gh", host: "github.com" } },
  targets: [{ host: "github.com", repo: "acme/widget", provider: "personal" }],
};

const IDENTITY = {
  host: "github.com", kind: "user", id: 7, login: "octo",
  quotaKey: "q".repeat(64), accessKey: "a".repeat(64), credentialKey: "c".repeat(64),
  generation: 1, observedAt: 1,
};

function temporaryRoot(t) {
  const root = mkdtempSync(join(tmpdir(), "gh-glance-review-1031-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  return { env: { XDG_CONFIG_HOME: root }, platform: "linux", home: root };
}

// A GraphQL page as fetchGraphqlPage returns it. The row mappers below are the
// production shapes (ISSUE_ROW and PR_ROW), including the PR fields a stored
// snapshot normalizes (`reviewDecision: null` is stored as "").
function graphqlPage(connection, nodes) {
  return {
    ok: true, observedCost: 1, overrun: false, observations: [],
    requestMetrics: { httpRequests: 1, graphqlUnits: 1 },
    data: { repository: { id: "R_1", nameWithOwner: "acme/widget",
      [connection]: { totalCount: nodes.length, pageInfo: { hasNextPage: false, endCursor: null }, nodes } } },
  };
}

const GRAPHQL_FIXTURES = {
  issues: {
    connection: "issues",
    node: { number: 1, title: "steady issue", author: { login: "octo" }, labels: { nodes: [] },
      updatedAt: "2026-10-01T00:00:00Z", url: "https://github.com/acme/widget/issues/1" },
    mapRow: (node) => ({ number: node.number, title: node.title, author: node.author?.login ?? "",
      label: node.labels?.nodes?.[0]?.name ?? "", updatedAt: node.updatedAt, url: node.url }),
  },
  prs: {
    connection: "pullRequests",
    node: { number: 2, title: "steady pr", author: { login: "octo" }, headRefName: "topic",
      isDraft: false, reviewDecision: null, updatedAt: "2026-10-01T00:00:00Z",
      url: "https://github.com/acme/widget/pull/2" },
    mapRow: (node) => ({ number: node.number, title: node.title, author: node.author?.login ?? "",
      headRefName: node.headRefName, isDraft: node.isDraft, reviewDecision: node.reviewDecision,
      updatedAt: node.updatedAt, url: node.url }),
  },
};

// RT-01 (#166): a collector producer receives its previous snapshot back from
// the shared store, where it has been normalized. Three identical GraphQL
// observations must count as unchanged and reach the quiet cadence, exactly as
// they do for a standalone pane comparing against its own previous result.
for (const resource of ["issues", "prs"]) {
  test(`RT-01: identical collector ${resource} observations reach the quiet cadence through the store`, async (t) => {
    const fixture = GRAPHQL_FIXTURES[resource];
    let now = 1_000_000;
    const intervals = [];
    const runtime = createCollectorAcquisitionRuntime({
      config: normalizeCollectorConfig(CONFIG),
      pathOptions: temporaryRoot(t),
      now: () => now,
      setTimeout() { return { unref() {} }; }, clearTimeout() {},
      resolveProvider: async () => IDENTITY,
      resolveTargetIdentity: async () => ({ id: "R_1", nameWithOwner: "acme/widget" }),
      async produce({ resource: produced, snapshot, demand, claim, markStarted }) {
        await markStarted();
        const result = await fetchGraphqlList(produced, fixture.mapRow, {
          previousRaw: snapshot?.raw ?? null,
          fetchPage: async () => graphqlPage(fixture.connection, [fixture.node]),
        });
        const publication = collectorPublicationFromResult(produced, result, snapshot, demand, now, claim.state);
        intervals.push(publication.nextDueAt - now);
        return publication;
      },
    });
    t.after(() => runtime.close());
    const handle = runtime.subscribe({ target: normalizeCollectorConfig(CONFIG).targets[0], resource,
      demand: { active: true, background: true, floorMs: 5_000, pages: 1 }, onSnapshot() {}, onHold() {} });
    await handle.whenCurrentPollSettled();
    for (let poll = 0; poll < 2; poll += 1) {
      now += 10_000;
      await handle.refresh();
      await handle.whenCurrentPollSettled();
    }
    assert.equal(intervals.length, 3);
    assert.equal(intervals[0], 5_000, "the first observation is a change and keeps the floor");
    assert.equal(intervals.at(-1), POLL_QUIET_MS[resource],
      "two unchanged observations must reach the quiet cadence");
  });
}

// Publishes each list of issue nodes in turn through a real collector runtime
// and returns the snapshots the shared store delivered back, as a pane adopting
// a peer's publication would receive them.
async function storedIssueSnapshots(t, generations) {
  const fixture = GRAPHQL_FIXTURES.issues;
  let now = 2_000_000;
  let index = 0;
  const delivered = [];
  const runtime = createCollectorAcquisitionRuntime({
    config: normalizeCollectorConfig(CONFIG),
    pathOptions: temporaryRoot(t),
    now: () => now,
    setTimeout() { return { unref() {} }; }, clearTimeout() {},
    resolveProvider: async () => IDENTITY,
    resolveTargetIdentity: async () => ({ id: "R_1", nameWithOwner: "acme/widget" }),
    async produce({ snapshot, demand, claim, markStarted }) {
      await markStarted();
      const nodes = generations[index];
      index += 1;
      const result = await fetchGraphqlList("issues", fixture.mapRow, {
        previousRaw: snapshot?.raw ?? null,
        fetchPage: async () => graphqlPage(fixture.connection, nodes),
      });
      return collectorPublicationFromResult("issues", result, snapshot, demand, now, claim.state);
    },
  });
  t.after(() => runtime.close());
  const handle = runtime.subscribe({ target: normalizeCollectorConfig(CONFIG).targets[0], resource: "issues",
    demand: { active: true, background: true, floorMs: 5_000, pages: 1 },
    onSnapshot(snapshot) { delivered.push(snapshot); }, onHold() {} });
  await handle.whenCurrentPollSettled();
  while (index < generations.length) {
    now += 10_000;
    await handle.refresh();
    await handle.whenCurrentPollSettled();
  }
  return delivered;
}

function ownIssueFetch(nodes, previousRaw) {
  const fixture = GRAPHQL_FIXTURES.issues;
  return fetchGraphqlList("issues", fixture.mapRow, {
    previousRaw,
    fetchPage: async () => graphqlPage(fixture.connection, nodes),
  });
}

// RT-06 (#167): pane P fetched A, adopted a peer's B, then fetched A again.
// Its unchanged sentinel must follow the adopted rows, or the third result is
// "unchanged" and B is republished with a fresh success time.
test("RT-06: an A, B, A adoption sequence shows A again instead of republishing B", async (t) => {
  const A = [{ ...GRAPHQL_FIXTURES.issues.node, title: "state A" }];
  const B = [{ ...GRAPHQL_FIXTURES.issues.node, title: "state B" }];
  const delivered = await storedIssueSnapshots(t, [A, B]);
  const storedB = delivered.at(-1);
  assert.equal(storedB.rows[0].title, "state B");

  const first = await ownIssueFetch(A, null);
  let rawRef = pollResultTransition({ key: "issues", previousRaw: undefined, raw: first.raw,
    parse: first.parse, limit: first.limit, completedAt: 1 }).nextRaw;
  rawRef = adoptedAcquisitionRaw(rawRef, storedB, false);

  const again = await ownIssueFetch(A, rawRef);
  const transition = pollResultTransition({ key: "issues", previousRaw: rawRef, raw: again.raw,
    parse: again.parse, limit: again.limit, completedAt: 2 });
  assert.equal(transition.kind, "changed");
  assert.equal(transition.data[0].title, "state A");
});

test("RT-06: adopting the same content keeps the sentinel, and a stored snapshot matches its own fetch", async (t) => {
  const A = [GRAPHQL_FIXTURES.issues.node];
  const [storedA] = await storedIssueSnapshots(t, [A]);
  const own = await ownIssueFetch(A, null);
  assert.equal(storedA.raw, own.raw, "fetchers and the store must share one comparison representation");
  assert.equal(adoptedAcquisitionRaw(own.raw, storedA, true), own.raw);
  assert.equal(adoptedAcquisitionRaw("previous", { rows: [] }, false), null,
    "a snapshot without the shared representation clears the sentinel");
  const again = await ownIssueFetch(A, adoptedAcquisitionRaw(own.raw, storedA, false));
  assert.equal(pollResultTransition({ key: "issues", previousRaw: storedA.raw, raw: again.raw,
    parse() { throw new Error("unchanged results must not parse"); }, limit: again.limit, completedAt: 3 }).kind,
  "unchanged");
});

// PC-04 (#172): with no --repo or GH_REPO the cache key is inferred. The remote
// slug is resolved offline before mount, so it is part of the identity: a
// changed remote in the same directory must not restore the other repository.
test("PC-04: a changed remote in the same directory does not restore the other repository's rows", (t) => {
  const root = temporaryRoot(t).home;
  const path = join(root, "gh-glance", "dashboard-cache.json");
  const cwd = join(root, "checkout");
  const inferred = (remoteUrls) => dashboardCacheTarget({ repo: null, ghRepo: null, host: "github.com",
    cwd, account: "a".repeat(64), remoteUrls });
  const one = inferred(["git@github.com:acme/one.git"]);
  const two = inferred(["https://github.com/acme/two.git"]);
  const unresolved = inferred([]);
  assert.equal(new Set([one, two, unresolved]).size, 3);
  const row = { databaseId: 1, displayTitle: "acme/one run", workflowName: "CI", number: 1,
    headBranch: "main", status: "completed", conclusion: "success",
    startedAt: "2026-10-01T00:00:00Z", updatedAt: "2026-10-01T00:01:00Z",
    url: "https://github.com/acme/one/actions/runs/1" };
  const tabs = { actions: { data: [row], meta: { at: 1, truncated: false }, lastOk: 1 } };
  assert.equal(saveDashboardCache(path, { [one]: { tabs, securityNotes: [], securityBlind: false,
    updatedAt: Date.now() } }).ok, true);
  assert.equal(loadDashboardCache(path, one).entry?.tabs.actions.data[0].displayTitle, "acme/one run");
  assert.equal(loadDashboardCache(path, two).entry, null);
  assert.equal(loadDashboardCache(path, unresolved).entry, null);
});

// RT-04 (#171), secondary part: the monotonic clock does not advance across a
// suspend, so the collector source age alone omitted the sleep. Wall elapsed
// time bounds it from below as well; a backward wall step still cannot make
// the same observation younger.
test("RT-04: collector source age includes time spent suspended and never shrinks", () => {
  let wall = 1_000_000;
  let mono = 0;
  const tracker = createCollectorSourceAgeTracker({ now: () => wall, monotonicNow: () => mono });
  assert.equal(tracker.observe({ lastSuccessAt: wall - 10_000, serverNow: wall }), 10_000);
  wall += 3_601_000;
  mono += 1_000;
  assert.equal(tracker.current(), 3_611_000, "an hour asleep and a second awake");
  wall -= 3_600_000;
  assert.equal(tracker.current(), 3_611_000, "a backward wall step cannot shrink the age");
  mono += 1_000;
  assert.equal(tracker.current(), 3_611_000);
  assert.equal(tracker.observe({ lastSuccessAt: wall - 500, serverNow: wall }), 500,
    "a newer observation still replaces the age");
});

// RT-07 (#168): a Security batch in which every source replays its capability
// backoff makes no request. It is not a source observation (plan D6), so it
// must not advance freshness or complete durable webhook work (ADR 0005).
const forbidden = Object.assign(new Error("HTTP 403: feature disabled"), {
  requestMetrics: { httpRequests: 1, failedRequests: 1 },
});
const emptyAlerts = { status: 200, body: "[]", staged: null, observations: [],
  requestMetrics: { httpRequests: 1, rest200: 1, coreUnits: 1, failedRequests: 0 } };

function clearSecurityBackoff(t) {
  clearForcedBackoffAfterStart("security", true, "started");
  t.after(() => clearForcedBackoffAfterStart("security", true, "started"));
}

test("RT-07: fetchSecurity reports whether any source produced a real observation", async (t) => {
  clearSecurityBackoff(t);
  const refused = await fetchSecurity(null, { request: async () => { throw forbidden; } });
  assert.equal(refused.httpRequests, ALERT_SOURCES.length);
  assert.equal(refused.sourceObserved, true, "a current provider refusal is an observation");
  const replayed = await fetchSecurity(null, { request: async () => { throw new Error("must not request"); } });
  assert.equal(replayed.httpRequests, 0);
  assert.equal(replayed.sourceObserved, false, "an all-backoff batch is not an observation");
  const forced = await fetchSecurity(null, { force: true, request: async () => emptyAlerts });
  assert.equal(forced.sourceObserved, true);
});

test("RT-07: a collector all-backoff publication keeps the previous success time and rows", () => {
  const previous = { rows: [], raw: "previous", entities: [], pageInfo: null, lastSuccessAt: 1_000,
    lastChangedAt: 500, meta: { at: 500, truncated: false }, capabilities: {},
    securityNotes: ["Dependabot: not enabled"], securityBlind: false };
  const replay = { raw: "backoff:x", parse: () => ({ alerts: [], notes: ["Dependabot: not enabled"] }),
    limit: 100, stagedEntities: new Map(), sourceObserved: false, capabilities: {} };
  const demand = { active: true, background: true, floorMs: 5_000, pages: 1 };
  const published = collectorPublicationFromResult("security", replay, previous, demand, 9_000, {});
  assert.equal(published.lastSuccessAt, 1_000);
  assert.equal(published.lastChangedAt, 500);
  assert.deepEqual(published.securityNotes, ["Dependabot: not enabled"]);
  assert.ok(published.nextDueAt > 9_000, "the replay still schedules the next attempt");
  assert.throws(() => collectorPublicationFromResult("security", replay, null, demand, 9_000, {}),
    /no valid snapshot/, "a replay cannot create the first observation");
  const observed = collectorPublicationFromResult("security", { ...replay, sourceObserved: true },
    previous, demand, 9_000, {});
  assert.equal(observed.lastSuccessAt, 9_000);
});

const WEBHOOK_CONFIG = { ...CONFIG, webhook: { enabled: true, address: "127.0.0.1", port: 8787,
  secretFile: "/private/webhook-secret", targets: [{ ...CONFIG.targets[0], resources: ["security"] }] } };

test("RT-07: a Security webhook is not completed by a capability-backoff replay", async (t) => {
  clearSecurityBackoff(t);
  let now = 5_000_000;
  let calls = 0;
  let requests = 0;
  const runtime = createCollectorAcquisitionRuntime({
    config: normalizeCollectorConfig(WEBHOOK_CONFIG),
    pathOptions: temporaryRoot(t),
    now: () => now,
    setTimeout() { return { unref() {} }; }, clearTimeout() {},
    resolveProvider: async () => IDENTITY,
    resolveTargetIdentity: async () => ({ id: "R_1", nameWithOwner: "acme/widget" }),
    async produce({ snapshot, demand, claim, markStarted, force }) {
      await markStarted();
      calls += 1;
      const result = await fetchSecurity(null, { force, entities: new Map(), previousRaw: snapshot?.raw ?? null,
        request: async () => { requests += 1; if (calls === 1) throw forbidden; return emptyAlerts; } });
      return collectorPublicationFromResult("security", result, snapshot, demand, now, claim.state);
    },
  });
  t.after(() => runtime.close());
  const snapshots = [];
  const handle = runtime.subscribe({ target: normalizeCollectorConfig(CONFIG).targets[0], resource: "security",
    demand: { active: true, background: true, floorMs: 5_000, pages: 1 },
    onSnapshot(snapshot) { snapshots.push(snapshot); }, onHold() {} });
  await handle.whenCurrentPollSettled();
  assert.equal(requests, ALERT_SOURCES.length, "the first poll is a real refusal");
  const observedAt = snapshots.at(-1).lastSuccessAt;

  now += 10_000;
  let completed = false;
  const invalidated = runtime.invalidate({ ...CONFIG.targets[0], resource: "security", accessRemoved: false })
    .then(() => { completed = true; });
  for (let turn = 0; turn < 20 && calls < 2; turn += 1) await new Promise((resolve) => setImmediate(resolve));
  await handle.whenCurrentPollSettled();
  for (let turn = 0; turn < 20; turn += 1) await new Promise((resolve) => setImmediate(resolve));
  assert.equal(calls, 2, "the replay must not re-poll in a tight loop");
  assert.equal(requests, ALERT_SOURCES.length, "the follow-up replayed backoff with zero requests");
  assert.equal(snapshots.at(-1).lastSuccessAt, observedAt, "a replay does not advance freshness");
  assert.equal(completed, false, "a replay must not complete durable webhook work");

  now += 10_000;
  await handle.refresh(true);
  await handle.whenCurrentPollSettled();
  await invalidated;
  assert.equal(completed, true, "a real observation completes it");
  assert.ok(snapshots.at(-1).lastSuccessAt > observedAt);
});

test("RT-07: an on-demand refresh answered by a replay does not keep polling", async (t) => {
  clearSecurityBackoff(t);
  let now = 6_000_000;
  let calls = 0;
  const timers = [];
  const runtime = createCollectorAcquisitionRuntime({
    config: normalizeCollectorConfig(CONFIG),
    pathOptions: temporaryRoot(t),
    now: () => now,
    setTimeout(run, delay) { timers.push(delay); return { unref() {} }; }, clearTimeout() {},
    resolveProvider: async () => IDENTITY,
    resolveTargetIdentity: async () => ({ id: "R_1", nameWithOwner: "acme/widget" }),
    async produce({ snapshot, demand, claim, markStarted, force }) {
      await markStarted();
      calls += 1;
      const result = await fetchSecurity(null, { force, entities: new Map(), previousRaw: snapshot?.raw ?? null,
        request: async () => { throw forbidden; } });
      return collectorPublicationFromResult("security", result, snapshot, demand, now, claim.state);
    },
  });
  t.after(() => runtime.close());
  const handle = runtime.subscribe({ target: normalizeCollectorConfig(CONFIG).targets[0], resource: "security",
    demand: { active: false, background: false, floorMs: 5_000, pages: 1 }, onSnapshot() {}, onHold() {} });
  await handle.refresh();
  await handle.whenCurrentPollSettled();
  assert.equal(calls, 1);
  now += 10_000;
  timers.length = 0;
  await handle.refresh();
  await handle.whenCurrentPollSettled();
  assert.equal(calls, 2, "the second request replayed backoff");
  assert.deepEqual(timers, [], "an answered on-demand request schedules no further poll");
});
