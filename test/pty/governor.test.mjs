import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import {
  existsSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

import {
  ACQUISITION_CLAIM_TTL_MS,
  ACQUISITION_STARTED_DEADLINE_MS,
  BUDGET_SNAPSHOT_TTL_MS,
  GOVERNOR_LOCK_ORPHAN_MS,
  acquisitionStorePath,
  loadAcquisitionStore,
  resourceReserve,
  tabRequestCost,
  withFileLock,
  writeGovernorState,
} from "../../index.mjs";
import { captureAsync } from "./capture.mjs";
import { seedKnownHeldIdentity } from "./fixtures/known-identity.mjs";

const STATE_HELPER = join(dirname(fileURLToPath(import.meta.url)), "fixtures", "gh-state.mjs");
const LIMIT = 10_000;
const WINDOW_MS = 600_000;
// Phase 6 makes duplicate panes followers of one acquisition generation. The
// one producer owns the governor reservation and every follower consumes its
// published snapshot.
const PANE_COUNT = 12;
const ACTIONS_CALLS = tabRequestCost("actions").core;
const STARTUP_DATA_STARTS = ACTIONS_CALLS;
// What the external burn below deliberately leaves spendable: room for two
// Actions batches and no more.
const BURN_HEADROOM = 2 * ACTIONS_CALLS;
const SIX_PANE_MIX = [
  ["widget-actions-a", "acme/widget", "actions"],
  ["widget-actions-b", "acme/widget", "actions"],
  ["widget-issues", "acme/widget", "issues"],
  ["widget-prs", "acme/widget", "prs"],
  ["widget-security", "acme/widget", "security"],
  ["other-actions", "acme/other", "actions"],
];

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
  if (state.core.remaining === 0) seedKnownHeldIdentity(root, state, now);
  writeFileSync(statePath, `${JSON.stringify(state)}\n`, { mode: 0o600 });
  return {
    root,
    statePath,
    read: () => JSON.parse(readFileSync(statePath, "utf8")),
    readGovernor: () => {
      const directory = join(root, "gh-glance", "coordination-v2");
      const name = readdirSync(directory).find((entry) => /^quota-[a-f0-9]{64}\.json$/.test(entry));
      return JSON.parse(readFileSync(join(directory, name), "utf8"));
    },
    readAcquisition: () => loadAcquisitionStore(
      join(root, "gh-glance", "coordination-v2", "acquisition.json"),
    ).value,
  };
}

function starts(state, predicate) {
  return state.events.filter((event) => event.type === "start" && predicate(event));
}

function probes(state) {
  // The shared budget probe is the claimed GraphQL observer now. `api
  // rate_limit` is no longer authority, so it is not what panes coordinate on.
  return starts(state, (event) => event.graphqlOperation === "graphql.observer");
}

function dataStarts(state) {
  return starts(state, (event) =>
    ["run", "issue", "pr"].includes(event.argv[0]) ||
    (event.graphqlOperation
      // The claimed observer is control-plane work, not data. It shares its
      // command line with every page, so only the parsed operation separates them.
      ? event.graphqlOperation !== "graphql.observer"
      : event.argv[0] === "api" && event.argv[1] !== "rate_limit" && !event.argv.includes("user")));
}

function isActionsEndpoint(event) {
  return event.argv[0] === "api" &&
    event.argv.some((argument) => argument.includes("/actions/"));
}

function actionsRuns(state) {
  return dataStarts(state)
    .filter((event) => event.argv.some((argument) => argument.includes("/actions/runs?")));
}

function widgetActionsEvidence(fixtureState, acquisition) {
  const records = Object.values(acquisition.queries).filter((record) =>
    record.query.repository === "acme/widget" && record.query.resource === "actions");
  const subscriptions = Object.values(acquisition.subscriptions).filter(({ queryKey }) =>
    records.some((record) => record.query.queryKey === queryKey));
  const starts = actionsRuns(fixtureState).filter(({ pane }) => pane?.startsWith("widget-"));
  return { records, subscriptions, starts };
}

