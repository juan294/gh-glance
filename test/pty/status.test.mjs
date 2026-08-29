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

import { capture, isStatusLine, waitForAwk } from "./capture.mjs";

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
    event.argv[0] === "api" && event.argv[1] !== "rate_limit"
  ));

const statusLine = (result) => result.finalFrame.lines.find(isStatusLine);

test("footer layout keeps semantic status and essential actions from 80 to 24 columns", (t) => {
  for (const cols of [80, 60, 45, 24]) {
    const box = sharedFixture(t, {
      core: { limit: 5000, used: 5000, remaining: 0, resetMs: Date.now() + 3_600_000 },
    });
    const result = capture({
      cols,
      rows: 20,
      signal: "none",
      settle: 15,
      stdin: waitForAwk('"$GH_GLANCE_CAPTURE_OUT"', 'index($0, "Paused") { ok=1 }') +
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
    if (cols >= 45) assert.match(line ?? "", /reset \d\d:\d\d/);
    else assert.doesNotMatch(line ?? "", /reset|\d\d:\d\d/);
    assert.ok(result.finalFrame.widest <= cols, `${cols}-column frame overflowed`);
    assert.ok(result.liveScreen.maxStatusLines <= 1);
    assert.equal(result.liveScreen.lines.at(-1), "");
  }
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
  assert.match(statusLine(noColor) ?? "", /^· (?:Watching|Waiting)/);
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
  assert.match(statusLine(result) ?? "", /^\. (?:Watching|Waiting)/);
  const frame = result.finalFrame.lines.join("\n");
  assert.match(frame, /^│ {2}[+x-] {2}\S/m);
  assert.doesNotMatch(frame, /[\uE000-\uF8FF]/);
  assert.equal(result.finalFrame.widest <= 45, true);
});

test("delayed admitted startup animates Checking and settles to Watching", (t) => {
  const box = sharedFixture(t, { delayByCommand: { run: 1_200 } });
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
    delayByCommand: { run: 1_200 },
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
  const waitingAt = statuses.findIndex((line) => /^· Waiting.*next \d\d:\d\d/.test(line));
  const checkingAt = statuses.findIndex((line) => / Checking(?:\s|$)/.test(line));
  const watchingAt = statuses.findIndex(
    (line, index) => index > checkingAt && /^· Watching/.test(line),
  );
  const checkingMarkers = statuses
    .filter((line) => / Checking(?:\s|$)/.test(line))
    .map((line) => [...line][0]);
  assert.ok(waitingAt >= 0, statuses.join(" -> "));
  assert.ok(checkingAt > waitingAt, statuses.join(" -> "));
  assert.equal(new Set(checkingMarkers).size, 1, "adapted automatic Checking animated");
  assert.ok(watchingAt > checkingAt, statuses.join(" -> "));
});

test("manual refresh waits without motion and animates only after admission", (t) => {
  const now = Date.now();
  const box = sharedFixture(t, {
    core: { limit: 5000, used: 3900, remaining: 1100, resetMs: now + 120_000 },
    delayByCommand: { run: 3_000 },
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
  const manual = capture({
    cols: 80,
    rows: 24,
    signal: "none",
    settle: 30,
    stdin:
      waitForAwk('"$GH_GLANCE_CAPTURE_OUT"', 'index($0, "Waiting") { ok=1 }') +
      `watching=$(${captureCount("Watching")}); ` +
      "printf r; " +
      waitForAwk(
        '"$GH_GLANCE_CAPTURE_OUT"',
        'index($0, "⣾ Checking") { first=1 } ' +
          '/⣽ Checking|⣻ Checking|⢿ Checking|⡿ Checking|⣟ Checking|⣯ Checking|⣷ Checking/ ' +
          '{ moved=1 } first && moved { ok=1 }',
        200,
      ) +
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
  const statuses = manual.liveScreen.statusHistory;
  const waitingAt = statuses.findIndex((line) => /^· Waiting/.test(line));
  const checking = statuses
    .map((line, index) => ({ line, index }))
    .filter(({ line }) => / Checking(?:\s|$)/.test(line));
  assert.ok(waitingAt >= 0, statuses.join(" -> "));
  assert.ok(checking[0]?.index > waitingAt, statuses.join(" -> "));
  assert.ok(
    new Set(checking.map(({ line }) => [...line][0])).size > 1,
    `manual Checking did not animate: ${statuses.join(" -> ")}`,
  );
  assert.equal(dataStarts(box.read(), "manual").filter((event) => event.argv[0] === "run").length, 1);
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
  assert.equal(dataStarts(box.read(), "switch").filter((event) => event.argv[0] === "run").length, 0);
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
  assert.match(corrupt.finalFrame.lines.join("\n"), /API coordination unavailable/);

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
  assert.match(locked.finalFrame.lines.join("\n"), /API coordination unavailable/);

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
  assert.match(unwritable.finalFrame.lines.join("\n"), /API coordination unavailable/);
  assert.equal(dataStarts(box.read()).length, before);
  assert.equal(dataStarts(blocked.read()).length, 0);
});

test("a coordination notice can appear and clear without overflowing the frame", (t) => {
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
        'index($0, "API coordination unavailable") { ok=1 }',
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

  assert.match(result.raw, /API coordination unavailable/);
  assert.doesNotMatch(result.finalFrame.lines.join("\n"), /API coordination unavailable/);
  assert.ok(result.liveScreen.statusHistory.some((line) => /^‖ Paused/.test(line)));
  assert.match(statusLine(result) ?? "", /^· (?:Watching|Waiting)/);
  assert.ok(result.fullClears <= 2, `${result.fullClears} full clears during notice transition`);
  assert.equal(result.liveScreen.maxStatusLines, 1);
  assert.equal(result.finalFrame.lines.length, 11);
});

test("a non-budget failure settles on Failed and stops status motion", (t) => {
  const result = capture({
    cols: 80,
    rows: 24,
    settle: 8,
    args: "--tab issues",
    animation: true,
    configHome: configRoot(t, "gh-glance-status-failed-"),
    env: {
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
    settle: 8,
    args: "--tab security",
    configHome: root,
    env: {
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
    delayByCommand: { run: 1_200 },
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
      waitForAwk('"$GH_GLANCE_CAPTURE_OUT"', 'index($0, "Waiting") { ok=1 }') +
      waitForAwk('"$GH_GLANCE_CAPTURE_OUT"', 'index($0, "Watching") { ok=1 }', 200) +
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
  assert.ok(reader.fixtureCalls.filter((call) => call.startsWith("run list")).length >= 1);
  assert.match(reader.raw, /Waiting/);
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

  const startupBox = sharedFixture(t, { delayByCommand: { run: 1_200 } });
  const startup = capture({
    cols: 80,
    rows: 24,
    settle: 9,
    configHome: startupBox.root,
    env: {
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
    settle: 7,
    configHome: heldBox.root,
    env: {
      INK_SCREEN_READER: "true",
      GH_GLANCE_FIXTURE_STATE: heldBox.statePath,
      GH_GLANCE_FIXTURE_PANE: "reader-paused",
    },
  });
  assert.match(paused.raw, /Paused/);
  assert.match(paused.raw, /reset \d\d:\d\d/);

  const failed = capture({
    cols: 80,
    rows: 24,
    settle: 8,
    args: "--tab issues",
    configHome: configRoot(t, "gh-glance-reader-failed-"),
    env: {
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
    settle: 8,
    args: "--tab security",
    configHome: limitedRoot,
    env: {
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
    settle: 9,
    configHome: staleRoot,
    env: {
      INK_SCREEN_READER: "true",
      GH_GLANCE_FIXTURE_FAIL: "HTTP 403: API rate limit exceeded",
      GH_GLANCE_FIXTURE_FAIL_ON: "run",
    },
  });
  assert.match(staleError.raw, /ci: pin actions to commit/);
  assert.match(staleError.raw, /GitHub rate limit reached -- backing off/);
  assert.match(staleError.raw, /Paused/);
  assert.match(staleError.raw, /stale 2m/);
});
