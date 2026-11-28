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
  assert.equal(result.focusEnableAfterAltEnter, true, `${label}: focus reporting enabled outside the alternate screen`);
  assert.equal(result.focusDisableBeforeAltExit, true, `${label}: focus reporting disabled too late`);
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
const focus = async (label, check, { rows = true } = {}) => {
  const before = { tabs: tabBar(), selection: selected(), calls: calls().length };
  if (rows && !before.selection) throw Error(label + ": no selected row to compare\\n" + screen());
  send(ESC + "[I" + ESC + "[O");
  await pause(400);
  if (quit()) throw Error(label + ": a focus report quit the dashboard");
  if (tabBar() !== before.tabs) throw Error(label + ": tab bar changed\\n" + screen());
  if (selected() !== before.selection) throw Error(label + ": selection changed\\n" + screen());
  if (!check()) throw Error(label + ": the open view changed\\n" + screen());
  if (calls().length !== before.calls) throw Error(label + ": a focus report started a gh call");
};
await until(() => screen().includes("ci: pin actions"));
// Nothing is selected until you move; the comparison needs a selected row.
send("j"); await until(() => selected() !== "");
await focus("actions", () => screen().includes("ci: pin actions"));
send("?"); await until(() => /n next.*p prev/.test(screen()));
await focus("help", () => /n next.*p prev/.test(screen()), { rows: false });
send("?"); await until(() => !/n next.*p prev/.test(screen()));
send("w"); await until(() => screen().includes("Width: WORKFLOW"));
const width = screen().match(/Width: WORKFLOW \\d+/)[0];
await focus("width", () => screen().includes(width));
send(ESC); await until(() => !screen().includes("Width: WORKFLOW"));
send("2"); await until(() => screen().includes("SIGTERM erases"));
send("j"); await until(() => selected().includes("SIGTERM erases"));
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

// ---------- Phase 2: revalidate the selected tab on focus-in ----------

const RUNS_PATH = "repos/acme/widget/actions/runs?exclude_pull_requests=true&per_page=60";

// Driver-side helpers that read the fixture's own request log. The fixture
// writes state.json atomically enough for tests elsewhere, but a read can
// still land mid-write, so the helpers retry inside `until` and `settle`.
const REQUESTS = `
const state = () => JSON.parse(readFileSync(process.env.GH_GLANCE_FIXTURE_STATE, "utf8"));
const starts = (match) => state().events.filter((event) => event.type === "start" && match(event));
const issuePages = () => starts((event) => event.graphqlOperation === "issues.page");
const issueEnds = () => {
  const { events } = state();
  const pages = new Set(events.filter((event) => event.type === "start" &&
    event.graphqlOperation === "issues.page").map((event) => event.sequence));
  return events.filter((event) => event.type === "end" && pages.has(event.sequence));
};
const runs = () => starts((event) => event.argv?.some((argument) => argument === ${JSON.stringify(RUNS_PATH)}));
const dataStarts = () => starts((event) => event.graphqlOperation ||
  event.argv?.some((argument) => /actions\\/runs|alerts/.test(String(argument))));
const settle = async (read) => { for (;;) { try { return read(); } catch { await pause(20); } } };
const pauseUntil = async (at) => { const wait = at - Date.now(); if (wait > 0) await pause(wait); };
`;

function requestsOf(box) {
  const state = box.read();
  const starts = (match) => state.events.filter((event) => event.type === "start" && match(event));
  return {
    state,
    issues: starts((event) => event.graphqlOperation === "issues.page"),
    pulls: starts((event) => event.graphqlOperation === "pulls.page"),
    alerts: starts((event) => event.argv?.some((argument) => /alerts/.test(String(argument)))),
    runs: starts((event) => event.argv?.some((argument) => argument === RUNS_PATH)),
  };
}

const isConditional = (event) => event.argv.some((argument) => /^If-None-Match:/i.test(argument));

