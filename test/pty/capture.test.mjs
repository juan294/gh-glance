import assert from "node:assert/strict";
import { test } from "node:test";

import { parseCapture } from "./capture.mjs";

const ESC = "\x1b";
const ALT_ENTER = `${ESC}[?1049h`;
const ALT_EXIT = `${ESC}[?1049l`;
const SYNC_START = `${ESC}[?2026h`;
const SYNC_END = `${ESC}[?2026l`;

test("terminal replay preserves a compact dashboard and its guard row", () => {
  const raw =
    ALT_ENTER +
    SYNC_START +
    "[1:Act]\r\nbody\r\n⣾ Fetching\r\n" +
    SYNC_END +
    ALT_EXIT;

  const parsed = parseCapture(raw, { cols: 20, rows: 5 });

  assert.deepEqual(parsed.finalFrame.lines, ["[1:Act]", "body", "⣾ Fetching"]);
  assert.equal(parsed.liveScreen.lines.length, 5);
  assert.equal(parsed.liveScreen.lines.at(-1), "");
  assert.equal(parsed.liveScreen.statusLines, 1);
  assert.equal(parsed.liveScreen.maxStatusLines, 1);
});

test("terminal replay applies incremental cursor updates without accumulating status lines", () => {
  const initial = "[1:Actions]\r\nbody\r\n⣾ Fetching\r\n";
  const update =
    `${ESC}[3A` +
    `${ESC}[E` +
    `${ESC}[E` +
    `${ESC}[G⣾ Fetching stale 1m${ESC}[K\r\n`;
  const raw =
    ALT_ENTER +
    SYNC_START +
    initial +
    SYNC_END +
    SYNC_START +
    update +
    SYNC_END +
    ALT_EXIT;

  const parsed = parseCapture(raw, { cols: 24, rows: 5 });

  assert.equal(parsed.finalFrame.lines[2], "⣾ Fetching stale 1m");
  assert.equal(parsed.liveScreen.statusLines, 1);
  assert.equal(parsed.liveScreen.maxStatusLines, 1);
  assert.equal(parsed.liveScreen.lines.at(-1), "");
});

test("terminal replay retains transient status accumulation evidence", () => {
  const raw =
    ALT_ENTER +
    SYNC_START +
    "[1:Actions]\r\n⣾ Fetching old\r\n⣾ Fetching new\r\n" +
    SYNC_END +
    SYNC_START +
    `${ESC}[2J${ESC}[H` +
    "[1:Actions]\r\nbody\r\n⣾ Fetching\r\n" +
    SYNC_END +
    ALT_EXIT;

  const parsed = parseCapture(raw, { cols: 24, rows: 5 });

  assert.equal(parsed.liveScreen.statusLines, 1);
  assert.equal(parsed.liveScreen.maxStatusLines, 2);
});
