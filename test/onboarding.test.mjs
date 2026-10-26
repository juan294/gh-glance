import assert from "node:assert/strict";
import { test } from "node:test";
import * as app from "../index.mjs";

const nowMs = new Date(2026, 9, 25, 12, 30).getTime();
const sourceAt = nowMs - 60_000;
const view = (overrides = {}) => app.dashboardPresentation({
  tab: "issues", rows: [], hasSnapshot: true, sourceAt, nowMs, ...overrides,
});
const text = (result) => [result.title, result.explanation, result.sourceCheck, result.action,
  ...result.notes].join(" ");

test("CX-01/02: successful empty tabs identify the observed scope without table chrome", () => {
  for (const [tab, title] of [["actions", "No workflow runs found"], ["issues", "No open issues"],
    ["prs", "No open pull requests"]]) {
    const result = view({ tab });
    assert.equal(result.title, title);
    assert.equal(result.showTable, false);
    assert.match(result.sourceCheck, /Checked.*12:29/);
    assert.doesNotMatch(text(result), /all caught up|secure|never had/i);
  }
  assert.match(view({ tab: "actions" }).explanation, /automated.*workflow.*trigger/);
});
test("CX-03/04: unchecked loading and waiting never claim zero results or cached data", () => {
  const loading = view({ hasSnapshot: false, rows: null, requestState: "loading" });
  assert.equal(loading.title, "Checking Issues…");
  const waiting = view({ hasSnapshot: false, rows: null, requestState: "waiting",
    recovery: app.recoveryCause({ reason: "local-reserve", retryAt: nowMs + 60_000 }) });
  assert.equal(waiting.title, "Waiting to check Issues");
  assert.match(text(waiting), /Local quota reserve pacing/);
  assert.match(waiting.action, /next/);
  for (const result of [loading, waiting]) {
    assert.equal(result.sourceCheck, "Not checked yet");
    assert.doesNotMatch(text(result), /No open|cached|Saved|\(0\)/);
  }
});
test("CX-05/06/14: failures outrank loading, retain earlier results and actionable recovery", () => {
  for (const rows of [null, [], [{ number: 1 }]]) {
    const result = view({ rows, hasSnapshot: rows !== null, requestState: "loading",
      error: true, recovery: app.recoveryCause({ reason: "auth-problem" }) });
    assert.equal(result.title, rows === null ? "Could not load Issues" : "Could not refresh Issues");
    assert.match(result.action, /gh auth status/);
    assert.equal(result.showTable, rows?.length > 0);
    assert.doesNotMatch(result.title, /Checking|No open/);
    if (rows?.length === 0) assert.match(result.explanation, /Last check found no open issues/);
  }
  assert.match(view({ recovery: app.recoveryCause({ reason: "unwritable" }) }).action,
    /gh-glance --doctor; check storage permissions/);
});
test("CX-07/08: overdue and saved views do not invent a failed request", () => {
  assert.equal(view({ overdue: true }).title, "Issues needs an update");
  assert.equal(view({ onDemand: true }).title, "Saved Issues view");
  assert.match(view({ onDemand: true }).action, /Press r/);
  assert.doesNotMatch(text(view({ overdue: true })), /connection failed|Could not/);
  assert.doesNotMatch(text(view({ onDemand: true })), /continuously|Watching/);
});
test("CX-09: existing snapshots with unknown or future source clocks stay uncertain", () => {
  for (const sourceAt of [null, nowMs + 60_000]) {
    const result = view({ sourceAt });
    assert.equal(result.sourceCheck, "Last-check time unavailable");
    assert.doesNotMatch(text(result), /Not checked yet|just now|0s/);
    const lines = app.presentRecovery(app.recoveryCause({ reason: "clock-recovery", sourceAt }),
      { nowMs, cols: 80, hasSnapshot: true });
    assert.match(lines.join(" "), /Last-check time unavailable/);
  }
  assert.match(app.presentRecovery(app.recoveryCause({ reason: "busy" }),
    { nowMs, cols: 80, hasSnapshot: false }).join(" "), /Not checked yet/);
});
test("CX-10: Security disclosures never equate incomplete coverage with clearance", () => {
  const notes = ["Code scanning: not enabled here"];
  const partial = view({ tab: "security", securityNotes: notes });
  assert.equal(partial.title, "No alerts returned by the checked sources");
  assert.deepEqual(partial.notes, notes);
  assert.equal(view({ tab: "security", securityAllUnavailable: true }).title, "No alert sources available");
  const unavailable = view({ tab: "security", securityAllUnavailable: true, onDemand: true });
  assert.doesNotMatch(text(unavailable), /checked sources|returned no alerts/);
  assert.equal(view({ tab: "security", securityAllUnavailable: true, error: true }).title,
    "Could not refresh Security");
  assert.equal(view({ tab: "security", securityAllUnavailable: true, requestState: "waiting" }).title,
    "Waiting to update Security");
  assert.doesNotMatch(text(partial), /all clear|safe|secure|^No alerts$/i);
});
test("CX-11/12: success clears failure evidence and uses only the supplied source clock", () => {
  const failed = view({ error: true, recovery: app.recoveryCause({ reason: "network-outage" }) });
  const recovered = view({ sourceAt: nowMs });
  assert.match(text(failed), /connection failed/);
  assert.doesNotMatch(text(recovered), /failed|retry automatically/i);
  assert.notEqual(failed.sourceCheck, recovered.sourceCheck);
  assert.deepEqual(view(), view({ nowMs: nowMs + 1000 }));
});
test("CX-13: tableless layout fits small panes and prioritizes state and remedy", () => {
  const result = view({ error: true, recovery: app.recoveryCause({ reason: "corrupt" }) });
  for (const cols of [24, 45, 80, 120]) for (const rows of [10, 24]) {
    const lines = app.contextualPanelLayout(result, { cols, rows });
    assert.ok(lines.length <= rows - 6);
    assert.ok(lines.every((line) => [...line].length <= cols - 5));
    assert.match(lines.join(" "), /Could not refresh/);
    assert.match(lines.join(" "), /doctor/);
  }
});

test("CX-05: source diagnostics remain available beside classified recovery", () => {
  const result = view({ hasSnapshot: false, rows: null, error: true,
    recovery: app.recoveryCause({ reason: "interrupted-request" }),
    diagnostic: "Issues: dial tcp: fixture unavailable" });
  assert.equal(result.title, "Could not load Issues");
  assert.ok(result.notes.includes("Issues: dial tcp: fixture unavailable"));
  assert.match(result.action, /quota/);
});
