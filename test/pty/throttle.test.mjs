import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

import { resourceDecision, resourceReserve } from "../../index.mjs";
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
  return {
    root,
    statePath,
    read: () => JSON.parse(readFileSync(statePath, "utf8")),
    readGovernor: () => {
      const directory = join(root, "gh-glance");
      const name = readdirSync(directory).find((entry) => entry.startsWith("rate-governor-v1-"));
      return JSON.parse(readFileSync(join(directory, name), "utf8"));
    },
  };
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

function capturePanes(count, box, panePrefix, options = {}) {
  return Promise.all(Array.from({ length: count }, (_, index) => captureAsync({
    cols: 70,
    rows: 20,
    ...options,
    configHome: box.root,
    env: {
      ...options.env,
      GH_GLANCE_FIXTURE_STATE: box.statePath,
      GH_GLANCE_FIXTURE_PANE: `${panePrefix}-${index}`,
    },
  })));
}

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

test("the shared fixture recovers an exact dead recovery marker", (t) => {
  const box = fixture(t);
  const recoveryPath = `${box.statePath}.lock.recovery-dead-recovery`;
  writeFileSync(recoveryPath, `${JSON.stringify({
    pid: 99_999_999,
    nonce: "dead-recovery",
  })}\n`, { mode: 0o600 });
  execFileSync(process.execPath, [STATE_HELPER, "--version"], {
    env: { ...process.env, GH_GLANCE_FIXTURE_STATE: box.statePath },
  });
  assert.equal(starts(box.read(), "--version").length, 1);
  assert.equal(existsSync(recoveryPath), false);
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
  await capturePanes(3, box, "reset", {
    cols: 80,
    rows: 24,
    settle: 30,
    args: "--refresh 40",
  });
  const state = box.read();
  const probes = starts(state, "api").filter((event) => event.argv[1] === "rate_limit");
  const runs = starts(state, "run");
  assert.ok(probes.length >= 2, `expected reset probe, got ${probes.length}`);
  assert.equal(runs.length, 3, `expected one active request per pane, got ${runs.length}`);
  assert.equal(new Set(runs.map((event) => event.pane)).size, 3);
  assert.equal(dataStarts(state).length, runs.length, "background work joined the reset phase");
  assert.ok(probes[1].at <= runs[0].at, "data raced the reset publication");
  assert.equal(state.maxDataConcurrency, 1, "reset data requests overlapped");
  for (let index = 1; index < runs.length; index += 1) {
    assert.ok(runs[index].at - runs[index - 1].at >= 1_000, "reset requests were not phased");
  }
});

test("twelve panes share probe ownership and start bounded phased work", async (t) => {
  const box = fixture(t, { delayMs: 40 });
  const setup = box.read();
  const decision = resourceDecision({
    budget: {
      ...setup.core,
      observedAt: setup.createdAt,
      blockUntil: null,
      blockReason: null,
      laneNextAt: setup.createdAt,
      roundRobinCursor: null,
      lastExternalFactor: 1,
      epoch: `${setup.core.limit}:${setup.core.resetMs}`,
    },
    resource: "core",
    nowMs: setup.createdAt,
    cost: 2,
    chargedCost: 0,
  });
  const laneInterval = 2 / decision.callsPerMs;
  await capturePanes(12, box, "pane", {
    // Five seconds of epoch phase plus one paced lane interval can place the
    // second pane just beyond an eight-second process-start observation.
    settle: 12,
  });
  const state = box.read();
  const probes = starts(state, "api").filter((event) => event.argv[1] === "rate_limit");
  const runs = starts(state, "run");
  assert.ok(probes.length >= 1 && probes.length <= 2, `shared probes: ${probes.length}`);
  assert.ok(runs.length >= 1, "no pane progressed");
  assert.ok(new Set(runs.map((event) => event.pane)).size > 1, "round-robin made no progress");
  assert.equal(state.maxDataConcurrency, 1, `data requests overlapped: ${state.maxDataConcurrency}`);
  for (let index = 1; index < runs.length; index += 1) {
    assert.ok(
      runs[index].at - runs[index - 1].at >= laneInterval - 250,
      `data starts escaped lane pacing: ${JSON.stringify(runs.map(({ at, pane }) => ({ at, pane })))}`,
    );
  }
});