function assertSharedWidgetActions(fixtureState, acquisition, {
  expectedSubscribers = null, expectedActive = null, require304 = false, requireSettled = false,
} = {}) {
  const { records, subscriptions, starts } = widgetActionsEvidence(fixtureState, acquisition);
  assert.equal(records.length, 1,
    "widget panes must share one logical Actions query after identity discovery");
  const record = records[0];
  assert.ok(record.snapshot?.generation > 0);
  if (expectedSubscribers !== null) assert.equal(subscriptions.length, expectedSubscribers);
  if (expectedActive !== null) {
    assert.equal(subscriptions.filter(({ demand }) => demand.active).length, expectedActive);
  }
  assert.equal(starts.length, record.snapshot.generation,
    "one shared source request must publish each Actions generation");
  const sequences = new Set(starts.map(({ sequence }) => sequence));
  let inFlight = 0;
  for (const event of fixtureState.events) {
    if (!sequences.has(event.sequence)) continue;
    inFlight += event.type === "start" ? 1 : event.type === "end" ? -1 : 0;
    assert.ok(inFlight <= 1, "one shared Actions producer may run at a time");
  }
  if (requireSettled) assert.equal(inFlight, 0);
  if (require304) {
    assert.ok(starts.some(({ sequence }) => fixtureState.events.some((event) =>
      event.type === "end" && event.sequence === sequence && event.status === 304)),
    "the shared query must advance on an unchanged response");
  }
  return record;
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

function readyInput(path, attempts = 1_000, delaySeconds = 0) {
  return `i=0; while [ ! -f "${path}" ] && [ "$i" -lt ${attempts} ]; do ` +
    `sleep .05; i=$((i + 1)); done; sleep ${delaySeconds}; printf q`;
}

function startPane(box, pane, {
  tab = "actions",
  repo = "acme/widget",
  refresh = 40,
  readyPath,
  readyAttempts = 1_000,
  readyDelay = 0,
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
    stdin: stdin ?? (readyPath ? readyInput(readyPath, readyAttempts, readyDelay) : "sleep 120"),
    args: `--repo ${repo} --refresh ${refresh} --tab ${tab}`,
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
  if (expected === 1) return;
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
    startPane(box, `startup-${index}`, { readyPath, readyDelay: 2 }));

  let progress;
  let startupGovernor;
  let acquisition;
  let panes;
  try {
    const scheduled = await observeUntil(
      () => ({ fixture: box.read(), governor: box.readGovernor() }),
      ({ governor }) => reservationSlots(governor, "core").length === 1,
      30_000,
    );
    startupGovernor = scheduled.governor;
    const completed = await observeUntil(
      () => ({ fixture: box.read(), governor: box.readGovernor(), acquisition: box.readAcquisition() }),
      ({ fixture, governor, acquisition: shared }) => {
        const records = Object.values(shared.queries);
        const record = records.find((candidate) => candidate.query.resource === "actions");
        const subscriptions = Object.values(shared.subscriptions);
        const generation = record?.generation ?? 0;
        const runs = actionsRuns(fixture);
        const slots = reservationSlots(governor, "core");
        const settlements = Object.values(governor.reservations).filter((reservation) =>
          reservation.epochs?.core === governor.epochs.core &&
          reservation.costs?.core > 0 && reservation.status === "completed");
        return records.length === 1 && record?.claim === null &&
          record.snapshot?.rows?.length > 0 && subscriptions.length === PANE_COUNT &&
          subscriptions.every((subscription) =>
            subscription.queryKey === record.query.queryKey &&
            subscription.requestedGeneration <= generation &&
            subscription.waitingGeneration === null) &&
          runs.length === generation && slots.length === generation &&
          settlements.length === generation;
      },
      reservationHorizon(startupGovernor, "core"),
    );
    progress = completed.fixture;
    startupGovernor = completed.governor;
    acquisition = completed.acquisition;
  } finally {
    panes = await releasePanes(readyPath, captures);
  }

  const data = dataStarts(progress);
  const actionsRecord = Object.values(acquisition.queries)
    .find((record) => record.query.resource === "actions");
  const generation = actionsRecord.generation;
  const runs = actionsRuns(progress);
  assert.equal(probes(progress).length, 1, `startup probes: ${JSON.stringify(probes(progress))}`);
  assert.equal(data.length, generation, "startup launched work outside the shared generations");
  assert.equal(runs.length, generation, "a shared generation acquired Actions more than once");
  assert.ok(data.every(isActionsEndpoint), "a non-active tab ran at startup");
  assertDebitsStayOutsideReserve(data);
  const slots = reservationSlots(startupGovernor, "core");
  assert.equal(slots.length, generation, "each shared generation must own one persisted slot");
  for (let index = 0; index < generation; index += 1) {
    assert.ok(runs[index].at >= slots[index], `startup start ${index} preceded its persisted slot`);
  }
  const settlements = Object.values(startupGovernor.reservations).filter((reservation) =>
    reservation.epochs?.core === startupGovernor.epochs.core &&
    reservation.costs?.core > 0 && reservation.status === "completed");
  assert.equal(settlements.length, generation, "each shared generation must settle quota once");
  assert.equal(Object.values(acquisition.queries).filter((record) => record.snapshot).length, 1);
  assert.equal(Object.keys(acquisition.subscriptions).length, PANE_COUNT);
  assert.ok(panes.every((pane) => {
    const screen = pane.finalFrame.lines.join("\n");
    return screen.includes("ci: pin actions") && screen.includes("#443");
  }),
    `every pane must render the shared published row before exit: ${JSON.stringify(
      panes.map((pane) => pane.finalFrame.lines),
    )}`);
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
    progress = await observeUntil(box.read, (state) => {
      const data = dataStarts(state);
      return actionsRuns(state).length >= 1 &&
        data.filter((event) => event.graphqlOperation === "issues.page").length === 1 &&
        data.filter((event) => event.graphqlOperation === "pulls.page").length === 1 &&
        data.filter((event) => event.pane.includes("-security-")).length === 3;
    }, 30_000);
  } finally {
    await releasePanes(readyPath, captures);
  }

  const data = dataStarts(progress);
  const seenResources = new Set(data.map((event) => {
    if (event.pane.includes("-actions-")) return "actions";
    if (event.pane.includes("-issues-")) return "issues";
    if (event.pane.includes("-prs-")) return "prs";
    if (event.pane.includes("-security-")) return "security";
    return "unknown";
  }));
  assert.deepEqual(
    [...seenResources].sort(),
    tabs,
    "every distinct active resource query should make progress",
  );
  assert.ok(data.some((event) => event.cost.core > 0));
  assert.ok(data.some((event) => event.cost.graphql > 0));
  for (const event of data) {
    if (event.pane.includes("-actions-")) assert.ok(isActionsEndpoint(event));
    // Semantic, not argv-shaped: Issues and PRs are both `api -i graphql` now,
    // so only the parsed operation says which tab a pane was actually serving.
    if (event.pane.includes("-issues-")) assert.equal(event.graphqlOperation, "issues.page");
    if (event.pane.includes("-prs-")) assert.equal(event.graphqlOperation, "pulls.page");
    if (event.pane.includes("-security-")) assert.equal(event.argv[0], "api");
  }
  assertDebitsStayOutsideReserve(data);
});

