# Phase 3: accumulated-state and sustained acceptance

Parent: [durable freshness and recovery](../2026-09-28-durable-freshness-and-recovery.md). Entry: accepted Phases 1–2. Status: planned, not implemented.

## Scope

Implement F09–F11 and package-level F01. Existing monitor exclusions and duration logic are at [scripts/freshness-monitor.mjs:159](../../../scripts/freshness-monitor.mjs:159), [218](../../../scripts/freshness-monitor.mjs:218), [252](../../../scripts/freshness-monitor.mjs:252), [326](../../../scripts/freshness-monitor.mjs:326). Efficiency exclusions currently use injected/reported labels at [scripts/measure-efficiency.mjs:93](../../../scripts/measure-efficiency.mjs:93).

1. Extend the external-request oracle and production-function simulation to 72 hours, at least 10,000 admissions and 1,000 faulted/interrupted operations. Include 1/6/10-pane cohorts, duplicate/distinct repositories, all tabs, repeated resets, short/long sleeps, identity changes, crash windows and completion-storage failures. Preserve existing one-hour efficiency gates.
2. Independently record request issue/finish, actual response cost, receipt/debt state, acquisition generation and source success. Reconcile every charge and transition. Reset/counter advancement alone cannot hide unresolved transports. Use deterministic seeds and record them.
3. Set expected cadence in the fixture/cohort manifest, not from production `nextDueAt`. Use parent F10 deadlines; keep quota-insufficient scenarios distinct and verify explicit paced operation. At least one unmodified-baseline reproduction must fail for actual source staleness, not just a schema mismatch.
4. Strengthen the standalone monitor with requested/actual elapsed duration, sample coverage, monotonic timing, source clock checks, exact candidate hash, expected pane/repo/tab/host/identity cohort and observer/debt diagnostics. Require a sample every five seconds and fail an unexplained gap exceeding 15 seconds. An expected pane disappearing is failure. SIGINT before full duration produces incomplete evidence and nonzero exit.
5. Allow exclusions only with independently captured external evidence, such as a provider rejection/reset header or a measured network outage; require scope and interval. An `observer`, `coordination`, or `disconnected` label by itself grants no exclusion. Report total wall time, external outage duration and eligible duration separately. Sleep marks a gap and requires a new uninterrupted window for the 24-hour qualification; separately prove resume recovery.
6. Pack the candidate and run the actual extracted CLI under PTY with fixture `gh` on PATH and isolated roots. Seed aged v6, change a run from queued to running to completed and assert rendered values, source timestamps and oracle latency. Exercise optional modes for regression without making them prerequisites for standalone success.

```text
@ qualifyFreshness(manifest, samples, externalEvidence) -> report
ctx: independent cohort clock and source-response oracle
pre: manifest fixes candidate identity, cohort, cadence and requested duration
do:
  1. validate duration, sample continuity, cohort presence and timestamp order
  2. compute source deadlines from declared cadence and recovery contract
  3. match external exclusions to independent scope and interval evidence
  4. emit failures and both total and eligible observation windows
br: internal coordination holds always count against freshness acceptance
fail: interruption, missing evidence or a local stall prevents success
```

## Automated acceptance

- `test/freshness-monitor.test.mjs` must prove the monitor rejects early SIGINT, missing pane, zero new successes, far-future `nextDueAt`, forged observer exclusion, incorrect candidate hash and sampling/clock gaps. Legitimate evidenced provider holds remain visibly accounted for.
- The multi-day oracle must fail if started records regain indefinite detailed retention, if debt is dropped on reset, if any completion caller ignores persistence failure, or if source time advances on retries alone. Include these targeted mutation checks or equivalent demonstrated negative controls.
- The packed CLI test must fail against 0.15.2's reproduced cap and pass against the candidate without private entry points or manual recovery. Package boundaries and default existing-gh authentication behavior remain intact.
- All five sequential parent gates, independent review and simplify. Save generated JSON plus concise Markdown evidence with exact SHA, package SHA-256, fixture seed and measured maxima. Private paths/identities are not committed.

## Manual/live boundary and handoff

Local package testing does not prove real GitHub or EMU freshness. Save `phase-3-validation.md` with all F01–F11 dispositions and a complete Phase 4 activation manifest template populated from available evidence; unknown live fields must be discovered before activation, never filled with guessed values. No batch-eligible units because fixture/oracle contracts depend on each other.
