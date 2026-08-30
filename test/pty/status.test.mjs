import assert from "node:assert/strict";
import {
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { capture, captureAsync, isStatusLine, waitForAwk } from "./capture.mjs";

function configRoot(t, prefix) {
  const root = mkdtempSync(join(tmpdir(), prefix));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  return root;
}

function captureCount(token) {
  return `awk '{ count += gsub(/${token}/, "&") } END { print count + 0 }' ` +
    '"$GH_GLANCE_CAPTURE_OUT" 2>/dev/null';
}

function quitAfterCached(tab) {
  return 'cache="$XDG_CONFIG_HOME/gh-glance/dashboard-cache.json"; ' +
    waitForAwk('"$cache"', `index($0, "\\"${tab}\\"") { ok=1 }`) +
    "sleep .3; printf q";
}

function sharedFixture(t, overrides = {}) {
  const root = configRoot(t, "gh-glance-status-");
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

function governorPath(root) {
  const directory = join(root, "gh-glance");
  const name = readdirSync(directory).find((entry) => entry.startsWith("rate-governor-v1-"));
  assert.ok(name, "governor state was not created");
  return join(directory, name);
}

const dataStarts = (state, pane = null) => state.events.filter((event) =>
  event.type === "start" && (pane === null || event.pane === pane) && (
    ["run", "issue", "pr"].includes(event.argv[0]) ||
    event.argv[0] === "api" && event.argv[1] !== "rate_limit" && !event.argv.includes("user")
  ));
const actionsRuns = (state, pane = null) => dataStarts(state, pane)
  .filter((event) => event.argv.some((argument) => argument.includes("/actions/runs?")));

const statusLine = (result) => result.finalFrame.lines.find(isStatusLine);
const translatedCoordinationNotice =
  /(?:Can't coordinate API use — retrying|Coordinating with your other panes)/;

test("footer layout keeps semantic status and essential actions from 80 to 24 columns", (t) => {
  for (const cols of [80, 60, 45, 24]) {
    const box = sharedFixture(t, {
      core: { limit: 5000, used: 4450, remaining: 550, resetMs: Date.now() + 3_600_000 },
    });
    const result = capture({
      cols,
      rows: 20,
      signal: "none",
      settle: 15,
      stdin: waitForAwk(
        '"$GH_GLANCE_CAPTURE_OUT"',
        cols >= 45
          ? 'index($0, "Paused") && index($0, "reset") { ok=1 }'
          : 'index($0, "Paused") { ok=1 }',
      ) +
        "sleep .3; printf q",
      configHome: box.root,
      env: {
        GH_GLANCE_CAPTURE_LIVE_FLUSH: "1",
        GH_GLANCE_FIXTURE_STATE: box.statePath,
      },
    });
    const line = statusLine(result);
    assert.match(line ?? "", /^‖ Paused/);
    assert.match(line ?? "", /(?:Refresh: )?r(?:\s|$)/);
    assert.match(line ?? "", /(?:Quit: )?q(?:\s|$)/);
    if (cols >= 45) {
      assert.ok(
        result.liveScreen.statusHistory.some((status) => /^‖ Paused.*reset \d+m/.test(status)),
        result.liveScreen.statusHistory.join(" -> "),
      );
    } else {
      assert.doesNotMatch(result.liveScreen.statusHistory.join("\n"), /reset|\d+m/);
    }
    assert.ok(result.finalFrame.widest <= cols, `${cols}-column frame overflowed`);
    assert.ok(result.liveScreen.maxStatusLines <= 1);
    assert.equal(result.liveScreen.lines.at(-1), "");
  }
});

test("four ample panes explain a shared lane without moving the hint group", async (t) => {
  const box = sharedFixture(t);
  const releasePath = join(box.root, "release-sharing-holders");
  const holders = Array.from({ length: 3 }, (_, index) => captureAsync({
    cols: 80,
    rows: 20,
    signal: "none",
    // The observer can legitimately wait 40 seconds for its shared lane. Keep
    // all three owners live past that horizon on both GNU and BSD script(1).
    settle: 65,
    stdin: `i=0; while [ ! -f "${releasePath}" ] && [ "$i" -lt 1200 ]; do ` +
      "sleep .05; i=$((i + 1)); done; printf q",
    args: "--refresh 40 --tab security",
    configHome: box.root,
    env: {
      GH_GLANCE_CAPTURE_LIVE_FLUSH: "1",
      GH_GLANCE_FIXTURE_STATE: box.statePath,
      GH_GLANCE_FIXTURE_PANE: `sharing-${index}`,
    },
  }));
  let observer;
  try {
    const deadline = Date.now() + 10_000;
    let leaseCount = 0;
    while (Date.now() < deadline && leaseCount < 3) {
      try {
        const state = JSON.parse(readFileSync(governorPath(box.root), "utf8"));
        leaseCount = Object.keys(state.leases).length;
      } catch {
        // The first atomic governor publication is transiently absent.
      }
      if (leaseCount < 3) await new Promise((resolve) => setTimeout(resolve, 40));
    }
    assert.equal(leaseCount, 3, "holder panes did not publish three live leases");
    observer = await captureAsync({
      cols: 80,
      rows: 20,
      signal: "none",
      settle: 45,
      stdin: waitForAwk(
        '"$GH_GLANCE_CAPTURE_OUT"',
        'index($0, "Watching sharing 4") { ok=1 }',
        400,
      ) + "printf q",
      args: "--refresh 40 --tab security",
      configHome: box.root,
      env: {
        GH_GLANCE_CAPTURE_LIVE_FLUSH: "1",
        GH_GLANCE_FIXTURE_STATE: box.statePath,
        GH_GLANCE_FIXTURE_PANE: "sharing-observer",
      },
    });
  } finally {
    writeFileSync(releasePath, "release\n", { mode: 0o600 });
    const settled = await Promise.allSettled(holders);
    assert.equal(
      settled.filter((result) => result.status === "rejected").length,
      0,
      settled.map((result) => result.reason?.message).filter(Boolean).join("\n"),
    );
  }
  const statuses = observer.liveScreen.statusHistory;
  const sharing = statuses.find((line) => /^· Watching sharing 4/.test(line));
  const baseline = statuses.find((line) => !line.includes("sharing 4") && line.includes("Refresh"));
  assert.ok(sharing, statuses.join(" -> "));
  assert.ok(baseline, statuses.join(" -> "));
  assert.ok(sharing.indexOf("Refresh") >= 0, sharing);
  assert.equal(sharing.indexOf("Refresh"), baseline.indexOf("Refresh"));
});

test("Setup and NO_COLOR footers keep explicit semantic labels", (t) => {
  const setup = capture({
    cols: 80,
    rows: 24,
    signal: "none",
    settle: 8,
    stdin: waitForAwk('"$GH_GLANCE_CAPTURE_OUT"', 'index($0, "Setup") { ok=1 }') + "printf q",
    configHome: configRoot(t, "gh-glance-status-setup-"),
    env: {
      GH_GLANCE_FIXTURE_FAIL: "failed to determine base repo: no git remotes found",
      GH_GLANCE_FIXTURE_FAIL_ON: "run,issue,pr,api-data",
      GH_GLANCE_CAPTURE_LIVE_FLUSH: "1",
    },
  });
  assert.match(statusLine(setup) ?? "", /^· Setup/);
  assert.match(setup.finalFrame.lines.join("\n"), /No GitHub remote found/);

  const noColor = capture({
    cols: 45,
    rows: 20,
    signal: "none",
    settle: 15,
    stdin: quitAfterCached("actions"),
    configHome: configRoot(t, "gh-glance-status-no-color-"),
    env: { NO_COLOR: "1" },
  });
  assert.match(statusLine(noColor) ?? "", /^· Watching/);
  assert.match(statusLine(noColor) ?? "", /(?:Refresh: )?r(?:\s|$)/);
  assert.match(statusLine(noColor) ?? "", /(?:Quit: )?q(?:\s|$)/);
});

test("ASCII profile keeps the same status label and a width-one marker", (t) => {
  const result = capture({
    cols: 45,
    rows: 20,
    signal: "none",
    settle: 15,
    stdin: quitAfterCached("actions"),
    icons: "ascii",
    configHome: configRoot(t, "gh-glance-status-ascii-"),
  });
  assert.match(statusLine(result) ?? "", /^\. Watching/);
  const frame = result.finalFrame.lines.join("\n");
  assert.match(frame, /^│ {2}[+x-] {2}\S/m);
  assert.doesNotMatch(frame, /[\uE000-\uF8FF]/);
  assert.equal(result.finalFrame.widest <= 45, true);
});

test("delayed admitted startup animates Checking and settles to Watching", (t) => {
  const box = sharedFixture(t, { delayByCommand: { actions: 1_200 } });
  const result = capture({
    cols: 80,
    rows: 24,
    signal: "none",
    settle: 12,
    stdin: "sleep 9; printf q",
    animation: true,
    configHome: box.root,
    env: { GH_GLANCE_FIXTURE_STATE: box.statePath },
  });
  const checking = result.liveScreen.statusHistory.filter((line) => / Checking(?:\s|$)/.test(line));
  assert.ok(new Set(checking.map((line) => [...line][0])).size > 1, checking.join(" -> "));
  assert.match(statusLine(result) ?? "", /^· Watching/);
  assert.equal(result.liveScreen.maxStatusLines, 1);
});

test("a future adapted check stays still, shows next, and then settles", (t) => {
  const now = Date.now();
  const box = sharedFixture(t, {
    core: { limit: 5000, used: 3900, remaining: 1100, resetMs: now + 120_000 },
    delayByCommand: { actions: 1_200 },
  });
  capture({
    cols: 80,
    rows: 24,
    signal: "none",
    settle: 15,
    stdin: quitAfterCached("actions"),
    args: "--refresh 40",
    configHome: box.root,
    env: { GH_GLANCE_FIXTURE_STATE: box.statePath, GH_GLANCE_FIXTURE_PANE: "warm" },
  });
  const adapted = capture({
    cols: 80,
    rows: 24,
    signal: "none",
    settle: 12,
    stdin: "sleep 9; printf q",
    args: "--refresh 40",
    animation: true,
    configHome: box.root,
    env: { GH_GLANCE_FIXTURE_STATE: box.statePath, GH_GLANCE_FIXTURE_PANE: "adapted" },
  });
  const statuses = adapted.liveScreen.statusHistory;
  const scheduledAt = statuses.findIndex((line) => /^· Watching next (?:<1m|\d+m)/.test(line));
  const checkingAt = statuses.findIndex((line) => / Checking(?:\s|$)/.test(line));
  const watchingAt = statuses.findIndex(
    (line, index) => index > checkingAt && /^· Watching/.test(line),
  );
  const checkingMarkers = statuses
    .filter((line) => / Checking(?:\s|$)/.test(line))
    .map((line) => [...line][0]);
  assert.ok(scheduledAt >= 0, statuses.join(" -> "));
  assert.ok(checkingAt > scheduledAt, statuses.join(" -> "));
  assert.equal(new Set(checkingMarkers).size, 1, "adapted automatic Checking animated");
  assert.ok(watchingAt > checkingAt, statuses.join(" -> "));
  assert.equal(adapted.hasFullKeyHints, true);
});

test("a long future grant uses a coarse minute interval without moving full hints", (t) => {
  const now = Date.now();
  const box = sharedFixture(t, {
    core: { limit: 5000, used: 3950, remaining: 1050, resetMs: now + 3_600_000 },
  });
  capture({
    cols: 80,
    rows: 24,
    signal: "none",
    settle: 15,
    stdin: quitAfterCached("actions"),
    args: "--refresh 40",
    configHome: box.root,
    env: { GH_GLANCE_FIXTURE_STATE: box.statePath, GH_GLANCE_FIXTURE_PANE: "long-warm" },
  });
  const held = capture({
    cols: 80,
    rows: 24,
    signal: "none",
    settle: 15,
    stdin: waitForAwk(
      '"$GH_GLANCE_CAPTURE_OUT"',
      '/^· Watching next [0-9]+m/ { ok=1 }',
      200,
    ) + "sleep .3; printf q",
    args: "--refresh 40",
    configHome: box.root,
    env: {
      GH_GLANCE_CAPTURE_LIVE_FLUSH: "1",
      GH_GLANCE_FIXTURE_STATE: box.statePath,
      GH_GLANCE_FIXTURE_PANE: "long-held",
    },
  });
  assert.ok(
    held.liveScreen.statusHistory.some((line) => /^· Watching next \d+m/.test(line)),
    held.liveScreen.statusHistory.join(" -> "),
  );
  assert.equal(held.hasFullKeyHints, true);
});

test("manual refresh waits without motion and animates only after admission", async (t) => {
  const now = Date.now();
  const box = sharedFixture(t, {
    // The keypress is released from the persisted scheduled reservation below,
    // rather than from terminal bytes whose live flush timing differs between
    // GNU and BSD script(1).
    core: { limit: 5000, used: 3900, remaining: 1100, resetMs: now + 120_000 },
    delayByCommand: { actions: 3_000 },
  });
  capture({
    cols: 80,
    rows: 24,
    signal: "none",
    settle: 15,
    stdin: quitAfterCached("actions"),
    args: "--refresh 40",
    configHome: box.root,
    env: { GH_GLANCE_FIXTURE_STATE: box.statePath, GH_GLANCE_FIXTURE_PANE: "warm" },
  });
  const manualReady = join(box.root, "manual-refresh-ready");
  const manualCapture = captureAsync({
    cols: 80,
    rows: 24,
    signal: "none",
    settle: 30,
    stdin:
      `i=0; while [ ! -f "${manualReady}" ] && [ $i -lt 300 ]; do ` +
      "i=$((i + 1)); sleep .1; done; sleep .3; printf r; " +
      waitForAwk(
        '"$GH_GLANCE_CAPTURE_OUT"',
        'index($0, "⣾ Checking") { first=1 } ' +
          '/⣽ Checking|⣻ Checking|⢿ Checking|⡿ Checking|⣟ Checking|⣯ Checking|⣷ Checking/ ' +
          '{ moved=1 } first && moved { ok=1 }',
        200,
      ) +
      `watching=$(${captureCount("Watching")}); ` +
      "i=0; current=$watching; while [ \"$current\" -le \"$watching\" ] && [ $i -lt 200 ]; " +
      `do i=$((i + 1)); sleep .1; current=$(${captureCount("Watching")}); ` +
      "done; sleep .3; printf q",
    args: "--refresh 40",
    animation: true,
    configHome: box.root,
    env: {
      GH_GLANCE_CAPTURE_LIVE_FLUSH: "1",
      GH_GLANCE_FIXTURE_STATE: box.statePath,
      GH_GLANCE_FIXTURE_PANE: "manual",
    },
  });
  const deadline = Date.now() + 15_000;
  let scheduled = false;
  while (Date.now() < deadline && !scheduled) {
    try {
      const state = JSON.parse(readFileSync(governorPath(box.root), "utf8"));
      scheduled = Object.values(state.reservations ?? {}).some((reservation) =>
        reservation.status === "scheduled" && reservation.costs?.core === 2 &&
        reservation.notBefore > Date.now());
    } catch {
      // The new process has not published its first atomic governor update yet.
    }
    if (!scheduled) await new Promise((resolve) => setTimeout(resolve, 40));
  }
  writeFileSync(manualReady, "ready\n", { mode: 0o600 });
  const manual = await manualCapture;
  assert.equal(scheduled, true, "manual keypress fixture never reached a held automatic lane");
  const statuses = manual.liveScreen.statusHistory;
  const scheduledAt = statuses.findIndex((line) => /^· Watching next/.test(line));
  const checking = statuses
    .map((line, index) => ({ line, index }))
    .filter(({ line }) => / Checking(?:\s|$)/.test(line));
  assert.ok(scheduledAt >= 0, statuses.join(" -> "));
  assert.ok(checking[0]?.index > scheduledAt, statuses.join(" -> "));
  assert.ok(
    new Set(checking.map(({ line }) => [...line][0])).size > 1,
    `manual Checking did not animate: ${statuses.join(" -> ")}`,
  );
  assert.equal(actionsRuns(box.read(), "manual").length, 1);
});

test("a held core tab stays Paused while a selected GraphQL tab progresses", (t) => {
  const box = sharedFixture(t, {
    core: { limit: 5000, used: 5000, remaining: 0, resetMs: Date.now() + 3_600_000 },
  });
  const result = capture({
    cols: 80,
    rows: 24,
    signal: "none",
    settle: 20,
    args: "--refresh 40 --tab actions",
    stdin:
      waitForAwk('"$GH_GLANCE_CAPTURE_OUT"', 'index($0, "Paused") { ok=1 }') +
      "printf 2; " +
      "i=0; cache=\"$XDG_CONFIG_HOME/gh-glance/dashboard-cache.json\"; " +
      waitForAwk('"$cache"', 'index($0, "\\"issues\\"") { ok=1 }') +
      "sleep .3; " +
      `seen=$(${captureCount("\\[1:Actions")}); ` +
      "printf 1; i=0; current=$seen; while [ \"$current\" -le \"$seen\" ] && [ $i -lt 150 ]; " +
      `do i=$((i + 1)); sleep .1; current=$(${captureCount("\\[1:Actions")}); ` +
      "done; sleep .3; printf q",
    configHome: box.root,
    env: {
      GH_GLANCE_CAPTURE_LIVE_FLUSH: "1",
      GH_GLANCE_FIXTURE_STATE: box.statePath,
      GH_GLANCE_FIXTURE_PANE: "switch",
    },
  });
  const statuses = result.liveScreen.statusHistory;
  const firstPaused = statuses.findIndex((line) => /^‖ Paused/.test(line));
  const independent = statuses.findIndex(
    (line, index) => index > firstPaused && / (?:Checking|Watching)(?:\s|$)/.test(line),
  );
  const finalPaused = statuses.findLastIndex((line) => /^‖ Paused/.test(line));
  assert.ok(firstPaused >= 0, statuses.join(" -> "));
  assert.ok(independent > firstPaused, statuses.join(" -> "));
  assert.ok(finalPaused > independent, statuses.join(" -> "));
  assert.equal(actionsRuns(box.read(), "switch").length, 0);
  assert.ok(dataStarts(box.read(), "switch").some((event) => event.argv[0] === "issue"));
});

test("corrupt, live-locked, and blocked storage pause with no data calls", (t) => {
  const box = sharedFixture(t);
  capture({
    cols: 80,
    rows: 24,
    signal: "none",
    settle: 15,
    stdin: quitAfterCached("actions"),
    configHome: box.root,
    env: { GH_GLANCE_FIXTURE_STATE: box.statePath, GH_GLANCE_FIXTURE_PANE: "warm" },
  });
  const path = governorPath(box.root);
  const healthy = readFileSync(path, "utf8");
  const before = dataStarts(box.read()).length;

  writeFileSync(path, "{corrupt\n", { mode: 0o600 });
  const corrupt = capture({
    cols: 80,
    rows: 24,
    settle: 7,
    configHome: box.root,
    env: { GH_GLANCE_FIXTURE_STATE: box.statePath, GH_GLANCE_FIXTURE_PANE: "corrupt" },
  });
  writeFileSync(path, healthy, { mode: 0o600 });
  assert.match(statusLine(corrupt) ?? "", /^‖ Paused/);
  assert.match(corrupt.finalFrame.lines.join("\n"), translatedCoordinationNotice);

  writeFileSync(`${path}.lock`, `${JSON.stringify({ pid: process.pid, nonce: "live-test-owner" })}\n`, {
    mode: 0o600,
  });
  const locked = capture({
    cols: 80,
    rows: 24,
    settle: 7,
    configHome: box.root,
    env: { GH_GLANCE_FIXTURE_STATE: box.statePath, GH_GLANCE_FIXTURE_PANE: "locked" },
  });
  rmSync(`${path}.lock`, { force: true });
  assert.match(statusLine(locked) ?? "", /^‖ Paused/);
  assert.match(locked.finalFrame.lines.join("\n"), translatedCoordinationNotice);

  const blocked = sharedFixture(t);
  writeFileSync(join(blocked.root, "gh-glance"), "not a directory\n", { mode: 0o600 });
  const unwritable = capture({
    cols: 80,
    rows: 24,
    settle: 7,
    configHome: blocked.root,
    env: { GH_GLANCE_FIXTURE_STATE: blocked.statePath, GH_GLANCE_FIXTURE_PANE: "blocked" },
  });
  assert.match(statusLine(unwritable) ?? "", /^‖ Paused/);
  assert.match(unwritable.finalFrame.lines.join("\n"), translatedCoordinationNotice);
  assert.equal(dataStarts(box.read()).length, before);
  assert.equal(dataStarts(blocked.read()).length, 0);
});

test("a sub-threshold coordination blip stays silent", (t) => {
  const root = configRoot(t, "gh-glance-status-notice-blip-");
  capture({
    cols: 80,
    rows: 12,
    signal: "none",
    settle: 15,
    stdin: quitAfterCached("actions"),
    configHome: root,
  });
  const noticeLock = `${governorPath(root)}.lock`;
  const result = capture({
    cols: 80,
    rows: 12,
    signal: "none",
    settle: 25,
    stdin:
      waitForAwk('"$GH_GLANCE_CAPTURE_OUT"', 'index($0, "Watching") { ok=1 }') +
      'printf \'{"pid":%s,"nonce":"notice-blip-owner"}\\n\' "$$" > "$GH_GLANCE_NOTICE_LOCK"; ' +
      waitForAwk('"$GH_GLANCE_CAPTURE_OUT"', 'index($0, "Paused") { ok=1 }', 200) +
      `watching=$(${captureCount("Watching")}); ` +
      'rm -f "$GH_GLANCE_NOTICE_LOCK"; ' +
      'i=0; current=$watching; while [ "$current" -le "$watching" ] && [ $i -lt 200 ]; ' +
      `do i=$((i + 1)); sleep .1; current=$(${captureCount("Watching")}); ` +
      'done; sleep .3; printf q',
    configHome: root,
    env: {
      GH_GLANCE_CAPTURE_LIVE_FLUSH: "1",
      GH_GLANCE_NOTICE_LOCK: noticeLock,
    },
  });

  assert.ok(result.liveScreen.statusHistory.some((line) => /^‖ Paused/.test(line)));
  assert.doesNotMatch(
    result.raw,
    /Confirming your GitHub login|Holding until|Coordinating with your other panes|Can't coordinate/,
  );
  assert.match(statusLine(result) ?? "", /^· Watching/);
});

test("a sustained coordination notice can appear and clear without overflowing the frame", (t) => {
  const root = configRoot(t, "gh-glance-status-notice-transition-");
  capture({
    cols: 80,
    rows: 12,
    signal: "none",
    settle: 15,
    stdin: quitAfterCached("actions"),
    configHome: root,
  });
  const noticeLock = `${governorPath(root)}.lock`;
  const result = capture({
    cols: 80,
    rows: 12,
    signal: "none",
    settle: 25,
    stdin:
      waitForAwk('"$GH_GLANCE_CAPTURE_OUT"', 'index($0, "Watching") { ok=1 }') +
      'printf \'{"pid":%s,"nonce":"notice-transition-owner"}\\n\' "$$" > "$GH_GLANCE_NOTICE_LOCK"; ' +
      waitForAwk(
        '"$GH_GLANCE_CAPTURE_OUT"',
        'index($0, "Coordinating with your other panes") { ok=1 }',
        200,
      ) +
      `watching=$(${captureCount("Watching")}); ` +
      'rm -f "$GH_GLANCE_NOTICE_LOCK"; ' +
      'i=0; current=$watching; while [ "$current" -le "$watching" ] && [ $i -lt 200 ]; ' +
      `do i=$((i + 1)); sleep .1; current=$(${captureCount("Watching")}); ` +
      'done; sleep .3; printf q',
    configHome: root,
    env: {
      GH_GLANCE_CAPTURE_LIVE_FLUSH: "1",
      GH_GLANCE_NOTICE_LOCK: noticeLock,
    },
  });

  assert.match(result.raw, /Coordinating with your other panes/);
  assert.doesNotMatch(result.finalFrame.lines.join("\n"), /Coordinating with your other panes/);
  assert.ok(result.liveScreen.statusHistory.some((line) => /^‖ Paused/.test(line)));
  assert.match(statusLine(result) ?? "", /^· Watching/);
  assert.ok(result.fullClears <= 2, `${result.fullClears} full clears during notice transition`);
  assert.equal(result.liveScreen.maxStatusLines, 1);
  assert.equal(result.finalFrame.lines.length, 11);
});

test("a non-budget failure settles on Failed and stops status motion", (t) => {
  const result = capture({
    cols: 80,
    rows: 24,
    signal: "none",
    settle: 30,
    stdin: waitForAwk(
      '"$GH_GLANCE_CAPTURE_OUT"',
      'index($0, "Failed") { ok=1 }',
      250,
    ) + "sleep .3; printf q",
    args: "--tab issues",
    animation: true,
    configHome: configRoot(t, "gh-glance-status-failed-"),
    env: {
      GH_GLANCE_CAPTURE_LIVE_FLUSH: "1",
      GH_GLANCE_FIXTURE_FAIL: "dial tcp: fixture unavailable",
      GH_GLANCE_FIXTURE_FAIL_ON: "issue",
    },
  });
  const statuses = result.liveScreen.statusHistory;
  const failedAt = statuses.findLastIndex((line) => / Failed(?:\s|$)/.test(line));
  assert.ok(failedAt >= 0, statuses.join(" -> "));
  assert.equal(statuses.slice(failedAt + 1).some((line) => / Checking(?:\s|$)/.test(line)), false);
  assert.match(statusLine(result) ?? "", /^! Failed/);
});

test("incomplete Security observation preserves known rows and shows Limited", (t) => {
  const root = configRoot(t, "gh-glance-status-limited-");
  const warm = capture({
    cols: 80,
    rows: 24,
    signal: "none",
    settle: 15,
    args: "--tab security",
    stdin: quitAfterCached("security"),
    configHome: root,
    env: { GH_GLANCE_FIXTURE_SECURITY_ALERTS: "1" },
  });
  assert.match(warm.finalFrame.lines.join("\n"), /cached dependency alert/);

  const blind = capture({
    cols: 80,
    rows: 24,
    signal: "none",
    settle: 30,
    stdin: waitForAwk(
      '"$GH_GLANCE_CAPTURE_OUT"',
      'index($0, "Limited") { ok=1 }',
      250,
    ) + "sleep .3; printf q",
    args: "--tab security",
    configHome: root,
    env: {
      GH_GLANCE_CAPTURE_LIVE_FLUSH: "1",
      GH_GLANCE_FIXTURE_FAIL: "You are not logged into any GitHub hosts",
      GH_GLANCE_FIXTURE_FAIL_ON: "api-data",
    },
  });
  const screen = blind.finalFrame.lines.join("\n");
  assert.match(screen, /cached dependency alert/);
  assert.match(screen, /Security \(\?\)/);
  assert.match(screen, /1 of \?/);
  assert.match(statusLine(blind) ?? "", /^\? Limited/);
});

test("linear screen-reader polling omits adapted Checking but retains manual Checking", (t) => {
  const now = Date.now();
  const box = sharedFixture(t, {
    core: { limit: 5000, used: 3900, remaining: 1100, resetMs: now + 120_000 },
    delayByCommand: { actions: 1_200 },
  });
  capture({
    cols: 80,
    rows: 24,
    signal: "none",
    settle: 15,
    stdin: quitAfterCached("actions"),
    configHome: box.root,
    env: { GH_GLANCE_FIXTURE_STATE: box.statePath, GH_GLANCE_FIXTURE_PANE: "reader-warm" },
  });
  const reader = capture({
    cols: 80,
    rows: 24,
    signal: "none",
    settle: 20,
    stdin:
      waitForAwk('"$GH_GLANCE_CAPTURE_OUT"', 'index($0, "Watching next") { ok=1 }') +
      `watching=$(${captureCount("Watching")}); ` +
      "i=0; current=$watching; while [ \"$current\" -le \"$watching\" ] && [ $i -lt 200 ]; " +
      `do i=$((i + 1)); sleep .1; current=$(${captureCount("Watching")}); ` +
      "done; " +
      "printf r; " +
      waitForAwk('"$GH_GLANCE_CAPTURE_OUT"', 'index($0, "Checking") { ok=1 }', 200) +
      "sleep .3; printf q",
    configHome: box.root,
    env: {
      GH_GLANCE_CAPTURE_LIVE_FLUSH: "1",
      GH_GLANCE_FIXTURE_STATE: box.statePath,
      GH_GLANCE_FIXTURE_PANE: "reader",
      INK_SCREEN_READER: "true",
    },
  });
  assert.ok(reader.fixtureCalls.filter((call) => call.includes("/actions/runs?")).length >= 1);
  assert.doesNotMatch(reader.raw, /\bWaiting\b/);
  assert.match(reader.raw, /Watching next (?:<1m|\d+m)/);
  assert.match(reader.raw, /Watching/);
  assert.ok(reader.raw.indexOf("Checking") > reader.raw.indexOf("Watching"));
});

test("linear screen-reader output retains startup, holds, failures, limits, stale rows, and errors", (t) => {
  const setup = capture({
    cols: 80,
    rows: 24,
    settle: 8,
    configHome: configRoot(t, "gh-glance-reader-setup-"),
    env: {
      INK_SCREEN_READER: "true",
      GH_GLANCE_FIXTURE_FAIL: "failed to determine base repo: no git remotes found",
      GH_GLANCE_FIXTURE_FAIL_ON: "run,issue,pr,api-data",
    },
  });
  assert.match(setup.raw, /Setup/);
  assert.match(setup.raw, /No GitHub remote found/);

  const startupBox = sharedFixture(t, { delayByCommand: { actions: 1_200 } });
  const startup = capture({
    cols: 80,
    rows: 24,
    signal: "none",
    settle: 30,
    stdin: waitForAwk(
      '"$GH_GLANCE_CAPTURE_OUT"',
      'index($0, "Checking") { checking=1 } checking && index($0, "Watching") { ok=1 }',
      250,
    ) + "sleep .3; printf q",
    configHome: startupBox.root,
    env: {
      GH_GLANCE_CAPTURE_LIVE_FLUSH: "1",
      INK_SCREEN_READER: "true",
      GH_GLANCE_FIXTURE_STATE: startupBox.statePath,
      GH_GLANCE_FIXTURE_PANE: "reader-startup",
    },
  });
  assert.match(startup.raw, /Checking/);
  assert.match(startup.raw, /Watching/);

  const heldBox = sharedFixture(t, {
    core: { limit: 5000, used: 5000, remaining: 0, resetMs: Date.now() + 3_600_000 },
  });
  const paused = capture({
    cols: 80,
    rows: 24,
    signal: "none",
    settle: 30,
    stdin: waitForAwk(
      '"$GH_GLANCE_CAPTURE_OUT"',
      'index($0, "Paused") { ok=1 }',
      250,
    ) + "sleep .3; printf q",
    configHome: heldBox.root,
    env: {
      GH_GLANCE_CAPTURE_LIVE_FLUSH: "1",
      INK_SCREEN_READER: "true",
      GH_GLANCE_FIXTURE_STATE: heldBox.statePath,
      GH_GLANCE_FIXTURE_PANE: "reader-paused",
    },
  });
  assert.match(paused.raw, /Paused/);
  assert.match(paused.raw, /reset \d+m/);

  const failed = capture({
    cols: 80,
    rows: 24,
    signal: "none",
    settle: 30,
    stdin: waitForAwk(
      '"$GH_GLANCE_CAPTURE_OUT"',
      'index($0, "Failed") { ok=1 }',
      250,
    ) + "sleep .3; printf q",
    args: "--tab issues",
    configHome: configRoot(t, "gh-glance-reader-failed-"),
    env: {
      GH_GLANCE_CAPTURE_LIVE_FLUSH: "1",
      INK_SCREEN_READER: "true",
      GH_GLANCE_FIXTURE_FAIL: "dial tcp: fixture unavailable",
      GH_GLANCE_FIXTURE_FAIL_ON: "issue",
    },
  });
  assert.match(failed.raw, /Failed/);
  assert.match(failed.raw, /fixture unavailable/);

  const limitedRoot = configRoot(t, "gh-glance-reader-limited-");
  capture({
    cols: 80,
    rows: 24,
    signal: "none",
    settle: 15,
    args: "--tab security",
    stdin: quitAfterCached("security"),
    configHome: limitedRoot,
    env: { GH_GLANCE_FIXTURE_SECURITY_ALERTS: "1" },
  });
  const limited = capture({
    cols: 80,
    rows: 24,
    signal: "none",
    settle: 30,
    stdin: waitForAwk(
      '"$GH_GLANCE_CAPTURE_OUT"',
      'index($0, "Limited") { ok=1 }',
      250,
    ) + "sleep .3; printf q",
    args: "--tab security",
    configHome: limitedRoot,
    env: {
      GH_GLANCE_CAPTURE_LIVE_FLUSH: "1",
      INK_SCREEN_READER: "true",
      GH_GLANCE_FIXTURE_FAIL: "You are not logged into any GitHub hosts",
      GH_GLANCE_FIXTURE_FAIL_ON: "api-data",
    },
  });
  assert.match(limited.raw, /Limited/);
  assert.match(limited.raw, /cached dependency alert/);

  const staleRoot = configRoot(t, "gh-glance-reader-stale-");
  capture({
    cols: 80,
    rows: 24,
    signal: "none",
    settle: 15,
    stdin: quitAfterCached("actions"),
    configHome: staleRoot,
  });
  const cachePath = join(staleRoot, "gh-glance", "dashboard-cache.json");
  const document = JSON.parse(readFileSync(cachePath, "utf8"));
  const old = Date.now() - 120_000;
  for (const entry of Object.values(document.targets)) {
    entry.updatedAt = old;
    for (const cachedTab of Object.values(entry.tabs)) {
      cachedTab.lastOk = old;
      cachedTab.meta.at = old;
    }
  }
  writeFileSync(cachePath, `${JSON.stringify(document)}\n`, { mode: 0o600 });
  const staleError = capture({
    cols: 80,
    rows: 24,
    signal: "none",
    settle: 30,
    stdin: waitForAwk(
      '"$GH_GLANCE_CAPTURE_OUT"',
      'index($0, "GitHub rate limit reached -- backing off") { failed=1 } ' +
        'failed && index($0, "stale 2m") { ok=1 }',
      250,
    ) + "sleep .3; printf q",
    configHome: staleRoot,
    env: {
      GH_GLANCE_CAPTURE_LIVE_FLUSH: "1",
      INK_SCREEN_READER: "true",
      GH_GLANCE_FIXTURE_FAIL: "HTTP 403: API rate limit exceeded",
      GH_GLANCE_FIXTURE_FAIL_ON: "actions",
    },
  });
  assert.match(staleError.raw, /ci: pin actions to commit/);
  assert.match(staleError.raw, /GitHub rate limit reached -- backing off/);
  assert.match(staleError.raw, /Paused/);
  assert.match(staleError.raw, /stale 2m/);
});
