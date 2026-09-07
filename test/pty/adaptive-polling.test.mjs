import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

import { capture, waitForAwk } from "./capture.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const RUNS_PATH = "repos/acme/widget/actions/runs?exclude_pull_requests=true&per_page=60";
const WORKFLOWS_PATH = "repos/acme/widget/actions/workflows?page=1&per_page=100";

function fixture(t, overrides = {}) {
  const root = mkdtempSync(join(tmpdir(), "gh-glance-adaptive-pty-"));
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
    readGovernor: () => {
      const directory = join(root, "gh-glance", "coordination-v2");
      const name = readdirSync(directory).find((entry) => /^quota-[a-f0-9]{64}\.json$/.test(entry));
      return JSON.parse(readFileSync(join(directory, name), "utf8"));
    },
  };
}

function pathEvents(state, path, type = "start") {
  return state.events.filter((event) =>
    event.type === type && event.argv?.some((argument) => argument === path));
}

function graphqlEvents(state, operation) {
  return state.events.filter((event) =>
    event.type === "start" && event.graphqlOperation === operation);
}

function isConditional(event) {
  return event.argv.some((argument) => /^If-None-Match:/i.test(argument));
}

function gaps(events) {
  return events.slice(1).map((event, index) => event.at - events[index].at);
}

function waitForActionsRuns(count) {
  return waitForAwk(
    '"$GH_GLANCE_CAPTURE_OUT.calls"',
    `index($0, "/actions/runs?") { count++ } END { if (count >= ${count}) ok=1 }`,
    600,
  );
}

function waitForIssuePages(count) {
  return waitForAwk(
    '"$GH_GLANCE_CAPTURE_OUT.calls"',
    `index($0, "graphql issues.page") { count++ } END { if (count >= ${count}) ok=1 }`,
    600,
  );
}

// ---------- POLL-02 ----------

test("POLL-02 running CI is checked every five seconds, not at the two-second floor", (t) => {
  const running = readFileSync(join(HERE, "fixtures", "actions-runs-running.json"), "utf8");
  const box = fixture(t, {
    apiEntities: { [RUNS_PATH]: { sequence: [{ etag: '"runs-running"', body: running }] } },
  });
  const result = capture({
    cols: 80,
    rows: 24,
    signal: "none",
    settle: 20,
    stdin: waitForActionsRuns(4) + "sleep .3; printf q",
    args: "--repo acme/widget --refresh 2 --tab actions",
    configHome: box.root,
    env: { GH_GLANCE_CAPTURE_LIVE_FLUSH: "1", GH_GLANCE_FIXTURE_STATE: box.statePath },
  });
  const runs = pathEvents(box.read(), RUNS_PATH);
  assert.ok(runs.length >= 4, `Actions runs calls: ${runs.length}`);
  // max(floor, 5s) with a floor of 2s. The distinguishing property is that the
  // cadence is NOT the floor: an in-progress run is worth 5s, and a repository
  // with nothing running must not get 2s just because the pane asked for it.
  for (const gap of gaps(runs.slice(0, 4))) {
    assert.ok(gap >= 4_000 && gap <= 7_000, `in-progress gap ${gap}ms outside 5s +/- 2s`);
  }
  assert.match(result.finalFrame.lines.join("\n"), /deploy the staging bundle/);
});

test("POLL-02 a quiet list waits its 30s interval and is checked within two seconds of it", (t) => {
  const box = fixture(t);
  capture({
    cols: 80,
    rows: 24,
    signal: "none",
    settle: 45,
    // Three observations at the 2s floor take the tab into quiet mode (two
    // unchanged), and the fourth is the one this asserts on.
    stdin: waitForIssuePages(4) + "sleep .3; printf q",
    args: "--repo acme/widget --refresh 2 --tab issues",
    configHome: box.root,
    env: { GH_GLANCE_CAPTURE_LIVE_FLUSH: "1", GH_GLANCE_FIXTURE_STATE: box.statePath },
  });
  const pages = graphqlEvents(box.read(), "issues.page");
  assert.ok(pages.length >= 4, `issue page calls: ${pages.length}`);
  const observed = gaps(pages.slice(0, 4));
  // The first two gaps are the floor: nothing is known to be quiet yet.
  assert.ok(observed[0] <= 4_000, `first gap ${observed[0]}ms should be the 2s floor`);
  assert.ok(observed[1] <= 4_000, `second gap ${observed[1]}ms should be the 2s floor`);
  // The third is the quiet cadence: 30 seconds, arriving within two of it.
  assert.ok(observed[2] >= 28_000 && observed[2] <= 32_000,
    `quiet gap ${observed[2]}ms outside 30s +2s`);
});

// ---------- POLL-01 ----------

