import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  RECOVERY_COPY,
  COORDINATION_NOTICE_AFTER_MS,
  NOTIFICATION_LOG_MAX,
  NOTICE_LEVELS,
  noticeLevel,
  fetchErrorLevel,
  createNotificationLog,
  notificationConditions,
  diffNotificationSnapshots,
  seedNotificationsFromJournal,
  recordRecoveryTransition,
  readRecoveryTransitions,
} from "../index.mjs";

const ACTION_CODES = [
  "unwritable", "corrupt", "capacity", "accounting-overflow", "reservations-invalid",
  "external-factor-invalid", "pacing-invalid", "budget-resource", "legacy-unresolved",
  "legacy-corrupt", "restart-required", "throttle-paused", "credential-unavailable",
  "identity-unavailable", "disconnected", "app-auth", "auth-problem", "unavailable",
  "backup-conflict", "version-mismatch", "unsafe-permissions", "disk-full",
];

test("noticeLevel: every recovery code has exactly one level; 22 action and 34 wait", () => {
  // The table itself must list every code: the unknown-code fallback would
  // otherwise hide a new RECOVERY_COPY key that nobody classified.
  assert.deepEqual(Object.keys(NOTICE_LEVELS).sort(), Object.keys(RECOVERY_COPY).sort());
  const levels = Object.keys(RECOVERY_COPY).map((code) => [code, noticeLevel({ code })]);
  for (const [code, level] of levels) {
    assert.ok(["action", "wait"].includes(level), `${code} -> ${level}`);
  }
  const action = levels.filter(([, level]) => level === "action").map(([code]) => code).sort();
  assert.deepEqual(action, [...ACTION_CODES].sort());
  assert.equal(levels.filter(([, level]) => level === "wait").length, 34);
  assert.equal(levels.length, 56);
});

test("noticeLevel: fetch verdicts, unknown codes and empty input", () => {
  for (const verdict of ["auth-problem", "unavailable", "no-remote"]) {
    assert.equal(noticeLevel({ verdict }), "action", verdict);
  }
  assert.equal(noticeLevel({ verdict: "other" }), "problem");
  assert.equal(noticeLevel({ verdict: "unusable-output" }), "problem");
  assert.equal(noticeLevel({ verdict: "rate-limited" }), "wait");
  assert.equal(noticeLevel({ code: "not-a-code" }), "wait");
  assert.equal(noticeLevel({}), "info");
  assert.equal(noticeLevel(), "info");
});

test("fetchErrorLevel: a shared budget pause reported as text is a wait", () => {
  assert.equal(fetchErrorLevel({ kind: "fetch", verdict: "other", raw: "API budget paused (core)" }), "wait");
  assert.equal(fetchErrorLevel({ kind: "fetch", verdict: "other", raw: "boom" }), "problem");
  assert.equal(fetchErrorLevel({ kind: "text", text: "boom" }), "problem");
  assert.equal(fetchErrorLevel({ kind: "fetch", verdict: "auth-problem", raw: "" }), "action");
  assert.equal(fetchErrorLevel(null), null);
});

function clock(start = 1_000_000) {
  let at = start;
  return { now: () => at, advance: (ms) => { at += ms; return at; } };
}

test("log: repeated refreshes coalesce; an intervening wait for the same source starts a new entry", () => {
  const time = clock();
  const log = createNotificationLog({ now: time.now });
  for (let i = 0; i < 12; i += 1) {
    log.record({ key: "refreshed:actions", level: "info", source: "Actions", text: "Refreshed Actions" });
    time.advance(1000);
  }
  assert.equal(log.size(), 1);
  assert.equal(log.list()[0].count, 12);
  assert.equal(log.list()[0].lastAt, time.now() - 1000);
  log.record({ key: "cause:budget-stale", level: "wait", source: "Actions", text: "GitHub budget evidence is old" });
  log.record({ key: "refreshed:actions", level: "info", source: "Actions", text: "Refreshed Actions" });
  assert.equal(log.size(), 3);
  assert.equal(log.list()[0].count, 1);
  assert.equal(log.list()[0].key, "refreshed:actions");
  // Another source's wait does not split Actions refreshes.
  log.record({ key: "cause:busy", level: "wait", source: "Issues", text: "Coordinating" });
  log.record({ key: "refreshed:actions", level: "info", source: "Actions", text: "Refreshed Actions" });
  assert.equal(log.size(), 4);
  assert.equal(log.list()[0].key, "refreshed:actions");
  assert.equal(log.list()[0].count, 2);
});

