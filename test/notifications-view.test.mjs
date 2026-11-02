import assert from "node:assert/strict";
import { test } from "node:test";
import {
  recoveryCause,
  criticalInlineLines,
  tabBarEntries,
  tabBarWidth,
  notificationViewLines,
} from "../index.mjs";

const NOW = new Date(2026, 10, 2, 9, 30).getTime();

test("criticalInlineLines: only action causes and action fetch verdicts stay inline", () => {
  const corrupt = recoveryCause({ reason: "corrupt", resource: "core", sourceAt: NOW - 60_000 });
  const stale = recoveryCause({ reason: "budget-stale", resource: "core", sourceAt: NOW - 60_000 });
  const base = { nowMs: NOW, cols: 80, hasSnapshot: true, capacity: 11 };

  const action = criticalInlineLines({ ...base, cause: corrupt, showCause: true });
  assert.equal(action.source, "cause");
  assert.ok(action.lines.length >= 1 && action.lines.length <= 3);
  assert.match(action.lines.join("\n"), /gh-glance --doctor/);

  assert.deepEqual(criticalInlineLines({ ...base, cause: stale, showCause: true }), { lines: [], source: null });
  // Before the debounce elapses, an action cause shows nothing yet.
  assert.deepEqual(criticalInlineLines({ ...base, cause: corrupt, showCause: false }), { lines: [], source: null });

  const auth = { kind: "fetch", verdict: "auth-problem", raw: "401" };
  assert.deepEqual(criticalInlineLines({ ...base, cause: stale, showCause: true, tabError: auth,
    displayError: "Run gh auth status" }), { lines: ["Run gh auth status"], source: "error" });

  const other = { kind: "fetch", verdict: "other", raw: "HTTP 502" };
  assert.deepEqual(criticalInlineLines({ ...base, tabError: other, displayError: "HTTP 502" }),
    { lines: [], source: null });
  const limited = { kind: "fetch", verdict: "rate-limited", raw: "rate limit" };
  assert.deepEqual(criticalInlineLines({ ...base, tabError: limited, displayError: "limited" }),
    { lines: [], source: null });
});

test("criticalInlineLines: capacity bounds the lines and keeps the remedy on a one-row pane", () => {
  const corrupt = recoveryCause({ reason: "corrupt", resource: "core", sourceAt: NOW - 60_000 });
  const base = { cause: corrupt, showCause: true, nowMs: NOW, cols: 50, hasSnapshot: true };
  assert.equal(criticalInlineLines({ ...base, capacity: 3 }).lines.length, 3);
  assert.deepEqual(criticalInlineLines({ ...base, capacity: 1 }).lines, ["Run gh-glance --doctor"]);
  assert.deepEqual(criticalInlineLines({ ...base, capacity: 0 }).lines, []);
});

const tabInputs = (overrides = {}) => ({
  counts: { actions: "30", issues: "12", prs: "5", security: "0" },
  brokenCI: { actions: false, issues: false, prs: false, security: false },
  firstLoad: { actions: false, issues: false, prs: false, security: false },
  failed: { actions: false, issues: false, prs: false, security: false },
  spin: "-",
  activeIndex: 0,
  notifications: { unread: 3, tone: "yellow" },
  ...overrides,
});

test("tabBarEntries: five entries fit one row with every digit at 120, 80, 60 and 40 columns", () => {
  for (const cols of [120, 80, 60, 40]) {
    const entries = tabBarEntries({ ...tabInputs(), cols, useShort: cols < 98 });
    assert.equal(entries.length, 5);
    assert.ok(tabBarWidth(entries) <= cols, `${cols}: ${tabBarWidth(entries)}`);
    entries.forEach((entry, index) => assert.ok(entry.label.includes(String(index + 1)), entry.label));
  }
  const wide = tabBarEntries({ ...tabInputs(), cols: 120, useShort: false });
  assert.deepEqual(wide.map((entry) => entry.label),
    ["[1:Actions (30)]", " 2:Issues (12) ", " 3:Pull requests (5) ", " 4:Security (0) ", " 5:Notifications (3) "]);
  const medium = tabBarEntries({ ...tabInputs(), cols: 80, useShort: true });
  assert.equal(medium[4].label, " 5:Notices (3) ");
  assert.equal(medium[2].label, " 3:PRs (5) ");
  const narrow = tabBarEntries({ ...tabInputs(), cols: 40, useShort: true });
  assert.deepEqual(narrow.map((entry) => entry.label), ["[1(30)]", " 2(12) ", " 3(5) ", " 4(0) ", " 5(3) "]);
});

