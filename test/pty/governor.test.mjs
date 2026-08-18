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
    event.argv[0] === "api" && event.argv[1] !== "rate_limit");
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
} = {}) {
  return captureAsync({
    cols: 70,
    rows: 20,
    signal: "none",
    settle,
    stdin: readyPath ? readyInput(readyPath, readyAttempts) : "sleep 120",
    args: `${CAPTURE_ARGS} --tab ${tab}`,
    configHome: box.root,
    env: {
      GH_GLANCE_FIXTURE_STATE: box.statePath,
      GH_GLANCE_FIXTURE_PANE: pane,
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
  try {
    progress = await observeUntil(
      box.read,
      (state) => new Set(dataStarts(state).map((event) => event.pane)).size === 12,
      30_000,
    );
  } finally {
    await releasePanes(readyPath, captures);
  }

  const data = dataStarts(progress);
  assert.equal(probes(progress).length, 1, `startup probes: ${JSON.stringify(probes(progress))}`);
  assert.equal(data.length, 12, "startup launched background or duplicate data work");
  assert.equal(new Set(data.map((event) => event.pane)).size, 12);
  assert.ok(data.every((event) => event.argv[0] === "run"), "a non-active tab ran at startup");
  assertDebitsStayOutsideReserve(data);
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
    if (event.pane.includes("-actions-")) assert.equal(event.argv[0], "run");
    if (event.pane.includes("-issues-")) assert.equal(event.argv[0], "issue");
    if (event.pane.includes("-prs-")) assert.equal(event.argv[0], "pr");
    if (event.pane.includes("-security-")) assert.equal(event.argv[0], "api");
  }
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
    const lastNotBefore = Math.max(
      ...Object.values(scheduled.reservations).map((reservation) => reservation.notBefore),
    );
    const progressTimeout = Math.min(75_000, Math.max(65_000, lastNotBefore - Date.now() + 65_000));
    resetProgress = await observeUntil(
      resetBox.read,
      (state) => probes(state).length === 2 &&
        new Set(dataStarts(state).map((event) => event.pane)).size === 12,
      progressTimeout,
    );
  } finally {
    await releasePanes(resetReady, resetCaptures);
  }
  const resetGovernor = resetBox.readGovernor();
  assert.notEqual(resetGovernor.epochs.core, firstEpoch);
  assert.equal(probes(resetProgress).length, 2);
  const resetData = dataStarts(resetProgress);
  assert.equal(resetData.length, 12, "reset launched duplicate data work");
  assert.equal(new Set(resetData.map((event) => event.pane)).size, 12);
  assertDebitsStayOutsideReserve(resetData);

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
  assert.equal(burnEvent.amount, 7996);
  assert.equal(burnEvent.after.core.remaining, resourceReserve(LIMIT) + 4);
  assert.ok(burnData.length >= 1 && burnData.length <= 2, `burn admitted ${burnData.length} calls`);
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
    delayByCommand: { run: { ms: 30_000, remaining: 1 } },
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
      (state) => dataStarts(state).some((event) => event.pane === "reservation-survivor"),
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
