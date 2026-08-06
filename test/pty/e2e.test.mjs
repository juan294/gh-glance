// End-to-end assertions against a real run of index.mjs under a pty.
//
// This covers the region the unit suite structurally cannot reach: rendered
// output, frame geometry, and terminal state on exit. Every row of data arrives
// through a useEffect poll, and ink's own renderToString explicitly does not
// reflect useEffect state updates -- so a populated frame is only observable
// through a pty.
//
// The rule that keeps this useful: assert STRUCTURE, never cell contents. Line
// counts, widths, escape balance and exit codes are stable under copy changes;
// the text in a cell is not, and asserting it would red the build for no defect.
//
// Captures cost several seconds each, so each one is taken once at module scope
// and asserted against repeatedly.

import assert from "node:assert/strict";
import { test } from "node:test";

import { capture } from "./capture.mjs";
import { MIN_TABLE_WIDTH } from "../../index.mjs";

// 80x24: the full column set. 45x20: below MIN_TABLE_WIDTH (61), so the compact
// set. Both are killed with SIGTERM, which is the path #41 lives on.
const wide = capture({ cols: 80, rows: 24 });
const narrow = capture({ cols: 45, rows: 20 });
const repositoryResolutionFailure =
  "GraphQL: Could not resolve to a Repository with the name 'Nvteca/cashflor-forecast'. (repository)";
const inaccessibleRepository = capture({
  cols: 80,
  rows: 24,
  args: "--tab issues",
  env: {
    GH_GLANCE_FIXTURE_FAIL: repositoryResolutionFailure,
    GH_GLANCE_FIXTURE_FAIL_ON: "issue,repo",
  },
});

test("the app reaches the data layer at all", () => {
  // Guards the silent failures: a zero-byte BSD capture when stdin is a socket,
  // and a preflight exit(3) before anything renders. Without this, every
  // assertion below could be passing against an empty screen.
  assert.ok(
    wide.fixtureCalls.length > 0,
    `the fixture gh was never invoked -- the capture is not of a running dashboard`,
  );
  assert.ok(
    wide.fixtureCalls.some((call) => call.startsWith("run list")),
    "expected the Actions tab to fetch on first paint",
  );
});

test("healthy startup does not probe optional failure context", () => {
  assert.ok(
    !wide.fixtureCalls.some((call) => call.startsWith("repo view")),
    "healthy startup unexpectedly probed repository context",
  );
  assert.ok(
    !wide.fixtureCalls.some((call) => call.startsWith("auth status") && call.includes("--json hosts")),
    "healthy startup unexpectedly probed compact auth context",
  );
});

test("an inaccessible repository resolves failure context once", () => {
  const calls = inaccessibleRepository.fixtureCalls;
  assert.ok(calls.some((call) => call.startsWith("issue list")), "Issues did not fail");
  assert.ok(calls.some((call) => call.startsWith("repo view")), "repository context was not read");
  assert.ok(
    calls.some((call) => call.startsWith("auth status") && call.includes("--json hosts")),
    "auth context was not read",
  );
  assert.ok(
    calls.filter((call) => call.startsWith("repo view")).length <= 1,
    "repository context was read more than once",
  );
  assert.ok(
    calls.filter((call) => call.startsWith("auth status") && call.includes("--json hosts")).length <=
      1,
    "auth context was read more than once",
  );
});

test("the failure frame preserves terminal geometry and clean teardown", () => {
  assert.equal(inaccessibleRepository.finalFrame.lines.length, 24);
  assert.ok(
    inaccessibleRepository.finalFrame.widest <= 80,
    `widest failure line was ${inaccessibleRepository.finalFrame.widest} in an 80-column terminal`,
  );
  assert.equal(inaccessibleRepository.altEnter, 1);
  assert.equal(inaccessibleRepository.altExit, 1);
  assert.equal(inaccessibleRepository.afterRestore.hasScrollbackErase, false);
  assert.equal(inaccessibleRepository.afterRestore.hasClear, false);
  assert.equal(inaccessibleRepository.afterRestore.visible, "");
});

test("the alternate screen is entered exactly once and left exactly once", () => {
  // An unbalanced pair strands the user's terminal in the alternate buffer,
  // which outlives the process.
  assert.equal(wide.altEnter, 1, "entered the alternate screen more than once");
  assert.equal(wide.altExit, 1, "left the alternate screen more than once");
});

