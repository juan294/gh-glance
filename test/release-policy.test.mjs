import assert from "node:assert/strict";
import { test } from "node:test";

import {
  AGGREGATE_CONTEXT, CANARY_LIMITS, GITHUB_ACTIONS_APP_ID, LEGACY_CONTEXTS, SECURITY_CONTEXTS,
  canaryMayAdmit, planCanary, planProtectionStep,
} from "../scripts/release-policy.mjs";

// The required_status_checks shape main had on 2026-10-02 (read-only API).
const CAPTURED = { strict: true, checks: [
  { context: "Smoke (Node 22)", app_id: 15368 }, { context: "Smoke (Node 24)", app_id: 15368 },
  { context: "Lint", app_id: 15368 }, { context: "analyze (javascript-typescript)", app_id: 15368 },
  { context: "Test (Node 22)", app_id: 15368 }, { context: "Test (Node 24)", app_id: 15368 },
  { context: "dependency-review", app_id: 15368 }, { context: "PTY", app_id: null },
] };

// Apply a planned PATCH body the way GitHub's required_status_checks endpoint
// does: it replaces only strict and the checks list.
const apply = (current, body) => ({ ...current, strict: body.strict, checks: body.checks });
const names = (state) => state.checks.map((check) => check.context).sort();

test("PROT-01 add before remove: the aggregate joins first, legacy contexts leave second", () => {
  assert.deepEqual(planProtectionStep(CAPTURED, { aggregateObservedSuccess: false }).action, "wait");
  const first = planProtectionStep(CAPTURED, { aggregateObservedSuccess: true });
  assert.equal(first.action, "add-aggregate");
  const middle = apply(CAPTURED, first.body);
  assert.deepEqual(names(middle), [...names(CAPTURED), AGGREGATE_CONTEXT].sort(), "nothing removed while adding");
  assert.equal(middle.checks.find((check) => check.context === AGGREGATE_CONTEXT).app_id, GITHUB_ACTIONS_APP_ID);
  assert.equal(middle.checks.find((check) => check.context === "PTY").app_id, -1,
    "an unbound context (app_id null) stays unbound: -1 is the PATCH spelling of any app");
  assert.equal(middle.checks.find((check) => check.context === "Lint").app_id, 15368, "app bindings preserved");
  const second = planProtectionStep(middle, { aggregateObservedSuccess: true });
  assert.equal(second.action, "retire-legacy");
  const final = apply(middle, second.body);
  assert.deepEqual(names(final), [...SECURITY_CONTEXTS, AGGREGATE_CONTEXT].sort());
  assert.equal(final.strict, true);
  assert.equal(planProtectionStep(final, { aggregateObservedSuccess: true }).action, "done");
});

test("PROT-02 every intermediate state is at least as strict as the start, and resume converges", () => {
  // Interrupt after each step and resume from the readback.
  let state = CAPTURED;
  const seen = [];
  for (let step = 0; step < 5; step += 1) {
    const plan = planProtectionStep(state, { aggregateObservedSuccess: true });
    seen.push(plan.action);
    if (plan.action === "done") break;
    state = apply(state, plan.body);
    const required = new Set(names(state));
    assert.ok(SECURITY_CONTEXTS.every((context) => required.has(context)), "security checks always required");
    assert.ok(required.has(AGGREGATE_CONTEXT) || LEGACY_CONTEXTS.every((context) => required.has(context)),
      "legacy contexts are only retired once the aggregate is required");
    assert.equal(state.strict, true);
  }
  assert.deepEqual(seen, ["add-aggregate", "retire-legacy", "done"]);
});

test("PROT-03 unknown drift stops every mutation", () => {
  const cases = [
    [{ ...CAPTURED, strict: false }, /strict/],
    [{ ...CAPTURED, checks: [...CAPTURED.checks, { context: "Mystery", app_id: 1 }] }, /unexpected required contexts: Mystery/],
    [{ ...CAPTURED, checks: CAPTURED.checks.filter((check) => check.context !== "dependency-review") }, /security contexts missing/],
    [{ ...CAPTURED, checks: CAPTURED.checks.filter((check) => check.context !== "Lint") }, /removed before the aggregate/],
  ];
  for (const [state, pattern] of cases) {
    const plan = planProtectionStep(state, { aggregateObservedSuccess: true });
    assert.equal(plan.action, "blocked");
    assert.match(plan.reason, pattern);
  }
});

