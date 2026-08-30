// Last-known-good cache behavior across real process boundaries.
//
// One caller-owned config root is shared by four PTY captures: a healthy run
// writes the cache, the same target restarts while every GitHub data call is
// rate-limited, Security proves blind refreshes preserve known alerts, and a
// different target proves entries never cross repositories.

import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { capture } from "./capture.mjs";

const configHome = mkdtempSync(join(tmpdir(), "gh-glance-pty-cache-"));
const cachePath = join(configHome, "gh-glance", "dashboard-cache.json");
const rateLimited = {
  GH_GLANCE_FIXTURE_FAIL: "HTTP 403: API rate limit exceeded",
  GH_GLANCE_FIXTURE_FAIL_ON: "run,issue,pr,api-data",
};

function quitAfterCached(tab) {
  return "tries=0; while ! grep -q '\"" + tab + "\"' " +
    '"$XDG_CONFIG_HOME/gh-glance/dashboard-cache.json" 2>/dev/null; do ' +
    'tries=$((tries + 1)); if [ "$tries" -ge 200 ]; then printf q; exit 0; fi; ' +
    "sleep .1; done; printf q";
}

let warm;
let warmSecurity;
let recovered;
let securityRecovered;
let isolated;
try {
  warm = capture({
    cols: 80,
    rows: 24,
    signal: "none",
    settle: 20,
    stdin: quitAfterCached("actions"),
    args: "--repo acme/widget",
    env: { GH_GLANCE_FIXTURE_SECURITY_ALERTS: "1" },
    configHome,
  });
  warmSecurity = capture({
    cols: 80,
    rows: 24,
    signal: "none",
    settle: 20,
    stdin: quitAfterCached("security"),
    args: "--repo acme/widget --tab security",
    env: { GH_GLANCE_FIXTURE_SECURITY_ALERTS: "1" },
    configHome,
  });

  // Make staleness deterministic without a 30-second sleep. This is the same
  // versioned file the first real process wrote; only its success clocks move.
  const document = JSON.parse(readFileSync(cachePath, "utf8"));
  const old = Date.now() - 120_000;
  for (const entry of Object.values(document.targets)) {
    entry.updatedAt = old;
    for (const tab of Object.values(entry.tabs)) {
      tab.lastOk = old;
      tab.meta.at = old;
    }
  }
  writeFileSync(cachePath, `${JSON.stringify(document, null, 2)}\n`, "utf8");

  recovered = capture({
    cols: 80,
    rows: 24,
    settle: 12,
    args: "--repo acme/widget",
    env: { ...rateLimited, GH_GLANCE_FIXTURE_RATE_REMAINING: "1000" },
    configHome,
  });
  securityRecovered = capture({
    cols: 80,
    rows: 24,
    settle: 7,
    args: "--repo acme/widget --tab security",
    env: rateLimited,
    configHome,
  });
  isolated = capture({
    cols: 80,
    rows: 24,
    settle: 4,
    args: "--repo acme/other",
    env: rateLimited,
    configHome,
  });
} finally {
  // This exact directory came from the mkdtempSync call above.
  rmSync(configHome, { recursive: true, force: true });
}

const screenOf = (result) => result.finalFrame.lines.join("\n");
const assertTerminalContract = (result) => {
  assert.equal(result.finalFrame.lines.length, 23);
  assert.ok(result.finalFrame.widest <= 80);
  assert.equal(result.liveScreen.lines.at(-1), "");
  assert.equal(result.liveScreen.maxStatusLines, 1);
  assert.equal(result.altEnter, 1);
  assert.equal(result.altExit, 1);
  assert.equal(result.afterRestore.hasScrollbackErase, false);
  assert.equal(result.afterRestore.hasClear, false);
  assert.equal(result.afterRestore.visible, "");
};

test("a healthy process writes dashboard state for restart", () => {
  assert.ok(warm.fixtureCalls.some((call) => call.includes("/actions/runs?")));
  assert.match(screenOf(warm), /ci: pin actions to commit/);
});

test("same-target restart keeps stale Actions rows under a live rate-limit error", () => {
  const screen = screenOf(recovered);
  assert.ok(recovered.fixtureCalls.some((call) => call.includes("/actions/runs?")));
  assert.match(screen, /GitHub rate limit reached -- backing off/);
  assert.match(screen, /stale 2m/);
  assert.match(screen, /ci: pin actions to commit/);
  assert.match(screen, /4 of 4/);
  assert.match(screen, /‖ Paused.*stale 2m/);
  assert.doesNotMatch(screen, /reset \S+/);
  const pausedAt = recovered.liveScreen.statusHistory.findLastIndex((line) => / Paused(?:\s|$)/.test(line));
  assert.ok(pausedAt >= 0, recovered.liveScreen.statusHistory.join(" -> "));
  assert.equal(
    recovered.liveScreen.statusHistory.slice(pausedAt + 1)
      .some((line) => / Checking(?:\s|$)/.test(line)),
    false,
  );
  assertTerminalContract(recovered);
});

test("a blind Security refresh preserves cached alerts", () => {
  assert.ok(warmSecurity.fixtureCalls.some((call) => call.includes("dependabot")));
  const screen = screenOf(securityRecovered);
  assert.match(screen, /cached dependency alert/);
  assert.match(screen, /Security \(1\)/);
  assert.equal(
    securityRecovered.fixtureCalls.some((call) => call.includes("dependabot")),
    false,
    "a shared core hold launched a Security data call",
  );
  assertTerminalContract(securityRecovered);
});

test("a different repository target never receives cached rows", () => {
  const screen = screenOf(isolated);
  assert.match(screen, /waiting for API budget/);
  assert.doesNotMatch(screen, /ci: pin actions to commit/);
  assert.doesNotMatch(screen, /4 of 4/);
  assertTerminalContract(isolated);
});
