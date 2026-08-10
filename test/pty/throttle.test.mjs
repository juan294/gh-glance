// The adaptive throttle, end to end.
//
// The control law itself is pinned by pure unit tests; what only a real run can
// show is that the loop actually probes, actually re-arms its timer, and
// actually says so on the status bar. The fixture `gh` answers
// `api rate_limit` with an injectable budget, so a capture can put the pane in
// front of a nearly drained token without one existing.
//
// Like the other pty files, this asserts on the fixture log and on the presence
// of a badge -- never on cell contents or layout, which a copy change would
// redden for no defect.

import assert from "node:assert/strict";
import { test } from "node:test";

import { capture } from "./capture.mjs";

// Captures cost several seconds each, so each is taken once at module scope.
//
// A nearly drained budget makes the very first probe -- which fires on the first
// tick, by design, so a pane started into an exhausted budget backs off at once
// -- widen straight to the cap. So this needs one settle window, not two.
const drained = capture({
  cols: 80,
  rows: 24,
  settle: 12,
  env: { GH_GLANCE_FIXTURE_RATE_REMAINING: "40" },
});
const healthy = capture({ cols: 80, rows: 24, settle: 12 });

const screenOf = (result) => result.finalFrame.lines.join("\n");
const runListCalls = (result) => result.fixtureCalls.filter((c) => c.startsWith("run list")).length;

test("the budget probe runs at all", () => {
  // Guards the whole file: without this, every assertion below would pass
  // vacuously on a pane that never probed.
  assert.ok(
    drained.fixtureCalls.some((c) => c.startsWith("api rate_limit")),
    "the adaptive loop never probed the rate limit",
  );
});

test("a drained budget shows the throttle badge", () => {
  assert.match(screenOf(drained), /throttled \d+s/);
});

test("a healthy budget shows no badge and does not adapt", () => {
  // The no-regression check: an ordinary single pane must look exactly as it did
  // before the throttle existed.
  assert.doesNotMatch(screenOf(healthy), /throttled/);
});

test("the drained pane still renders its frame and tab bar", () => {
  // Structural only -- cell contents are never asserted here.
  assert.ok(drained.hasPanelFrame);
  assert.ok(drained.hasTabBar);
});

test("the drained pane stops polling at the floor rate", () => {
  // The fixture log is the request record. Over a 12s settle a 5s floor issues
  // several run-list calls; a widened interval issues fewer.
  const runs = runListCalls(drained);
  const base = runListCalls(healthy);
  assert.ok(runs < base, `drained ${runs} vs healthy ${base}`);
});
