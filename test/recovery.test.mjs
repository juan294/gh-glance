import assert from "node:assert/strict";
import { test } from "node:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  emptyGovernorState,
  readGovernorState,
  recoveryCause,
  presentRecovery,
  recordRecoveryTransition,
  readRecoveryTransitions,
  shouldClearRecoveryCause,
  safeRecordRecoveryTransition,
  recoveryRetryAt,
  terminalizationRecoveryCode,
  terminalizationBacklogForResource,
  receiptCapabilityFromReservation,
  requestFailureRecoveryCode,
  wallClockRecovery,
  collectorSourceAdvanced,
  cleanupQueueForResource,
  scheduleIntents,
} from "../index.mjs";
import { agedGovernorV6 } from "./fixtures/aged-governor-v6.mjs";

test("D6: read-only v6 inspection does not create a migration backup or replace quota", (t) => {
  const root = mkdtempSync(join(tmpdir(), "gh-glance-recovery-read-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const path = join(root, `quota-${"a".repeat(64)}.json`);
  const now = Date.now();
  const raw = `${JSON.stringify(agedGovernorV6(emptyGovernorState(), now))}\n`;
  writeFileSync(path, raw);
  assert.equal(readGovernorState(path, now, { persistMigration: false }).ok, true);
  assert.equal(readFileSync(path, "utf8"), raw);
  assert.equal(existsSync(`${path}.pre-v7.backup`), false);
});

test("D6: success in one core tab cannot clear another tab's source failure", () => {
  const cause = recoveryCause({ reason: "network-outage", resource: "core", origin: "source", tab: "security" });
  assert.equal(shouldClearRecoveryCause(cause, { sourceSuccess: true, tab: "actions" }), false);
  assert.equal(shouldClearRecoveryCause(cause, { sourceSuccess: true, tab: "security" }), true);
  assert.equal(shouldClearRecoveryCause(cause, { sourceSuccess: false, tab: "security" }), false);
  assert.equal(shouldClearRecoveryCause(recoveryCause({ reason: "busy", resource: "core" }), {
    sourceSuccess: false, tab: "actions" }), true);
});

test("D6: scheduled grants clear only transient causes after a confirmed hold write", () => {
  for (const reason of ["busy", "stale", "acquisition-busy"]) {
    const cause = recoveryCause({ reason, resource: "core" });
    assert.equal(shouldClearRecoveryCause(cause, {
      scheduledHold: { ok: true, value: "cleared" },
    }), true, reason);
    for (const scheduledHold of [
      { ok: true, value: "already-clear" },
      { ok: true, value: "retained" },
      { ok: false, reason: "unwritable" },
      { ok: false, reason: "stale-hold" },
    ]) {
      assert.equal(shouldClearRecoveryCause(cause, { scheduledHold }), false,
        `${reason}: ${scheduledHold.value ?? scheduledHold.reason}`);
    }
  }
  for (const reason of ["unwritable", "corrupt", "capacity", "accounting-overflow",
    "unsafe-permissions", "disk-full", "coordination", "receipt-retry", "request-queue",
    "legacy-unresolved", "probe-failed", "rate-limit", "secondary", "network-outage"]) {
    assert.equal(shouldClearRecoveryCause(recoveryCause({ reason, resource: "core" }), {
      scheduledHold: { ok: true, value: "cleared" },
    }), false, reason);
  }
  assert.equal(shouldClearRecoveryCause(recoveryCause({
    reason: "busy", resource: "core", origin: "source", tab: "actions",
  }), { scheduledHold: { ok: true, value: "cleared" } }), false);
});

test("D6: recovery cause maps resource, action, retry and cached age without raw errors", () => {
  const at = Date.now();
  const cases = [
    ["busy", "core", /other panes/i, /retry/i],
    ["receipt-retry", "core", /saving request result/i, /retry/i],
    ["interrupted-request", "core", /interrupted request/i, /retry/i],
    ["request-queue", "core", /local request queue/i, /retry/i],
    ["accounting-overflow", "core", /local coordination/i, /doctor/i],
    ["capacity", "core", /local coordination/i, /doctor/i],
    ["unwritable", "core", /local coordination/i, /doctor/i],
    ["corrupt", "core", /local coordination/i, /doctor/i],
    ["legacy-corrupt", "core", /older coordination/i, /doctor/i],
    ["disk-full", "core", /local coordination/i, /doctor/i],
    ["unsafe-permissions", "core", /local coordination/i, /doctor/i],
    ["legacy-unresolved", "core", /older requests/i, /restart/i],
    ["migration-hold", "core", /older session/i, /retry|wait/i],
    ["restart-required", "core", /older session/i, /restart/i],
    ["version-mismatch", "core", /older session/i, /restart/i],
    ["identity-backoff", "graphql", /budget check/i, /retry/i],
    ["probe-failed", "graphql", /budget check/i, /retry/i],
    ["identity-capacity", "graphql", /budget check/i, /retry/i],
    ["rate-limit", "core", /quota/i, /retry/i],
    ["reset", "core", /quota/i, /retry/i],
    ["priority", "core", /background/i, /retry/i],
    ["rate-limited", "core", /request limit/i, /retry/i],
    ["local-reserve", "core", /reserve/i, /retry/i],
    ["secondary", "graphql", /request limit/i, /retry/i],
    ["secondary-rate-limit", "graphql", /request limit/i, /retry/i],
    ["abuse-limit", "core", /request limit/i, /retry/i],
    ["throttle-paused", "core", /request limit/i, /press r/i],
    ["network-outage", "core", /connection/i, /retry/i],
    ["reservations-invalid", "core", /local coordination/i, /doctor/i],
    ["external-factor-invalid", "core", /local coordination/i, /doctor/i],
    ["pacing-invalid", "core", /local coordination/i, /doctor/i],
    ["budget-resource", "core", /local coordination/i, /doctor/i],
    ["credential-unavailable", "core", /login/i, /gh auth/i],
    ["auth-problem", "core", /authorization/i, /gh auth/i],
    ["unavailable", "core", /unavailable/i, /check/i],
    ["disconnected", "core", /collector/i, /connection/i],
    ["app-auth", "core", /app authorization/i, /restore/i],
    ["security-incomplete", "core", /incomplete/i, /doctor/i],
    ["clock-recovery", "core", /sleep|clock/i, /retry/i],
  ];
  for (const [reason, resource, causePattern, actionPattern] of cases) {
    const cause = recoveryCause({ reason, resource, at, retryAt: at + 60_000, sourceAt: at - 3_600_000,
      raw: "ghp_ABCDEFGHIJKLMNOPQRST private response" });
    assert.equal(cause.resource, resource);
    assert.match(cause.summary, causePattern);
    assert.match(cause.action, actionPattern);
    assert.equal(cause.sourceAt, at - 3_600_000);
    assert.doesNotMatch(JSON.stringify(cause), /ghp_|private response/);
    const normal = presentRecovery(cause, { nowMs: at, cols: 100 });
    assert.match(normal.join(" "), causePattern);
    assert.match(normal.join(" "), actionPattern);
    assert.match(normal.join(" "), /cached 1h/i);
    const narrow = presentRecovery(cause, { nowMs: at, cols: 24 });
    assert.ok(narrow.every((line) => line.length <= 23), narrow.join("\n"));
    assert.match(narrow.join(" "), /cached 1h/i);
    assert.match(narrow.join(" "), /doctor|retry|auth|connection|restart|check|wait|press r/i);
    if (reason === "legacy-unresolved") assert.match(narrow.join(" "), /Check children; restart/);
    if (reason === "migration-hold") assert.doesNotMatch(narrow.join(" "), /restart/i);
    if (reason === "migration-hold") assert.match(narrow.join(" "), /next \d+[smh]/i);
  }
});

test("D6: planner denials name their own cause instead of the coordination fallback", () => {
  const now = 1_000_000;
  const resetMs = now + 300_000;
  const budget = { limit: 5000, remaining: 2000, used: 3000, resetMs, observedAt: now };
  const leases = { lease: { expiresAt: now + 90_000, phaseSeed: { seed: "lease", registeredAt: now } } };
  const intent = (priority) => ({ id: priority, leaseId: "lease", tab: "actions", priority,
    expiresAt: resetMs + 90_000 });
  // An external drain pushes the shared lane past the quota reset, the 0.16.0
  // incident in which every new pane read "retry when storage works".
  const reset = scheduleIntents({ intents: [intent("active")], leases, budgets: { core: budget },
    lanes: { core: { nextAt: resetMs + 60_000 } }, nowMs: now }).denied[0];
  const priority = scheduleIntents({ intents: [intent("background")], leases, budgets: { core: budget },
    lanes: { core: { nextAt: now + 7_000 } }, nowMs: now, deferFutureBackground: true }).denied[0];
  for (const [denial, causePattern] of [[reset, /quota/i], [priority, /background/i]]) {
    const cause = recoveryCause({ reason: denial.reason, resource: "core", retryAt: denial.retryAt });
    assert.equal(cause.code, denial.reason);
    assert.match(cause.summary, causePattern);
    assert.doesNotMatch(presentRecovery(cause, { nowMs: now, cols: 80 }).join(" "), /storage|doctor/i);
  }
});

test("D6: a long recovery action still exposes cached age at 80 columns", () => {
  const now = Date.now();
  for (const reason of ["legacy-unresolved", "corrupt", "migration-hold"]) {
    const lines = presentRecovery(recoveryCause({ reason, resource: "core",
      sourceAt: now - 3_600_000, retryAt: now + 60_000 }), { nowMs: now, cols: 80 });
    assert.match(lines.join(" "), /cached 1h/i, reason);
    assert.ok(lines.length <= 3 && lines.every((line) => line.length <= 79), reason);
  }
});

test("D6: clock rollback does not call a future source observation fresh", () => {
  const now = Date.now();
  const cause = recoveryCause({ reason: "clock-recovery", resource: "core", sourceAt: now + 60_000 });
  assert.match(presentRecovery(cause, { nowMs: now, cols: 80 }).join(" "), /cached age unavailable/i);
  assert.doesNotMatch(presentRecovery(cause, { nowMs: now, cols: 80 }).join(" "), /cached 0s/i);
});

test("D6: recovery journal is bounded, payload-free, survives handoff and clears only on resolution", (t) => {
  const root = mkdtempSync(join(tmpdir(), "gh-glance-recovery-journal-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const scope = { path: join(root, `quota-${"a".repeat(64)}.json`) };
  const at = Date.now();
  const first = recoveryCause({ reason: "unwritable", resource: "core", at, sourceAt: at - 10_000 });
  assert.equal(recordRecoveryTransition(scope, first).ok, true);
  const handoff = readRecoveryTransitions(scope);
  assert.equal(handoff.current.core.code, "unwritable");
  assert.equal(handoff.current.core.firstAt, at);
  assert.equal(recordRecoveryTransition(scope, { ...first, at: at + 1000 }).ok, true);
  assert.equal(readRecoveryTransitions(scope).current.core.firstAt, at);
  for (let index = 0; index < 200; index += 1) {
    const event = recoveryCause({ reason: index % 2 ? "busy" : "unwritable", resource: "core",
      at: at + index + 2000, sourceAt: at - 10_000, raw: `private-${index}` });
    assert.equal(recordRecoveryTransition(scope, event).ok, true);
  }
  const journal = readRecoveryTransitions(scope);
  assert.ok(journal.entries.length <= 128);
  assert.ok(readFileSync(`${scope.path}.recovery.json`).byteLength <= 128 * 1024);
  assert.doesNotMatch(readFileSync(`${scope.path}.recovery.json`, "utf8"), /private-/);
  assert.equal(recordRecoveryTransition(scope, { resource: "core", clear: true, at: at + 5000 }).ok, true);
  assert.equal(readRecoveryTransitions(scope).current.core, null);
  const blocked = recordRecoveryTransition({ path: join(root, "absent", "quota.json") }, first);
  assert.equal(blocked.ok, false);
});

test("D6: recovery journal survives an earlier event clock and repairs retained timestamp skew", (t) => {
  const root = mkdtempSync(join(tmpdir(), "gh-glance-recovery-clock-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const scope = { path: join(root, "quota.json") };
  const at = Date.now();
  const cause = (time) => recoveryCause({ reason: "busy", resource: "core", at: time });

  assert.equal(recordRecoveryTransition(scope, cause(at)).ok, true);
  assert.equal(recordRecoveryTransition(scope, cause(at - 500)).ok, true);
  const afterRollback = readRecoveryTransitions(scope);
  assert.equal(afterRollback.status, "healthy");
  assert.equal(afterRollback.current.core.firstAt, at - 500);
  assert.equal(afterRollback.current.core.at, at - 500);

  const path = `${scope.path}.recovery.json`;
  const retained = JSON.parse(readFileSync(path, "utf8"));
  retained.current.core.firstAt = at + 500;
  writeFileSync(path, JSON.stringify(retained));
  const repairedRead = readRecoveryTransitions(scope);
  assert.equal(repairedRead.status, "healthy");
  assert.equal(repairedRead.current.core.firstAt, at - 500);
  assert.equal(repairedRead.entries.length, retained.entries.length);
  assert.equal(recordRecoveryTransition(scope, cause(at + 1000)).ok, true);
  assert.equal(readRecoveryTransitions(scope).status, "healthy");
  assert.equal(JSON.parse(readFileSync(path, "utf8")).current.core.firstAt, at - 500);
});

test("D6: valid-shaped private strings cannot become recovery codes or doctor text", (t) => {
  const root = mkdtempSync(join(tmpdir(), "gh-glance-recovery-private-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const scope = { path: join(root, "quota.json") };
  const event = recoveryCause({ reason: "private-secret-value", resource: "core",
    lastFailedTransition: "private-secret-value" });
  assert.equal(event.code, "coordination");
  assert.equal(event.lastFailedTransition, "coordination");
  assert.equal(recordRecoveryTransition(scope, event).ok, true);
  assert.doesNotMatch(readFileSync(`${scope.path}.recovery.json`, "utf8"), /private-secret-value/);
  const corrupted = JSON.parse(readFileSync(`${scope.path}.recovery.json`, "utf8"));
  corrupted.current.core.code = "private-secret-value";
  writeFileSync(`${scope.path}.recovery.json`, JSON.stringify(corrupted));
  assert.equal(readRecoveryTransitions(scope).status, "corrupt");
});

test("D6: same resource and failure code in a new tab starts a new causal transition", (t) => {
  const root = mkdtempSync(join(tmpdir(), "gh-glance-recovery-tabs-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const scope = { path: join(root, "quota.json") };
  const at = Date.now();
  const cause = (tab, time) => recoveryCause({ reason: "network-outage", resource: "core",
    origin: "source", tab, at: time });
  assert.equal(recordRecoveryTransition(scope, cause("security", at)).ok, true);
  assert.equal(recordRecoveryTransition(scope, cause("actions", at + 1)).ok, true);
  const journal = readRecoveryTransitions(scope);
  assert.equal(journal.current.core.tab, "actions");
  assert.equal(journal.current.core.firstAt, at + 1);
  assert.equal(journal.entries.at(-1).tab, "actions");
});

test("D6: a diagnostic writer exception stays advisory", () => {
  const result = safeRecordRecoveryTransition({ path: "/unused" },
    recoveryCause({ reason: "unwritable", resource: "core" }), () => {
      throw new Error("fixture storage fault");
    });
  assert.equal(result.ok, false);
  assert.equal(result.reason, "unavailable");
});

test("D6: observer retries use persisted attempt time while pacing uses provider deadline", () => {
  const at = Date.now();
  const budget = { resetMs: at + 3_600_000, blockUntil: 0 };
  assert.equal(recoveryRetryAt({ mode: "probe", reason: "budget-stale" }, budget,
    { nextAt: at + 60_000 }, at), at + 60_000);
  assert.equal(recoveryRetryAt({ mode: "probe", reason: "budget-reset" }, budget,
    { nextAt: at + 60_000 }, at), budget.resetMs);
  assert.equal(recoveryRetryAt({ mode: "paused", reason: "secondary-rate-limit" },
    { ...budget, blockUntil: at + 300_000 }, { nextAt: at + 60_000 }, at), at + 300_000);
  assert.equal(recoveryRetryAt({ mode: "probe", reason: "budget-stale" }, budget,
    { nextAt: at - 1 }, at), null);
  for (const reason of ["reservations-invalid", "external-factor-invalid", "pacing-invalid", "budget-resource"]) {
    assert.equal(recoveryRetryAt({ mode: "paused", reason }, budget,
      { nextAt: at + 60_000 }, at), null, reason);
  }
});

test("D6: actual terminal and transport outcomes select the retained recovery cause", () => {
  assert.equal(terminalizationRecoveryCode({ status: "retryable", reason: "busy" }), "receipt-retry");
  assert.equal(terminalizationRecoveryCode({ status: "compacted", reason: "stale" }), "interrupted-request");
  assert.equal(terminalizationRecoveryCode({ status: "blocked", reason: "completion-capacity" }), "capacity");
  assert.equal(requestFailureRecoveryCode({ httpStarted: true }, "other"), "interrupted-request");
  assert.equal(requestFailureRecoveryCode({ httpStarted: true }, "auth-problem"), "auth-problem");
  assert.equal(requestFailureRecoveryCode({ httpStarted: true }, "unavailable"), "unavailable");
  assert.equal(requestFailureRecoveryCode({}, "rate-limited"), "rate-limited");
  assert.equal(requestFailureRecoveryCode({}, "other"), "network-outage");
});

test("D6: wall-clock rollback and suspend select a source recheck", () => {
  assert.equal(wallClockRecovery(10_000, 9_000, 5_000), "clock-recovery");
  assert.equal(wallClockRecovery(10_000, 45_000, 5_000), "clock-recovery");
  assert.equal(wallClockRecovery(10_000, 15_000, 5_000), null);
  let previousAt = 10_000;
  for (let at = 15_000; at <= 55_000; at += 5_000) {
    assert.equal(wallClockRecovery(previousAt, at, 5_000), null,
      `healthy liveness tick at ${at} ms must not look like a suspend`);
    previousAt = at;
  }
});

test("D6: cached collector snapshots do not clear source failures", () => {
  const previousServerSuccess = 42_000;
  assert.equal(collectorSourceAdvanced(previousServerSuccess, previousServerSuccess), false);
  assert.equal(collectorSourceAdvanced(previousServerSuccess, previousServerSuccess - 1), false);
  assert.equal(collectorSourceAdvanced(previousServerSuccess, null), false);
  assert.equal(collectorSourceAdvanced(previousServerSuccess, previousServerSuccess + 1), true);
  assert.equal(collectorSourceAdvanced(undefined, previousServerSuccess), false,
    "a first cached replay only establishes the server baseline");
  assert.equal(collectorSourceAdvanced(previousServerSuccess, previousServerSuccess + 1), true);
});

test("D6: one resource's pending cleanup cannot retain another resource's notice", () => {
  const scopeHash = "scope-one";
  const dashboardCapability = receiptCapabilityFromReservation("reservation-one", {
    leaseId: "lease-one", costs: { core: 0, graphql: 1 }, receipt: {
      scopeHash, ownerNonce: "owner", generation: "generation", deadline: 60_000,
    },
  });
  const backlog = new Map([["graphql", {
    scope: { hash: scopeHash }, capability: dashboardCapability,
  }]]);
  assert.equal(terminalizationBacklogForResource(backlog, scopeHash, "core"), 0);
  assert.equal(terminalizationBacklogForResource(backlog, scopeHash, "graphql"), 1);
  assert.equal(terminalizationBacklogForResource(backlog, "scope-two", "graphql"), 0);
  backlog.delete("graphql");
  assert.equal(terminalizationBacklogForResource(backlog, scopeHash, "graphql"), 0);

  const queue = new Set([{ cleanupKey: "issues" }]);
  assert.equal(cleanupQueueForResource(queue, "core"), 0);
  assert.equal(cleanupQueueForResource(queue, "graphql"), 1);
  queue.clear();
  assert.equal(cleanupQueueForResource(queue, "graphql"), 0);
});

test("D6: capacity-blocking unknown debt displays its exact reserved units", () => {
  const cause = recoveryCause({ reason: "legacy-unresolved", resource: "core", debtUnits: 456 });
  for (const cols of [80, 24]) {
    const lines = presentRecovery(cause, { cols });
    assert.match(lines.join(" "), /456/);
    assert.match(lines.join(" "), /units/);
  }
});
