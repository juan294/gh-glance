import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { test } from "node:test";

import { capture, captureAsync } from "./capture.mjs";

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

test("core zero probes before data and manual refresh cannot bypass the hold", (t) => {
  const box = fixture(t, {
    core: { limit: 5000, used: 5000, remaining: 0, resetMs: Date.now() + 3_600_000 },
  });
  const result = capture({
    cols: 80,
    rows: 24,
    signal: "none",
    settle: 5,
    stdin: "sleep 2; printf r; sleep 2; printf q",
    configHome: box.root,
    env: { GH_GLANCE_FIXTURE_STATE: box.statePath, GH_GLANCE_FIXTURE_PANE: "held" },
  });
  const state = box.read();
  const rate = starts(state, "api").filter((event) => event.argv[1] === "rate_limit");
  assert.ok(rate.length >= 1, "startup did not probe");
  assert.equal(dataStarts(state).length, 0, "manual refresh crossed the core hold");
  assert.equal(result.exitCode, 0);
});

test("a held core resource leaves GraphQL tabs usable", (t) => {
  const box = fixture(t, {
    core: { limit: 5000, used: 5000, remaining: 0, resetMs: Date.now() + 3_600_000 },
  });
  capture({
    cols: 80,
    rows: 24,
    settle: 7,
    args: "--tab issues",
    configHome: box.root,
    env: { GH_GLANCE_FIXTURE_STATE: box.statePath, GH_GLANCE_FIXTURE_PANE: "graphql" },
  });
  const state = box.read();
  assert.equal(starts(state, "run").length, 0);
  assert.ok(starts(state, "issue").length >= 1, "GraphQL active tab did not progress");
});

test("a real reset gets one fresh probe before phased work resumes", (t) => {
  const box = fixture(t, {
    anchorAtFirstProbe: true,
    createdAt: null,
    core: { limit: 5000, used: 5000, remaining: 0, resetMs: 0, resetOffsetMs: 1_000 },
    resetSequence: [{
      offsetMs: 2_000,
      core: { used: 0, remaining: 5000, resetOffsetMs: 3_602_000 },
    }],
  });
  capture({
    cols: 80,
    rows: 24,
    settle: 9,
    configHome: box.root,
    env: { GH_GLANCE_FIXTURE_STATE: box.statePath, GH_GLANCE_FIXTURE_PANE: "reset" },
  });
  const state = box.read();
  const probes = starts(state, "api").filter((event) => event.argv[1] === "rate_limit");
  const runs = starts(state, "run");
  assert.ok(probes.length >= 2, `expected reset probe, got ${probes.length}`);
  assert.ok(runs.length >= 1, "active work did not resume after reset");
  assert.ok(probes[1].at <= runs[0].at, "data raced the reset publication");
});

test("twelve panes share probe ownership and start bounded phased work", async (t) => {
  const box = fixture(t, { delayMs: 40 });
  await Promise.all(Array.from({ length: 12 }, (_, index) => captureAsync({
    cols: 70,
    rows: 20,
    settle: 8,
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
