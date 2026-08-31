import assert from "node:assert/strict";
import { test } from "node:test";

import {
  ALERT_SOURCES,
  RowBoundary,
  activeKeyHints,
  adoptPersistedSnapshot,
  alertRequestArgs,
  authCacheIdentity,
  clearForcedBackoffAfterStart,
  createOpenRequestRegistry,
  forcedBackoffKeys,
  entityKey,
  fetchAlertSource,
  fetchConditionalEntity,
  formatTabErrorForWidth,
  helpLines,
  mergeAlertRows,
  mergeDashboardCacheSnapshots,
  mergeWidthPreferenceSnapshots,
  pollResultTransition,
  pollSchedule,
  mapAllSettledBounded,
  reconcileSelectionViewport,
  resourceDecision,
  securityPollDelay,
  selectionLabel,
  shouldCheckpointFreshness,
  shouldEnableMouseReporting,
  shouldFetchAlertPriorityLanes,
  shouldShowFetchLoading,
  summarizeDoctorEnv,
  tabFailureSuffix,
} from "../index.mjs";

test("a replacement record resets a failed row without changing list identity", () => {
  const first = { number: 7, title: "bad" };
  const replacement = { number: 7, title: "fixed" };
  const failed = { failed: true, key: first };

  assert.equal(RowBoundary.getDerivedStateFromProps({ resetKey: first }, failed).failed, true);
  assert.equal(
    RowBoundary.getDerivedStateFromProps({ resetKey: replacement }, failed).failed,
    false,
  );
});

test("forced Security refresh clears the tab and every source backoff only", () => {
  assert.deepEqual(forcedBackoffKeys("issues"), ["tab:issues"]);
  assert.deepEqual(forcedBackoffKeys("security"), [
    "tab:security",
    ...ALERT_SOURCES.map(({ key }) => key),
  ]);
});

test("Security requests are bounded and include explicit priority lanes", () => {
  const requests = ALERT_SOURCES.flatMap(alertRequestArgs);
  assert.equal(requests.length, 6);
  assert.ok(requests.every((args) => !args.includes("--paginate")));
  assert.ok(requests.every((args) => args.some((arg) => arg.includes("per_page=100"))));

  const dependabot = requests.filter((args) => args[0].includes("dependabot"));
  assert.ok(dependabot.some((args) => args[0].includes("severity=critical,high")));
  const code = requests.filter((args) => args[0].includes("code-scanning"));
  assert.ok(code.some((args) => args[0].includes("severity=critical")));
  assert.ok(code.some((args) => args[0].includes("severity=high")));

  const rows = mergeAlertRows([
    [{ number: 1, severity: "low" }, { number: 2, severity: "high" }],
    [{ number: 2, severity: "high" }, { number: 3, severity: "critical" }],
  ]);
  assert.deepEqual(rows.map(({ number }) => number), [1, 2, 3]);
  assert.equal(shouldFetchAlertPriorityLanes(0), false);
  assert.equal(shouldFetchAlertPriorityLanes(99), false);
  assert.equal(shouldFetchAlertPriorityLanes(100), true);
});

test("a 304 Security primary reuses its path-keyed body to decide priority work", async () => {
  const source = {
    key: "conditional-security-test",
    name: "Conditional Security test",
    path: "primary",
    priorityQueries: ["severity=high"],
    jq: ".",
    unavailable: "unavailable",
    map: (alert) => alert,
  };
  const primaryBody = JSON.stringify(Array.from({ length: 100 }, (_, index) => ({
    number: index + 1,
    state: "open",
  })));
  const priorityPath = "primary&severity=high";
  const priorityBody = JSON.stringify([{ number: 101, state: "open" }]);
  const entities = new Map([
    [entityKey("security", source.path), { etag: '"primary"', body: primaryBody }],
    [entityKey("security", priorityPath), { etag: '"priority"', body: priorityBody }],
  ]);
  const calls = [];
  const request = (input) => fetchConditionalEntity({
    ...input,
    request: async (args, { etag }) => {
      calls.push({ path: args[0], etag });
      return { status: 304, etag, rateLimit: null, body: "" };
    },
  });

  const result = await fetchAlertSource(source, null, performance.now(), { entities, request });

  assert.deepEqual(calls, [
    { path: source.path, etag: '"primary"' },
    { path: priorityPath, etag: '"priority"' },
  ]);
  assert.equal(result.completedCalls, 0);
  assert.equal(result.allNotModified, true);
  assert.deepEqual(result.stagedEntities, new Map());
  assert.equal(result.parse().alerts.length, 101);
});