test("POLL-01 --background off emits zero inactive data calls", (t) => {
  const box = fixture(t);
  capture({
    cols: 80,
    rows: 24,
    signal: "none",
    settle: 25,
    stdin: waitForActionsRuns(3) + "sleep 1; printf q",
    args: "--repo acme/widget --refresh 2 --tab actions --background off",
    configHome: box.root,
    env: { GH_GLANCE_CAPTURE_LIVE_FLUSH: "1", GH_GLANCE_FIXTURE_STATE: box.statePath },
  });
  const state = box.read();
  assert.ok(pathEvents(state, RUNS_PATH).length >= 3, "the active tab stopped polling");
  assert.equal(graphqlEvents(state, "issues.page").length, 0, "issues polled with background off");
  assert.equal(graphqlEvents(state, "pulls.page").length, 0, "pull requests polled with background off");
  assert.equal(
    state.events.filter((event) => event.type === "start" &&
      event.argv?.some((argument) => /alerts/.test(String(argument)))).length,
    0,
    "security polled with background off",
  );
});

// ---------- POLL-03 ----------

test("POLL-03 complete run names never ask for the workflow catalog", (t) => {
  const box = fixture(t);
  const result = capture({
    cols: 80,
    rows: 24,
    signal: "none",
    settle: 20,
    stdin: waitForActionsRuns(3) + "sleep .3; printf q",
    args: "--repo acme/widget --refresh 2 --tab actions",
    configHome: box.root,
    env: { GH_GLANCE_CAPTURE_LIVE_FLUSH: "1", GH_GLANCE_FIXTURE_STATE: box.statePath },
  });
  const state = box.read();
  assert.ok(pathEvents(state, RUNS_PATH).length >= 3);
  assert.equal(pathEvents(state, WORKFLOWS_PATH).length, 0,
    "the catalog was fetched although every run carried its own name");
  // The name still renders: it comes from the run itself now.
  assert.match(result.finalFrame.lines.join("\n"), /CI/);
});

test("POLL-03 a missing name asks for the catalog once and reuses it", (t) => {
  const nameless = readFileSync(join(HERE, "fixtures", "actions-runs-nameless.json"), "utf8");
  const box = fixture(t, {
    apiEntities: { [RUNS_PATH]: { sequence: [{ etag: '"runs-nameless"', body: nameless }] } },
  });
  const result = capture({
    cols: 80,
    rows: 24,
    signal: "none",
    settle: 20,
    // Three checks, not four. The body never changes, so the third observation
    // is the one that takes the tab into quiet mode -- waiting for a fourth
    // waits out the whole 30-second interval for no additional evidence. Two
    // polls after the catalog arrives already prove it was reused.
    stdin: waitForActionsRuns(3) + "sleep .3; printf q",
    args: "--repo acme/widget --refresh 2 --tab actions",
    configHome: box.root,
    env: { GH_GLANCE_CAPTURE_LIVE_FLUSH: "1", GH_GLANCE_FIXTURE_STATE: box.statePath },
  });
  const state = box.read();
  assert.ok(pathEvents(state, RUNS_PATH).length >= 3);
  assert.equal(pathEvents(state, WORKFLOWS_PATH).length, 1,
    "the 15-minute catalog TTL did not hold across polls");
  assert.match(result.finalFrame.lines.join("\n"), /CI/);
});

// ---------- REFRESH ----------

test("REFRESH-01 r keeps If-None-Match and a quiet 304 spends nothing", (t) => {
  const box = fixture(t);
  const result = capture({
    cols: 80,
    rows: 24,
    signal: "none",
    settle: 25,
    stdin: waitForActionsRuns(2) + "printf r; " + waitForActionsRuns(3) + "sleep .5; printf q",
    args: "--repo acme/widget --refresh 5 --tab actions",
    configHome: box.root,
    env: { GH_GLANCE_FIXTURE_STATE: box.statePath },
  });
  const state = box.read();
  const runs = pathEvents(state, RUNS_PATH);
  assert.ok(runs.length >= 3, `Actions runs calls: ${runs.length}`);
  // Every request after the first carries a validator, including the one the
  // key press produced: `r` is a prioritized conditional check, not a cache
  // drop, so a quiet repository answers 304 and spends nothing.
  assert.ok(runs.slice(1).every(isConditional), "`r` dropped If-None-Match");
  assert.ok(runs.slice(1).every((event) => event.cost.core === 0), "`r` spent primary REST on a 304");
  // The one unconditional first request, plus the repository/auth bootstrap.
  // No third unit: the workflow catalog is never asked for, because every run
  // in this fixture carries its own name.
  assert.equal(state.core.used, 2);
  assert.match(result.finalFrame.lines.join("\n"), /ci: pin actions to commit/);
});

