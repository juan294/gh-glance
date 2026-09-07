import assert from "node:assert/strict";
import { test } from "node:test";

import {
  BACKGROUND_EVERY,
  POLL_ACTIVE_CI_MS,
  POLL_QUIET_AFTER,
  POLL_QUIET_MS,
  POLL_BACKGROUND_MS,
  WORKFLOW_CATALOG_TTL_MS,
  ACTIONS_RUN_LIMIT,
  pollPolicyInterval,
  advanceUnchangedCount,
  pollSchedule,
  actionsRunsArgs,
  entityKey,
  fetchActions,
  fetchConditionalEntity,
  pollResultTransition,
  parseActionsRuns,
  resolveWorkflowNames,
  workflowCatalogDemand,
} from "../index.mjs";

const FLOOR = 5_000;
const NOW = 1_800_000_000_000;

// ---------- POLL-01 ----------

test("POLL-01 two unchanged observations enter the quiet cadence", () => {
  // One unchanged observation is not enough: a repository that answers 304 once
  // is not yet quiet, and dropping to 30s after a single 304 would slow the
  // first real change by a whole quiet interval for no evidence.
  for (const tab of ["actions", "issues", "prs", "security"]) {
    assert.equal(
      pollPolicyInterval({ tab, floorMs: FLOOR, demand: "active", unchangedCount: 0 }),
      FLOOR,
      `${tab} fresh`,
    );
    assert.equal(
      pollPolicyInterval({ tab, floorMs: FLOOR, demand: "active", unchangedCount: 1 }),
      FLOOR,
      `${tab} after one unchanged`,
    );
    assert.equal(
      pollPolicyInterval({ tab, floorMs: FLOOR, demand: "active", unchangedCount: POLL_QUIET_AFTER }),
      Math.max(FLOOR, POLL_QUIET_MS[tab]),
      `${tab} quiet`,
    );
  }
  assert.equal(POLL_QUIET_MS.actions, 30_000);
  assert.equal(POLL_QUIET_MS.issues, 30_000);
  assert.equal(POLL_QUIET_MS.prs, 30_000);
  assert.equal(POLL_QUIET_MS.security, 60_000);
});

test("POLL-01 the floor is a floor, never a ceiling the quiet cadence undercuts", () => {
  // A user who asked for --refresh 120 gets 120s quiet, not 30s.
  assert.equal(
    pollPolicyInterval({ tab: "actions", floorMs: 120_000, demand: "active", unchangedCount: 2 }),
    120_000,
  );
  assert.equal(
    pollPolicyInterval({ tab: "security", floorMs: 300_000, demand: "active", unchangedCount: 9 }),
    300_000,
  );
});

test("POLL-01 a change or in-progress CI restores the specified floor", () => {
  // A validated content change resets the quiet counter outright.
  assert.equal(advanceUnchangedCount(7, "changed"), 0);
  assert.equal(advanceUnchangedCount(7, "unchanged"), 8);
  // Errors do not increment: a tab that cannot be read is not evidence of quiet.
  assert.equal(advanceUnchangedCount(7, "error"), 7);
  assert.equal(advanceUnchangedCount(7, "blind"), 7);
  assert.equal(advanceUnchangedCount(7, "unusable"), 7);
  // A newly active subscription resets quiet mode.
  assert.equal(advanceUnchangedCount(7, "subscribed"), 0);

  assert.equal(
    pollPolicyInterval({ tab: "actions", floorMs: FLOOR, demand: "active", unchangedCount: 0 }),
    FLOOR,
  );
  // Running or queued Actions outrank the quiet counter entirely.
  assert.equal(
    pollPolicyInterval({
      tab: "actions", floorMs: FLOOR, demand: "active", unchangedCount: 9, inProgressCI: true,
    }),
    Math.max(FLOOR, POLL_ACTIVE_CI_MS),
  );
  assert.equal(
    pollPolicyInterval({
      tab: "actions", floorMs: 2_000, demand: "active", unchangedCount: 9, inProgressCI: true,
    }),
    POLL_ACTIVE_CI_MS,
  );
  // In-progress CI is an Actions property; it does not accelerate other tabs.
  assert.equal(
    pollPolicyInterval({
      tab: "issues", floorMs: FLOOR, demand: "active", unchangedCount: 9, inProgressCI: true,
    }),
    POLL_QUIET_MS.issues,
  );
});