test("the cursor is restored before exit", () => {
  // index.mjs writes ?25h itself because an explicit process.exit() skips ink's
  // own unmount restore.
  assert.ok(wide.cursorShows >= 1, "the cursor was never shown again");
});

test("the final frame is exactly as tall as the terminal", () => {
  // Output.get() pre-allocates exactly `height` rows, so any other count means
  // the layout overflowed or collapsed.
  assert.equal(wide.finalFrame.lines.length, 24);
  assert.equal(narrow.finalFrame.lines.length, 20);
});

test("no rendered line exceeds the terminal width", () => {
  // Measured before the narrow-width fix: 45x20 rendered 48 columns wide, so
  // rows hard-wrapped and ink repainted the whole screen every frame.
  assert.ok(
    wide.finalFrame.widest <= 80,
    `widest line was ${wide.finalFrame.widest} in an 80-column terminal`,
  );
  assert.ok(
    narrow.finalFrame.widest <= 45,
    `widest line was ${narrow.finalFrame.widest} in a 45-column terminal`,
  );
});

test("a pane narrower than the table minimum still renders its chrome", () => {
  // 45 is below MIN_TABLE_WIDTH, so this exercises the compact column set. The
  // frame, tab bar and status line must survive -- the behaviour before the fix
  // pushed all three off the bottom of the pane.
  assert.ok(
    MIN_TABLE_WIDTH > 45,
    `45 must stay below the compact-mode threshold (currently ${MIN_TABLE_WIDTH})`,
  );
  assert.ok(narrow.hasPanelFrame, "panel frame missing in compact mode");
  assert.ok(narrow.hasTabBar, "tab bar missing in compact mode");
});

test("the panel frame and tab bar are drawn at full width", () => {
  assert.ok(wide.hasPanelFrame);
  assert.ok(wide.hasTabBar);
});

test("the frame does not repaint by full clear in steady state", () => {
  // Two clears are the alternate-screen entry itself, and measurement puts a
  // healthy run at exactly two across 80x24, 45x20 and 60x16. Anything more is
  // the overflow-repaint path, where ink clears and rewrites the whole screen
  // every frame instead of diffing -- which is what a frame wider or taller than
  // the viewport causes, and the reason the width assertions above exist.
  assert.ok(
    wide.fullClears <= 2,
    `${wide.fullClears} full clears suggests an overflow repaint loop`,
  );
  assert.ok(
    narrow.fullClears <= 2,
    `${narrow.fullClears} full clears in compact mode suggests an overflow repaint loop`,
  );
});

test("SIGTERM exits 143", () => {
  // Documented in CHANGELOG.md but asserted nowhere until now.
  assert.equal(wide.exitCode, 143);
});

test("SIGINT exits 130 and SIGHUP exits 129", () => {
  assert.equal(capture({ cols: 60, rows: 16, signal: "INT" }).exitCode, 130);
  assert.equal(capture({ cols: 60, rows: 16, signal: "HUP" }).exitCode, 129);
});

test("nothing is written to the primary buffer after the alternate screen is left", () => {
  // This is the assertion the release-time pty check did not make. It checked
  // enter/exit balance, cursor restore and maximum width -- all of which still
  // pass while this fails.
  //
  // signal-exit runs the app's own `exit` listener before ink's unmount, so
  // restoreScreen() returns the terminal to the primary buffer and ink then
  // repaints onto it. Because the root Box is height: rows the frame always
  // exactly fills the viewport, so that repaint takes the
  // `isUnmounting && previousOutputHeight >= viewportRows` branch and is
  // preceded by ESC[2J ESC[3J -- and ESC[3J erases the user's scrollback.
  const after = wide.afterRestore;
  assert.equal(
    after.hasScrollbackErase,
    false,
    `ESC[3J was written to the primary buffer, erasing the user's scrollback (${after.bytes} bytes followed the restore)`,
  );
  assert.equal(
    after.hasClear,
    false,
    "the primary buffer was cleared after the dashboard had already released it",
  );
  assert.equal(
    after.visible,
    "",
    `a dead dashboard frame was left on the primary buffer: ${JSON.stringify(after.visible.slice(0, 120))}`,
  );
});
