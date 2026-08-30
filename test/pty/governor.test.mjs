import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import {
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

import { resourceReserve } from "../../index.mjs";
import { captureAsync } from "./capture.mjs";

const STATE_HELPER = join(dirname(fileURLToPath(import.meta.url)), "fixtures", "gh-state.mjs");
const LIMIT = 10_000;
const WINDOW_MS = 600_000;
const CAPTURE_ARGS = "--repo acme/widget --refresh 40";

function fixture(t, overrides = {}) {
  const root = mkdtempSync(join(tmpdir(), "gh-glance-governor-pty-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const now = Date.now();
  const statePath = join(root, "fixture.json");
  const state = {
    createdAt: now,
    core: { limit: LIMIT, used: 0, remaining: LIMIT, resetMs: now + WINDOW_MS },
    graphql: { limit: LIMIT, used: 0, remaining: LIMIT, resetMs: now + WINDOW_MS },
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

function starts(state, predicate) {
  return state.events.filter((event) => event.type === "start" && predicate(event));
}

function probes(state) {
  return starts(state, (event) => event.argv[0] === "api" && event.argv[1] === "rate_limit");
}

function dataStarts(state) {
  return starts(state, (event) =>
    ["run", "issue", "pr"].includes(event.argv[0]) ||
    event.argv[0] === "api" && event.argv[1] !== "rate_limit" && !event.argv.includes("user"));
}

function isActionsEndpoint(event) {
  return event.argv[0] === "api" &&
    event.argv.some((argument) => argument.includes("/actions/"));
}

function actionsRuns(state) {
  return dataStarts(state)
    .filter((event) => event.argv.some((argument) => argument.includes("/actions/runs?")));
}

async function observeUntil(read, predicate, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  let lastValue;
  while (Date.now() < deadline) {
    try {
      const value = read();
      lastValue = value;
      if (predicate(value)) return value;
    } catch {
      // The first governor write and fixture atomic renames are transiently absent.
    }
    await new Promise((resolve) => setTimeout(resolve, 40));
  }
  throw new Error(
    `timed out after ${timeoutMs}ms waiting for governor PTY evidence: ${JSON.stringify(lastValue)}`,
  );
}

function readyInput(path, attempts = 1_000) {
  return `i=0; while [ ! -f "${path}" ] && [ "$i" -lt ${attempts} ]; do ` +
    "sleep .05; i=$((i + 1)); done; printf q";
}

function startPane(box, pane, {
  tab = "actions",
  readyPath,
  readyAttempts = 1_000,
  settle = 45,
  stdin = null,
  animation = false,
  env = {},
} = {}) {
  return captureAsync({
    cols: 70,
    rows: 20,
    signal: "none",
    settle,
    stdin: stdin ?? (readyPath ? readyInput(readyPath, readyAttempts) : "sleep 120"),
    args: `${CAPTURE_ARGS} --tab ${tab}`,
    animation,
    configHome: box.root,
    env: {
      GH_GLANCE_FIXTURE_STATE: box.statePath,
      GH_GLANCE_FIXTURE_PANE: pane,
      ...env,
    },
  });
}

async function releasePanes(readyPath, captures) {
  writeFileSync(readyPath, "ready\n", { mode: 0o600 });
  const settled = await Promise.allSettled(captures);
  const failures = settled.filter((item) => item.status === "rejected");
  assert.equal(failures.length, 0, failures.map((item) => item.reason?.message).join("\n"));
  return settled.map((item) => item.value);
}

function assertDebitsStayOutsideReserve(events) {
  for (const event of events) {
    for (const resource of ["core", "graphql"]) {
      if ((event.cost?.[resource] ?? 0) === 0) continue;
      const before = event.before[resource];
      const after = event.after[resource];
      assert.equal(before.remaining - after.remaining, event.cost[resource]);
      assert.equal(after.used - before.used, event.cost[resource]);
      assert.ok(
        after.remaining >= resourceReserve(after.limit),
        `${resource} crossed reserve in ${JSON.stringify(event)}`,
      );
    }
  }
}

function reservationSlots(governor, resource) {
  const epoch = governor.epochs[resource];
  return Object.values(governor.reservations)
    .filter((reservation) =>
      reservation.epochs?.[resource] === epoch && reservation.costs?.[resource] > 0)
    .map((reservation) => reservation.notBefore)
    .sort((left, right) => left - right);
}

function reservationHorizon(governor, resource) {
  const lastNotBefore = reservationSlots(governor, resource).at(-1);
  assert.ok(Number.isFinite(lastNotBefore), `missing ${resource} reservation horizon`);
  return Math.max(20_000, lastNotBefore - Date.now() + 20_000);
}

function assertPhasedStarts(governor, events, resource, expected, label) {
  const slots = reservationSlots(governor, resource);
  const actual = events
    .filter((event) => event.cost?.[resource] > 0)
    .map((event) => event.at)
    .sort((left, right) => left - right);
  assert.equal(slots.length, expected, `${label} persisted ${slots.length} slots`);
  assert.equal(actual.length, expected, `${label} observed ${actual.length} starts`);
  for (let index = 0; index < expected; index += 1) {
    assert.ok(actual[index] >= slots[index], `${label} start ${index} preceded its persisted slot`);
  }
  const plannedSpan = slots.at(-1) - slots[0];
  const actualSpan = actual.at(-1) - actual[0];
  assert.ok(plannedSpan > 0, `${label} persisted no phase or lane spacing`);
  assert.ok(
    actualSpan >= Math.min(250, plannedSpan / 4),
    `${label} starts collapsed into ${actualSpan}ms for a ${plannedSpan}ms slot span`,
  );
}

function killRecordedProcess(event) {
  assert.ok(Number.isSafeInteger(event?.ownerPid) && event.ownerPid > 1);
  assert.notEqual(event.ownerPid, process.pid);
  for (const pid of [event.ownerPid, event.pid]) {
    try { process.kill(pid, "SIGKILL"); } catch (error) {
      if (error?.code !== "ESRCH") throw error;
    }
  }
}

test("twelve real panes share one startup probe and every active pane progresses safely", async (t) => {
  const box = fixture(t, { delayMs: 20 });
  const readyPath = join(box.root, "startup-ready");
  const captures = Array.from({ length: 12 }, (_, index) =>
    startPane(box, `startup-${index}`, { readyPath }));

  let progress;
  let startupGovernor;
  try {
    const scheduled = await observeUntil(
      () => ({ fixture: box.read(), governor: box.readGovernor() }),
      ({ governor }) => reservationSlots(governor, "core").length === 12,
      30_000,
    );
    startupGovernor = scheduled.governor;
    progress = await observeUntil(
      box.read,
      (state) => dataStarts(state).length >= 24 &&
        new Set(dataStarts(state).map((event) => event.pane)).size === 12,
      reservationHorizon(startupGovernor, "core"),
    );
  } finally {
    await releasePanes(readyPath, captures);
  }

  const data = dataStarts(progress);
  assert.equal(probes(progress).length, 1, `startup probes: ${JSON.stringify(probes(progress))}`);
  assert.equal(data.length, 24, "startup launched background or duplicate data work");
  assert.equal(new Set(data.map((event) => event.pane)).size, 12);
  assert.ok(data.every(isActionsEndpoint), "a non-active tab ran at startup");
  assertDebitsStayOutsideReserve(data);
  assertPhasedStarts(startupGovernor, actionsRuns(progress), "core", 12, "startup");
});

test("twelve mixed active panes pace core and GraphQL without consuming either reserve", async (t) => {
  const box = fixture(t, { delayMs: 20 });
  const readyPath = join(box.root, "mixed-ready");
  const tabs = ["actions", "issues", "prs", "security"];
  const captures = [startPane(box, "mixed-actions-0", { readyPath })];

  let progress;
  try {
    await observeUntil(box.read, (state) => probes(state).length === 1, 10_000);
    captures.push(...Array.from({ length: 11 }, (_, offset) => {
      const index = offset + 1;
      const tab = tabs[index % tabs.length];
      return startPane(box, `mixed-${tab}-${index}`, { tab, readyPath });
    }));
    progress = await observeUntil(
      box.read,
      (state) => new Set(dataStarts(state).map((event) => event.pane)).size === 12,
      30_000,
    );
  } finally {
    await releasePanes(readyPath, captures);
  }

  const data = dataStarts(progress);
  const seen = new Set(data.map((event) => event.pane));
  assert.equal(seen.size, 12);
  assert.ok(data.some((event) => event.cost.core > 0));
  assert.ok(data.some((event) => event.cost.graphql > 0));
  for (const event of data) {
    if (event.pane.includes("-actions-")) assert.ok(isActionsEndpoint(event));
    if (event.pane.includes("-issues-")) assert.equal(event.argv[0], "issue");
    if (event.pane.includes("-prs-")) assert.equal(event.argv[0], "pr");
    if (event.pane.includes("-security-")) assert.equal(event.argv[0], "api");
  }
  assertDebitsStayOutsideReserve(data);
});

test("manual refresh wins a held lane without stacking repeated requests", { timeout: 60_000 }, async (t) => {
  const box = fixture(t, {
    anchorAtFirstProbe: true,
    createdAt: null,
    core: { limit: LIMIT, used: LIMIT, remaining: 0, resetMs: 0, resetOffsetMs: 10_000 },
    resetSequence: [{
      offsetMs: 10_500,
      core: { used: 0, remaining: LIMIT, resetOffsetMs: WINDOW_MS },
    }],
    delayByCommand: { actions: 800 },
  });
  const competitorReady = join(box.root, "manual-competitor-ready");
  const manualInput =
    "i=0; while ! grep -Eq 'Watching (next|probing)' \"$GH_GLANCE_CAPTURE_OUT\" 2>/dev/null && [ $i -lt 150 ]; " +
    "do i=$((i + 1)); sleep .1; done; " +
    "i=0; while [ $i -lt 8 ]; do printf r; i=$((i + 1)); sleep .03; done; " +
    "i=0; while ! grep -Fq '\"pane\":\"manual\",\"argv\":[\"api\",\"-i\",\"repos/acme/widget/actions/runs?' " +
    "\"$GH_GLANCE_FIXTURE_STATE\" 2>/dev/null && [ $i -lt 300 ]; " +
    "do i=$((i + 1)); sleep .1; done; sleep .5; printf q";
  const captures = [startPane(box, "manual", {
    stdin: manualInput,
    animation: true,
    settle: 40,
    env: { GH_GLANCE_CAPTURE_LIVE_FLUSH: "1" },
  })];

  let held;
  let progress;
  let results;
  try {
    await observeUntil(
      box.readGovernor,
      (governor) => Object.values(governor.intents ?? {})
        .some((intent) => intent.priority === "manual"),
      15_000,
    );
    captures.push(startPane(box, "competitor", { readyPath: competitorReady, settle: 40 }));
    held = await observeUntil(
      box.readGovernor,
      (governor) => {
        const priorities = Object.values(governor.intents ?? {}).map((intent) => intent.priority);
        return priorities.length === 2 && priorities.includes("manual") &&
          priorities.some((priority) => priority !== "manual");
      },
      10_000,
    );
    progress = await observeUntil(
      box.read,
      (state) => new Set(dataStarts(state).map((event) => event.pane)).size === 2,
      30_000,
    );
  } finally {
    results = await releasePanes(competitorReady, captures);
  }

  assert.equal(Object.values(held.intents).filter((intent) => intent.priority === "manual").length, 1);
  const runs = actionsRuns(progress);
  assert.equal(runs.filter((event) => event.pane === "manual").length, 1);
  assert.equal(runs.filter((event) => event.pane === "competitor").length, 1);
  assert.equal(runs[0].pane, "manual", "lower-priority work started before manual refresh");
  const manualResult = results[0];
  const statuses = manualResult.liveScreen.statusHistory;
  const scheduledAt = statuses.findIndex((status) => / Watching (?:next|probing)(?:\s|$)/.test(status));
  const checkingAt = statuses.findIndex((status, index) =>
    index > scheduledAt && / Checking(?:\s|$)/.test(status));
  assert.ok(scheduledAt >= 0, statuses.join(" -> "));
  assert.ok(checkingAt > scheduledAt, statuses.join(" -> "));
  assertDebitsStayOutsideReserve(runs);
});

test("twelve exhausted core panes share one visible hold and make no REST data calls", async (t) => {
  const box = fixture(t, {
    core: { limit: LIMIT, used: LIMIT, remaining: 0, resetMs: Date.now() + WINDOW_MS },
  });
  const readyPath = join(box.root, "exhausted-ready");
  const captures = [startPane(box, "exhausted-0", { readyPath })];

  let publication;
  let results;
  try {
    publication = await observeUntil(
      box.readGovernor,
      (governor) => governor?.probeOutcome?.status === "healthy" &&
        governor?.budgets?.core?.remaining === 0,
      10_000,
    );
    captures.push(...Array.from({ length: 11 }, (_, offset) =>
      startPane(box, `exhausted-${offset + 1}`, { readyPath })));
    await observeUntil(
      box.readGovernor,
      (governor) => Object.keys(governor.leases ?? {}).length === 12,
      15_000,
    );
    await new Promise((resolve) => setTimeout(resolve, 1_000));
  } finally {
    results = await releasePanes(readyPath, captures);
  }

  const state = box.read();
  assert.equal(probes(state).length, 1);
  assert.equal(publication.budgets.core.remaining, 0);
  assert.equal(dataStarts(state).filter((event) => event.cost.core > 0).length, 0);
  assert.equal(results.length, 12);
  for (const [index, result] of results.entries()) {
    assert.ok(
      result.liveScreen.statusHistory.some((status) => / Paused(?:\s|$)/.test(status)),
      `pane ${index} did not render the shared hold: ${result.liveScreen.statusHistory.join(" -> ")}`,
    );
  }
});

test("a held core pane switches to Issues and spends only GraphQL", async (t) => {
  const box = fixture(t, {
    core: { limit: LIMIT, used: LIMIT, remaining: 0, resetMs: Date.now() + WINDOW_MS },
  });
  const input =
    "i=0; while ! grep -q 'Paused' \"$GH_GLANCE_CAPTURE_OUT\" 2>/dev/null && [ $i -lt 150 ]; " +
    "do i=$((i + 1)); sleep .1; done; printf 2; " +
    "i=0; while ! grep -Fq '\"pane\":\"isolation\",\"argv\":[\"issue\"' " +
    "\"$GH_GLANCE_FIXTURE_STATE\" 2>/dev/null && [ $i -lt 200 ]; " +
    "do i=$((i + 1)); sleep .1; done; sleep .5; printf q";
  const result = await startPane(box, "isolation", {
    stdin: input,
    settle: 30,
    env: { GH_GLANCE_CAPTURE_LIVE_FLUSH: "1" },
  });

  const state = box.read();
  const data = dataStarts(state, "isolation");
  assert.equal(data.filter((event) => event.cost.core > 0).length, 0);
  assert.equal(data.filter((event) => event.argv[0] === "issue").length, 1);
  assert.equal(data.filter((event) => event.cost.graphql > 0).length, 1);
  const statuses = result.liveScreen.statusHistory;
  const pausedAt = statuses.findIndex((status) => / Paused(?:\s|$)/.test(status));
  const progressedAt = statuses.findIndex((status, index) =>
    index > pausedAt && / (?:Checking|Watching)(?:\s|$)/.test(status));
  assert.ok(pausedAt >= 0, statuses.join(" -> "));
  assert.ok(progressedAt > pausedAt, statuses.join(" -> "));
  assertDebitsStayOutsideReserve(data);
});

test("a real reset resumes all panes, while atomic external burn limits the next epoch", async (t) => {
  const resetBox = fixture(t, {
    anchorAtFirstProbe: true,
    createdAt: null,
    core: { limit: LIMIT, used: LIMIT, remaining: 0, resetMs: 0, resetOffsetMs: 10_000 },
    resetSequence: [{
      offsetMs: 10_500,
      core: { used: 0, remaining: LIMIT, resetOffsetMs: WINDOW_MS },
    }],
  });
  const resetReady = join(resetBox.root, "reset-ready");
  const resetCaptures = [startPane(resetBox, "reset-0", {
    readyPath: resetReady,
    readyAttempts: 2_000,
    settle: 95,
  })];

  let resetProgress;
  let resetSchedule;
  let firstEpoch;
  try {
    const first = await observeUntil(
      () => ({ fixture: resetBox.read(), governor: resetBox.readGovernor() }),
      ({ governor }) => governor?.budgets?.core?.remaining === 0,
      15_000,
    );
    firstEpoch = first.governor.epochs.core;
    resetCaptures.push(...Array.from({ length: 11 }, (_, offset) =>
      startPane(resetBox, `reset-${offset + 1}`, {
        readyPath: resetReady,
        readyAttempts: 2_000,
        settle: 95,
      })));
    const scheduled = await observeUntil(
      resetBox.readGovernor,
      (governor) => governor?.epochs?.core !== firstEpoch &&
        Object.values(governor.reservations ?? {}).filter(
          (reservation) => reservation.epochs?.core === governor.epochs.core,
        ).length === 12,
      30_000,
    );
    resetSchedule = scheduled;
    resetProgress = await observeUntil(
      resetBox.read,
      (state) => probes(state).length === 2 &&
        new Set(dataStarts(state).map((event) => event.pane)).size === 12,
      reservationHorizon(scheduled, "core"),
    );
  } finally {
    await releasePanes(resetReady, resetCaptures);
  }
  const resetGovernor = resetBox.readGovernor();
  assert.notEqual(resetGovernor.epochs.core, firstEpoch);
  assert.equal(probes(resetProgress).length, 2);
  const resetData = dataStarts(resetProgress);
  const resetRuns = actionsRuns(resetProgress);
  assert.equal(resetRuns.length, 12, "reset launched duplicate Actions batches");
  assert.ok(resetData.length >= 12 && resetData.length <= 24,
    "reset launched work outside the twelve Actions batches");
  assert.equal(new Set(resetData.map((event) => event.pane)).size, 12);
  assertDebitsStayOutsideReserve(resetData);
  assertPhasedStarts(resetSchedule, resetRuns, "core", 12, "reset");

  const burnBox = fixture(t, {
    anchorAtFirstProbe: true,
    createdAt: null,
    core: { limit: LIMIT, used: LIMIT, remaining: 0, resetMs: 0, resetOffsetMs: 10_000 },
    resetSequence: [{
      offsetMs: 10_500,
      core: { used: 0, remaining: LIMIT, resetOffsetMs: 25_000 },
    }],
  });
  const burnReady = join(burnBox.root, "burn-ready");
  const burnCaptures = [startPane(burnBox, "burn-0", {
    readyPath: burnReady,
    settle: 35,
  })];

  let burned;
  try {
    const anchored = await observeUntil(burnBox.read, (state) => Number.isFinite(state.createdAt), 10_000);
    burnCaptures.push(...Array.from({ length: 11 }, (_, offset) =>
      startPane(burnBox, `burn-${offset + 1}`, { readyPath: burnReady, settle: 35 })));
    await new Promise((resolve) => setTimeout(
      resolve,
      Math.max(0, anchored.createdAt + 10_700 - Date.now()),
    ));
    execFileSync(process.execPath, [STATE_HELPER, "--fixture-burn", "core", "7996"], {
      env: { ...process.env, GH_GLANCE_FIXTURE_STATE: burnBox.statePath },
    });
    burned = await observeUntil(
      burnBox.read,
      (state) => probes(state).length === 2 && dataStarts(state).length >= 1,
      20_000,
    );
    await new Promise((resolve) => setTimeout(resolve, 11_000));
  } finally {
    await releasePanes(burnReady, burnCaptures);
  }

  const finalBurn = burnBox.read();
  const burnEvent = finalBurn.events.find((event) => event.type === "external-burn");
  const burnData = dataStarts(finalBurn);
  const burnRuns = actionsRuns(finalBurn);
  assert.equal(burnEvent.amount, 7996);
  assert.equal(burnEvent.after.core.remaining, resourceReserve(LIMIT) + 4);
  assert.ok(burnRuns.length >= 1 && burnRuns.length <= 2,
    `burn admitted ${burnRuns.length} Actions batches`);
  assert.equal(burnData.length, burnRuns.length * 2,
    `burn admitted incomplete Actions batches: ${burnData.length} calls`);
  assert.equal(probes(burned).length, 2);
  assertDebitsStayOutsideReserve(burnData);
});

test("probe and reservation owner crashes recover without optimistic spend", { timeout: 120_000 }, async (t) => {
  const probeBox = fixture(t, {
    delayByCommand: { rate_limit: { ms: 30_000, remaining: 1 } },
  });
  const probeOwnerReady = join(probeBox.root, "probe-owner-ready");
  const crashedProbeCapture = startPane(probeBox, "probe-owner", {
    readyPath: probeOwnerReady,
    settle: 95,
  });
  const probeStartState = await observeUntil(probeBox.read, (state) => probes(state).length === 1, 10_000);
  const crashedProbe = probes(probeStartState)[0];
  killRecordedProcess(crashedProbe);
  writeFileSync(probeOwnerReady, "ready\n", { mode: 0o600 });
  await crashedProbeCapture;

  const survivorReady = join(probeBox.root, "probe-survivor-ready");
  const survivorCapture = startPane(probeBox, "probe-survivor", {
    readyPath: survivorReady,
    readyAttempts: 2_000,
    settle: 95,
  });
  let recoveredProbe;
  try {
    recoveredProbe = await observeUntil(
      probeBox.read,
      (state) => probes(state).length === 2 &&
        dataStarts(state).some((event) => event.pane === "probe-survivor"),
      85_000,
    );
  } finally {
    await releasePanes(survivorReady, [survivorCapture]);
  }
  assert.equal(probes(recoveredProbe).length, 2);
  assert.equal(recoveredProbe.events.some((event) =>
    event.type === "end" && event.sequence === crashedProbe.sequence), false);
  assertDebitsStayOutsideReserve(dataStarts(recoveredProbe));

  const reservationBox = fixture(t, {
    delayByCommand: { actions: { ms: 30_000, remaining: 1 } },
  });
  const reservationOwnerReady = join(reservationBox.root, "reservation-owner-ready");
  const crashedReservationCapture = startPane(reservationBox, "reservation-owner", {
    readyPath: reservationOwnerReady,
    settle: 35,
  });
  const reservationStartState = await observeUntil(
    reservationBox.read,
    (state) => dataStarts(state).some((event) => event.pane === "reservation-owner"),
    15_000,
  );
  const crashedReservation = dataStarts(reservationStartState)
    .find((event) => event.pane === "reservation-owner");
  killRecordedProcess(crashedReservation);
  writeFileSync(reservationOwnerReady, "ready\n", { mode: 0o600 });
  await crashedReservationCapture;

  const reservationReady = join(reservationBox.root, "reservation-survivor-ready");
  const reservationSurvivor = startPane(reservationBox, "reservation-survivor", {
    readyPath: reservationReady,
    settle: 35,
  });
  let recoveredReservation;
  try {
    recoveredReservation = await observeUntil(
      reservationBox.read,
      (state) => dataStarts(state).some((event) => event.pane === "reservation-survivor") &&
        state.active === 0 && state.dataActive === 0,
      20_000,
    );
  } finally {
    await releasePanes(reservationReady, [reservationSurvivor]);
  }
  const reservationGovernor = reservationBox.readGovernor();
  assert.ok(Object.values(reservationGovernor.reservations).some((reservation) =>
    reservation.status === "started" && reservation.outcome === null));
  assert.equal(recoveredReservation.active, 0);
  assert.equal(recoveredReservation.dataActive, 0);
  assertDebitsStayOutsideReserve(dataStarts(recoveredReservation));
});