test("POLL-01 inactive demand uses the background interval and off disables it", () => {
  assert.equal(
    pollPolicyInterval({ tab: "actions", floorMs: FLOOR, demand: "inactive" }),
    Math.max(BACKGROUND_EVERY * FLOOR, POLL_BACKGROUND_MS.actions),
  );
  assert.equal(
    pollPolicyInterval({ tab: "security", floorMs: FLOOR, demand: "inactive" }),
    Math.max(BACKGROUND_EVERY * FLOOR, POLL_BACKGROUND_MS.security),
  );
  // 12 x floor wins once the floor is large.
  assert.equal(
    pollPolicyInterval({ tab: "issues", floorMs: 60_000, demand: "inactive" }),
    BACKGROUND_EVERY * 60_000,
  );
  assert.equal(
    pollPolicyInterval({ tab: "issues", floorMs: FLOOR, demand: "inactive", background: "off" }),
    Number.POSITIVE_INFINITY,
  );
  // No demand at all never polls, whatever the background setting.
  assert.equal(
    pollPolicyInterval({ tab: "issues", floorMs: FLOOR, demand: "none" }),
    Number.POSITIVE_INFINITY,
  );
});

test("POLL-01 background off emits zero inactive data calls", () => {
  const planned = pollSchedule({
    nowMs: NOW,
    floorMs: FLOOR,
    activeKey: "actions",
    dueAt: Object.fromEntries(["actions", "issues", "prs", "security"].map((k) => [k, NOW])),
    background: "off",
  });
  assert.deepEqual(planned.due, [{ key: "actions", kind: "active" }]);
  assert.equal(planned.dueAt.issues, Number.POSITIVE_INFINITY);
  assert.equal(planned.dueAt.prs, Number.POSITIVE_INFINITY);
  assert.equal(planned.dueAt.security, Number.POSITIVE_INFINITY);
  assert.equal(planned.nextAt, NOW + FLOOR);
});

test("POLL-01 a quiet active tab reschedules itself at the quiet cadence", () => {
  const planned = pollSchedule({
    nowMs: NOW,
    floorMs: FLOOR,
    activeKey: "security",
    dueAt: { security: NOW },
    states: { security: { unchangedCount: 2 } },
    background: "off",
  });
  assert.deepEqual(planned.due, [{ key: "security", kind: "active" }]);
  assert.equal(planned.dueAt.security, NOW + POLL_QUIET_MS.security);
});

test("POLL-01 at most one background tab is selected per wake, round robin", () => {
  const dueAt = { actions: NOW + 10_000, issues: NOW, prs: NOW, security: NOW };
  const first = pollSchedule({
    nowMs: NOW, floorMs: FLOOR, activeKey: "actions", dueAt, backgroundIndex: 0,
  });
  assert.equal(first.due.length, 1);
  assert.equal(first.due[0].kind, "background");
  const second = pollSchedule({
    nowMs: NOW,
    floorMs: FLOOR,
    activeKey: "actions",
    dueAt: first.dueAt,
    backgroundIndex: first.backgroundIndex,
  });
  assert.equal(second.due.length, 1);
  assert.notEqual(second.due[0].key, first.due[0].key);
});

test("POLL-01 a held resource defers the tab to its retry rather than dropping it", () => {
  const retryAt = NOW + 42_000;
  const planned = pollSchedule({
    nowMs: NOW,
    floorMs: FLOOR,
    activeKey: "actions",
    dueAt: { actions: NOW },
    heldResources: { core: { held: true, retryAt } },
    background: "off",
  });
  assert.deepEqual(planned.due, []);
  assert.equal(planned.dueAt.actions, retryAt);
  assert.equal(planned.nextAt, retryAt);
});

// ---------- POLL-03 ----------

test("POLL-03 the Actions runs request is a stable 60-row variant", () => {
  // The request no longer varies with pane height: two terminals of different
  // sizes ask the identical question, so their validators and any shared entry
  // are reusable rather than one-per-geometry.
  assert.equal(ACTIONS_RUN_LIMIT, 60);
  const path = actionsRunsArgs()[0];
  assert.match(path, /per_page=60/);
  assert.deepEqual(actionsRunsArgs(), actionsRunsArgs());
});