test("unchanged Security data uses a slower bounded cadence and force bypasses it", () => {
  assert.equal(securityPollDelay({ unchangedPolls: 0, floorMs: 5000 }), 5000);
  assert.equal(securityPollDelay({ unchangedPolls: 1, floorMs: 5000 }), 60_000);
  assert.equal(securityPollDelay({ unchangedPolls: 5, floorMs: 120_000 }), 120_000);
  assert.equal(securityPollDelay({ unchangedPolls: 5, floorMs: 5000, force: true }), 0);
});

test("cache identity follows the effective gh account namespace without storing a token", () => {
  const base = {
    env: { GH_CONFIG_DIR: "/tmp/gh-a", GH_TOKEN: "ghp_one-secret-value-123456" },
    home: "/home/octo",
    platform: "linux",
    stat: { dev: 1, ino: 2, size: 30, mtimeMs: 40 },
  };
  const first = authCacheIdentity(base);
  assert.equal(first, authCacheIdentity(base));
  assert.notEqual(first, authCacheIdentity({ ...base, env: { ...base.env, GH_CONFIG_DIR: "/tmp/gh-b" } }));
  assert.notEqual(first, authCacheIdentity({ ...base, stat: { ...base.stat, mtimeMs: 41 } }));
  assert.notEqual(
    first,
    authCacheIdentity({
      ...base,
      env: { ...base.env, GITHUB_ENTERPRISE_TOKEN: "enterprise-secret" },
    }),
  );
  assert.notEqual(
    authCacheIdentity({ ...base, env: { GH_TOKEN: "public", GH_ENTERPRISE_TOKEN: "first" } }),
    authCacheIdentity({ ...base, env: { GH_TOKEN: "public", GH_ENTERPRISE_TOKEN: "second" } }),
  );
  assert.ok(!first.includes(base.env.GH_TOKEN));
});

test("three-way persistence merges concurrent unrelated changes and preserves deletions", () => {
  const baseWidths = { actions: { workflow: 10 }, issues: { author: 12 } };
  const diskWidths = { actions: { workflow: 10 }, issues: { author: 20 } };
  const nextWidths = { actions: { workflow: 15 }, issues: { author: 12 } };
  assert.deepEqual(mergeWidthPreferenceSnapshots(baseWidths, diskWidths, nextWidths), {
    actions: { workflow: 15 },
    issues: { author: 20 },
  });
  assert.deepEqual(
    mergeWidthPreferenceSnapshots(
      { actions: { workflow: 15 } },
      { actions: { workflow: 15 }, prs: { author: 18 } },
      {},
    ),
    { prs: { author: 18 } },
  );

  const baseCache = {
    one: {
      tabs: { actions: { data: ["old"] } },
      securityNotes: [],
      securityBlind: false,
      updatedAt: 1,
    },
  };
  const diskCache = {
    one: {
      tabs: { actions: { data: ["old"] }, issues: { data: ["external"] } },
      securityNotes: ["external note"],
      securityBlind: true,
      updatedAt: 2,
    },
    two: { updatedAt: 2 },
  };
  const nextCache = {
    one: {
      tabs: { actions: { data: ["local"] } },
      securityNotes: [],
      securityBlind: false,
      updatedAt: 3,
    },
  };
  assert.deepEqual(mergeDashboardCacheSnapshots(baseCache, diskCache, nextCache), {
    one: {
      tabs: { actions: { data: ["local"] }, issues: { data: ["external"] } },
      securityNotes: ["external note"],
      securityBlind: true,
      updatedAt: 3,
    },
    two: { updatedAt: 2 },
  });

  const persistedRef = { current: baseCache };
  const liveRef = { current: nextCache };
  const persisted = mergeDashboardCacheSnapshots(baseCache, diskCache, nextCache);
  assert.equal(adoptPersistedSnapshot({ ok: true, persisted }, persistedRef, liveRef), true);
  assert.equal(persistedRef.current, persisted);
  assert.equal(liveRef.current, persisted);
});

test("freshness checkpoints are bounded instead of writing every successful poll", () => {
  assert.equal(shouldCheckpointFreshness({ persistedAt: 1000, completedAt: 60_999 }), false);
  assert.equal(shouldCheckpointFreshness({ persistedAt: 1000, completedAt: 61_000 }), true);
  assert.equal(shouldCheckpointFreshness({ persistedAt: null, completedAt: 1 }), true);
});