// The `R` half of REFRESH-01 lives in conditional-polling.test.mjs, replacing
// the old forced-`r` expectation this phase deliberately changed.

test("REFRESH-03 Width mode keeps both width resets and starts no refresh", (t) => {
  const box = fixture(t);
  const result = capture({
    cols: 80,
    rows: 24,
    signal: "none",
    settle: 25,
    // Enter width mode, widen a column, then use both reset keys. Neither may
    // produce a data request while the mode is active.
    stdin: waitForActionsRuns(1) +
      "printf w; sleep .4; printf '\\033[C\\033[C'; sleep .4; printf r; sleep .4; printf R; sleep .8; " +
      "printf w; sleep .4; printf q",
    args: "--repo acme/widget --refresh 60 --tab actions",
    configHome: box.root,
    env: { GH_GLANCE_FIXTURE_STATE: box.statePath },
  });
  const state = box.read();
  const runs = pathEvents(state, RUNS_PATH);
  // A 60s floor means the only automatic checks are the startup ones; the two
  // key presses inside width mode must add nothing.
  assert.equal(runs.length, 1, `width-mode keys started ${runs.length - 1} extra refreshes`);
  assert.ok(runs.every((event) => event.cost.core <= 1));
  assert.match(result.finalFrame.lines.join("\n"), /ci: pin actions to commit/);
});

// ---------- PAGE ----------

function waitForIssuePagesInLog(count) {
  return waitForAwk(
    '"$GH_GLANCE_CAPTURE_OUT.calls"',
    `index($0, "graphql issues.page") { count++ } END { if (count >= ${count}) ok=1 }`,
    600,
  );
}

test("PAGE-01 scrolling toward the end acquires one page, and only then", (t) => {
  const box = fixture(t);
  const result = capture({
    cols: 80,
    rows: 24,
    signal: "none",
    settle: 45,
    // Forty-five presses put the cursor on row 44 of the 50 loaded -- the first
    // press only seeds the cursor on row 0 -- which is past the ten-row runway
    // where demand begins. One key per write, because ink delivers a chunk as a
    // single input and "jjjj" matches no binding. A 60-second floor means no
    // automatic poll can land inside the run, so every request here was asked
    // for by the viewport.
    stdin: waitForIssuePagesInLog(1) + "sleep .8; " +
      "i=0; while [ $i -lt 45 ]; do printf j; i=$((i + 1)); sleep .08; done; " +
      waitForIssuePagesInLog(3) + "sleep .5; printf q",
    args: "--repo acme/widget --refresh 60 --tab issues",
    configHome: box.root,
    env: {
      GH_GLANCE_CAPTURE_LIVE_FLUSH: "1",
      GH_GLANCE_FIXTURE_STATE: box.statePath,
      GH_GLANCE_FIXTURE_GRAPHQL_ROWS: "120",
    },
  });
  const pages = result.fixtureCalls.filter((call) => call.startsWith("graphql issues.page"));
  const cursored = pages.filter((call) => !call.endsWith("after=-"));
  // Exactly one page past the first. Three page-downs are one demand, not
  // three, and the cap is nowhere near reached.
  assert.equal(cursored.length, 1, `cursored issue pages: ${JSON.stringify(pages)}`);
  assert.match(cursored[0], /after=cursor:50$/);
  assert.ok(pages.every((call) => / first=50 /.test(call)), `page size drifted: ${JSON.stringify(pages)}`);

  const frame = result.finalFrame.lines.join("\n");
  // The rows arrived: the tab count is the second page's worth, still marked
  // incomplete because 120 issues exist behind the 100 now held.
  assert.match(frame, /Issues \(100\+\)/);
  assert.doesNotMatch(frame, /Issues \(50\+\)/);
});

test("PAGE-01 a list nobody scrolls never asks for a second page", (t) => {
  const box = fixture(t);
  const result = capture({
    cols: 80,
    rows: 24,
    signal: "none",
    settle: 30,
    stdin: waitForIssuePagesInLog(1) + "sleep 3; printf q",
    args: "--repo acme/widget --refresh 60 --tab issues",
    configHome: box.root,
    env: {
      GH_GLANCE_CAPTURE_LIVE_FLUSH: "1",
      GH_GLANCE_FIXTURE_STATE: box.statePath,
      GH_GLANCE_FIXTURE_GRAPHQL_ROWS: "120",
    },
  });
  const pages = result.fixtureCalls.filter((call) => call.startsWith("graphql issues.page"));
  assert.equal(pages.length, 1, `issue pages: ${JSON.stringify(pages)}`);
  assert.ok(pages[0].endsWith("after=-"));
  // Fifty of 120, and the count says so rather than presenting 50 as the total.
  assert.match(result.finalFrame.lines.join("\n"), /Issues \(50\+\)/);
});