test("POLL-03 complete run names cause no workflow-catalog request", () => {
  const body = JSON.stringify([
    { databaseId: 1, workflowName: "CI", workflowId: 10, number: 1, status: "completed" },
    { databaseId: 2, workflowName: "Release", workflowId: 11, number: 2, status: "completed" },
  ]);
  const runs = parseActionsRuns(body);
  assert.deepEqual(runs.map((run) => run.workflowName), ["CI", "Release"]);
  assert.equal(workflowCatalogDemand({ runs, catalog: null, nowMs: NOW }), false);
});

test("POLL-03 a missing name causes one catalog request, reused for 15 minutes", () => {
  assert.equal(WORKFLOW_CATALOG_TTL_MS, 15 * 60_000);
  const runs = parseActionsRuns(JSON.stringify([
    { databaseId: 1, workflowName: "", workflowId: 10, number: 1, status: "completed" },
  ]));
  assert.equal(workflowCatalogDemand({ runs, catalog: null, nowMs: NOW }), true);

  const catalog = { at: NOW, names: new Map([[10, "CI"]]) };
  assert.equal(workflowCatalogDemand({ runs, catalog, nowMs: NOW + 1 }), false);
  assert.deepEqual(resolveWorkflowNames(runs, catalog).map((r) => r.workflowName), ["CI"]);

  // Still inside the TTL with the id unresolved: one request, not one per poll.
  const empty = { at: NOW, names: new Map() };
  assert.equal(workflowCatalogDemand({ runs, catalog: empty, nowMs: NOW + WORKFLOW_CATALOG_TTL_MS - 1 }), false);
  assert.equal(workflowCatalogDemand({ runs, catalog: empty, nowMs: NOW + WORKFLOW_CATALOG_TTL_MS }), true);
});

test("POLL-03 a failed catalog keeps a valid run list with the last-known name", () => {
  const runs = parseActionsRuns(JSON.stringify([
    { databaseId: 1, workflowName: "", workflowId: 10, number: 1, status: "completed" },
    { databaseId: 2, workflowName: "", workflowId: 99, number: 2, status: "completed" },
  ]));
  // A stale catalog is still the best answer available; an unknown id renders
  // empty rather than blocking the CI status the rest of the row carries.
  const resolved = resolveWorkflowNames(runs, { at: NOW - WORKFLOW_CATALOG_TTL_MS * 4, names: new Map([[10, "CI"]]) });
  assert.deepEqual(resolved.map((run) => run.workflowName), ["CI", ""]);
  assert.deepEqual(resolved.map((run) => run.databaseId), [1, 2]);
  // No catalog at all is not an error either.
  assert.deepEqual(resolveWorkflowNames(runs, null).map((run) => run.workflowName), ["", ""]);
});

// ---------- REFRESH ----------

test("REFRESH-03 Width mode owns r and R and starts no refresh", async () => {
  const { refreshIntent } = await import("../index.mjs");
  assert.equal(refreshIntent("r", { widthMode: false }), "conditional");
  assert.equal(refreshIntent("R", { widthMode: false }), "resync");
  // Width mode keeps its own two reset meanings, so neither key may leak a
  // refresh into it.
  assert.equal(refreshIntent("r", { widthMode: true }), null);
  assert.equal(refreshIntent("R", { widthMode: true }), null);
  assert.equal(refreshIntent("x", { widthMode: false }), null);
});

test("REFRESH-01 r keeps validators; R drops them exactly once", async () => {
  const { manualRefreshRequest } = await import("../index.mjs");
  // `r` is an ordinary conditional check at manual priority: it bypasses the
  // scheduled interval and the tab's failure ladder, but still sends
  // If-None-Match, so a quiet repository answers 304 and spends nothing.
  assert.deepEqual(manualRefreshRequest("conditional"), {
    kind: "manual", force: false, dropValidators: false, clearCapabilityBackoff: false,
  });
  // `R` is the resynchronization: one generation without validators.
  assert.deepEqual(manualRefreshRequest("resync"), {
    kind: "manual", force: true, dropValidators: true, clearCapabilityBackoff: true,
  });
  assert.equal(manualRefreshRequest(null), null);
});

