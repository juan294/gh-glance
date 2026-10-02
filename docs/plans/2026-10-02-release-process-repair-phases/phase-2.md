# Phase 2: explicit test selections and reliable evidence

Parent: [release process repair](../2026-10-02-release-process-repair.md). Entry: accepted Phase 1. Status: planned.

## Outcome and scope

Resolve A02/A03 and G04/G05/G06/G09, with fixture-first support for A05/G08. Add genuinely fast commands while preserving complete coverage and real fixture semantics. No product change, GitHub call, package publication or live pane launch is required.

Read [package scripts:16](../../../package.json:16), [sustained oracle:6](../../../test/sustained-recovery.test.mjs:6), [package boundary:61](../../../test/package-boundary.test.mjs:61), [capture helper:465](../../../test/pty/capture.mjs:465), [identity children:46](../../../test/identity-process.test.mjs:46), and the six fixtures below before editing.

## Changes and test-first sequence

1. Add a small test-selection module/runner under `scripts/`, with node:test tests under `test/`. First prove that every discovered test file has an owner, no required selection is empty, unknown paths select broad coverage, selected commands aggregate failures, and excluded files do not spawn module-level captures. Keep `npm test`'s full existing contract.
2. Add `test:fast`, `test:recovery`, `test:package`, `test:pty:smoke`. Extract the cheap reconciliation rejection cases from [sustained-recovery.test.mjs:43](../../../test/sustained-recovery.test.mjs:43) so fast feedback still exercises them. Keep all sustained 72-hour/admission/interruption/debt/freshness invariants unchanged in recovery. Keep E2E efficiency workloads separate; they must not run implicitly through fast. Cheap existing non-E2E checks in `test/efficiency.test.mjs` remain in fast coverage.
3. Separate pure pack-manifest parsing tests from network-dependent installation. Reuse one helper for the exact five-file allowlist, installed executable, blocked import surface, version/help and bin linkage. `test:package` can create a tarball for standalone developer use, but candidate CI passes the already packed explicit path and forbids repacking. An injected invalid path, missing file, wrong version or broken bin must fail. Update [package-boundary.test.mjs:98](../../../test/package-boundary.test.mjs:98)'s script-shape assumptions to behavior assertions.
4. Build the terminal smoke from existing startup/Actions/navigation/quit, cached-age and recovery scenarios, exercising the installed candidate via an explicit binary path. Reuse the cached-age assertion at [adaptive-polling.test.mjs:361](../../../test/pty/adaptive-polling.test.mjs:361); do not add another broad charter. Move costly module-level captures in e2e/keys into lazy, bounded setup. Smoke excludes exhaustive mouse/layout/load cases by explicit inventory, with full PTY retaining them.
5. Add failure-retention ownership to capture/streaming helpers without breaking their normal result contracts or `readme-sample.mjs`. A capture stages bounded raw terminal bytes, parsed frames, fixture gh call timings and runtime/platform/deadline metadata into a private task directory. Retain the bundle when the child fails or when an outer assertion later fails; delete it only after the test's successful completion. Use a supported test wrapper/teardown contract verified against Node 22/24, not an assumed TestContext property. Scrub credential/environment values, cap retained data at 2 MiB per failed case and 20 MiB per job, and label truncation. CI uploads failure-only evidence with seven-day retention. State/credential files are excluded.
6. Repair remaining identity fixture races: give each case one absolute outer budget; each child gets only its remaining bounded share, leaving explicit shutdown margin. Wait for all siblings to finish or terminate and close them before deleting shared state. Preserve the first failure and aggregate sibling failures. Prove forced early rejection, long child and teardown ownership without weakening one-proof or allowance assertions. Do not attribute these adjacent gaps to a historical run without proof.
7. Replace broad scratch-sensitive lint input with an explicit source/test/script scope or narrowly verified generated-evidence excludes. Include every tracked executable JS/MJS file that belongs to the product/tooling, including new scripts; do not hide actual test/tool code. Put new scratch programs outside the checkout. Test lint scope with one ignored scratch diagnostic and one real source diagnostic.
8. Update command consumers together: package scripts, docs/rules, PR template, coverage command assumptions and runtime coverage runner. Keep full PTY file execution serial; per-case process concurrency stays real. The normal full test inventory and coverage denominator remain transparent.

