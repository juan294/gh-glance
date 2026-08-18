import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

import { capture, captureAsync } from "./capture.mjs";

const STATE_HELPER = join(dirname(fileURLToPath(import.meta.url)), "fixtures", "gh-state.mjs");

function fixture(t, overrides = {}) {
  const root = mkdtempSync(join(tmpdir(), "gh-glance-shared-pty-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const now = Date.now();
  const statePath = join(root, "fixture.json");
  const state = {
    createdAt: now,
    core: { limit: 5000, used: 0, remaining: 5000, resetMs: now + 3_600_000 },
    graphql: { limit: 5000, used: 0, remaining: 5000, resetMs: now + 3_600_000 },
    events: [],
    ...overrides,
  };
  writeFileSync(statePath, `${JSON.stringify(state)}\n`, { mode: 0o600 });
  return { root, statePath, read: () => JSON.parse(readFileSync(statePath, "utf8")) };
}

const starts = (state, command) => state.events.filter(
  (event) => event.type === "start" && event.argv[0] === command,
);
const dataStarts = (state) => state.events.filter((event) =>
  event.type === "start" && (
    ["run", "issue", "pr"].includes(event.argv[0]) ||
    event.argv[0] === "api" && event.argv[1] !== "rate_limit"
  ),
);

test("the shared fixture recovers a dead private lock without using governor state", (t) => {
  const box = fixture(t);
  const lockPath = `${box.statePath}.lock`;
  writeFileSync(lockPath, `${JSON.stringify({ pid: 99_999_999, nonce: "dead-owner" })}\n`, {
    mode: 0o600,
  });
  execFileSync(process.execPath, [STATE_HELPER, "--version"], {
    env: { ...process.env, GH_GLANCE_FIXTURE_STATE: box.statePath },
  });
  assert.equal(starts(box.read(), "--version").length, 1);
  assert.equal(existsSync(lockPath), false);
  assert.equal(statSync(box.statePath).mode & 0o777, 0o600);
});

test("manual refresh bursts create one unchanged held-sample probe demand", (t) => {
  const box = fixture(t, {
    core: { limit: 5000, used: 5000, remaining: 0, resetMs: Date.now() + 3_600_000 },
  });
  const result = capture({
    cols: 80,
    rows: 24,
    signal: "none",
    settle: 7,
    stdin:
      "sleep 2; printf r; sleep .2; printf r; sleep .2; printf r; " +
      "sleep 2; printf r; sleep .2; printf r; sleep .2; printf r; sleep 1; printf q",
    configHome: box.root,
    env: { GH_GLANCE_FIXTURE_STATE: box.statePath, GH_GLANCE_FIXTURE_PANE: "held" },
  });
  const state = box.read();
  const rate = starts(state, "api").filter((event) => event.argv[1] === "rate_limit");
  assert.equal(rate.length, 2, `expected startup plus one manual probe, got ${rate.length}`);
  assert.equal(dataStarts(state).length, 0, "manual refresh crossed the core hold");
  assert.equal(result.exitCode, 0);
});

test("a held core resource leaves both GraphQL tabs usable", async (t) => {
  const box = fixture(t, {
    core: { limit: 5000, used: 5000, remaining: 0, resetMs: Date.now() + 3_600_000 },
  });
  await Promise.all(["issues", "prs"].map((tab) => captureAsync({
    cols: 80,
    rows: 24,
    settle: 10,
    args: `--tab ${tab}`,
    configHome: box.root,
    env: { GH_GLANCE_FIXTURE_STATE: box.statePath, GH_GLANCE_FIXTURE_PANE: tab },
  })));
  const state = box.read();
  assert.equal(starts(state, "run").length, 0);
  assert.ok(starts(state, "issue").length >= 1, "Issues did not progress");
  assert.ok(starts(state, "pr").length >= 1, "pull requests did not progress");
});

test("a real reset gets one fresh probe then one phased active request per pane", async (t) => {
  const box = fixture(t, {
    anchorAtFirstProbe: true,
    createdAt: null,
    core: { limit: 5000, used: 5000, remaining: 0, resetMs: 0, resetOffsetMs: 1_000 },
    resetSequence: [{
      offsetMs: 2_000,
      core: { used: 0, remaining: 5000, resetOffsetMs: 3_602_000 },
    }],
  });
  await Promise.all(Array.from({ length: 3 }, (_, index) => captureAsync({
    cols: 80,
    rows: 24,
    settle: 30,
    args: "--refresh 40",
    configHome: box.root,
    env: { GH_GLANCE_FIXTURE_STATE: box.statePath, GH_GLANCE_FIXTURE_PANE: `reset-${index}` },
  })));
  const state = box.read();
  const probes = starts(state, "api").filter((event) => event.argv[1] === "rate_limit");
  const runs = starts(state, "run");
  assert.ok(probes.length >= 2, `expected reset probe, got ${probes.length}`);
  assert.equal(runs.length, 3, `expected one active request per pane, got ${runs.length}`);
  assert.equal(new Set(runs.map((event) => event.pane)).size, 3);
  assert.equal(dataStarts(state).length, runs.length, "background work joined the reset phase");
  assert.ok(probes[1].at <= runs[0].at, "data raced the reset publication");
});

test("twelve panes share probe ownership and start bounded phased work", async (t) => {
  const box = fixture(t, { delayMs: 40 });
  await Promise.all(Array.from({ length: 12 }, (_, index) => captureAsync({
    cols: 70,
    rows: 20,
    // Five seconds of epoch phase plus one paced lane interval can place the
    // second pane just beyond an eight-second process-start observation.
    settle: 12,
    configHome: box.root,
    env: {
      GH_GLANCE_FIXTURE_STATE: box.statePath,
      GH_GLANCE_FIXTURE_PANE: `pane-${index}`,
    },
  })));
  const state = box.read();
  const probes = starts(state, "api").filter((event) => event.argv[1] === "rate_limit");
  const runs = starts(state, "run");
  assert.ok(probes.length >= 1 && probes.length <= 2, `shared probes: ${probes.length}`);
  assert.ok(runs.length >= 1, "no pane progressed");
  assert.ok(new Set(runs.map((event) => event.pane)).size > 1, "round-robin made no progress");
  assert.ok(state.maxConcurrency <= 12, `unbounded fixture concurrency: ${state.maxConcurrency}`);
});

test("twelve held panes share one block probe instead of retrying per pane", async (t) => {
  const box = fixture(t, {
    core: { limit: 5000, used: 5000, remaining: 0, resetMs: Date.now() + 3_600_000 },
  });
  await Promise.all(Array.from({ length: 12 }, (_, index) => captureAsync({
    cols: 70,
    rows: 20,
    settle: 8,
    configHome: box.root,
    env: {
      GH_GLANCE_FIXTURE_STATE: box.statePath,
      GH_GLANCE_FIXTURE_PANE: `held-pane-${index}`,
    },
  })));
  const state = box.read();
  const probes = starts(state, "api").filter((event) => event.argv[1] === "rate_limit");
  assert.ok(probes.length >= 1 && probes.length <= 2, `shared held probes: ${probes.length}`);
  assert.equal(dataStarts(state).length, 0);
});
