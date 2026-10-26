# Debt-journal compaction implementation notes

## Authorization and identity

The owner authorized all phases without stopping, local integration into `develop` and removal of the task worktree afterwards ("now, all phases, no stopping. When done merge to develop and prune tree", 2026-10-26). No push or publication is authorized.

Baseline: `d46132e` on `develop`. Implementation branch: `fix/debt-journal-compaction`. Worktree: `/Users/juan/code/gh-glance-debt-journal`. Runtime: Node v24.22.1 on macOS. The research document, plan and phase files were copied unchanged from the main checkout, where they were untracked at planning time. An unrelated worktree `/Users/juan/code/gh-glance-remediate-wave1-20261026` (branch `remediate/wave1-20261026`) belongs to another session and was not touched.

One implementation owner (this session) per phase; an independent reviewer agent in a fresh context reviews each phase diff before acceptance.

## Deviations

- Plan said: build the researched ledger shape with started control receipts for both resources. Found: `claimProbe` only retires the GraphQL control receipt; the core receipt is retired by `startIdentityControl`, which needs the identity coordinator and is not reachable from the governor unit tests. Chose: the regression test carries the GraphQL control receipt only. Why: the code path from `retireControlReceiptToDebt` down is shared by both resources and is what the test exercises.
- Plan said: existing suites pass unchanged. Found: `test/governor.test.mjs` "a full debt journal defers compaction so an old-boot observer can free space" asserted that the expired child stayed detailed through the publication because the journal was still full at claim time. With compaction the journal has free slots at the claim, so the child is sealed there (into an unresolved unknown-child group, since its dispatch never reported terminal) and the publication still retires all 128 snapshot units. Chose: update that test's final expectations to the new timing (quiescent 0, unresolved 1, reservation sealed). Why: the test's original concern, that a snapshot taken over a full journal can be retired by one publication, still holds and is still asserted; only the sealing moment moved earlier, which is the intended effect.

## Phase 1

Tests were written first and failed on the baseline with the expected reasons (`accounting-overflow` instead of a successful claim, `accounting-overflow` instead of `debt-journal-full`, 128 groups instead of 1 after compaction, `coordination` copy instead of the new reason).

Gate on the candidate (`d46132e` plus the uncommitted Phase 1 diff, 3 files), run sequentially from `/private/tmp/claude-501/-Users-juan-code-gh-glance/db09f381-1709-4e6b-9145-c0f158d2340b/scratchpad/phase1-gate.log`: `npm run lint` pass, `node --check index.mjs` pass, `npm test` 836/836 pass, `npm run test:efficiency` 9/9 pass (99.6 s).

### Phase 1 independent review

Reviewer (fresh-context agent, read-only) verdict on the first candidate: request changes, no blockers. It re-ran the governor and recovery suites (138 pass) and confirmed the four new tests fail on the baseline `index.mjs` with the recorded reasons. Findings and dispositions:

- Snapshot safety, totals invariant, caller mapping, migration write, acknowledgement path, efficiency: no issue (findings 1, 2, 3, 5, 6, 11).
- Finding 4 (should-fix): the runtime ignored a failed mutation's `retryAt` in `publishControlStatus`'s observer branch and showed the stale observer `nextAt`. Fixed: a finite `refreshed.retryAt` now wins. Evidence limit: no unit test, because that branch is a closure inside the dashboard component and reaching it needs the PTY harness with a full-journal fixture.
- Finding 10 (should-fix): CHANGELOG and notes were missing at review time; both exist now. Baseline failures recorded: test 1 `{"ok":false,"reason":"accounting-overflow"}`; test 2 actual `accounting-overflow`, expected `debt-journal-full`; test 3 actual 128 groups, expected 1; recovery copy actual `coordination`.
- Finding 7 (nit): exact group counts asserted (3 after compaction in test 1, 1 after publication in the pre-existing test); test 1 now round-trips the compacted state through `serializeGovernorState` and `normalizeGovernorState` (AC-5).
- Finding 8 (nit): test 2's control receipt carries an explicit `bootId` so the result does not depend on `coordinationBootId()` on the host.
- Finding 9 (nit): all `accounting-overflow` literal returns use the frozen `ACCOUNTING_OVERFLOW` constant.
- AC-6: the `storageFailures` exclusion is verified by reading `recordRuntimeRecovery`, not by a test, for the same component-internal reason.

### Phase 1 simplify pass

Four read-only cleanup reviewers (reuse, simplification, efficiency, altitude) read the reviewed diff. Efficiency: nothing material (every new pass is bounded by 128 groups). Altitude: compaction sits at the right layer; the modified pre-existing test records intended timing, not a regression. Applied:

- Threshold derived as `GOVERNOR_MAX_DEBT_GROUPS / 2` so compaction can never sit above the cap.
- `newDebtGroup` factory used by the migration site, `transferReceiptToDebt` and the merge, so one group shape exists in the runtime.
- `debtGroupSettlesAt` shared by `reconcileBootDebt` and `debtJournalFullFailure`, which now also honours a live claim's `leaseUntil` as an unblock event.
- `hasLiveProbeClaim` shared by compaction and the doctor status.
- `Map.groupBy` bucketing and array folds in `compactQuiescentDebtGroups`.
- `compactGovernorReceipts` trial branch defers on the transfer's own `debt-journal-full` reason instead of a duplicate `debtGroupTarget` lookup.
- Every `retireControlReceiptToDebt` caller names its result `failure`.
- Tests: `testDebtGroup` gained `resource`, `ownerNonce` and `bootId`; the duplicate `journalDebtGroup`, the `journalTotals` helper and its redundant assertions, the unused `fillJournal` return value and `owner` callback were removed; `journalControlReceipt` takes a positional `bootId`.

Skipped with reasons: converting `makeDebtGroupQuiescent` to the `null | failure` convention (pre-existing mix, four callers outside the change); a shared `sumDebtGroups` helper (the three reduce sites differ in shape); replacing the `Number.isFinite(refreshed?.retryAt)` guard with `??` (keeps a non-finite value out of the scheduler); returning inline literals instead of `ACCOUNTING_OVERFLOW` (the independent reviewer asked for the constant); a second compaction pass before receipt sealing (one mutation of delay, units stay charged meanwhile).

Targeted tests (10), lint and `node --check` pass on the simplified candidate; the full gate is recorded below.

Phase 1 final gate on the simplified candidate (`d46132e` plus the uncommitted diff: index.mjs, test/governor.test.mjs, test/recovery.test.mjs, CHANGELOG.md; 355 insertions, 66 deletions), log `phase1-gate3.log` in the session scratchpad: `npm run lint` pass, `node --check index.mjs` pass, `npm test` 836/836 pass, `npm run test:efficiency` 9/9 pass. Phase 1 accepted locally and committed on `fix/debt-journal-compaction`.