test("tab resource decisions keep GraphQL and REST independent", () => {
  const nowMs = 1_000_000;
  const budgets = {
    core: { limit: 5000, remaining: 5000, used: 0, resetMs: nowMs + 3_600_000, observedAt: nowMs },
    graphql: { limit: 5000, remaining: 1000, used: 4000, resetMs: nowMs + 3_600_000, observedAt: nowMs },
  };
  assert.equal(resourceDecision({
    budget: budgets.core,
    resource: "core",
    cost: 2,
    nowMs,
  }).mode, "open");
  assert.equal(resourceDecision({
    budget: budgets.graphql,
    resource: "graphql",
    cost: 2,
    nowMs,
  }).mode, "paused");

  budgets.core = { ...budgets.core, remaining: 1000, used: 4000 };
  budgets.graphql = { ...budgets.graphql, remaining: 5000, used: 0 };
  assert.equal(resourceDecision({ budget: budgets.core, resource: "core", cost: 2, nowMs }).mode, "paused");
  assert.equal(resourceDecision({ budget: budgets.graphql, resource: "graphql", cost: 2, nowMs }).mode, "open");
});

test("settled automatic polling stays invisible while first load and manual refresh stay visible", () => {
  assert.equal(shouldShowFetchLoading({ hasData: false, force: false }), true);
  assert.equal(shouldShowFetchLoading({ hasData: true, force: false }), false);
  assert.equal(shouldShowFetchLoading({ hasData: true, force: true }), true);
});

test("doctor summaries preserve diagnostic identity without local path or network disclosure", () => {
  assert.equal(summarizeDoctorEnv("NO_PROXY", "localhost,10.0.0.0/8,corp.internal"), "set (3 entries)");
  assert.equal(
    summarizeDoctorEnv("GH_CONFIG_DIR", "/Users/octo/.config/gh-work", { home: "/Users/octo" }),
    "~/.config/gh-work",
  );
});

test("the poll controller keeps unchanged, blind, and changed transitions separate", () => {
  let parses = 0;
  const unchanged = pollResultTransition({
    key: "issues",
    previousRaw: "same",
    raw: "same",
    parse: () => {
      parses += 1;
      return [];
    },
    limit: 100,
    completedAt: 10,
  });
  assert.equal(unchanged.kind, "unchanged");
  assert.equal(parses, 0);

  const blind = pollResultTransition({
    key: "security",
    previousRaw: "good",
    raw: "failed",
    parse: () => ({ alerts: [], blind: true, notes: ["offline"] }),
    limit: 100,
    completedAt: 20,
  });
  assert.equal(blind.kind, "blind");
  assert.equal(blind.nextRaw, null);

  let schedule = pollSchedule({
    nowMs: 0,
    floorMs: 5,
    activeKey: "issues",
    activeAt: 0,
    backgroundAt: 20,
  });
  assert.deepEqual(schedule.due, [{ key: "issues", kind: "active" }]);
  const rotations = [];
  for (const nowMs of [20, 40, 60]) {
    schedule = pollSchedule({
      nowMs,
      floorMs: 5,
      activeKey: "issues",
      activeAt: nowMs,
      backgroundAt: nowMs,
      backgroundIndex: schedule.backgroundIndex,
    });
    rotations.push(schedule.due);
  }
  assert.deepEqual(rotations, [
    [{ key: "issues", kind: "active" }, { key: "actions", kind: "background" }],
    [{ key: "issues", kind: "active" }, { key: "prs", kind: "background" }],
    [{ key: "issues", kind: "active" }, { key: "security", kind: "background" }],
  ]);
  assert.deepEqual(
    pollSchedule({
      nowMs: 20,
      floorMs: 5,
      activeKey: "issues",
      activeAt: 20,
      backgroundAt: 20,
      heldResources: { core: { held: true, retryAt: 100 } },
    }).due,
    [{ key: "issues", kind: "active" }, { key: "prs", kind: "background" }],
  );

  assert.deepEqual(
    pollSchedule({
      nowMs: 20,
      floorMs: 5,
      activeKey: "actions",
      activeAt: 20,
      backgroundAt: 20,
      heldResources: { core: { held: true, retryAt: 100 } },
    }).due,
    [{ key: "issues", kind: "background" }],
  );
});

