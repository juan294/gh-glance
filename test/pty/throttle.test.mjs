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

import {
  GOVERNOR_PHASE_WINDOW_MS,
  resourceDecision,
  resourceReserve,
} from "../../index.mjs";
import { captureAsync } from "./capture.mjs";

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
const actionsRuns = (state) => dataStarts(state)
  .filter((event) => event.argv.some((argument) => argument.includes("/actions/runs?")));
const actionsCalls = (state) => dataStarts(state)
  .filter((event) => event.argv.some((argument) => argument.includes("/actions/")));

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

async function observeUntil(read, predicate, deadlineAt) {
  let value = null;
  while (Date.now() < deadlineAt) {
    try {
      value = read();
      if (predicate(value)) return { matched: true, value };
    } catch {
      // The governor directory and atomic fixture state can be between writes.
    }
    await new Promise((resolve) => setTimeout(resolve, 40));
  }
  return { matched: false, value };
}

function readFixtureLockArtifacts(root) {
  const artifacts = {};
  for (const name of readdirSync(root)) {
    if (!name.startsWith("fixture.json.lock")) continue;
    try {
      artifacts[name] = readFileSync(join(root, name), "utf8");
    } catch {
      artifacts[name] = "(disappeared during inspection)";
    }
  }
  return artifacts;
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

test("manual refresh bursts create one unchanged held-sample probe demand", async (t) => {
  const setupAt = Date.now();
  const box = fixture(t, {
    core: { limit: 5000, used: 5000, remaining: 0, resetMs: Date.now() + 3_600_000 },
  });
  const startupReadyPath = join(box.root, "manual-startup-ready");
  const secondBurstReadyPath = join(box.root, "manual-second-burst-ready");
  const resultPromise = captureAsync({
    cols: 80,
    rows: 24,
    signal: "none",
    settle: 45,
    stdin:
      "i=0; while [ ! -f \"$GH_GLANCE_STARTUP_READY\" ] && [ \"$i\" -lt 300 ]; do " +
      "sleep .1; i=$((i + 1)); done; printf r; sleep .2; printf r; sleep .2; printf r; " +
      "i=0; while [ ! -f \"$GH_GLANCE_SECOND_BURST_READY\" ] && [ \"$i\" -lt 300 ]; do " +
      "sleep .1; i=$((i + 1)); done; printf r; sleep .2; printf r; sleep .2; printf r; " +
      "sleep 1; printf q",
    configHome: box.root,
    env: {
      GH_GLANCE_FIXTURE_STATE: box.statePath,
      GH_GLANCE_FIXTURE_PANE: "held",
      GH_GLANCE_STARTUP_READY: startupReadyPath,
      GH_GLANCE_SECOND_BURST_READY: secondBurstReadyPath,
    },
  });
  const startupPublication = await observeUntil(
    box.readGovernor,
    (governor) => governor?.budgets?.core?.remaining === 0 &&
      governor.budgets.core.observedAt >= setupAt,
    setupAt + 20_000,
  );
  const startupObservedAt = startupPublication.matched
    ? startupPublication.value.budgets.core.observedAt
    : setupAt;
  writeFileSync(startupReadyPath, "ready\n", { mode: 0o600 });
  const manualPublication = await observeUntil(
    box.readGovernor,
    (governor) => governor?.budgets?.core?.remaining === 0 &&
      governor.budgets.core.observedAt > startupObservedAt,
    Date.now() + 20_000,
  );
  writeFileSync(secondBurstReadyPath, "ready\n", { mode: 0o600 });
  const result = await resultPromise;
  const state = box.read();
  const rate = starts(state, "api").filter((event) => event.argv[1] === "rate_limit");
  assert.equal(startupPublication.matched, true, "startup held publication was not observed");
  assert.equal(manualPublication.matched, true, "manual held publication was not observed");
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
  assert.equal(actionsCalls(state).length, 0);
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
  const readyPath = join(box.root, "reset-ready");
  const captures = capturePanes(3, box, "reset", {
    cols: 80,
    rows: 24,
    signal: "none",
    settle: 45,
    args: "--refresh 40",
    stdin:
      "i=0; while [ ! -f \"$GH_GLANCE_FIXTURE_READY\" ] && [ \"$i\" -lt 600 ]; do " +
      "sleep .1; i=$((i + 1)); done; printf q",
    env: { GH_GLANCE_FIXTURE_READY: readyPath },
  });
  const resetProbe = await observeUntil(
    box.read,
    (state) => starts(state, "api").filter((event) => event.argv[1] === "rate_limit").length >= 2,
    Date.now() + 20_000,
  );
  const resetProbeAt = resetProbe.matched
    ? starts(resetProbe.value, "api").filter((event) => event.argv[1] === "rate_limit")[1].at
    : null;
  const publication = Number.isFinite(resetProbeAt)
    ? await observeUntil(
      box.readGovernor,
      (governor) => governor?.budgets?.core?.used === 0 &&
        governor.budgets.core.observedAt >= resetProbeAt,
      Date.now() + 10_000,
    )
    : null;
  const publishedCore = publication?.matched ? publication.value.budgets.core : null;
  const resetDecision = publishedCore && resourceDecision({
    budget: publishedCore,
    resource: "core",
    nowMs: publishedCore.observedAt,
    cost: 2,
    chargedCost: 0,
  });
  const laneInterval = resetDecision?.mode === "open" ? 2 / resetDecision.callsPerMs : null;
  const progressDeadline = Number.isFinite(laneInterval)
    ? publishedCore.observedAt + GOVERNOR_PHASE_WINDOW_MS + 2 * laneInterval + 10_000
    : Date.now();
  const progress = Number.isFinite(laneInterval)
    ? await observeUntil(
      box.read,
      (state) => new Set(actionsRuns(state).map((event) => event.pane)).size >= 3,
      progressDeadline,
    )
    : null;
  const preReleaseGovernor = progress?.matched ? box.readGovernor() : null;
  const plannedReservations = Object.values(preReleaseGovernor?.reservations ?? {})
    .filter((reservation) => reservation.costs.core === 2 && reservation.costs.graphql === 0)
    .sort((left, right) => left.notBefore - right.notBefore);
  writeFileSync(readyPath, "ready\n", { mode: 0o600 });
  await captures;

  const state = box.read();
  const probes = starts(state, "api").filter((event) => event.argv[1] === "rate_limit");
  const runs = actionsRuns(state).sort((left, right) => left.at - right.at);
  const schedulingTolerance = laneInterval * 0.15;
  t.diagnostic(`reset publication ${publishedCore?.observedAt}; ` +
    `slots ${plannedReservations.map(({ notBefore }) => notBefore).join(",")}; ` +
    `starts ${runs.map(({ at }) => at).join(",")}; horizon ${progressDeadline}; ` +
    `lane ${laneInterval}`);
  assert.ok(publication?.matched, "the reset budget publication was not observed");
  assert.equal(resetDecision?.mode, "open", "reset publication did not reopen the core lane");
  assert.equal(progress?.matched, true, `three panes missed the reset horizon ${progressDeadline}`);
  assert.ok(probes.length >= 2, `expected reset probe, got ${probes.length}`);
  assert.equal(runs.length, 3, `expected one active request per pane, got ${runs.length}`);
  assert.equal(new Set(runs.map((event) => event.pane)).size, 3);
  assert.equal(dataStarts(state).length, runs.length * 2, "background work joined the reset phase");
  assert.ok(probes[1].at <= runs[0].at, "data raced the reset publication");
  assert.equal(state.maxDataConcurrency, 1, "governed Actions batches overlapped");
  assert.equal(plannedReservations.length, 3, "reset reservations were not retained before teardown");
  for (let index = 1; index < plannedReservations.length; index += 1) {
    assert.ok(
      plannedReservations[index].notBefore - plannedReservations[index - 1].notBefore >=
        laneInterval - schedulingTolerance,
      `reset slots escaped the ${laneInterval}ms lane: ${JSON.stringify(plannedReservations)}`,
    );
  }
  for (let index = 0; index < runs.length; index += 1) {
    assert.ok(runs[index].at >= plannedReservations[index].notBefore - schedulingTolerance,
      `reset request started before its due slot: ${JSON.stringify({
        run: runs[index],
        reservation: plannedReservations[index],
      })}`);
  }
});

test("twelve panes share probe ownership and start bounded phased work", async (t) => {
  const box = fixture(t, { delayMs: 40 });
  const readyPath = join(box.root, "healthy-ready");
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
  const captures = capturePanes(12, box, "pane", {
    signal: "none",
    settle: 35,
    stdin:
      "i=0; while [ ! -f \"$GH_GLANCE_FIXTURE_READY\" ] && [ \"$i\" -lt 500 ]; do " +
      "sleep .1; i=$((i + 1)); done; printf q",
    env: { GH_GLANCE_FIXTURE_READY: readyPath },
  });

  const publicationResult = await observeUntil(
    box.readGovernor,
    (governor) => Number.isFinite(governor?.budgets?.core?.observedAt),
    Date.now() + 20_000,
  );
  const publication = publicationResult.matched ? publicationResult.value : null;
  const registered = publication
    ? await observeUntil(
      box.readGovernor,
      (governor) => Object.keys(governor?.leases ?? {}).length >= 2,
      Date.now() + 10_000,
    )
    : null;
  const registeredGovernor = registered?.matched ? registered.value : null;
  const registeredAts = Object.values(registeredGovernor?.leases ?? {})
    .map((lease) => lease.phaseSeed.registeredAt)
    .sort((left, right) => left - right);
  const publicationAt = publication?.budgets?.core?.observedAt;
  const phaseAnchor = Math.max(publicationAt ?? Date.now(), registeredAts[1] ?? 0);
  const processStartMarginMs = 3_000;
  const progressHorizonAt = phaseAnchor + GOVERNOR_PHASE_WINDOW_MS + laneInterval +
    processStartMarginMs;
  const progress = publication && registeredGovernor
    ? await observeUntil(
      box.read,
      (state) => new Set(actionsRuns(state).map((event) => event.pane)).size >= 2,
      progressHorizonAt,
    )
    : null;
  const preReleaseState = box.read();
  const fixtureLockArtifacts = readFixtureLockArtifacts(box.root);
  writeFileSync(readyPath, "ready\n", { mode: 0o600 });
  await captures;

  const state = box.read();
  const governor = box.readGovernor();
  const probes = starts(state, "api").filter((event) => event.argv[1] === "rate_limit");
  const runs = actionsRuns(state).sort((left, right) => left.at - right.at);
  t.diagnostic(JSON.stringify({
    publicationAt,
    progressHorizonAt,
    laneInterval,
    progressObserved: Boolean(progress?.matched && new Set(
      actionsRuns(progress.value).map((event) => event.pane),
    ).size >= 2),
    preReleaseActive: preReleaseState.active,
    preReleaseEvents: preReleaseState.events,
    fixtureLockArtifacts,
    probes: probes.map(({ at, pane }) => ({ at, pane })),
    runs: runs.map(({ at, pane }) => ({ at, pane })),
    maxDataConcurrency: state.maxDataConcurrency,
    leases: Object.fromEntries(Object.entries(governor.leases).map(([id, lease]) => [id, {
      registeredAt: lease.phaseSeed.registeredAt,
      activeTab: lease.activeTab,
    }])),
    intents: governor.intents,
    reservations: Object.fromEntries(Object.entries(governor.reservations).map(([id, item]) => [
      id,
      { leaseId: item.leaseId, status: item.status, notBefore: item.notBefore },
    ])),
  }));
  assert.ok(publication, "the shared budget publication was not observed");
  assert.ok(registeredAts.length >= 2, "fewer than two live leases registered after publication");
  assert.ok(probes.length >= 1 && probes.length <= 2, `shared probes: ${probes.length}`);
  assert.ok(runs.length >= 2, "fewer than two panes progressed within the policy horizon");
  assert.ok(new Set(runs.map((event) => event.pane)).size > 1, "round-robin made no progress");
  assert.equal(state.maxDataConcurrency, 1,
    `governed Actions batches overlapped: ${state.maxDataConcurrency}`);
  for (let index = 1; index < runs.length; index += 1) {
    assert.ok(
      runs[index].at - runs[index - 1].at >= laneInterval - 250,
      `data starts escaped lane pacing: ${JSON.stringify(runs.map(({ at, pane }) => ({ at, pane })))}`,
    );
  }
});

test("twelve held panes share one block probe instead of retrying per pane", async (t) => {
  const setupAt = Date.now();
  const box = fixture(t, {
    core: { limit: 5000, used: 5000, remaining: 0, resetMs: Date.now() + 3_600_000 },
  });
  const readyPath = join(box.root, "held-ready");
  const captures = capturePanes(12, box, "held-pane", {
    signal: "none",
    settle: 35,
    stdin:
      "i=0; while [ ! -f \"$GH_GLANCE_FIXTURE_READY\" ] && [ \"$i\" -lt 350 ]; do " +
      "sleep .1; i=$((i + 1)); done; printf q",
    env: { GH_GLANCE_FIXTURE_READY: readyPath },
  });
  const publicationResult = await observeUntil(
    box.readGovernor,
    (governor) => governor?.budgets?.core?.remaining === 0 &&
      Number.isFinite(governor.budgets.core.observedAt),
    setupAt + 20_000,
  );
  const publicationAt = publicationResult.matched
    ? publicationResult.value.budgets.core.observedAt
    : setupAt + 20_000;
  const releaseAt = Math.min(
    publicationAt + GOVERNOR_PHASE_WINDOW_MS + 3_000,
    setupAt + 30_000,
  );
  await new Promise((resolve) => setTimeout(resolve, Math.max(0, releaseAt - Date.now())));
  writeFileSync(readyPath, "ready\n", { mode: 0o600 });
  await captures;
  const state = box.read();
  const governor = box.readGovernor();
  const probes = starts(state, "api").filter((event) => event.argv[1] === "rate_limit");
  assert.equal(publicationResult.matched, true, "the shared held publication missed its readiness bound");
  assert.ok(probes.length >= 1 && probes.length <= 2, `shared held probes: ${probes.length}`);
  assert.equal(dataStarts(state).length, 0);
  assert.equal(governor.budgets.core.remaining, 0, "the published core lane was not held");
});

test("twelve panes preserve one runtime rate-limit block across the minute", async (t) => {
  const setupAt = Date.now();
  const readyPath = join(tmpdir(), `gh-glance-block-ready-${process.pid}-${setupAt}`);
  t.after(() => rmSync(readyPath, { force: true }));
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
      selector: "actions",
      remaining: 1,
      message: "HTTP 403: API rate limit exceeded",
    },
  });
  const captures = capturePanes(12, box, "blocked-minute", {
    signal: "none",
    settle: 90,
    stdin:
      "i=0; while [ ! -f \"$GH_GLANCE_FIXTURE_READY\" ] && [ \"$i\" -lt 1000 ]; do " +
      "sleep .1; i=$((i + 1)); done; printf q",
    env: { GH_GLANCE_FIXTURE_READY: readyPath },
  });
  const startupOuterDeadline = setupAt + 40_000;
  const publicationResult = await observeUntil(
    box.readGovernor,
    (governor) => Number.isFinite(governor?.budgets?.core?.observedAt),
    startupOuterDeadline,
  );
  const publicationGovernor = publicationResult.matched ? publicationResult.value : null;
  const publicationAt = publicationGovernor?.budgets?.core?.observedAt;
  const registeredResult = publicationGovernor
    ? await observeUntil(
      box.readGovernor,
      (governor) => Object.values(governor?.reservations ?? {}).some((reservation) =>
        reservation?.costs?.core > 0 &&
        Number.isFinite(governor?.leases?.[reservation.leaseId]?.phaseSeed?.registeredAt)),
      startupOuterDeadline,
    )
    : null;
  const registeredGovernor = registeredResult?.matched ? registeredResult.value : null;
  const relevantReservation = Object.values(registeredGovernor?.reservations ?? {})
    .filter((reservation) => reservation?.costs?.core > 0)
    .sort((left, right) => left.notBefore - right.notBefore)[0];
  const registeredAt = registeredGovernor?.leases?.[relevantReservation?.leaseId]
    ?.phaseSeed?.registeredAt;
  const firstDecision = publicationGovernor && resourceDecision({
    budget: publicationGovernor.budgets.core,
    resource: "core",
    nowMs: publicationAt,
    cost: relevantReservation?.costs?.core ?? 2,
    chargedCost: 0,
  });
  const firstLaneInterval = firstDecision?.mode === "open"
    ? (relevantReservation?.costs?.core ?? 2) / firstDecision.callsPerMs
    : null;
  const processStartMarginMs = 3_000;
  const firstStartHorizon = Number.isFinite(publicationAt) && Number.isFinite(registeredAt) &&
    Number.isFinite(firstLaneInterval)
    ? Math.max(publicationAt, registeredAt) + GOVERNOR_PHASE_WINDOW_MS + firstLaneInterval +
      processStartMarginMs
    : startupOuterDeadline;
  const blockResult = await observeUntil(
    box.readGovernor,
    (governor) => governor?.budgets?.core?.blockReason === "rate-limit" &&
      Number.isFinite(governor?.probeOutcome?.nextAt),
    Math.min(firstStartHorizon, startupOuterDeadline),
  );
  const blockedGovernor = blockResult.matched ? blockResult.value : null;
  const blockObservedAt = blockResult.matched ? Date.now() : null;
  const initialProbeNextAt = blockedGovernor?.probeOutcome?.nextAt;
  const boundedDeadline = Math.min(
    Number.isFinite(initialProbeNextAt) ? initialProbeNextAt + 15_000 : setupAt + 20_000,
    setupAt + 95_000,
  );
  const secondProbe = blockedGovernor
    ? await observeUntil(
      box.read,
      (state) => starts(state, "api").filter((event) => event.argv[1] === "rate_limit").length >= 2,
      boundedDeadline,
    )
    : null;
  try {
    writeFileSync(readyPath, "ready\n", { mode: 0o600 });
    await captures;
  } finally {
    rmSync(readyPath, { force: true });
  }
  const state = box.read();
  const probes = starts(state, "api").filter((event) => event.argv[1] === "rate_limit");
  const coreData = dataStarts(state).filter((event) => event.cost.core > 0);
  const failureEnd = state.events.find((event) => event.type === "end" && event.failed === true);
  const governor = box.readGovernor();
  t.diagnostic(`core starts ${coreData.length}; probes ${probes.length}; ` +
    `publication ${publicationAt}; registered ${registeredAt}; ` +
    `first horizon ${firstStartHorizon}; first lane ${firstLaneInterval}; ` +
    `failure end ${failureEnd?.at}; block observed ${blockObservedAt}; ` +
    `next probe ${initialProbeNextAt}; deadline ${boundedDeadline}; ` +
    `block ${governor.budgets.core.blockReason}`);
  assert.ok(publicationResult.matched, "the startup core publication was not observed");
  assert.ok(registeredResult?.matched, "no core reservation registered with a live lease");
  assert.equal(firstDecision?.mode, "open", "the published core lane was not spendable");
  assert.ok(Number.isFinite(firstLaneInterval), "the first core lane interval was unavailable");
  assert.equal(state.failure.remaining, 0, "the rate-limit response was not injected");
  assert.ok(coreData.length >= 1 && coreData.length <= 2,
    `unbounded initial core starts: ${JSON.stringify(coreData)}`);
  assert.ok(failureEnd, "the injected rate-limit failure never completed");
  assert.ok(Number.isFinite(blockObservedAt), "the shared rate-limit block was never observed");
  assert.ok(Number.isFinite(initialProbeNextAt), "the startup probe did not publish its next wake");
  assert.equal(secondProbe?.matched, true, `the shared minute probe missed ${boundedDeadline}`);
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
  assert.ok(probes[1].at - probes[0].at >= 59_500,
    `shared probe retried before one minute: ${JSON.stringify(probes)}`);
});
