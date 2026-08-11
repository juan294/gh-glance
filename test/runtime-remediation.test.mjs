import assert from "node:assert/strict";
import { test } from "node:test";

import {
  ALERT_SOURCES,
  RowBoundary,
  activeKeyHints,
  alertRequestArgs,
  authCacheIdentity,
  createOpenRequestRegistry,
  forcedBackoffKeys,
  formatTabErrorForWidth,
  helpLines,
  mergeAlertRows,
  mergeDashboardCacheSnapshots,
  mergeWidthPreferenceSnapshots,
  nextBudgetTargets,
  pollResultTransition,
  pollTickKeys,
  reconcileSelectionViewport,
  securityPollDelay,
  selectionLabel,
  shouldCheckpointFreshness,
  shouldEnableMouseReporting,
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

  const dependabot = requests.filter((args) => args[1].includes("dependabot"));
  assert.ok(dependabot.some((args) => args[1].includes("severity=critical,high")));
  const code = requests.filter((args) => args[1].includes("code-scanning"));
  assert.ok(code.some((args) => args[1].includes("severity=critical")));
  assert.ok(code.some((args) => args[1].includes("severity=high")));

  const rows = mergeAlertRows([
    [{ number: 1, severity: "low" }, { number: 2, severity: "high" }],
    [{ number: 2, severity: "high" }, { number: 3, severity: "critical" }],
  ]);
  assert.deepEqual(rows.map(({ number }) => number), [1, 2, 3]);
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

  const baseCache = { one: { updatedAt: 1 } };
  const diskCache = { one: { updatedAt: 1 }, two: { updatedAt: 2 } };
  const nextCache = { one: { updatedAt: 3 } };
  assert.deepEqual(mergeDashboardCacheSnapshots(baseCache, diskCache, nextCache), {
    one: { updatedAt: 3 },
    two: { updatedAt: 2 },
  });
});

test("freshness checkpoints are bounded instead of writing every successful poll", () => {
  assert.equal(shouldCheckpointFreshness({ persistedAt: 1000, completedAt: 60_999 }), false);
  assert.equal(shouldCheckpointFreshness({ persistedAt: 1000, completedAt: 61_000 }), true);
  assert.equal(shouldCheckpointFreshness({ persistedAt: null, completedAt: 1 }), true);
});

test("GraphQL and REST budgets each constrain the adaptive interval", () => {
  const nowMs = 1_000_000;
  const budgets = {
    core: { remaining: 5000, resetMs: nowMs + 3_600_000 },
    graphql: { remaining: 100, resetMs: nowMs + 3_600_000 },
  };
  const constrained = nextBudgetTargets({
    budgets,
    samples: { core: null, graphql: null },
    shares: { core: 1, graphql: 1 },
    activeKey: "issues",
    floorMs: 5000,
    nowMs,
  });
  assert.ok(
    constrained.targetMs > 5000,
    `GraphQL budget did not widen the interval: ${constrained.targetMs}`,
  );
  const coreConstrained = nextBudgetTargets({
    budgets: {
      core: { remaining: 100, resetMs: nowMs + 3_600_000 },
      graphql: { remaining: 5000, resetMs: nowMs + 3_600_000 },
    },
    samples: { core: null, graphql: null },
    shares: { core: 1, graphql: 1 },
    activeKey: "issues",
    floorMs: 5000,
    nowMs,
  });
  assert.ok(
    coreConstrained.targetMs > 5000,
    `REST budget did not widen the interval: ${coreConstrained.targetMs}`,
  );
  assert.deepEqual(
    nextBudgetTargets({
      budgets: { core: budgets.core, graphql: null },
      samples: {},
      shares: {},
      previous: { core: 9000, graphql: 12_000 },
      activeKey: "issues",
      floorMs: 5000,
      nowMs,
    }).targets,
    { core: 5000, graphql: 12_000 },
  );
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

  assert.deepEqual(pollTickKeys({ ticks: 0, activeKey: "issues" }).due, [
    "actions",
    "issues",
    "prs",
    "security",
  ]);
  assert.deepEqual(pollTickKeys({ ticks: 1, activeKey: "issues" }).due, ["issues"]);
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
  assert.ok(lines.some((line) => /more|closes/.test(line)));
});

test("mouse reporting is opt-in to width mode while divider dragging remains available there", () => {
  assert.equal(shouldEnableMouseReporting({ interactive: true, widthMode: false }), false);
  assert.equal(shouldEnableMouseReporting({ interactive: true, widthMode: true }), true);
  assert.equal(shouldEnableMouseReporting({ interactive: false, widthMode: true }), false);
});