test("mixed panes join one Actions query after repository identity discovery", { timeout: 50_000 }, async (t) => {
  const box = fixture(t, { delayByCommand: { actions: { ms: 4_000, remaining: 1 } } });
  const readyPath = join(box.root, "alias-ready");
  const captures = SIX_PANE_MIX.map(([pane, repo, tab]) => startPane(box, pane, {
    repo, tab, refresh: 5, readyPath, readyAttempts: 900, settle: 90,
  }));
  const startedAt = Date.now();
  let observed;
  try {
    observed = await observeUntil(
      () => ({ fixture: box.read(), acquisition: box.readAcquisition() }),
      ({ fixture, acquisition }) => {
        const { records, subscriptions, starts } = widgetActionsEvidence(fixture, acquisition);
        return Date.now() - startedAt >= 30_000 && records.some((record) => record.snapshot) &&
          Object.values(acquisition.aliases).includes("R_acme_widget") &&
          subscriptions.length >= 5 &&
          starts.length > 0 && starts.every(({ sequence }) =>
            fixture.events.some((event) => event.type === "end" && event.sequence === sequence));
      }, 45_000,
    );
  } finally {
    await releasePanes(readyPath, captures);
  }
  assertSharedWidgetActions(observed.fixture, observed.acquisition,
    { expectedSubscribers: 5, expectedActive: 2, require304: true, requireSettled: true });
});