test("log: end marks the open entry and appends a cleared info entry for non-info levels", () => {
  const time = clock();
  const log = createNotificationLog({ now: time.now });
  log.record({ key: "cause:budget-stale", level: "wait", source: "Core", text: "GitHub budget evidence is old" });
  time.advance(5000);
  log.end("cause:budget-stale");
  const [cleared, original] = log.list();
  assert.equal(original.endedAt, time.now());
  assert.equal(cleared.level, "info");
  assert.equal(cleared.source, "Core");
  assert.match(cleared.text, /^Cleared: GitHub budget evidence is old/);
  // A recurring condition after its end is a new episode.
  log.record({ key: "cause:budget-stale", level: "wait", source: "Core", text: "GitHub budget evidence is old" });
  assert.equal(log.size(), 3);
  assert.equal(log.list()[0].endedAt, null);
  // Ending an info entry appends nothing.
  log.record({ key: "security:note", level: "info", source: "Security", text: "Dependabot: not enabled" });
  log.end("security:note");
  assert.equal(log.size(), 4);
  // Ending an unknown key is a no-op.
  log.end("nothing");
  assert.equal(log.size(), 4);
});

test("log: bound keeps the newest 500 entries and reports truncation", () => {
  const log = createNotificationLog({ now: () => 1 });
  assert.equal(NOTIFICATION_LOG_MAX, 500);
  for (let i = 0; i < 501; i += 1) {
    log.record({ key: `k${i}`, level: "info", source: `s${i}`, text: `event ${i}` });
  }
  assert.equal(log.size(), 500);
  assert.equal(log.summary().truncated, true);
  assert.equal(log.list()[0].text, "event 500");
  assert.equal(log.list().at(-1).text, "event 1");
});

test("log: unread count and tone", () => {
  const log = createNotificationLog({ now: () => 1 });
  log.record({ key: "refreshed:actions", level: "info", source: "Actions", text: "Refreshed Actions" });
  assert.deepEqual(log.summary(), { unread: 0, tone: "none", truncated: false, size: 1 });
  log.record({ key: "cause:busy", level: "wait", source: "Core", text: "Coordinating" });
  assert.equal(log.summary().unread, 1);
  assert.equal(log.summary().tone, "yellow");
  log.record({ key: "fetch:actions:other", level: "problem", source: "Actions", text: "boom" });
  assert.equal(log.summary().unread, 2);
  assert.equal(log.summary().tone, "red");
  log.markSeen();
  assert.equal(log.summary().unread, 0);
  assert.equal(log.summary().tone, "none");
  // A coalesced repeat of a seen entry is not new.
  log.record({ key: "fetch:actions:other", level: "problem", source: "Actions", text: "boom" });
  assert.equal(log.summary().unread, 0);
  log.record({ key: "cause:corrupt", level: "action", source: "Core", text: "corrupt" });
  assert.equal(log.summary().tone, "red");
});

test("log: summary returns the same object while nothing changed", () => {
  const log = createNotificationLog({ now: () => 1 });
  log.record({ key: "cause:busy", level: "wait", source: "Core", text: "Coordinating" });
  const first = log.summary();
  assert.equal(log.summary(), first);
  log.record({ key: "refreshed:actions", level: "info", source: "Actions", text: "Refreshed Actions" });
  assert.deepEqual(log.summary(), { ...first, size: 2 });
});

test("log: event text is sanitized and bounded", () => {
  const log = createNotificationLog({ now: () => 1 });
  log.record({ key: "x", level: "problem", source: "Act\x1b[2Jions", text: `bad\x1b[31m red\x07${"z".repeat(1000)}` });
  const [entry] = log.list();
  assert.equal(entry.text.includes("\x1b") || entry.text.includes("\x07"), false);
  assert.equal(entry.source.includes("\x1b"), false);
  assert.ok(Array.from(entry.text).length <= 300);
});

const BASE = Object.freeze({
  tabs: {
    actions: { lastOk: 100, error: null, failure: null, paused: null },
    issues: { lastOk: 100, error: null, failure: null, paused: null },
    prs: { lastOk: 100, error: null, failure: null, paused: null },
    security: { lastOk: 100, error: null, failure: null, paused: null },
  },
  recovery: { core: null, graphql: null },
  securityNotes: [],
  disconnected: null,
});

function snapshot(patch = {}) {
  return { ...BASE, ...patch, tabs: { ...BASE.tabs, ...patch.tabs } };
}

test("snapshot diff: a condition shorter than the notice debounce never records", () => {
  const withCause = snapshot({ tabs: { actions: { ...BASE.tabs.actions, paused: "budget-stale" } } });
  let result = diffNotificationSnapshots(null, BASE, 0);
  assert.deepEqual([result.begin, result.end], [[], []]);
  result = diffNotificationSnapshots(result.state, withCause, 1000);
  assert.deepEqual(result.begin, []);
  assert.equal(result.pending, 1000 + COORDINATION_NOTICE_AFTER_MS);
  result = diffNotificationSnapshots(result.state, withCause, 1000 + COORDINATION_NOTICE_AFTER_MS - 1);
  assert.deepEqual(result.begin, []);
  result = diffNotificationSnapshots(result.state, BASE, 1000 + COORDINATION_NOTICE_AFTER_MS);
  assert.deepEqual([result.begin, result.end, result.pending], [[], [], null]);
});