test("TF-10/11/12 focus-in checks a stale selected tab once, in place, and only when stale", (t) => {
  const box = fixture(t);
  const dimensions = { cols: 110, rows: 24 };
  const result = capture({
    ...dimensions, signal: "none", settle: 75, configHome: box.root,
    args: "--repo acme/widget --refresh 2",
    env: { GH_GLANCE_CAPTURE_LIVE_FLUSH: "1", GH_GLANCE_FIXTURE_STATE: box.statePath },
    stdin: driver(box.root, REQUESTS + `
await until(() => screen().includes("ci: pin actions"));
send("2");
await until(() => issueEnds().length === 1 && screen().includes("SIGTERM erases"));
const firstEnd = (await settle(issueEnds))[0].at;
// TF-12: data younger than 15 s is not checked again.
await pause(3000);
send(ESC + "[I");
await pause(2500);
if ((await settle(issuePages)).length !== 1) throw Error("TF-12: a fresh focus-in fetched");
// A focus-out on the same stale data never checks anything.
await pauseUntil(firstEnd + 16500);
send(ESC + "[O");
await pause(2000);
if ((await settle(issuePages)).length !== 1) throw Error("a focus-out fetched");
// TF-10: past 15 s a focus-in checks the selected tab, rows in place.
const sentAt = Date.now();
send(ESC + "[I");
const samples = [];
const sample = () => {
  const text = screen();
  samples.push({ rows: text.includes("SIGTERM erases"), waiting: /Waiting to check|Loading/.test(text) });
};
await until(() => { sample(); return issueEnds().length === 2; }, 10000);
for (let index = 0; index < 20; index += 1) { sample(); await pause(50); }
mark("samples", samples);
mark("second-start", String((await settle(issuePages))[1].at - sentAt));
// TF-11: an immediate second focus-in makes no request (here the data is
// fresh; the 15 s attempt throttle itself is pinned by the unit table); r does.
send(ESC + "[I"); send(ESC + "[O");
await pause(2500);
if ((await settle(issuePages)).length !== 2) throw Error("TF-11: a throttled focus-in fetched");
send("r");
await until(() => issueEnds().length === 3, 10000);
await pause(2000);
if ((await settle(issuePages)).length !== 3) throw Error("TF-11: r did not make exactly one request");
`, dimensions),
  });
  assertDriver(box.root);
  const { issues, pulls, alerts } = requestsOf(box);
  assert.equal(issues.length, 3, "open + one focus-in + one r");
  assert.equal(pulls.length, 0, "focus-in must not fetch hidden PRs");
  assert.equal(alerts.length, 0, "focus-in must not fetch hidden Security");
  assert.ok(Number(readFileSync(join(box.root, "second-start"), "utf8")) < 3000,
    "the focus-in check did not start promptly");
  const samples = JSON.parse(readFileSync(join(box.root, "samples"), "utf8"));
  assert.ok(samples.length > 0);
  assert.ok(samples.every((entry) => entry.rows && !entry.waiting),
    `cached rows left the screen during the focus check: ${JSON.stringify(samples)}`);
  assert.match(result.finalFrame.lines.join("\n"), /Cached/);
  assert.equal(result.exitCode, 0);
});

test("TF-13/16 a quiet Actions focus-in is a free conditional check that keeps the quiet cadence", (t) => {
  const box = fixture(t);
  const dimensions = { cols: 100, rows: 24 };
  const result = capture({
    ...dimensions, signal: "none", settle: 75, configHome: box.root,
    args: "--repo acme/widget --refresh 2 --tab actions",
    env: { GH_GLANCE_CAPTURE_LIVE_FLUSH: "1", GH_GLANCE_FIXTURE_STATE: box.statePath },
    stdin: driver(box.root, REQUESTS + `
// Three observations at the 2 s floor make the tab quiet (two unchanged);
// the next scheduled check is then 30 s away.
await until(() => runs().length >= 3, 30000);
const third = (await settle(runs))[2].at;
await pauseUntil(third + 16500);
if ((await settle(runs)).length !== 3) throw Error("Actions was not on its quiet cadence before focus");
const sentAt = Date.now();
send(ESC + "[I");
await until(() => runs().length === 4, 5000);
const focused = (await settle(runs))[3];
mark("focus-start", String(focused.at - sentAt));
// A tab-switch style reset would bring the next check back to the 2 s floor.
await pauseUntil(focused.at + 26000);
mark("runs-after-window", String((await settle(runs)).length));
`, dimensions),
  });
  assertDriver(box.root);
  const { runs, state } = requestsOf(box);
  assert.ok(Number(readFileSync(join(box.root, "focus-start"), "utf8")) < 3000,
    "the focus-in check did not start promptly");
  const focused = runs[3];
  assert.ok(isConditional(focused), "focus-in dropped If-None-Match");
  assert.equal(focused.cost.core, 0, "a quiet focus-in check spent primary REST");
  // No tab-switch side effect: the quiet counter was not reset to the floor,
  // so no scheduled check follows within 26 s of the focus check.
  assert.equal(readFileSync(join(box.root, "runs-after-window"), "utf8"), "4",
    `scheduled checks too soon after the focus check: ${JSON.stringify(runs.map((run) => run.at - focused.at))}`);
  // The GraphQL observer is budget control-plane work; no data page may follow.
  assert.equal(state.events.filter((event) => event.type === "start" &&
    /\.page$/.test(event.graphqlOperation ?? "")).length, 0, "focus-in on Actions fetched GraphQL data");
  assert.equal(result.exitCode, 0);
});