test("six mixed panes cross an orphan bound and keep duplicate and distinct targets live", { timeout: 220_000 }, async (t) => {
  const box = fixture(t, { delayByCommand: { actions: { ms: 4_000, remaining: 1 } } });
  const lockPath = `${acquisitionStorePath({ env: { XDG_CONFIG_HOME: box.root } })}.lock`;
  mkdirSync(dirname(lockPath), { recursive: true, mode: 0o700 });
  writeFileSync(lockPath, "", { mode: 0o600 });
  const readyPath = join(box.root, "mixed-orphan-ready");
  const panes = SIX_PANE_MIX;
  const startedAt = Date.now();
  const captures = panes.map(([pane, repo, tab]) => startPane(box, pane, {
    repo, tab, refresh: 5, readyPath, readyAttempts: 3_600, settle: 180,
  }));
  let progress;
  let shared;
  const observations = new Map();
  let firstActionSuccessAt = null;
  try {
    ({ fixture: progress, acquisition: shared } = await observeUntil(
      () => ({ fixture: box.read(), acquisition: box.readAcquisition() }),
      ({ fixture, acquisition }) => {
        const records = Object.values(acquisition.queries);
        for (const record of records) {
          const successAt = record.snapshot?.lastSuccessAt;
          if (!Number.isFinite(successAt)) continue;
          const key = `${record.query.repository}:${record.query.resource}`;
          const values = observations.get(key) ?? [];
          if (!values.some((value) => value.successAt === successAt)) values.push({
            successAt, changedAt: record.snapshot.lastChangedAt,
            nextDueAt: record.snapshot.nextDueAt,
            generation: record.snapshot.generation ?? record.generation,
          });
          observations.set(key, values);
          if (key === "acme/widget:actions" && firstActionSuccessAt === null) {
            firstActionSuccessAt = successAt;
          }
        }
        return Date.now() - startedAt >= 145_000 &&
          panes.every(([, repo, tab]) => records.some((record) =>
          record.query.repository === repo && record.query.resource === tab &&
          record.snapshot?.lastSuccessAt >= startedAt)) &&
          (observations.get("acme/other:issues")?.length ?? 0) >= 2 &&
          fixture.events.some((event) => event.type === "end" && event.status === 304);
      }, 170_000,
    ));
  } finally {
    await releasePanes(readyPath, captures);
  }
  assertSharedWidgetActions(progress, shared);
  assert.ok(firstActionSuccessAt >= startedAt + GOVERNOR_LOCK_ORPHAN_MS,
    "the fresh incomplete lock must remain protected until its orphan age");
  assert.ok(firstActionSuccessAt < startedAt + GOVERNOR_LOCK_ORPHAN_MS + 30_000,
    "the first eligible query must recover within 30 seconds of orphan age");
  assert.equal(existsSync(lockPath), false);
  const activeKeys = new Set(panes.map(([, repo, tab]) => `${repo}:${tab}`));
  for (const key of activeKeys) {
    assert.ok((observations.get(key)?.length ?? 0) >= 2,
      `${key} lacks a second validated source observation`);
  }
  assert.ok([...observations.values()].some((values) => values.slice(1).some(
    ({ successAt, changedAt }, index) =>
      successAt > values[index].successAt && changedAt === values[index].changedAt,
  )), "an unchanged response must advance source success without changing rows");
  for (const [key, values] of observations) {
    assert.ok(values.length >= 1, `${key} has no validated source observation`);
    if (values.length < 2) continue;
    const ordered = [...values].sort((left, right) => left.successAt - right.successAt);
    const maxGapMs = Math.max(0, ...ordered.slice(1).map(({ successAt }, index) =>
      successAt - ordered[index].successAt));
    assert.ok(Number.isFinite(maxGapMs), `${key} has no finite observed gap`);
    const overdue = ordered.slice(1).map(({ successAt }, index) =>
      successAt - ordered[index].nextDueAt);
    const maxOverdueMs = Math.max(0, ...overdue);
    const worstIndex = Math.max(0, overdue.indexOf(maxOverdueMs));
    const previous = ordered[worstIndex];
    const current = ordered[worstIndex + 1];
    assert.ok(maxOverdueMs <= 15_000,
      `${key} had ${maxOverdueMs}ms overdue: prior success ${previous.successAt}, ` +
      `due ${previous.nextDueAt}, generation ${previous.generation}; ` +
      `next success ${current.successAt}, generation ${current.generation}`);
  }
  assert.ok((observations.get("acme/other:issues")?.length ?? 0) >= 2,
    "an inactive query must advance across its background poll interval");
  assertDebitsStayOutsideReserve(dataStarts(progress));
});

