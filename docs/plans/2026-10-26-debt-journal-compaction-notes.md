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

## Phase 2

Baseline for this phase: `290d8ed` (Phase 1 committed). Tests were added before the runtime change was evaluated against them: on the Phase 1 runtime with only the `readIdentityQuotaState` export added, "doctor reports debt-journal occupancy" fails (no `debt groups` line) and "doctor names the state file and the three-file remedy" fails (no `repair` line); "a known identity with a missing ledger is corrupt" passes on both because it documents the pre-existing guard that made the owner's first quarantine attempt show `corrupt`.

One pre-existing test, "--doctor reports governor health without a raw scope identifier", failed on the first Phase 2 candidate because the `state file` line was shown whenever the cached read was not `ok`, which in probe mode (no cached read at all) printed the `coordination-v2` directory. The condition now matches the original (`cachedQuota.ok === false`) or a hard recovery reason. The full doctor suite (41) passes.

Deviation: plan step 1 asked for a governor-level test that a scope with no registry file yields a fresh ledger through the identity refresh. Found: identity refresh succeeds in both cases (verified with a scratch probe); the `corrupt` outcome arises later in `startIdentityControl`, which is not reachable from the unit tests. Chose: export `readIdentityQuotaState` and test the guard directly with a registry object that knows the quota key versus an empty one. Why: it is the exact function that produced the observed notice, and the test states the contract the repair text depends on.

### Phase 2 independent review

Reviewer (fresh-context agent, read-only) verdict on the first Phase 2 candidate: request changes, no blockers. It ran the doctor suite (41 pass) and the doctor binary against four scratch configuration roots. Findings and dispositions:

- Finding 1 (should-fix): the `repair` line only printed when a readable ledger's journal held a hard reason, so the two cases the remedy exists for (ledger missing with the registry still listing it, which is the owner's observed `corrupt` case, and an unparseable ledger) showed no remedy. Fixed: a failed cached read whose reason is hard, or is `cached quota missing` with a path (the `readIdentityQuotaState` guard case), now also triggers the `state file` and `repair` lines. The registry-guard test now runs the binary against that state and asserts both lines. This closes the plan's stuck-state row for a ledger moved aside while `registry.json` still lists its identity.
- Finding 2 (should-fix): the overspend bound named only debt units; receipts stay charged too. Reworded to "receipt and debt units below (when shown)".
- Finding 3 (test): the exact-key journal assertion now records a cause carrying `debtGroups`/`quiescentGroups` so the projection is exercised.
- Finding 5 (nit): `storageFailures` alias removed; the source-origin list spreads `HARD_STORAGE_REASONS`.
- Finding 11 (nit): CHANGELOG names the `debt groups` field and the missing/unreadable case.
- Findings 4, 6 to 10: no issue (TDZ, probe-mode redaction, `recoveryDetails.core` sufficiency, file names, test determinism, export precedent).

### Phase 2 simplify pass

Four read-only cleanup reviewers (reuse, simplification, efficiency, altitude) read the approved diff. Efficiency: nothing material. Altitude raised two structural points, both applied:

- Doctor classifies a missing or unreadable ledger through the runtime's own guard. `doctorCachedQuotaScope` now calls `readIdentityQuotaState` (with a new `options` passthrough so the doctor read never persists a migration) instead of re-deriving the missing-but-registered case from a doctor-only string. A missing ledger for a registry-listed key reports `unavailable (corrupt)`, the same reason the pane shows, and an unreadable ledger reports `unwritable`, which is hard; both now get the `repair` line.
- Journal occupancy (`debtGroups`, `quiescentGroups`) lives on `governorHealth`, the resource-independent projection doctor already prints, and `recoveryLedgerSummary` is back to its original shape. The journal-key assertion and the explicit occupancy arguments in the doctor test went away with the carrier.

Also applied: `LEDGER_REPAIR_ADVICE` and `STICKY_OVER_SOURCE_REASONS` constants beside `HARD_STORAGE_REASONS`; `recoveryRetryAt` spreads the hard list; the `ledgerPath`/`cachedFailure`/`hardRecovery` triple collapsed to one predicate; the paraphrasing comments trimmed; `test/fixtures/debt-group.mjs` exports `testDebtGroup` for both test files; `redactedStateFile(root)` and `REPAIR_LINE` replace three hand-built regexes in the doctor tests. The governor health key-set test now lists the two count fields.

Skipped with reasons: dropping the direct `readIdentityQuotaState` unit assertions (they state the fresh-registry branch the binary run cannot show); folding the empty-journal doctor spawn into another test (it documents the baseline line on its own); a `snapshotFile` helper for the "doctor never writes" pattern (three sites, each two lines).

The Phase 2 reviewer was asked to re-check the structural change; its verdict and the final gate are recorded below.

Post-simplify review verdict: approve (179 targeted tests re-run by the reviewer; four read-only doctor runs covering missing, unparseable, permission-denied and hard-journal ledgers, directory unchanged in each, no quota key printed). Two no-change nits: the `state file` condition relies on `&&` binding tighter than `||`, and the move-files advice is less apt for `unwritable`, which the plan included deliberately.

Phase 2 final gate on the simplified candidate (`290d8ed` plus index.mjs, test/doctor.test.mjs, test/governor.test.mjs, test/fixtures/debt-group.mjs, CHANGELOG.md), log `phase2-gate3.log` in the session scratchpad: `npm run lint` pass, `node --check index.mjs` pass, `npm test` 839/839 pass, `npm run test:pty:smoke` 7/7 pass. Phase 2 accepted locally.

## Integration and handoff

Both phases are committed on `fix/debt-journal-compaction` and merged into `develop` locally. No push, release or publication was authorized or performed; `develop` is ahead of `origin/develop` by these commits. The task worktree was removed after integration; the plan, phase files, research and these notes are tracked in the repository.

Remaining manual acceptance (owner's work machine): after the next release that carries this change, `gh-glance --doctor` should show `debt groups` and the three avolta-ag panes should refresh. The owner already recovered that machine on 2026-10-26 by moving the ledger, its journal and `registry.json` aside. Open research item, unchanged: why probes failed in sub-second bursts on 2026-10-19.

Integration gate on merged `develop` (`2a74385`, which also carries another session's `461474b`), log `integration-gate.log` in the session scratchpad: `npm run lint` pass, `node --check index.mjs` pass, `npm test` 841/841 pass, `npm run test:efficiency` 9/9 pass, `npm run test:pty:smoke` 7/7 pass. Worktree and branch removed after this record.