const PANE = { id: "pane-1", pid: 4242, repository: "juan294/gh-glance", host: "github.com", repositoryId: "R_1",
  accessKey: "a".repeat(64), tab: "actions", startedAt: 1_000, cadenceMs: 30_000 };
const QUOTA = { core: { limit: 5_000, remaining: 4_000 }, graphql: { limit: 5_000, remaining: 3_000 } };
const CANARY = { risk: "Actions refresh after a transport change", environment: "personal github.com, one running pane",
  pane: PANE, candidateHash: "b".repeat(64), durationMs: 300_000, quota: QUOTA, productReserve: { core: 500, graphql: 500 } };

test("CANARY-01 a valid canary is one existing Actions pane, five minutes, 20 admissions above the floor", () => {
  const plan = planCanary(CANARY);
  assert.equal(plan.ok, true, plan.problems?.join("\n"));
  assert.equal(plan.manifest.schema, 2);
  assert.deepEqual(plan.manifest.panes.map((pane) => pane.tab), ["actions"]);
  assert.equal(plan.manifest.requestedDurationMs, CANARY_LIMITS.maxDurationMs);
  assert.deepEqual(plan.budgets.core, { floor: 2_000, maxAdmissions: 20 });
  assert.match(plan.limitations.join("\n"), /does not qualify F12/);
});

test("CANARY-02 secondary tabs, spawned panes, long windows, missing risk and low quota are refused", () => {
  const cases = [
    [{ pane: { ...PANE, tab: "issues" } }, /Actions only, not issues/],
    [{ pane: { ...PANE, spawned: true } }, /may not start, restart or spawn/],
    [{ pane: null }, /one already running pane/],
    [{ durationMs: 300_001 }, /duration must be/],
    [{ risk: "" }, /named live risk/],
    [{ quota: { core: { limit: 5_000, remaining: 1_900 } } }, /core: remaining 1900 is at or below the floor 2000/],
    [{ quota: {} }, /no quota observation/],
    [{ quota: { core: { limit: null, remaining: 10 } } }, /core: quota unavailable/],
    [{ secondaryChecks: [{ tab: "issues", kind: "cadence" }] }, /one-shot/],
  ];
  for (const [override, pattern] of cases) {
    const plan = planCanary({ ...CANARY, ...override });
    assert.equal(plan.ok, false, String(pattern));
    assert.match(plan.problems.join("\n"), pattern);
  }
  assert.equal(planCanary({ ...CANARY, secondaryChecks: [{ tab: "prs", kind: "one-shot" }] }).ok, true);
  const tight = planCanary({ ...CANARY, quota: { core: { limit: 5_000, remaining: 2_010 } } });
  assert.deepEqual(tight.budgets.core, { floor: 2_000, maxAdmissions: 10 }, "only ten admissions fit above the floor");
});

test("CANARY-03 the stop rule counts every request and stops on unknown cost", () => {
  const { budgets } = planCanary(CANARY);
  assert.equal(canaryMayAdmit({ budgets, spent: { core: 19 }, resource: "core", charge: 1, remaining: 3_000 }).ok, true);
  assert.match(canaryMayAdmit({ budgets, spent: { core: 20 }, resource: "core", charge: 1 }).reason, /budget exhausted/);
  assert.match(canaryMayAdmit({ budgets, spent: {}, resource: "core", charge: 1, remaining: 2_000 }).reason, /cross the floor/);
  assert.match(canaryMayAdmit({ budgets, spent: {}, resource: "core", charge: null }).reason, /unknown charge stops/);
  assert.match(canaryMayAdmit({ budgets, spent: {}, resource: "search", charge: 1 }).reason, /no budget/);
});