test("failed GraphQL observer leaves core background tabs live and recovers without input", { timeout: 210_000 }, async (t) => {
  const box = fixture(t, { failure: { remaining: 2, selector: "graphql-observer",
    message: "temporary GraphQL observer failure" } });
  const readyPath = join(box.root, "observer-ready");
  const captures = [startPane(box, "observer-isolation", {
    tab: "issues", refresh: 5, readyPath, readyAttempts: 4_400, settle: 200,
  })];
  let held;
  let recovered;
  try {
    held = await observeUntil(() => ({ fixture: box.read(), governor: box.readGovernor() }),
      ({ fixture: state, governor }) =>
      state.failure.remaining === 0 && governor.observers.graphql.outcome === "failed" &&
      governor.observers.core.outcome === "healthy" &&
      actionsRuns(state).length > 0 &&
      dataStarts(state).some((event) => event.cost.core > 0 && !isActionsEndpoint(event)) &&
      dataStarts(state).every((event) => event.cost.graphql === 0), 105_000);
    recovered = await observeUntil(() => ({ fixture: box.read(), acquisition: box.readAcquisition() }),
      ({ fixture: state, acquisition }) =>
        dataStarts(state).some((event) => event.graphqlOperation === "issues.page") &&
        Object.values(acquisition.queries).some((record) =>
          record.query.resource === "issues" && record.snapshot?.lastSuccessAt > 0), 90_000);
  } finally {
    await releasePanes(readyPath, captures);
  }
  assert.equal(held.fixture.failure.remaining, 0);
  assert.ok(dataStarts(held.fixture).some((event) => event.cost.core > 0));
  assertDebitsStayOutsideReserve(dataStarts(recovered.fixture));
});

