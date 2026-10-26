# Phase 1 — Truthful empty and recovery states

Parent: [first-run experience plan](../2026-10-25-first-run-experience.md). Depends on accepted plan. Accepted locally: implementation, independent review, repairs, simplify and all required gates passed. See [implementation notes](../2026-10-25-first-run-experience-notes.md).

## Scope and evidence

Implement CX-01 through CX-14 from the parent, with CX-13 limited to its Phase 1 layout/control/remedy criteria; discoverable Help and complete overflow access are Phase 2 acceptance. Own `index.mjs`, new `test/onboarding.test.mjs`, new `test/pty/onboarding.test.mjs`, affected recovery/status/layout tests, deterministic PTY fixtures, and the relevant README First run/freshness explanations. Relevant source: empty renderer `index.mjs:19982`, layout budget `:17079`, header visibility `:19826`, timestamp computation `:19688`, `presentRecovery` `:15763`.

## Work sequence

1. Write failing table-driven tests for unknown versus empty, failed cached emptiness, on-demand saved results, clock uncertainty, Security coverage, and successful recovery. Add PTY state-transition fixtures before the UI change. Use existing fake gh transport; exercise real production presentation and App. Update the obsolete text wait barriers in `test/pty/identity-migration.test.mjs:147` and `:173` as well as copy assertions in `test/pty/cache.test.mjs:158`.
2. Add pure `dashboardPresentation` with the parent precedence/copy contract. Keep internal recovery reason codes, `refreshStatus` kinds, accounting, `lastOkRef`, source-age calculations and refresh policy intact. Pass `hasSnapshot` explicitly to `presentRecovery`; absent timestamp with retained data is uncertain time, not no prior check. Missing optional metadata at other call sites keeps the existing conservative fallback.
3. Render tableless content when there are no rows. Suppress headings/separator/viewport count and width adjustment only in those states. Populated stale/error views retain rows and receive concise source-check/recovery context. No-remote setup retains precedence. Known empty but failed data is described as the last result.
4. Compute layout budget from the selected presentation: reserve rendered notice/security rows once, reclaim hidden table rows, and clamp contextual content by actual cell width/available height. The compact-table minimum must not suppress readable text-only states. Disable dragging and width mode when the table disappears; selection/viewport behavior returns when rows arrive.
5. Keep detailed reason/remedy available for Phase 2 help. In this phase preserve existing visible diagnostic remedies when a short summary cannot convey them. No unsupported “retrying automatically” statement for manual-only recovery.
6. Update README explanations for empty versus unverified versus saved data. Review, repair, simplify, verify, and record evidence.

```text
@ contextualPanelLayout(view, dimensions) -> layout
pre: view distinguishes table, empty content and global setup
do:
  1. compute chrome and notice rows actually rendered
  2. compute body capacity from terminal dimensions
  3. emit prioritized title, action and evidence lines within capacity
br: populated data -> preserve table; no data -> reclaim header and counter space
fx: width mode ends when its header disappears
fail: limited space -> retain concise state and usable controls
```

## Automated acceptance

- Every parent CX row has a named regression assertion and meaningful negative assertion; mutate the source-state input to demonstrate tests discriminate states.
- Future timestamp regression at `test/recovery.test.mjs:172` still rejects zero age and does not claim no check occurred.
- PTY transitions: waiting→empty, error→rows, cached-empty→failed→fresh-empty, Security incomplete→complete, table→empty during width mode→table, resize narrow→wide. No unbounded spinner on failure, no stale error after success, no phantom headers or width action.
- Default on-demand, `--background all`, and `--background off` retain their acquisition behavior. No new requests or timers are introduced for copy.
- Test 24/45/80/120 columns with 10/24 rows, `NO_COLOR=1`, and `INK_SCREEN_READER=true`. State/remedy stays understandable when color is absent. Preserve existing output-efficiency assertions.
- Required sequential gates: lint, syntax, full unit suite, full PTY suite. Add efficiency if scope touches acquisition/scheduling.

## Manual acceptance

Inspect deterministic screenshots/captures at 45×24 and 80×24: title, meaning, check evidence and action are readable without unused table chrome. Inspect 24×10 fallback. Record any visual limitation; do not claim user-study validation.

## Stuck states and recovery

Parent rows CX-03–CX-14 apply. Each waiting/failure fixture must either recover through the actual production retry path or expose the actual user remedy. No-source and unknown-clock-time must remain distinct after refresh. Failures must not erase useful rows or publish a successful timestamp.

## Work units and gate

One sequential unit; not batch-eligible because production source, layout tests and fixtures overlap. Independent read-only review checks state precedence and source-age truth. No remote actions. Stop after completed checks and phase handoff for acceptance.

## Completion evidence

- [x] CX-01 through CX-14 implemented, with CX-13 overflow/help deferred to the approved Phase 2 scope.
- [x] Independent review, all ten grouped findings resolved, and simplify completed.
- [x] Required sequential lint, syntax, unit and PTY gates passed on fingerprint `7138212d644d5c22f527679a8a43406e4193a484aee8b99d5ec829d41654b482`.
- [x] Visual captures inspected; limitations and all failed/interrupted attempts preserved in implementation notes.

Unit: 819 passed. PTY: 180 passed, 0 failed, 1 historical-baseline skip. Source runtime SHA256: `8eecd6fcb3171021e4cfa2c00fe809f3b93025ddf8069a1d8ac29899ae5ae483`. Phase 2 may now proceed under the owner's all-phases authorization.