test("manual delay preserves backoff until the reservation actually starts", () => {
  const cleared = [];
  assert.equal(
    clearForcedBackoffAfterStart("security", true, "scheduled", (key) => cleared.push(key)),
    false,
  );
  assert.deepEqual(cleared, []);
  assert.equal(
    clearForcedBackoffAfterStart("security", true, "started", (key) => cleared.push(key)),
    true,
  );
  assert.deepEqual(cleared, forcedBackoffKeys("security"));
});

test("bounded diagnostic work settles independently and preserves result order", async () => {
  let active = 0;
  let maximum = 0;
  const settled = await mapAllSettledBounded([30, 5, 15, 1], 2, async (delay, index) => {
    active += 1;
    maximum = Math.max(maximum, active);
    await new Promise((resolve) => setTimeout(resolve, delay));
    active -= 1;
    if (index === 2) throw new Error("independent failure");
    return index;
  });
  assert.equal(maximum, 2);
  assert.deepEqual(settled.map(({ status }) => status), [
    "fulfilled",
    "fulfilled",
    "rejected",
    "fulfilled",
  ]);
  assert.deepEqual(settled.map((result) => result.value), [0, 1, undefined, 3]);
});

test("open request ownership preserves per-item guards and aborts every child on quit", async () => {
  const registry = createOpenRequestRegistry();
  let aborted = false;
  const first = registry.start("actions:1", ({ signal }) =>
    new Promise((resolve, reject) => {
      signal.addEventListener("abort", () => {
        aborted = true;
        reject(Object.assign(new Error("aborted"), { name: "AbortError" }));
      });
    }),
  );
  assert.equal(registry.start("actions:1", async () => {}), null);
  registry.abortAll();
  await assert.rejects(first, { name: "AbortError" });
  assert.equal(aborted, true);
  assert.equal(registry.size(), 0);
});

test("selection reconciliation keeps an existing key visible and clears only a missing key", () => {
  const items = Array.from({ length: 10 }, (_, number) => ({ number }));
  assert.deepEqual(
    reconcileSelectionViewport({ items, key: 6, offset: 0, rows: 4 }),
    { key: 6, offset: 3 },
  );
  assert.deepEqual(
    reconcileSelectionViewport({ items, key: 2, offset: 5, rows: 4 }),
    { key: 2, offset: 2 },
  );
  assert.deepEqual(
    reconcileSelectionViewport({ items, key: 99, offset: 5, rows: 4 }),
    { key: null, offset: 5 },
  );
});

test("status hints advertise only controls that work in the current state", () => {
  assert.deepEqual(
    activeKeyHints({ interactive: true, canMove: false, canOpen: false, canResize: false }).map(
      ({ label }) => label,
    ),
    ["Refresh", "Quit"],
  );
  assert.deepEqual(
    activeKeyHints({ interactive: true, canMove: true, canOpen: true, canResize: true }).map(
      ({ label }) => label,
    ),
    ["Move", "Open", "Refresh", "Width", "Quit"],
  );
});

test("failure and selection have non-colour text channels", () => {
  assert.equal(tabFailureSuffix({ count: "4", failed: true, brokenCI: false }), " (4x)");
  assert.equal(tabFailureSuffix({ count: "4", failed: false, brokenCI: true }), " (4!)");
  assert.equal(selectionLabel("open issue", true), "selected, open issue");
  assert.equal(selectionLabel("open issue", false), "open issue");
});

test("narrow errors start with a usable action", () => {
  const message = formatTabErrorForWidth(
    { kind: "fetch", verdict: "auth-problem", raw: "bad credentials" },
    null,
    42,
  );
  assert.match(message, /^Run: gh auth status/);
  assert.ok(message.length <= 42);
});

test("short help always includes exit, refresh, and an explicit continuation cue", () => {
  const lines = helpLines(4);
  assert.equal(lines.length, 4);
  assert.ok(lines.some((line) => /Quit/.test(line)));
  assert.ok(lines.some((line) => /Refresh/.test(line)));
  assert.ok(lines.some((line) => /Open the selected/.test(line)));
  assert.ok(lines.some((line) => /Move the cursor/.test(line)));
  assert.ok(lines.some((line) => /more|closes/.test(line)));
});

test("mouse reporting is opt-in to width mode while divider dragging remains available there", () => {
  assert.equal(shouldEnableMouseReporting({ interactive: true, widthMode: false }), false);
  assert.equal(shouldEnableMouseReporting({ interactive: true, widthMode: true }), true);
  assert.equal(shouldEnableMouseReporting({ interactive: false, widthMode: true }), false);
});
