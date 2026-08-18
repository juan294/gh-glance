import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { capture } from "./capture.mjs";

const ESC = String.fromCharCode(27);
const strip = (text) =>
  text.replace(new RegExp(`${ESC}\\[[0-9;?]*[A-Za-z]`, "g"), "").replace(/\r/g, "");

function fetchingForegroundStates(text) {
  const states = [];
  let brightCyan = false;
  for (let index = 0; index < text.length; index += 1) {
    if (text[index] === ESC && text[index + 1] === "[") {
      let end = index + 2;
      while (end < text.length && !/[A-Za-z]/.test(text[end])) end += 1;
      if (text[end] === "m") {
        const values = text
          .slice(index + 2, end)
          .split(";")
          .map((value) => Number(value || 0));
        if (values.includes(0) || values.includes(39)) brightCyan = false;
        if (values.includes(96)) brightCyan = true;
      }
      index = end;
      continue;
    }
    if (text.startsWith("Fetching", index)) states.push(brightCyan);
  }
  return states;
}

function withCounterCapture(prefix, initial, build) {
  const root = mkdtempSync(join(tmpdir(), prefix));
  const counter = join(root, "counter");
  writeFileSync(counter, `${initial}\n`, "utf8");
  try {
    return build(counter);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

const recovered = withCounterCapture("gh-glance-recover-", 1, (counter) =>
  capture({
    cols: 80,
    rows: 24,
    settle: 12,
    args: "--tab issues",
    env: {
      GH_GLANCE_FIXTURE_FAIL_FIRST_FILE: counter,
      GH_GLANCE_FIXTURE_FAIL_FIRST_ON: "issue",
      GH_GLANCE_FIXTURE_FAIL_FIRST_MESSAGE: "dial tcp: temporary network failure",
    },
  }),
);

const forcedSecurity = withCounterCapture("gh-glance-security-force-", 1, (counter) =>
  capture({
    cols: 80,
    rows: 24,
    signal: "none",
    settle: 15,
    args: "--tab security",
    stdin: "sleep 7; printf 'r'; sleep 4; printf 'q'; sleep 2",
    env: {
      GH_GLANCE_FIXTURE_FAIL_FIRST_FILE: counter,
      GH_GLANCE_FIXTURE_FAIL_FIRST_ON: "dependabot",
      GH_GLANCE_FIXTURE_FAIL_FIRST_MESSAGE:
        "You are not logged into any GitHub hosts. To log in, run: gh auth login",
    },
  }),
);

const cachedConfigHome = mkdtempSync(join(tmpdir(), "gh-glance-cached-pty-"));

const screenReader = capture({
  cols: 80,
  rows: 24,
  settle: 7,
  env: { INK_SCREEN_READER: "true" },
  configHome: cachedConfigHome,
});

const stalledStartedAt = Date.now();
const waitForStalledRow =
  "tries=0; cache=\"$XDG_CONFIG_HOME/gh-glance/dashboard-cache.json\"; " +
  "while ! grep -Eq '\"databaseId\"[[:space:]]*:[[:space:]]*101' \"$cache\" " +
  "2>/dev/null && [ $tries -lt 150 ]; do " +
  // The initial two-call Actions reservation advances the full-budget lane by
  // 1.8s. Wait through that slot so this abort test does not depend on a race
  // with an unrelated automatic poll.
  "tries=$((tries + 1)); sleep .1; done; sleep 2; ";
const waitForStalledOpen =
  "tries=0; while ! grep -q '^run view ' \"$GH_GLANCE_CAPTURE_OUT.calls\" " +
  "2>/dev/null && [ $tries -lt 100 ]; do tries=$((tries + 1)); sleep .1; done; ";
const stalledOpen = capture({
  cols: 80,
  rows: 24,
  signal: "none",
  settle: 15,
  args: "--refresh 40",
  stdin: waitForStalledRow + "printf 'j'; sleep 1; printf '\\r'; " +
    waitForStalledOpen + "printf 'q'; sleep 2",
  env: { GH_GLANCE_FIXTURE_STALL_VIEW: "1" },
});
const stalledElapsedMs = Date.now() - stalledStartedAt;

const insertedAbove = withCounterCapture("gh-glance-run-sequence-", 0, (counter) => {
  const waitForFirstList =
    "tries=0; while ! grep -q 'docs: update the readme' \"$GH_GLANCE_CAPTURE_OUT\" " +
    "2>/dev/null && [ $tries -lt 200 ]; do tries=$((tries + 1)); sleep .1; done; ";
  const waitForExpandedList =
    "tries=0; while ! grep -q 'new run one' \"$GH_GLANCE_CAPTURE_OUT\" " +
    "2>/dev/null && [ $tries -lt 200 ]; do tries=$((tries + 1)); sleep .1; done; ";
  return capture({
    cols: 80,
    rows: 12,
    signal: "none",
    settle: 30,
    args: "--refresh 40",
    stdin:
      waitForFirstList + "printf 'j'; sleep .2; printf 'j'; sleep .2; printf 'j'; " +
      "sleep .2; printf 'j'; sleep 1; printf 'r'; " + waitForExpandedList +
      "printf '\\r'; sleep 1; printf 'q'; sleep 2",
    env: { GH_GLANCE_FIXTURE_RUN_SEQUENCE_FILE: counter },
  });
});

const noColorFailure = capture({
  cols: 80,
  rows: 24,
  settle: 7,
  args: "--tab issues",
  env: {
    NO_COLOR: "1",
    GH_GLANCE_FIXTURE_FAIL: "dial tcp: fixture unavailable",
    GH_GLANCE_FIXTURE_FAIL_ON: "issue",
  },
});

const narrowAuthFailure = capture({
  cols: 45,
  rows: 20,
  settle: 7,
  args: "--tab issues",
  env: {
    GH_GLANCE_FIXTURE_FAIL:
      "You are not logged into any GitHub hosts. To log in, run: gh auth login",
    GH_GLANCE_FIXTURE_FAIL_ON: "issue",
  },
});

const automaticPoll = capture({
  cols: 80,
  rows: 24,
  settle: 12,
  configHome: cachedConfigHome,
});
rmSync(cachedConfigHome, { recursive: true, force: true });

const shortHelp = capture({
  cols: 45,
  rows: 13,
  signal: "none",
  settle: 12,
  stdin: "sleep 3; printf '?'; sleep 2; printf 'q'; sleep 2",
});

test("Fetching colour state tolerates combined and split SGR sequences", () => {
  assert.deepEqual(
    fetchingForegroundStates(
      `${ESC}[96m⣾ Fetching${ESC}[39m${ESC}[2m${ESC}[39m⣾ Fetching${ESC}[0m`,
    ),
    [true, false],
  );
});

test("a timer-driven list failure recovers in the same process", () => {
  const issueCalls = recovered.fixtureCalls.filter((call) => call.startsWith("issue list"));
  assert.ok(issueCalls.length >= 2, `expected a retry, saw ${issueCalls.length} issue calls`);
  assert.match(recovered.finalFrame.lines.join("\n"), /#41 SIGTERM/);
  assert.doesNotMatch(recovered.finalFrame.lines.join("\n"), /temporary network failure/i);
});

test("manual Security refresh bypasses a source auth backoff", () => {
  const dependabotCalls = forcedSecurity.fixtureCalls.filter(
    (call) => call.startsWith("api ") && call.includes("dependabot"),
  );
  assert.ok(
    dependabotCalls.length >= 2,
    `expected one failed and one forced-success call, saw ${dependabotCalls.length}`,
  );
  assert.equal(forcedSecurity.exitCode, 0);
  assert.doesNotMatch(forcedSecurity.finalFrame.lines.join("\n"), /not logged|auth login/i);
});

test("Ink screen-reader rendering has a linear content smoke test", () => {
  const plain = strip(screenReader.raw);
  assert.ok(screenReader.fixtureCalls.some((call) => call.startsWith("run list")));
  assert.match(plain, /success ci: pin actions to commit SHAs/);
  assert.equal(screenReader.exitCode, 143);
});

test("quitting aborts an in-flight open child instead of waiting for it", () => {
  assert.equal(stalledOpen.exitCode, 0);
  assert.equal(
    stalledOpen.fixtureCalls.filter((call) => call.startsWith("run view")).length,
    1,
  );
  assert.ok(stalledElapsedMs < 15_000, `open child kept the app alive for ${stalledElapsedMs} ms`);
});

test("selection stays visible and opens the same item after rows insert above it", () => {
  const frame = insertedAbove.finalFrame.lines.join("\n");
  assert.match(frame, />.*test: terminal lifecycle/);
  assert.ok(
    insertedAbove.fixtureCalls.some((call) => call.startsWith("run view") && call.includes("104")),
    insertedAbove.fixtureCalls.join("\n"),
  );
});

test("NO_COLOR retains an ASCII failure marker in the tab bar", () => {
  assert.match(strip(noColorFailure.raw), /2:Issues x/);
});

test("a narrow auth failure starts with the recovery action", () => {
  assert.match(narrowAuthFailure.finalFrame.lines.join("\n"), /Run: gh auth status/);
});

test("a cache-hydrated tab clears Fetching and settled polls do not re-enter it", () => {
  const runCalls = automaticPoll.fixtureCalls.filter((call) => call.startsWith("run list"));
  assert.ok(runCalls.length >= 2, `expected automatic polls, saw ${runCalls.length}`);
  const firstData = automaticPoll.raw.indexOf("ci: pin actions");
  assert.ok(firstData >= 0, "expected the first successful Actions frame");
  const states = fetchingForegroundStates(automaticPoll.raw.slice(firstData));
  const settledAt = states.indexOf(false);
  assert.ok(settledAt >= 0, "expected loading to clear after the first successful frame");
  assert.equal(states.slice(settledAt).includes(true), false);
});

test("short help keeps essential actions and points to the full reference", () => {
  const frame = shortHelp.finalFrame.lines.join("\n");
  assert.match(frame, /Quit/);
  assert.match(frame, /Refresh/);
  assert.match(frame, /Open the selected/);
  assert.match(frame, /Move the cursor/);
  assert.match(frame, /gh-glance --help/);
});
