# Phase 5: sustained mixed-pane acceptance and activation evidence

Depends on: Phase 4. Stops after local verification and review.

## Deliverable

Extend the independent offline workload and process fixture to measure each eligible query's maximum interval between successful source observations, not only aggregate successes and changed-row p95. Include duplicate and distinct repositories, all four tabs, active/background changes, 200/304, a recoverable empty/partial acquisition lock, competing recoverers, suspended owners, a long unstarted claim, failed core and GraphQL observers separately, secondary hold, reset, and a collector-connected topology. Record exclusion windows only for holds that the fixture actually injected and that the runtime correctly reported. [Current Actions-only workload](../../../scripts/measure-efficiency.mjs:650), [current assertion](../../../test/efficiency.test.mjs:84), [workload events](../../../test/fixtures/workloads/multi-instance-v1.json:36)

```text
for each canonical query with demand:
  fail if no first validated source success by eligibility deadline
  collect validated source-success timestamps, due times, and hold intervals
  compute maxOverdue = max(successAt - priorNextDueAt outside named hold)
  fail with repository/resource/generation and event trace if over contract
also check per-generation producer count, actual request count,
  conservative settled cost, resource reserve, and access partition
```

Add real-process acceptance using a private temporary config root and fixture `gh`: start at least six panes spanning duplicate and distinct projects and active tabs; inject an orphan lock and a delayed owner; assert recovery after the exact wall-clock bound without process restart or manual `r`, one producer publication per generation, correct 200/304 freshness, and a finite observed maximum gap. Keep the wall-clock soak long enough to cross the lock bound and one overdue poll; use deterministic fake-clock tests for the 180-second claim boundary so the full PTY gate remains practical. [Current process test](../../../test/pty/shared-acquisition.test.mjs:57), [lock bound](../../../index.mjs:3555), [status PTY](../../../test/pty/status.test.mjs:673)

Add a local read-only freshness monitor under `scripts/` that receives an explicit expected pane/query manifest at pane launch, independent of the acquisition store. It samples the validated store for those expected repository/tab targets and records source-success timestamps, active/background demand, known holds, lock health, and per-query maximum eligible gap to a redacted JSONL report. It starts no GitHub request and does not persist access keys or tokens. A missing/corrupt store or expired/missing subscription for an expected live pane is unmeasured/failing, never treated as absent demand; an intentional pane exit closes its expectation with an explicit timestamp. Give it a fixture test that includes 200, 304, old unchanged rows, a blocked lock, and a frozen store whose subscribers have all expired while the independent pane manifest remains live. This monitor supports the 24-hour post-install readback without trusting a screenshot or `--doctor`'s aggregate counts. [Current metadata loader](../../../index.mjs:12832), [query diagnostics](../../../index.mjs:12370)

Validate the packed npm artifact locally (version/help/doctor/non-TTY/package boundary) and compare its source to the verified candidate. Capture command output, exact SHA, measured max gaps, and any exclusions in a phase validation file beside this plan. Re-run the full sequential verification gate once on the integrated candidate; do not substitute a targeted test for `test:efficiency` or `test:pty`. [Package boundary](../../../test/package-boundary.test.mjs:37), [CI/runtime commands](../../../CLAUDE.md:29)

## Automated success

- Every eligible query meets the main plan's per-query overdue bound; a single starved pane fails the run even if p95 and aggregate counts pass.
- Injected lock/owner/observer failures recover without a manual refresh and without violating reserve, access isolation, or generation fencing.
- Standalone and collector clients produce consistent source ages; a disconnected collector makes no local GitHub fallback request.
- The packed artifact runs the same verified code and all sequential gates pass.

## Manual and live success

Inspect PTY captures and the validation report. After separately authorized release/installation, stop all 0.15.1 panes before starting the new binary; preserve quota ledgers and last-good acquisition artifacts. Bring up several actual project panes under one installed version and observe source-success timestamps, doctor lock status, and governor remaining units for an initial 30 minutes and a 24-hour sustained window. Capture a redacted per-query max-gap report with explicit hold intervals. Record whether every due tab advances or has an explicit hold; do not label an unmeasured interval healthy. The agent should operate available CLI/browser paths for this activation; ask the user to handle a terminal pane only if those paths cannot safely preserve its session. Do not claim production recovery from offline tests alone. [Mixed-version lock boundary](../../../index.mjs:12952), [release workflow](../../../CLAUDE.md:53)

## Delivery boundary

The implementation candidate ends at verified local `develop` state and a reviewable validation report. Push, protected-main PR, GitHub Release, npm publication, installed-package update, and live-pane restart remain explicit later gates; the plan grants none of them. [Git workflow](../../../CLAUDE.md:53)