## Six regressions that must survive

| Case | Existing behavioral oracle |
| --- | --- |
| CI-FIXTURE-01 | [identity-transport.test.mjs:277](../../../test/identity-transport.test.mjs:277): immediate/10-second delayed admission acquires fresh permits afterward. |
| CI-FIXTURE-02 | [status.test.mjs:867](../../../test/pty/status.test.mjs:867): Paused then Watching with measured fast recovery and no spurious recovery notice. |
| CI-FIXTURE-03 | [webhooks.test.mjs:721](../../../test/webhooks.test.mjs:721) and [:798](../../../test/webhooks.test.mjs:798): setup phase/readiness separated from unchanged signed delivery deadline. |
| CI-FIXTURE-04 | [identity-process.test.mjs:138](../../../test/identity-process.test.mjs:138): controlled busy state, bounded retry, release and allSettled before cleanup. |
| CI-FIXTURE-05 | [adaptive-polling.test.mjs:100](../../../test/pty/adaptive-polling.test.mjs:100): injected latency, previous response completion to next start. |
| CI-FIXTURE-06 | [keys.test.mjs:31](../../../test/pty/keys.test.mjs:31): actual Actions/Issues rows before keys/quit, with delayed provider setup. |

These are retained tests, not six new copies. Any changed assertion names the invariant it still checks and the mutation that makes it fail.

## Nontrivial behavior

```text
@ selectChecks(diff, reviewedProfile) -> inventory
ctx: tracked tests, explicit ownership, complete candidate diff
pre: known base/head or broad fallback
do:
  1. parse changed paths and test inventory
  2. validate requested profile against broad defaults and review evidence
  3. compute required commands and explicit exclusions
  4. emit exact file selections and reasons
fail: empty required selection or unowned test -> fail
```

```text
@ finishFixture(children, result, evidence) -> result
ctx: owned child handles, private capture directory
do:
  1. validate ownership and remaining shutdown deadline
  2. compute all child completion outcomes
  3. write bounded redacted evidence on any failure
  4. emit first failure and evidence location before owned cleanup
br: success -> remove staged diagnostics; failure -> retain bundle
fail: child cannot terminate -> fail and disclose retained owned path
```

## Verification and acceptance

Use R02/R03/R04, plus package portions of R05/R08 and offline canary portions of R10. Exercise real subprocesses and tarballs; only network/clock/provider boundaries are simulated. New behavior follows red → green. Run focused tests first, independent review, repair and simplify; then sequentially run `npm run lint`, `node --check index.mjs`, `npm test`, `npm run test:efficiency`, `npm run test:pty`. Run the new fast/package/smoke selections to establish their actual inventory and duration; reuse those results if unchanged. Run coverage once only if its selection/denominator changes, recording the changed basis.

Measure setup, command, cleanup and total duration on exact Node/platform inputs. Test enclosing budgets against declared setup + child/work + shutdown + margin; do not merely raise every timeout. Fast <=2 minutes is the target, not a reason to omit an invariant. Report a miss with its responsible case. Preserve all earlier failed results.

Native macOS BSD smoke is available locally. Use an existing local Linux environment if available; otherwise mark Linux-native results `UNVERIFIED` until the first authorized candidate workflow. The workflow must run GNU smoke and affected Unix-socket behavior; a simulated `script` argument test alone is not platform execution. Candidate workflows run the small BSD smoke on a hosted macOS runner as part of the later authorized CI scope. Do not create an experimental remote run merely for this phase.

Manual criteria: inspect one representative retained failure bundle for useful redacted evidence and one terminal smoke rendering only where visual judgment is needed. Automated frame/row/exit assertions remain authoritative for machine-checkable behavior.

## Work units and handoff

No batch-eligible implementation split initially: selection, package helper and capture ownership share tests/configuration. A parent may delegate bounded read-only fixture review; one integration owner edits/contracts and runs final suites. Save exact test inventory, duration results, platform gaps and all six regression pointers. Next entry: accepted Phase 2 with runnable selectors and reusable package exercise, then Phase 3. No claimed release speed or live recovery result follows from these tests.
