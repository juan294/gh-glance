// Terminal focus reporting (xterm mode 1004) under a real pseudo-terminal.
//
// "Terminal focus" is the terminal telling the app that its pane gained or
// lost focus (ESC [ I / ESC [ O). It is unrelated to the Jev semantic Focus
// feature covered by focus.test.mjs and jev-focus.test.mjs.
//
// Ink 7 delivers both reports to useInput as "[I" and "[O" with the leading
// Escape removed. A bare Escape quits the dashboard, so the main safety
// property is that neither report ever reaches a key binding, including when
// the Escape and the rest of the report arrive in separate reads.

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { capture } from "./capture.mjs";

const ESC = String.fromCharCode(27);
const reader = new URL("./capture.mjs", import.meta.url).href;

function fixture(t, overrides = {}) {
  const root = mkdtempSync(join(tmpdir(), "gh-glance-terminal-focus-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const now = Date.now();
  const statePath = join(root, "fixture.json");
  writeFileSync(statePath, `${JSON.stringify({
    createdAt: now,
    core: { limit: 5000, used: 0, remaining: 5000, resetMs: now + 3_600_000 },
    graphql: { limit: 5000, used: 0, remaining: 5000, resetMs: now + 3_600_000 },
    events: [],
    ...overrides,
  })}\n`, { mode: 0o600 });
  return {
    root,
    statePath,
    read: () => JSON.parse(readFileSync(statePath, "utf8")),
  };
}

// A node program run as the capture's stdin writer. Everything it writes is
// terminal input for the app; it reads the live capture to wait for states.
function driver(root, program, dimensions) {
  const path = join(root, "driver.mjs");
  writeFileSync(path, `import { readFileSync, writeFileSync } from "node:fs";
import { parseCapture } from ${JSON.stringify(reader)};
const root = ${JSON.stringify(root)};
const dimensions = ${JSON.stringify(dimensions)};
const ESC = String.fromCharCode(27);
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const raw = () => readFileSync(process.env.GH_GLANCE_CAPTURE_OUT, "utf8");
const frame = () => parseCapture(raw(), dimensions).finalFrame.lines;
const screen = () => frame().join("\\n");
const send = (bytes) => process.stdout.write(bytes);
const until = async (predicate, ms = 20000) => {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    try { if (predicate()) return; } catch {}
    await pause(50);
  }
  throw Error("UI barrier timed out: " + String(predicate) + "\\n" + screen());
};
const quit = () => raw().includes(ESC + "[?1049l");
const calls = () => readFileSync(process.env.GH_GLANCE_CAPTURE_OUT + ".calls", "utf8")
  .split("\\n").filter(Boolean);
const mark = (name, value) => writeFileSync(root + "/" + name, typeof value === "string" ? value : JSON.stringify(value));
try { ${program}
  mark("complete", "yes");
} catch (error) { mark("driver-error", String(error?.stack ?? error)); }
finally { send("q"); }
`);
  execFileSync(process.execPath, ["--check", path]);
  return `node '${path}'; sleep 2`;
}

function assertDriver(root) {
  const errorPath = join(root, "driver-error");
  assert.equal(existsSync(errorPath), false, existsSync(errorPath) ? readFileSync(errorPath, "utf8") : "");
  assert.equal(readFileSync(join(root, "complete"), "utf8"), "yes");
}

function assertFocusLifecycle(result, label) {
  assert.equal(result.focus1004Enter, 1, `${label}: focus reporting enable count`);
  assert.equal(result.focus1004Exit, 1, `${label}: focus reporting disable count`);
  assert.equal(result.focusDisableBeforeAltExit, true, `${label}: focus reporting disabled too late`);
  const altEnter = result.raw.indexOf(`${ESC}[?1049h`);
  assert.ok(altEnter !== -1 && result.focus1004EnterPositions[0] > altEnter,
    `${label}: focus reporting enabled before the alternate screen`);
}

// ---------- TF-01 / TF-02 / TF-03 ----------

test("TF-01/02/03 focus reports change nothing in any view, never quit, and are disabled on exit", (t) => {
  const box = fixture(t);
  const dimensions = { cols: 100, rows: 24 };
  // Ink 7.1.1 holds an incomplete escape sequence for 20 ms
  // (node_modules/ink/build/components/App.js, pendingInputFlushDelayMilliseconds)
  // before flushing it as a bare Escape. The split below stays well inside it.
  const result = capture({
    ...dimensions, signal: "none", settle: 60, configHome: box.root,
    args: "--repo acme/widget --refresh 300",
    env: { GH_GLANCE_CAPTURE_LIVE_FLUSH: "1", GH_GLANCE_FIXTURE_STATE: box.statePath },
    stdin: driver(box.root, `
const tabBar = () => frame().find((line) => line.includes("1:Actions")) ?? "";
const selected = () => frame().filter((line) => /^[│ ]*>/.test(line)).join("\\n");
const focus = async (label, check) => {
  const before = { tabs: tabBar(), selection: selected(), calls: calls().length };
  send(ESC + "[I" + ESC + "[O");
  await pause(400);
  if (quit()) throw Error(label + ": a focus report quit the dashboard");
  if (tabBar() !== before.tabs) throw Error(label + ": tab bar changed\\n" + screen());
  if (selected() !== before.selection) throw Error(label + ": selection changed\\n" + screen());
  if (!check()) throw Error(label + ": the open view changed\\n" + screen());
};
await until(() => screen().includes("ci: pin actions"));
send("j"); await pause(300);
await focus("actions", () => screen().includes("ci: pin actions"));
send("?"); await until(() => /n next.*p prev/.test(screen()));
await focus("help", () => /n next.*p prev/.test(screen()));
send("?"); await until(() => !/n next.*p prev/.test(screen()));
send("w"); await until(() => screen().includes("Width: WORKFLOW"));
const width = screen().match(/Width: WORKFLOW \\d+/)[0];
await focus("width", () => screen().includes(width));
send(ESC); await until(() => !screen().includes("Width: WORKFLOW"));
send("2"); await until(() => screen().includes("SIGTERM erases"));
await focus("issues", () => screen().includes("SIGTERM erases"));
// TF-03: the Escape and the rest of the report arrive in separate reads.
send(ESC); await pause(3); send("[I");
await pause(400);
if (quit()) throw Error("split: a split focus report quit the dashboard");
if (!screen().includes("SIGTERM erases")) throw Error("split: Issues view changed\\n" + screen());
`, dimensions),
  });
  assertDriver(box.root);
  assert.equal(result.exitCode, 0);
  assert.equal(result.altEnter, 1);
  assert.equal(result.altExit, 1);
  assertFocusLifecycle(result, "q exit");
  assert.equal(result.afterRestore.visible, "", "a dead frame remained after restore");
});

// ---------- TF-04 ----------

test("TF-04 help and doctor output never enable focus reporting", (t) => {
  const box = fixture(t);
  for (const args of ["--help", "--doctor --repo acme/widget"]) {
    const result = capture({
      cols: 100, rows: 24, signal: "none", settle: 8, configHome: box.root, args,
      env: { GH_GLANCE_FIXTURE_STATE: box.statePath },
    });
    assert.equal(result.focus1004Enter, 0, `${args}: wrote ?1004h`);
    assert.equal(result.focus1004Exit, 0, `${args}: wrote ?1004l`);
  }
});
