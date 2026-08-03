// Row selection, scrolling, and the cursor's stability.
//
// In its own file alongside keys.test.mjs, for the same reason: everything here
// needs timed input, and a timing flake must not red the structural assertions
// that carry the #41 regression guard.

import assert from "node:assert/strict";
import { test } from "node:test";

import { capture } from "./capture.mjs";

const REFRESH_SECONDS = 5;
const SETTLE = Math.ceil(REFRESH_SECONDS * 0.6);
const ESC = String.fromCharCode(27);

const strip = (text) =>
  text.replace(new RegExp(ESC + "\\[[0-9;?]*[A-Za-z]", "g"), "").replace(/\r/g, "");

// Down twice, then quit. Each keystroke is its own write: printf 'jj' would
// arrive as one read and ink would report input === "jj" rather than two "j"
// events, which is not what a human pressing the key twice produces.
// The fixture serves four runs, so two moves land on the second row.
const moved = capture({
  cols: 80,
  rows: 24,
  signal: "none",
  settle: 20,
  stdin: `sleep ${SETTLE}; printf 'j'; sleep 1; printf 'j'; sleep ${SETTLE}; printf 'q'; sleep 2`,
});

// No movement at all, as the control.
const untouched = capture({ cols: 80, rows: 24, settle: 4 });

test("nothing is selected until you move", () => {
  // The cursor marker shares the icon column, so an unselected pane has no ">"
  // anywhere in its rows. Starting with row one pre-selected would imply an
  // action the user did not take.
  const plain = strip(untouched.raw);
  const rowsWithCursor = plain.split("\n").filter((line) => /\|?\s*>/.test(line) && /#\d/.test(line));
  assert.equal(rowsWithCursor.length, 0, "no row should carry the cursor before any keypress");
});

test("moving the cursor marks exactly one row", () => {
  // Exactly one, not "at most one" -- an at-most assertion passes when the key
  // never registered at all, which is precisely the bug this caught during
  // implementation. Two would mean the key matches more than one item, which is
  // what an index-based cursor does once rows shift under it.
  const marked = moved.finalFrame.lines.filter((line) => /\|?\s*>\S/.test(line));
  assert.equal(marked.length, 1, `expected exactly one cursor row, saw ${marked.length}`);
});

test("the cursor marker is plain ASCII so it survives NO_COLOR", () => {
  // `inverse` alone is stripped at chalk level 0, which is the failure the tab
  // bar already had. The marker has to be a character, not an attribute.
  assert.ok(strip(moved.raw).includes(">"), "expected a literal > marker in the output");
});

test("selection does not disturb the terminal lifecycle", () => {
  // Scrolling and selecting must not change what the app does to the terminal:
  // still one alternate-screen enter and exit, still nothing left on the
  // primary buffer, still a clean exit.
  assert.equal(moved.altEnter, 1);
  assert.equal(moved.altExit, 1);
  assert.equal(moved.exitCode, 0);
  assert.equal(moved.afterRestore.hasScrollbackErase, false);
  assert.equal(moved.afterRestore.visible, "");
});

test("the frame keeps its geometry while a row is selected", () => {
  // The cursor shares the existing 3-wide icon column rather than claiming a
  // new one, so nothing may grow.
  assert.equal(moved.finalFrame.lines.length, 24);
  assert.ok(
    moved.finalFrame.widest <= 80,
    `widest line was ${moved.finalFrame.widest} with a row selected`,
  );
});
