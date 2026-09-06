import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
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

function validOwnedPid(pid) {
  return Number.isSafeInteger(pid) && pid > 1 && pid !== process.pid;
}

function readPublishedPid(path) {
  try {
    const raw = readFileSync(path, "utf8");
    if (!/^[1-9][0-9]*\n$/.test(raw)) return null;
    const pid = Number(raw.trim());
    return validOwnedPid(pid) ? pid : null;
  } catch { return null; }
}

function ownedDescendants(rootPid) {
  const result = spawnSync("ps", ["-axo", "pid=,ppid="], { encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
  const rows = result.stdout.trim().split("\n").map((row) => row.trim().split(/\s+/).map(Number));
  const owned = new Set([rootPid]);
  let changed = true;
  while (changed) {
    changed = false;
    for (const [pid, parent] of rows) {
      if (!validOwnedPid(pid) || owned.has(pid) || !owned.has(parent)) continue;
      owned.add(pid);
      changed = true;
    }
  }
  owned.delete(rootPid);
  return [...owned];
}

function processIsAlive(pid) {
  assert.ok(validOwnedPid(pid), `invalid owned PID: ${pid}`);
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
  const registrationGate = join(root, "before-pid-registration");
  const harness = spawn("/bin/sh", [
    RUN,
    "60",
    "16",
    out,
    "none",
    "30",
    `printf '%s\n' "$$" > "$GH_GLANCE_CAPTURE_OUT.producer"; ` +
      `sleep 300 & child=$!; printf '%s\n' "$child" > "$GH_GLANCE_CAPTURE_OUT.producer-child"; wait "$child"`,
  ], {
    stdio: "ignore",
    env: {
      PATH: process.env.PATH,
      HOME: root,
      XDG_CONFIG_HOME: join(root, "config"),
      TMPDIR: tmpdir(),
      LANG: "en_US.UTF-8",
      TERM: "xterm-256color",
      GH_GLANCE_CAPTURE_TEST_REGISTRATION_GATE: registrationGate,
    },
  });
  const exited = new Promise((resolve) => harness.once("exit", resolve));
  const tracked = [];
  t.after(() => {
    // Readiness can fail before tracked is populated. Capture the still-owned
    // trees and complete PID publications before stopping their parent.
    const cleanupPids = new Set([
      ...tracked,
      ...[producerPath, childPath, registrationGate].map(readPublishedPid).filter(validOwnedPid),
    ]);
    if (harness.exitCode === null && harness.signalCode === null) {
      for (const pid of ownedDescendants(harness.pid)) cleanupPids.add(pid);
    }
    try { harness.kill("SIGKILL"); } catch { /* already stopped */ }
    for (const pid of cleanupPids) {
      if (!validOwnedPid(pid)) continue;
      try { process.kill(pid, "SIGKILL"); } catch { /* already stopped */ }
    }
    rmSync(root, { recursive: true, force: true });
  });

  await waitFor(() => [producerPath, childPath, registrationGate].every((path) => readPublishedPid(path) !== null));
  tracked.push(...new Set([
    readPublishedPid(producerPath), readPublishedPid(childPath), readPublishedPid(registrationGate),
    ...ownedDescendants(harness.pid),
  ]));
  assert.ok(tracked.every(validOwnedPid));
  const terminatedAt = Date.now();
  harness.kill("SIGTERM");
  await exited;
  await waitFor(() => tracked.every((pid) => !processIsAlive(pid)));
  assert.ok(Date.now() - terminatedAt < 5_000, "capture cleanup must stay below five seconds");
  assert.ok(tracked.every((pid) => !processIsAlive(pid)));
});