test("tabBarEntries: narrow panes drop gaps, then counts, and never exceed the width", () => {
  const busy = tabInputs({ counts: { actions: "30", issues: "12", prs: "5", security: "0" },
    notifications: { unread: 12, tone: "red" } });
  const tight = tabBarEntries({ ...busy, cols: 33, useShort: true });
  assert.deepEqual(tight.map((entry) => entry.label), ["[1(30)]", " 2(12) ", " 3(5) ", " 4(0) ", " 5(12) "]);
  assert.equal(tabBarWidth(tight), 33);
  for (const cols of [32, 23, 19]) {
    const entries = tabBarEntries({ ...busy, cols, useShort: true });
    assert.ok(tabBarWidth(entries) <= cols, `${cols}: ${entries.map((entry) => entry.label).join("|")}`);
    assert.deepEqual(entries.map((entry) => entry.label), ["[1]", " 2 ", " 3 ", " 4 ", " 5(12) "]);
  }
});

test("tabBarEntries: badge tone and the active Notifications entry", () => {
  const [, , , , red] = tabBarEntries({ ...tabInputs({ notifications: { unread: 1, tone: "red" } }), cols: 120 });
  assert.equal(red.color, "redBright");
  const [, , , , yellow] = tabBarEntries({ ...tabInputs(), cols: 120 });
  assert.equal(yellow.color, "yellowBright");
  const [, , , , quiet] = tabBarEntries({ ...tabInputs({ notifications: { unread: 0, tone: "none" } }), cols: 120 });
  assert.equal(quiet.label, " 5:Notifications ");
  assert.equal(quiet.color, undefined);
  assert.equal(quiet.dim, true);
  const open = tabBarEntries({ ...tabInputs({ activeIndex: 4, notifications: { unread: 0, tone: "none" } }), cols: 120 });
  assert.equal(open[4].label, "[5:Notifications]");
  assert.equal(open[4].active, true);
  assert.equal(open[0].active, false);
});

const entry = (patch) => ({ id: 1, key: "k", level: "info", source: "Actions", code: null,
  text: "Refreshed Actions", action: null, firstAt: NOW, lastAt: NOW, count: 1, endedAt: null,
  seeded: false, tabs: [], ...patch });

test("notificationViewLines: status header, newest first rows, counts, retry and dimming", () => {
  const entries = [
    entry({ id: 3, key: "cause:budget-stale", level: "wait", source: "Core", code: "budget-stale",
      text: "GitHub budget evidence is old" }),
    entry({ id: 2, key: "cause:corrupt", level: "action", source: "Core", code: "corrupt",
      text: "Local coordination is corrupt", action: "Run gh-glance --doctor" }),
    entry({ id: 1, count: 12, lastAt: NOW - 86_400_000 }),
  ];
  const view = notificationViewLines({ entries, statusLine: "GitHub status: not checked yet", nowMs: NOW,
    capacity: 10, liveRetry: { "budget-stale": NOW + 120_000 }, profile: "ascii" });
  assert.deepEqual(view.lines.map((line) => line.text), [
    "GitHub status: not checked yet",
    "09:30 | Core: GitHub budget evidence is old; next 2m",
    "09:30 ! Core: Local coordination is corrupt; Run gh-glance --doctor",
    "11-01 09:30 . Actions: Refreshed Actions x12",
  ]);
  assert.deepEqual(view.lines.slice(1).map((line) => line.dim), [false, false, true]);
});

test("notificationViewLines: scrolling clamps to the available rows; empty log says so", () => {
  const entries = Array.from({ length: 20 }, (_, index) => entry({ id: 20 - index, text: `event ${19 - index}`,
    key: `k${index}`, source: `s${index}` }));
  const view = notificationViewLines({ entries, statusLine: "status", nowMs: NOW, capacity: 6, offset: 99,
    profile: "ascii" });
  assert.equal(view.offset, 15);
  assert.equal(view.maxOffset, 15);
  assert.equal(view.lines.length, 6);
  assert.match(view.lines.at(-1).text, /event 0$/);
  const empty = notificationViewLines({ entries: [], statusLine: "status", nowMs: NOW, capacity: 6, profile: "ascii" });
  assert.deepEqual(empty.lines.map((line) => line.text), ["status", "No events yet"]);
});