test("snapshot diff: a condition lasting the debounce begins once, then ends when gone", () => {
  const withCause = snapshot({ tabs: { actions: { ...BASE.tabs.actions, paused: "budget-stale" } } });
  let result = diffNotificationSnapshots(null, BASE, 0);
  result = diffNotificationSnapshots(result.state, withCause, 1000);
  result = diffNotificationSnapshots(result.state, withCause, 1000 + COORDINATION_NOTICE_AFTER_MS);
  assert.equal(result.begin.length, 1);
  const [event] = result.begin;
  assert.equal(event.key, "cause:budget-stale");
  assert.equal(event.level, "wait");
  assert.equal(event.source, "Actions");
  assert.match(event.text, /GitHub budget evidence is old/);
  assert.equal(result.pending, null);
  result = diffNotificationSnapshots(result.state, withCause, 5000);
  assert.deepEqual(result.begin, []);
  result = diffNotificationSnapshots(result.state, BASE, 6000);
  assert.deepEqual(result.end, ["cause:budget-stale"]);
});

test("snapshot diff: the same cause across tabs and resources is one condition", () => {
  const paused = { ...BASE.tabs.actions, paused: "budget-stale" };
  const current = snapshot({ tabs: { actions: paused, issues: paused, prs: paused },
    recovery: { core: { code: "budget-stale", resource: "core", summary: "GitHub budget evidence is old",
      action: "Retry the shared budget check automatically" }, graphql: null } });
  const conditions = notificationConditions(current);
  assert.deepEqual([...conditions.keys()], ["cause:budget-stale"]);
  assert.equal(conditions.get("cause:budget-stale").source, "Core");
});

test("snapshot diff: fetch errors, security notes and disconnection map to levels", () => {
  const current = snapshot({
    tabs: {
      actions: { ...BASE.tabs.actions, error: { kind: "fetch", verdict: "other", raw: "HTTP 502" } },
      issues: { ...BASE.tabs.issues, error: { kind: "fetch", verdict: "auth-problem", raw: "401" } },
    },
    securityNotes: ["Dependabot: not enabled for this repository", "Code scanning: unavailable (HTTP 500)"],
    disconnected: "identity-unavailable",
  });
  const conditions = notificationConditions(current);
  const byKey = Object.fromEntries([...conditions].map(([key, value]) => [key, value.level]));
  assert.deepEqual(byKey, {
    "fetch:actions:problem:other": "problem",
    "fetch:issues:action:auth-problem": "action",
    "security:Dependabot: not enabled for this repository": "info",
    "security:Code scanning: unavailable (HTTP 500)": "wait",
    "cause:identity-unavailable": "action",
  });
  assert.equal(conditions.get("fetch:actions:problem:other").text, "HTTP 502");
});

test("snapshot diff: a budget pause that becomes a real failure records the failure", () => {
  const paused = snapshot({ tabs: { actions: { ...BASE.tabs.actions,
    error: { kind: "fetch", verdict: "other", raw: "API budget paused (core)" } } } });
  const failed = snapshot({ tabs: { actions: { ...BASE.tabs.actions,
    error: { kind: "fetch", verdict: "other", raw: "HTTP 502" } } } });
  let result = diffNotificationSnapshots(null, paused, 0);
  result = diffNotificationSnapshots(result.state, paused, COORDINATION_NOTICE_AFTER_MS);
  assert.deepEqual(result.begin.map((event) => event.level), ["wait"]);
  result = diffNotificationSnapshots(result.state, failed, 2 * COORDINATION_NOTICE_AFTER_MS);
  result = diffNotificationSnapshots(result.state, failed, 3 * COORDINATION_NOTICE_AFTER_MS);
  assert.deepEqual(result.begin.map((event) => [event.level, event.text]), [["problem", "HTTP 502"]]);
});

test("log: a resource wait affecting a tab splits that tab's refreshes", () => {
  const conditions = notificationConditions(snapshot({ recovery: { core: { code: "budget-stale",
    resource: "core", summary: "GitHub budget evidence is old", action: "Retry" }, graphql: null } }));
  const wait = conditions.get("cause:budget-stale");
  assert.equal(wait.source, "Core");
  assert.ok(wait.tabs.includes("actions"));
  const log = createNotificationLog({ now: () => 1 });
  log.record({ key: "refreshed:actions", level: "info", source: "Actions", text: "Refreshed Actions", tabs: ["actions"] });
  log.record(wait);
  log.end("cause:budget-stale");
  log.record({ key: "refreshed:actions", level: "info", source: "Actions", text: "Refreshed Actions", tabs: ["actions"] });
  assert.deepEqual(log.list().map((entry) => [entry.key, entry.count]), [
    ["refreshed:actions", 1], ["cause:budget-stale:cleared", 1], ["cause:budget-stale", 1], ["refreshed:actions", 1],
  ]);
});