test("twelve held panes share one block probe instead of retrying per pane", async (t) => {
  const box = fixture(t, {
    core: { limit: 5000, used: 5000, remaining: 0, resetMs: Date.now() + 3_600_000 },
  });
  await capturePanes(12, box, "held-pane", {
    settle: 8,
  });
  const state = box.read();
  const probes = starts(state, "api").filter((event) => event.argv[1] === "rate_limit");
  assert.ok(probes.length >= 1 && probes.length <= 2, `shared held probes: ${probes.length}`);
  assert.equal(dataStarts(state).length, 0);
});

test("twelve panes preserve one runtime rate-limit block across the minute", async (t) => {
  const setupAt = Date.now();
  const coreLimit = 5000;
  const spendableCalls = 26;
  const coreRemaining = resourceReserve(coreLimit) + spendableCalls;
  const resetMs = setupAt + 120_000;
  const setupDecision = resourceDecision({
    budget: {
      limit: coreLimit,
      remaining: coreRemaining,
      used: coreLimit - coreRemaining,
      resetMs,
      observedAt: setupAt,
      blockUntil: null,
      blockReason: null,
      laneNextAt: setupAt,
      roundRobinCursor: null,
      lastExternalFactor: 1,
      epoch: `${coreLimit}:${resetMs}`,
    },
    resource: "core",
    nowMs: setupAt,
    cost: 2,
    chargedCost: 0,
  });
  assert.equal(coreRemaining - resourceReserve(coreLimit), spendableCalls);
  assert.equal(setupDecision.mode, "open");
  assert.ok(2 / setupDecision.callsPerMs >= 9_000, "setup core lane is too narrow");
  const box = fixture(t, {
    core: {
      limit: coreLimit,
      // Twelve Actions requests demand 24 of the 26 calls above the hard
      // reserve, so this exercises capacity while keeping the initial lane
      // wider than process-start jitter.
      used: coreLimit - coreRemaining,
      remaining: coreRemaining,
      resetMs,
    },
    delayMs: 40,
    failure: {
      selector: "run",
      remaining: 1,
      message: "HTTP 403: API rate limit exceeded",
    },
  });
  let blockObservedAt = null;
  const observer = setInterval(() => {
    try {
      if (box.readGovernor().budgets.core?.blockReason === "rate-limit") {
        blockObservedAt ??= Date.now();
      }
    } catch {
      // The first probe has not created the governor file yet.
    }
  }, 40);
  try {
    await capturePanes(12, box, "blocked-minute", {
      // Leave margin after the shared 60-second probe deadline so process startup
      // cannot turn this into a boundary-timing assertion.
      settle: 75,
    });
  } finally {
    clearInterval(observer);
  }
  const state = box.read();
  const probes = starts(state, "api").filter((event) => event.argv[1] === "rate_limit");
  const coreData = dataStarts(state).filter((event) => event.cost.core > 0);
  const failureEnd = state.events.find((event) => event.type === "end" && event.failed === true);
  const governor = box.readGovernor();
  assert.equal(state.failure.remaining, 0, "the rate-limit response was not injected");
  assert.ok(coreData.length >= 1 && coreData.length <= 2,
    `unbounded initial core starts: ${JSON.stringify(coreData)}`);
  assert.ok(failureEnd, "the injected rate-limit failure never completed");
  assert.ok(Number.isFinite(blockObservedAt), "the shared rate-limit block was never observed");
  assert.ok(failureEnd.at <= blockObservedAt, "the block preceded the injected failure completion");
  assert.ok(coreData.every((event) => event.at < blockObservedAt),
    `core data started after the shared block was classified: ${JSON.stringify(coreData)}`);
  assert.equal(governor.budgets.core.blockReason, "rate-limit");
  assert.ok(governor.budgets.core.blockUntil > Date.now(), "minute probe cleared the live block");
  assert.equal(probes.length, 2, `expected startup and minute probes, got ${probes.length}; ` +
    JSON.stringify({
      createdAt: state.createdAt,
      probeTimes: probes.map(({ at }) => at),
      outcome: governor.probeOutcome,
      core: governor.budgets.core,
    }));
  t.diagnostic(`core starts ${coreData.length}; probes ${probes.length}; ` +
    `failure end ${failureEnd.at}; block observed ${blockObservedAt}; ` +
    `block ${governor.budgets.core.blockReason}`);
});
