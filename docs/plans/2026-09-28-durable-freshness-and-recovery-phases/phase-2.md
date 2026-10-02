# Phase 2: visible causes and usable diagnostics

Parent: [durable freshness and recovery](../2026-09-28-durable-freshness-and-recovery.md). Entry: accepted Phase 1 and unchanged verified protocol. Status: planned, not implemented.

## Scope

Implement D6 and F08. Current observer waiting overwrites cause at [index.mjs:16186](../../../index.mjs:16186); the banner depends on flags at [17908](../../../index.mjs:17908). Doctor currently avoids quota inspection without probing at [10043](../../../index.mjs:10043). Preserve source-success semantics at [16440](../../../index.mjs:16440).

1. Define one bounded structured recovery status: cause code, resource, first/last occurrence, next retry or explicit action, source observation age, receipt/debt totals and last failed transition. It must survive scheduling/observer handoffs until its actual condition changes.
2. Render plain-language cause and next action within two seconds of sustained failure. Keep cached age visible. Clear the cause when that condition ends; clear stale data only when source success actually advances. Limit terminal line width without dropping the only actionable instruction.
3. Extend read-only `--doctor` to inspect safe cached local scope evidence without API calls or mutation. Report uncertainty when scope cannot be established. Redact tokens, credential fingerprints, private payloads and raw owner nonces. Keep machine-readable acceptance diagnostics private and bounded: at most 128 recent transition entries per scope, 1 KiB per entry and 128 KiB total; payload-free summaries only. Diagnostic write failure must not block data acquisition.
4. Implement and document every parent stuck-state action. Never recommend deleting the quota directory, repeated login or manual refresh for internal capacity recovery. For genuinely unrecoverable corruption, include the exact local path/cause and `gh-glance --doctor` report action; do not silently reset accounting.
5. Update README troubleshooting/freshness documentation and changelog's unreleased entry to describe automatic recovery and truthful limitations. Do not mark the live incident resolved.

```text
@ presentRecovery(activeCause, sourceObservation, schedulerStatus) -> view
ctx: normal terminal, narrow terminal and accessible output
pre: source observation and scheduling progress are independent facts
do:
  1. select the actual unresolved cause with resource and deadline
  2. compute age only from validated complete source observations
  3. emit concise cause, retry or action and cached-data age
br: generic waiting cannot replace a specific unresolved failure
fail: unavailable diagnostic evidence is shown as unavailable
```

## Automated acceptance

- Each stuck-state row in the parent has a test reference in `phase-2-validation.md`, including completion-storage failure, old-version peers, unknown debt, permissions, corruption, overflow, secondary circuit and provider disconnect.
- Exercise normal and narrow PTY, `NO_COLOR` and screen-reader outputs. Assert meaningful cause/action text and clearing behavior, not whole-screen snapshots alone.
- Assert no freshness advancement from observer success, retry, heartbeat, cache adoption or incomplete response. Assert valid 304 does advance source observation.
- Assert read-only doctor makes zero API calls, writes no state and never emits fixture secrets. `--doctor --probe` remains separately governed and uses Phase 1 settlement.
- All five parent gates, independent review and simplify pass, sequentially. A local error hidden by observer waiting is a failed phase.

## Manual/live boundary and handoff

Visual inspection may supplement terminal assertions; it does not satisfy sustained freshness. No activation required. Save `phase-2-validation.md` with cause-to-test mapping, exact candidate and next Phase 3 entry. No batch-eligible unit because status and runtime code overlap.