test("REFRESH-02 a manual request during automatic work schedules at most one follow-up", async () => {
  const { planManualRefresh } = await import("../index.mjs");
  const requestedAt = 1_000;
  // Nothing in flight: go now.
  assert.deepEqual(planManualRefresh({ requestedAt }), { join: false, start: true, followUp: false });
  // An acquisition that started after the press already answers it.
  assert.deepEqual(
    planManualRefresh({ requestedAt, inFlightStartedAt: requestedAt + 1 }),
    { join: true, start: false, followUp: false },
  );
  // One that predates the press cannot: schedule exactly one follow-up.
  assert.deepEqual(
    planManualRefresh({ requestedAt, inFlightStartedAt: requestedAt - 1 }),
    { join: false, start: false, followUp: true },
  );
  // Further presses coalesce into the follow-up already scheduled.
  assert.deepEqual(
    planManualRefresh({ requestedAt, inFlightStartedAt: requestedAt - 1, followUpPending: true }),
    { join: true, start: false, followUp: false },
  );
});

test("REFRESH-02 a 304 with no cached entity recovers once, then surfaces unusable state", async () => {
  const { conditionalRecoveryPlan } = await import("../index.mjs");
  // The healthy case: a 304 with the entity it validates.
  assert.deepEqual(
    conditionalRecoveryPlan({ status: 304, hasEntity: true }),
    { recover: false, unusable: false },
  );
  assert.deepEqual(
    conditionalRecoveryPlan({ status: 304, entity: "[]" }),
    { recover: false, unusable: false },
  );
  // Present but empty is not an answer: it parses to nothing and the validator
  // that named it is never refreshed.
  assert.deepEqual(
    conditionalRecoveryPlan({ status: 304, entity: "" }),
    { recover: true, unusable: false },
  );
  // The broken pair. One separately admitted unconditional attempt.
  assert.deepEqual(
    conditionalRecoveryPlan({ status: 304, hasEntity: false, attempts: 0 }),
    { recover: true, unusable: false },
  );
  // And then it stops, rather than becoming an API loop.
  assert.deepEqual(
    conditionalRecoveryPlan({ status: 304, hasEntity: false, attempts: 1 }),
    { recover: false, unusable: true },
  );
  assert.deepEqual(
    conditionalRecoveryPlan({ status: 200, hasEntity: false, attempts: 0 }),
    { recover: false, unusable: false },
  );
});

test("REFRESH-02 a 304 with no cached entity drops the validator and reports unusable once", async () => {
  const path = actionsRunsArgs()[0];
  // What a broken pair looks like: the pane holds a validator whose payload is
  // empty, so the server keeps saying "unchanged" about nothing. The validator
  // is only ever refreshed by a 200, so without a recovery this tab asks the
  // same unanswerable question at every poll for the life of the process.
  const entities = new Map([[entityKey("actions", path), { etag: '"gone"', body: "" }]]);
  const sent = [];
  const request = async (args, { etag }) => {
    sent.push(etag);
    return etag === null
      ? { status: 200, body: JSON.stringify([]), etag: '"fresh"', rateLimit: null }
      : { status: 304, body: null, etag, rateLimit: null };
  };

  const stuck = await fetchActions(undefined, { entities, request });
  // The unanswerable validator is gone, so the next admitted check is
  // unconditional rather than asking the same question forever.
  assert.equal(entities.has(entityKey("actions", path)), false);
  const transition = pollResultTransition({
    key: "actions",
    previousRaw: "previous",
    raw: stuck.raw,
    parse: stuck.parse,
    limit: stuck.limit,
    completedAt: 1,
  });
  // Unusable, not an error: the last-good rows and their freshness clock stay.
  assert.equal(transition.kind, "unusable");
  assert.equal(transition.nextRaw, null);

  const recovered = await fetchActions(undefined, { entities, request });
  assert.deepEqual(sent, ['"gone"', null]);
  assert.deepEqual(recovered.parse(), []);
  assert.equal(recovered.restSpent, 1);
});

test("REFRESH-02 a 304 with its entity present is the ordinary free case", async () => {
  const path = actionsRunsArgs()[0];
  const body = JSON.stringify([{ databaseId: 1, workflowName: "CI", workflowId: 10, number: 1, status: "completed" }]);
  const entities = new Map([[entityKey("actions", path), { etag: '"held"', body }]]);
  const response = await fetchConditionalEntity({
    tab: "actions",
    args: actionsRunsArgs(),
    operation: "tab:actions-runs",
    entities,
    force: false,
    request: async () => ({ status: 304, body: null, etag: '"held"', rateLimit: null }),
  });
  assert.equal(response.status, 304);
  assert.equal(response.body, body);
  assert.equal(response.recovered, false);
  // Nothing was dropped: this validator is doing exactly its job.
  assert.equal(entities.size, 1);
});
