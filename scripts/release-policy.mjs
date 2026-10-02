// Pure release policy: the add-before-remove protection migration (used by
// scripts/release.mjs) and the bounded live-canary plan (a library the
// playbook and README point to). No I/O here.

import { validManifest } from "./freshness-monitor.mjs";

// --------------------------------------------------- protection migration

export const AGGREGATE_CONTEXT = "Release candidate";
export const LEGACY_CONTEXTS = ["Lint", "Test (Node 22)", "Test (Node 24)", "Smoke (Node 22)", "Smoke (Node 24)", "PTY"];
export const SECURITY_CONTEXTS = ["analyze (javascript-typescript)", "dependency-review"];
export const GITHUB_ACTIONS_APP_ID = 15368;

// `current` is GET .../branches/main/protection/required_status_checks.
// Returns the next single PATCH body for that endpoint (which changes only the
// required checks; reviews, admin enforcement and the rest are untouched), or
// done/blocked. Strictness is always preserved. The aggregate is required
// only once it has been observed succeeding, and legacy contexts are removed
// only after the aggregate is already required, so no state between steps is
// weaker than the starting one.
export function planProtectionStep(current, { aggregateObservedSuccess }) {
  // GitHub reports "any app" as app_id null but takes -1 for it in a PATCH;
  // omitting it would rebind the context to the last reporting app.
  const checks = (current?.checks ?? []).map(({ context, app_id: appId }) => ({ context, app_id: appId ?? -1 }));
  const contexts = new Set(checks.map((check) => check.context));
  const expected = new Set([...LEGACY_CONTEXTS, ...SECURITY_CONTEXTS, AGGREGATE_CONTEXT]);
  const drift = [...contexts].filter((context) => !expected.has(context));
  if (current?.strict !== true) return { action: "blocked", reason: "strict up-to-date checks are not enabled; unknown drift" };
  if (drift.length > 0) return { action: "blocked", reason: `unexpected required contexts: ${drift.join(", ")}` };
  const missingSecurity = SECURITY_CONTEXTS.filter((context) => !contexts.has(context));
  if (missingSecurity.length > 0) return { action: "blocked", reason: `security contexts missing: ${missingSecurity.join(", ")}` };
  const hasAggregate = contexts.has(AGGREGATE_CONTEXT);
  const legacyLeft = LEGACY_CONTEXTS.filter((context) => contexts.has(context));
  if (!hasAggregate) {
    if (!aggregateObservedSuccess) {
      return { action: "wait", reason: `${AGGREGATE_CONTEXT} has not been observed succeeding on a release PR` };
    }
    if (legacyLeft.length !== LEGACY_CONTEXTS.length) {
      return { action: "blocked", reason: "legacy contexts were removed before the aggregate was required" };
    }
    return { action: "add-aggregate", body: { strict: true,
      checks: [...checks, { context: AGGREGATE_CONTEXT, app_id: GITHUB_ACTIONS_APP_ID }] } };
  }
  if (legacyLeft.length > 0) {
    return { action: "retire-legacy", body: { strict: true,
      checks: checks.filter((check) => !LEGACY_CONTEXTS.includes(check.context)) } };
  }
  return { action: "done" };
}

// -------------------------------------------------------- live canary plan

export const CANARY_LIMITS = { maxDurationMs: 5 * 60_000, maxAdmissionsPerResource: 20,
  floorFraction: 0.4 };

// A canary is optional and only for a named live risk. It observes ONE already
// running pane held on Actions for at most five minutes, through the existing
// schema-2 monitor, which describes continuously active Actions only. Secondary
// views get separate one-shot checks, never a cadence window.
export function planCanary({ risk, environment, pane, candidateHash, durationMs, quota, productReserve,
  secondaryChecks = [] }) {
  const problems = [];
  if (!risk || !environment) problems.push("a canary needs a named live risk and an exact environment");
  if (!pane) problems.push("a canary observes one already running pane; none was supplied");
  else {
    if (pane.tab !== "actions") problems.push(`the continuous window covers Actions only, not ${pane.tab}`);
    if (pane.spawned) problems.push("the canary may not start, restart or spawn panes");
  }
  if (!Number.isSafeInteger(durationMs) || durationMs <= 0 || durationMs > CANARY_LIMITS.maxDurationMs) {
    problems.push(`duration must be between 1 ms and ${CANARY_LIMITS.maxDurationMs} ms`);
  }
  const budgets = {};
  for (const [resource, observed] of Object.entries(quota ?? {})) {
    if (!Number.isSafeInteger(observed?.limit) || !Number.isSafeInteger(observed?.remaining)) {
      problems.push(`${resource}: quota unavailable`);
      continue;
    }
    const floor = Math.max(Math.ceil(observed.limit * CANARY_LIMITS.floorFraction), productReserve?.[resource] ?? 0);
    const spendable = Math.min(CANARY_LIMITS.maxAdmissionsPerResource, observed.remaining - floor);
    if (spendable <= 0) problems.push(`${resource}: remaining ${observed.remaining} is at or below the floor ${floor}`);
    budgets[resource] = { floor, maxAdmissions: Math.max(0, spendable) };
  }
  if (Object.keys(budgets).length === 0) problems.push("no quota observation; the budget cannot be bounded");
  for (const check of secondaryChecks) {
    if (!["issues", "prs", "security"].includes(check.tab) || check.kind !== "one-shot") {
      problems.push(`secondary check ${JSON.stringify(check)} must be a one-shot Issues, PRs or Security assertion`);
    }
  }
  if (problems.length > 0) return { ok: false, problems };
  const manifest = { schema: 2, candidateHash, requestedDurationMs: durationMs, sampleIntervalMs: 5_000,
    panes: [{ id: pane.id, pid: pane.pid, repository: pane.repository, host: pane.host,
      repositoryId: pane.repositoryId, accessKey: pane.accessKey, tab: "actions",
      startedAt: pane.startedAt, cadenceMs: pane.cadenceMs }] };
  try {
    validManifest(manifest);
  } catch (error) {
    return { ok: false, problems: [`monitor rejects the manifest: ${error.message}`] };
  }
  return { ok: true, manifest, budgets, secondaryChecks,
    limitations: ["source freshness only; rendered rows need a separate bounded capture",
      "other clients' traffic is unmeasured", "does not qualify F12 personal or work EMU windows"] };
}

// Stop rule while a canary runs. Setup, quota reads and comparisons count too;
// an unknown charge stops new requests rather than being assumed free.
export function canaryMayAdmit({ budgets, spent, resource, charge, remaining }) {
  const budget = budgets[resource];
  if (!budget) return { ok: false, reason: `${resource} has no budget` };
  if (!Number.isSafeInteger(charge)) return { ok: false, reason: "unknown charge stops new requests" };
  if ((spent[resource] ?? 0) + charge > budget.maxAdmissions) return { ok: false, reason: `${resource} budget exhausted` };
  if (Number.isSafeInteger(remaining) && remaining - charge < budget.floor) {
    return { ok: false, reason: `${resource} would cross the floor ${budget.floor}` };
  }
  return { ok: true };
}