test("snapshot diff: an advanced lastOk records a refreshed info event without debounce", () => {
  let result = diffNotificationSnapshots(null, BASE, 0);
  result = diffNotificationSnapshots(result.state,
    snapshot({ tabs: { actions: { ...BASE.tabs.actions, lastOk: 200 } } }), 10);
  assert.deepEqual(result.begin.map((event) => [event.key, event.level, event.text]),
    [["refreshed:actions", "info", "Refreshed Actions"]]);
  // The first observation of a tab is a baseline, not a refresh.
  result = diffNotificationSnapshots(null, snapshot({ tabs: { actions: { ...BASE.tabs.actions, lastOk: 300 } } }), 20);
  assert.deepEqual(result.begin, []);
});

function journalScope(t) {
  const root = mkdtempSync(join(tmpdir(), "gh-glance-notifications-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  return { path: join(root, `quota-${"b".repeat(64)}.json`) };
}

test("journal seed: healthy journal entries become earlier-session history", (t) => {
  const scope = journalScope(t);
  assert.equal(recordRecoveryTransition(scope, { resource: "core", reason: "budget-stale", at: 1000 }).ok, true);
  assert.equal(recordRecoveryTransition(scope, { resource: "core", clear: true, at: 2000 }).ok, true);
  assert.equal(recordRecoveryTransition(scope, { resource: "graphql", reason: "corrupt", at: 3000 }).ok, true);
  const log = createNotificationLog({ now: () => 10_000 });
  seedNotificationsFromJournal(log, scope);
  const entries = log.list();
  assert.deepEqual(entries.map((entry) => [entry.source, entry.level, entry.firstAt]), [
    ["Earlier session", "action", 3000],
    ["Earlier session", "info", 2000],
    ["Earlier session", "wait", 1000],
  ]);
  assert.match(entries[0].text, /^GraphQL: Local coordination is corrupt/);
  assert.equal(entries[2].endedAt, 2000);
  assert.match(entries[1].text, /^Cleared: Core: GitHub budget evidence is old/);
  // Earlier-session history does not raise the unread badge.
  assert.equal(log.summary().unread, 0);
});

test("journal seed: a cause replaced by another code ends like a live one", (t) => {
  const scope = journalScope(t);
  assert.equal(recordRecoveryTransition(scope, { resource: "core", reason: "budget-stale", at: 1000 }).ok, true);
  assert.equal(recordRecoveryTransition(scope, { resource: "core", reason: "corrupt", at: 3000 }).ok, true);
  const log = createNotificationLog({ now: () => 10_000 });
  seedNotificationsFromJournal(log, scope);
  assert.deepEqual(log.list().map((entry) => [entry.code, entry.endedAt]),
    [["corrupt", null], [null, null], ["budget-stale", 3000]]);
});

test("journal seed: the same cause journaled again for a new origin stays one entry", (t) => {
  const scope = journalScope(t);
  assert.equal(recordRecoveryTransition(scope, { resource: "core", reason: "budget-stale", at: 1000,
    origin: "source", tab: "actions" }).ok, true);
  assert.equal(recordRecoveryTransition(scope, { resource: "core", reason: "budget-stale", at: 2000 }).ok, true);
  assert.equal(readRecoveryTransitions(scope).entries.length, 2);
  const log = createNotificationLog({ now: () => 10_000 });
  seedNotificationsFromJournal(log, scope);
  assert.equal(log.size(), 1);
});

test("journal seed: a missing journal seeds nothing", (t) => {
  const log = createNotificationLog({ now: () => 1 });
  seedNotificationsFromJournal(log, journalScope(t));
  assert.equal(log.size(), 0);
});

test("journal seed: corrupt and unavailable journals add one doctor info entry", (t) => {
  const corrupt = journalScope(t);
  writeFileSync(`${corrupt.path}.recovery.json`, "{not json");
  const unavailable = journalScope(t);
  writeFileSync(`${unavailable.path}.recovery.json`, "x".repeat(129 * 1024));
  assert.equal(readRecoveryTransitions(corrupt).status, "corrupt");
  assert.equal(readRecoveryTransitions(unavailable).status, "unavailable");
  for (const scope of [corrupt, unavailable]) {
    const log = createNotificationLog({ now: () => 1 });
    seedNotificationsFromJournal(log, scope);
    assert.equal(log.size(), 1);
    const [entry] = log.list();
    assert.equal(entry.level, "info");
    assert.equal(entry.text, "Earlier recovery history unavailable; run gh-glance --doctor");
  }
});