test("TF-14 focus-in respects the failure backoff and r still bypasses it", (t) => {
  // The stateful fixture takes failures from its state file, not from
  // GH_GLANCE_FIXTURE_FAIL. A 404 is "unavailable": a 60 s local ladder.
  const box = fixture(t, { failure: { selector: "graphql-data", remaining: 2, message: "HTTP 404: Not Found" } });
  const dimensions = { cols: 110, rows: 24 };
  const result = capture({
    ...dimensions, signal: "none", settle: 45, configHome: box.root,
    args: "--repo acme/widget --refresh 2",
    env: {
      GH_GLANCE_CAPTURE_LIVE_FLUSH: "1", GH_GLANCE_FIXTURE_STATE: box.statePath,
    },
    stdin: driver(box.root, REQUESTS + `
await until(() => screen().includes("ci: pin actions"));
send("2");
await until(() => issueEnds().length === 1);
await pause(1500);
mark("error-screen", screen());
send(ESC + "[I");
await pause(2500);
if ((await settle(issuePages)).length !== 1) throw Error("TF-14: focus-in ignored the backoff");
send("r");
await until(() => issueEnds().length === 2, 10000);
await pause(1500);
`, dimensions),
  });
  assertDriver(box.root);
  const errorScreen = readFileSync(join(box.root, "error-screen"), "utf8");
  assert.doesNotMatch(errorScreen, /SIGTERM erases/);
  assert.match(errorScreen, /Could not load Issues/);
  assert.match(errorScreen, /Refresh: r/, `no recovery action on screen: ${errorScreen}`);
  assert.equal(requestsOf(box).issues.length, 2, "open + r, nothing from focus-in");
  assert.equal(result.exitCode, 0);
});

test("TF-15 focus-in during a GraphQL reserve hold adds no request and the held one completes once", (t) => {
  const now = Date.now();
  const box = fixture(t, {
    graphql: { limit: 5000, used: 4600, remaining: 400, resetMs: now + 14_000 },
    resetSequence: [{ offsetMs: 14_500,
      graphql: { used: 0, remaining: 5000, resetOffsetMs: 3_600_000 } }],
  });
  const dimensions = { cols: 110, rows: 24 };
  const result = capture({
    ...dimensions, signal: "none", settle: 60, configHome: box.root,
    args: "--repo acme/widget --refresh 2",
    env: { GH_GLANCE_CAPTURE_LIVE_FLUSH: "1", GH_GLANCE_FIXTURE_STATE: box.statePath },
    stdin: driver(box.root, REQUESTS + `
await until(() => screen().includes("ci: pin actions"));
send("2");
await until(() => /Paused|Waiting/.test(screen()));
mark("hold-screen", screen());
send(ESC + "[I");
await pause(1500);
send(ESC + "[I");
await pause(1500);
if ((await settle(issuePages)).length !== 0) throw Error("TF-15: focus-in fetched during the hold");
await until(() => issueEnds().length === 1 && screen().includes("SIGTERM erases"), 30000);
await pause(3000);
`, dimensions),
  });
  assertDriver(box.root);
  assert.match(readFileSync(join(box.root, "hold-screen"), "utf8"), /Paused|Waiting/);
  assert.equal(requestsOf(box).issues.length, 1, "the held request must complete exactly once");
  assert.equal(result.exitCode, 0);
});

test("TF-17 focus-in while Notifications is open fetches nothing", (t) => {
  const box = fixture(t);
  const dimensions = { cols: 110, rows: 24 };
  const result = capture({
    ...dimensions, signal: "none", settle: 45, configHome: box.root,
    args: "--repo acme/widget --refresh 2",
    env: { GH_GLANCE_CAPTURE_LIVE_FLUSH: "1", GH_GLANCE_FIXTURE_STATE: box.statePath },
    stdin: driver(box.root, REQUESTS + `
await until(() => screen().includes("ci: pin actions"));
send("2");
await until(() => issueEnds().length === 1 && screen().includes("SIGTERM erases"));
const loadedAt = (await settle(issueEnds))[0].at;
send("5");
await until(() => screen().includes("[5:Events"));
await pauseUntil(loadedAt + 16500);
const before = (await settle(dataStarts)).length;
send(ESC + "[I");
await pause(3000);
mark("new-data-requests", String((await settle(dataStarts)).length - before));
if (!screen().includes("[5:Events")) throw Error("TF-17: focus-in left Notifications");
`, dimensions),
  });
  assertDriver(box.root);
  assert.equal(readFileSync(join(box.root, "new-data-requests"), "utf8"), "0");
  assert.equal(result.exitCode, 0);
});

