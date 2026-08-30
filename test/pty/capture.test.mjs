import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

import { parseCapture } from "./capture.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const RUN = join(HERE, "run.sh");

async function waitFor(predicate, timeoutMs = 5_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error("timed out waiting for PTY harness evidence");
}

function processIsAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error?.code === "EPERM";
  }
}

const ESC = "\x1b";
const ALT_ENTER = `${ESC}[?1049h`;
const ALT_EXIT = `${ESC}[?1049l`;
const SYNC_START = `${ESC}[?2026h`;
const SYNC_END = `${ESC}[?2026l`;

test("terminal replay preserves a compact dashboard and its guard row", () => {
  const raw =
    ALT_ENTER +
    SYNC_START +
    "[1:Act]\r\nbody\r\n⣾ Checking\r\n" +
    SYNC_END +
    ALT_EXIT;

  const parsed = parseCapture(raw, { cols: 20, rows: 5 });

  assert.deepEqual(parsed.finalFrame.lines, ["[1:Act]", "body", "⣾ Checking"]);
  assert.equal(parsed.liveScreen.lines.length, 5);
  assert.equal(parsed.liveScreen.lines.at(-1), "");
  assert.equal(parsed.liveScreen.statusLines, 1);
  assert.equal(parsed.liveScreen.maxStatusLines, 1);
  assert.deepEqual(parsed.liveScreen.statusHistory, ["⣾ Checking"]);
});

test("terminal replay applies incremental cursor updates without accumulating status lines", () => {
  const initial = "[1:Actions]\r\nbody\r\n⣾ Checking\r\n";
  const update =
    `${ESC}[3A` +
    `${ESC}[E` +
    `${ESC}[E` +
    `${ESC}[G· Watching stale 1m${ESC}[K\r\n`;
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

  assert.equal(parsed.finalFrame.lines[2], "· Watching stale 1m");
  assert.equal(parsed.liveScreen.statusLines, 1);
  assert.equal(parsed.liveScreen.maxStatusLines, 1);
  assert.equal(parsed.liveScreen.lines.at(-1), "");
  assert.deepEqual(parsed.liveScreen.statusHistory, ["⣾ Checking", "· Watching stale 1m"]);
});

test("terminal replay retains transient status accumulation evidence", () => {
  const raw =
    ALT_ENTER +
    SYNC_START +
    "[1:Actions]\r\n· Watching next 2m\r\n⣾ Checking new\r\n" +
    SYNC_END +
    SYNC_START +
    `${ESC}[2J${ESC}[H` +
    "[1:Actions]\r\nbody\r\n· Watching\r\n" +
    SYNC_END +
    ALT_EXIT;

  const parsed = parseCapture(raw, { cols: 24, rows: 5 });

  assert.equal(parsed.liveScreen.statusLines, 1);
  assert.equal(parsed.liveScreen.maxStatusLines, 2);
  assert.deepEqual(parsed.liveScreen.statusHistory, ["· Watching next 2m", "⣾ Checking new", "· Watching"]);
});

test("terminal replay drops only the PTY EOF echo and preserves printable caret-D text", () => {
  const raw =
    ALT_ENTER +
    SYNC_START +
    "[1:Actions]\r\nprintable ^D\r\n· Watching\r\n^D\b\b" +
    SYNC_END +
    ALT_EXIT;

  const parsed = parseCapture(raw, { cols: 24, rows: 5 });

  assert.deepEqual(parsed.finalFrame.lines, ["[1:Actions]", "printable ^D", "· Watching"]);
  assert.equal(parsed.liveScreen.lines.at(-1), "");
});

test("capture termination reaps the full stdin producer and script trees", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "gh-glance-capture-cleanup-"));
  const out = join(root, "capture.txt");
  const producerPath = `${out}.producer`;
  const childPath = `${out}.producer-child`;
  const harness = spawn("/bin/sh", [
    RUN,
    "60",
    "16",
    out,
    "none",
    "30",
    `printf '%s' "$$" > "$GH_GLANCE_CAPTURE_OUT.producer"; ` +
      `sleep 300 & child=$!; printf '%s' "$child" > "$GH_GLANCE_CAPTURE_OUT.producer-child"; wait "$child"`,
  ], { stdio: "ignore" });
  const tracked = [];
  t.after(() => {
    try { harness.kill("SIGKILL"); } catch { /* already stopped */ }
    for (const pid of tracked) {
      try { process.kill(pid, "SIGKILL"); } catch { /* already stopped */ }
    }
    rmSync(root, { recursive: true, force: true });
  });

  await waitFor(() => existsSync(producerPath) && existsSync(childPath));
  tracked.push(Number(readFileSync(producerPath, "utf8")), Number(readFileSync(childPath, "utf8")));
  const terminatedAt = Date.now();
  harness.kill("SIGTERM");
  await new Promise((resolve) => harness.once("exit", resolve));
  await waitFor(() => tracked.every((pid) => !processIsAlive(pid)));
  assert.ok(Date.now() - terminatedAt < 5_000, "capture cleanup must stay below five seconds");
  assert.ok(tracked.every((pid) => !processIsAlive(pid)));
});