test("failed core observer leaves GraphQL background tabs live and recovers without input", { timeout: 210_000 }, async (t) => {
  const box = fixture(t);
  // The fixture calls /user for both identity proof and core observation.
  // Prove identity first, then make only the quota observer due and fail it.
  const warmReady = join(box.root, "core-identity-ready");
  const warm = [startPane(box, "core-identity", { tab: "issues", readyPath: warmReady,
    readyAttempts: 400, settle: 20 })];
  try {
    await observeUntil(box.readGovernor, (governor) =>
      governor.observers.core.outcome === "healthy" &&
      governor.observers.graphql.outcome === "healthy", 15_000);
  } finally {
    await releasePanes(warmReady, warm);
  }
  const directory = join(box.root, "gh-glance", "coordination-v2");
  const name = readdirSync(directory).find((entry) => /^quota-[a-f0-9]{64}\.json$/.test(entry));
  assert.ok(name);
  const quotaPath = join(directory, name);
  const governor = JSON.parse(readFileSync(quotaPath, "utf8"));
  const failedAt = Date.now();
  governor.budgets.core.observedAt = failedAt - BUDGET_SNAPSHOT_TTL_MS - 1_000;
  governor.budgets.core.factorBaseline.observedAt = governor.budgets.core.observedAt;
  governor.observers.core.nextAt = failedAt - 1;
  assert.equal(writeGovernorState(quotaPath, governor).ok, true);
  const state = box.read();
  const baselineSequence = state.sequence ?? 0;
  state.failure = { remaining: 2, selector: "core-observer",
    message: "temporary core observer failure" };
  writeFileSync(box.statePath, `${JSON.stringify(state)}\n`, { mode: 0o600 });
  const readyPath = join(box.root, "core-observer-ready");
  const captures = [startPane(box, "core-observer-isolation", {
    tab: "actions", refresh: 5, readyPath, readyAttempts: 4_400, settle: 200,
  })];
  let held;
  let recovered;
  try {
    held = await observeUntil(() => ({ fixture: box.read(), governor: box.readGovernor() }),
      ({ fixture: state, governor }) =>
      state.failure.remaining === 0 && governor.observers.core.outcome === "failed" &&
      governor.observers.graphql.outcome === "healthy" &&
      dataStarts(state).filter((event) => event.sequence > baselineSequence)
        .some((event) => event.graphqlOperation === "issues.page" ||
        event.graphqlOperation === "pulls.page") &&
      dataStarts(state).filter((event) => event.sequence > baselineSequence)
        .every((event) => event.cost.core === 0), 105_000);
    recovered = await observeUntil(() => ({ fixture: box.read(), acquisition: box.readAcquisition() }),
      ({ fixture: state, acquisition }) =>
        actionsRuns(state).some((event) => event.sequence > baselineSequence) &&
        Object.values(acquisition.queries).some((record) =>
          record.query.resource === "actions" && record.snapshot?.lastSuccessAt > failedAt), 90_000);
  } finally {
    await releasePanes(readyPath, captures);
  }
  assert.equal(held.fixture.failure.remaining, 0);
  assert.ok(dataStarts(held.fixture).some((event) =>
    event.sequence > baselineSequence && event.cost.graphql > 0));
  assertDebitsStayOutsideReserve(dataStarts(recovered.fixture));
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
    // Exhaustion is an actionable hold and therefore renders Paused. Retain
    // the transient Watching forms because a fast platform can observe them
    // before the authoritative reset sample is published.
    "i=0; while ! grep -Eq 'Paused|Watching (next|probing)' \"$GH_GLANCE_CAPTURE_OUT\" 2>/dev/null && [ $i -lt 150 ]; " +
    "do i=$((i + 1)); sleep .1; done; " +
    "i=0; while [ $i -lt 8 ]; do printf r; i=$((i + 1)); sleep .03; done; " +
    "i=0; while ! grep -Fq '\"pane\":\"manual\",\"argv\":[\"api\",\"-i\",\"repos/acme/widget/actions/runs?' " +
    "\"$GH_GLANCE_FIXTURE_STATE\" 2>/dev/null && [ $i -lt 300 ]; " +
    "do i=$((i + 1)); sleep .1; done; sleep 1.5; printf q";
  const captures = [startPane(box, "manual", {
    stdin: manualInput,
    animation: true,
    settle: 40,
    env: { GH_GLANCE_CAPTURE_LIVE_FLUSH: "1" },
  })];

  let held;
  let progress;
  let results;
  let admitted;
  try {
    await observeUntil(
      box.readGovernor,
      (governor) => Object.values(governor.intents ?? {})
        .some((intent) => intent.priority === "manual"),
      15_000,
    );
    captures.push(startPane(box, "competitor", { readyPath: competitorReady, settle: 40 }));
    held = await observeUntil(
      () => ({ governor: box.readGovernor(), acquisition: box.readAcquisition() }),
      ({ governor, acquisition }) =>
        Object.values(governor.intents ?? {}).filter((intent) => intent.priority === "manual").length === 1 &&
        Object.keys(acquisition.subscriptions ?? {}).length === 2,
      10_000,
    );
    const completed = await observeUntil(
      () => ({ fixture: box.read(), acquisition: box.readAcquisition() }),
      ({ fixture, acquisition }) => actionsRuns(fixture).length === 1 &&
        Object.values(acquisition.queries ?? {}).some((record) => record.snapshot?.rows?.length > 0),
      30_000,
    );
    progress = completed.fixture;
    await new Promise((resolve) => setTimeout(resolve, 1_200));
    admitted = box.readGovernor();
  } finally {
    results = await releasePanes(competitorReady, captures);
  }

  assert.equal(Object.values(held.governor.intents)
    .filter((intent) => intent.priority === "manual").length, 1);
  const runs = actionsRuns(progress);
  assert.equal(runs.filter((event) => event.pane === "manual").length, 1);
  assert.equal(runs.filter((event) => event.pane === "competitor").length, 0);
  const intentEntries = Object.entries(held.governor.intents);
  const [manualIntentId] = intentEntries.find(([, intent]) => intent.priority === "manual") ?? [];
  const reservations = Object.values(admitted.reservations);
  const manualReservation = reservations.find((reservation) => reservation.intentId === manualIntentId);
  assert.equal(manualReservation?.status, "completed");
  assert.ok(results.every((result) => result.finalFrame.lines.join("\n").includes("ci: pin actions")),
    "the manual producer and its follower must both render the shared result");
  const manualResult = results[0];
  const statuses = manualResult.liveScreen.statusHistory;
  const scheduledAt = statuses.findIndex((status) => / (?:Paused|Watching (?:next|probing))(?:\s|$)/.test(status));
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
      (governor) => governor?.observers?.graphql?.outcome === "healthy" &&
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
  assert.equal(data.filter((event) => event.graphqlOperation === "issues.page").length, 1);
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
        ).length === 1,
      30_000,
    );
    resetSchedule = scheduled;
    resetProgress = await observeUntil(
      resetBox.read,
      (state) => probes(state).length === 2 && actionsRuns(state).length === 1,
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
  assert.equal(resetRuns.length, 1, "reset launched duplicate Actions batches");
  assert.equal(resetData.length, STARTUP_DATA_STARTS,
    "reset launched work outside the shared Actions batch");
  assert.equal(new Set(resetData.map((event) => event.pane)).size, 1);
  assertDebitsStayOutsideReserve(resetData);
  assertPhasedStarts(resetSchedule, resetRuns, "core", 1, "reset");

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
    execFileSync(process.execPath, [
      STATE_HELPER,
      "--fixture-burn",
      "core",
      String(LIMIT - resourceReserve(LIMIT) - BURN_HEADROOM),
    ], {
      env: { GH_GLANCE_FIXTURE_STATE: burnBox.statePath },
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
  assert.equal(burnEvent.amount, LIMIT - resourceReserve(LIMIT) - BURN_HEADROOM);
  assert.equal(burnEvent.after.core.remaining, resourceReserve(LIMIT) + BURN_HEADROOM);
  assert.ok(burnRuns.length >= 1 && burnRuns.length <= 2,
    `burn admitted ${burnRuns.length} Actions batches`);
  assert.equal(burnData.length, burnRuns.length * ACTIONS_CALLS,
    `burn admitted incomplete Actions batches: ${burnData.length} calls`);
  assert.equal(probes(burned).length, 2);
  assertDebitsStayOutsideReserve(burnData);
});

test("probe and reservation owner crashes recover without optimistic spend", { timeout: 240_000 }, async (t) => {
  const probeBox = fixture(t, {
    // The shared budget probe is the claimed GraphQL observer now, so that is
    // the call this test has to hold open long enough to kill its owner.
    delayByCommand: { "graphql-observer": { ms: 30_000, remaining: 1 } },
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
  const crashedClaim = Object.values(reservationBox.readAcquisition().queries)
    .find((record) => record.query.resource === "actions")?.claim;
  assert.ok(crashedClaim, "the crashed owner had no durable acquisition claim");
  assert.ok(crashedClaim.leaseUntil - crashedClaim.claimedAt >= ACQUISITION_CLAIM_TTL_MS,
    "the durable claim did not retain the required crash-recovery window");
  killRecordedProcess(crashedReservation);
  writeFileSync(reservationOwnerReady, "ready\n", { mode: 0o600 });
  await crashedReservationCapture;

  const reservationReady = join(reservationBox.root, "reservation-survivor-ready");
  const reservationSurvivor = startPane(reservationBox, "reservation-survivor", {
    readyPath: reservationReady,
    readyAttempts: 2_000,
    settle: 130,
  });
  let recoveredReservation;
  try {
    recoveredReservation = await observeUntil(
      reservationBox.read,
      (state) => dataStarts(state).some((event) => event.pane === "reservation-survivor") &&
        state.active === 0 && state.dataActive === 0,
      115_000,
    );
  } finally {
    await releasePanes(reservationReady, [reservationSurvivor]);
  }
  const reservationGovernor = reservationBox.readGovernor();
  assert.ok(Object.values(reservationGovernor.reservations).some((reservation) =>
    reservation.status === "started" && reservation.outcome === null));
  const survivorStart = dataStarts(recoveredReservation)
    .find((event) => event.pane === "reservation-survivor");
  assert.ok(survivorStart.at >= crashedClaim.leaseUntil,
    `survivor started before the dead claim expired: ${survivorStart.at} < ${crashedClaim.leaseUntil}`);
  assert.equal(recoveredReservation.active, 0);
  assert.equal(recoveredReservation.dataActive, 0);
  assertDebitsStayOutsideReserve(dataStarts(recoveredReservation));
});

test("live started takeover fences a late pane's shared rows and local cache", { timeout: 70_000 }, async (t) => {
  const oldBody = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "fixtures", "actions-runs.json"), "utf8");
  const newBody = oldBody.replace("ci: pin actions to commit SHAs", "successor-only run");
  const path = "repos/acme/widget/actions/runs?exclude_pull_requests=true&per_page=60";
  const box = fixture(t, {
    delayByCommand: { actions: { ms: 15_000, remaining: 1 } },
    apiEntities: { [path]: { sequence: [
      { etag: '"old-generation"', body: oldBody },
      { etag: '"new-generation"', body: newBody },
    ] } },
  });
  const ownerReady = join(box.root, "late-owner-ready");
  const survivorReady = join(box.root, "late-survivor-ready");
  const owner = startPane(box, "late-owner", { readyPath: ownerReady, settle: 40 });
  await observeUntil(box.read, (state) => actionsRuns(state)
    .some((event) => event.pane === "late-owner"), 12_000);
  const storePath = join(box.root, "gh-glance", "coordination-v2", "acquisition.json");
  const aged = withFileLock(`${storePath}.lock`, () => {
    const state = JSON.parse(readFileSync(storePath, "utf8"));
    const record = Object.values(state.queries).find((candidate) => candidate.query.resource === "actions");
    assert.equal(record.claim.started, true);
    record.claim.startedAt = Date.now() - ACQUISITION_STARTED_DEADLINE_MS;
    const staged = `${storePath}.test-replace`;
    writeFileSync(staged, `${JSON.stringify(state)}\n`, { mode: 0o600 });
    renameSync(staged, storePath);
    return { ok: true };
  });
  assert.equal(aged.ok, true);
  const survivor = startPane(box, "late-survivor", { readyPath: survivorReady, settle: 40 });
  let ownerFrame;
  try {
    await observeUntil(box.read, (fixtureState) => actionsRuns(fixtureState)
      .some((event) => event.pane === "late-survivor"), 30_000);
    await observeUntil(box.readAcquisition, (shared) => Object.values(shared.queries)
      .some((candidate) => candidate.snapshot?.rows?.[0]?.displayTitle === "successor-only run"), 15_000);
    await observeUntil(box.read, (fixtureState) => fixtureState.events.some((event) =>
      event.type === "end" && event.pane === "late-owner" && isActionsEndpoint(event)), 20_000);
    await new Promise((resolve) => setTimeout(resolve, 1_000));
  } finally {
    [ownerFrame] = await releasePanes(ownerReady, [owner]);
    await releasePanes(survivorReady, [survivor]);
  }
  const shared = box.readAcquisition();
  const snapshot = Object.values(shared.queries).find((candidate) =>
    candidate.snapshot?.rows?.[0]?.displayTitle === "successor-only run")?.snapshot;
  assert.ok(snapshot);
  const ownerScreen = ownerFrame.finalFrame.lines.join("\n");
  assert.ok(ownerScreen.includes("successor-only r"), ownerScreen);
  assert.equal(ownerScreen.includes("ci: pin actions"), false);
  const cache = JSON.parse(readFileSync(join(box.root, "gh-glance", "dashboard-cache.json"), "utf8"));
  const cached = Object.values(cache.targets).find((target) => target.tabs?.actions)?.tabs.actions;
  assert.equal(cached.data[0].displayTitle, "successor-only run");
  assert.equal(cached.lastOk, snapshot.lastSuccessAt);
});
