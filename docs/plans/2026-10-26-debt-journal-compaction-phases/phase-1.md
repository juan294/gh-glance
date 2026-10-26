# Phase 1 — Journal compaction and the `debt-journal-full` reason

Parent: [debt-journal compaction plan](../2026-10-26-debt-journal-compaction.md). Depends on the accepted plan. Status: not started.

## Scope and evidence

Implement AC-1 through AC-6 and AC-8 from the parent. Own `index.mjs`, `test/governor.test.mjs`, `test/recovery.test.mjs`, and the Unreleased section of `CHANGELOG.md`. Relevant source: `debtGroupTarget` `index.mjs:4583-4597`, `transferReceiptToDebt` `:4599-4647`, `makeDebtGroupQuiescent` `:4649-4671`, `retireControlReceiptToDebt` `:4673-4690`, `reconcileBootDebt` `:4695-4709`, `compactGovernorReceipts` `:4711-4780`, `mutateGovernor` `:5190-5235`, claim snapshot `:5465-5486`, `retireClaimedQuiescentDebt` `:5609-5635`, `failProbeClaim` `:5792-5820`, `RECOVERY_COPY` `:15702-15716`, `recoveryRetryAt` `:15792-15806`, `recordRuntimeRecovery` `:18035-18070`. Test helpers: `sandbox` `test/governor.test.mjs:129`, `lease` `:148`, `publishInitial` `:170`, `testDebtGroup` `:238`, the existing overflow test `:3774-3797`.

## Work sequence

1. Write the failing regression first (AC-1/AC-2). Build the researched shape with `testDebtGroup` extended by `resource`, `owner` and `bootId` options: 120 GraphQL and 8 core quiescent single-unit groups, 126 with an `ownerNonce`, one at `UNKNOWN_DEBT_GROUP_ID`, debt totals set to match; started control receipts for both resources with one terminal dispatch and a generation that has no group. Persist with `writeGovernorState`, then assert `claimProbe(..., "graphql")` currently returns `accounting-overflow`. Flip the assertion to `ok: true` as the target. Add AC-3, AC-4, AC-5, AC-8 cases in the same block, each asserting the file is byte-identical on rejection and that `normalizeGovernorState` accepts every written state.
2. Add `DEBT_JOURNAL_COMPACT_AT = 64` next to `GOVERNOR_MAX_DEBT_GROUPS` and implement `compactQuiescentDebtGroups` per the parent contract. Call it in `mutateGovernor` after the second `reconcileBootDebt`; fold its `changed` into the migration clone condition so a rejected mutator still persists the compacted journal.
3. Change `transferReceiptToDebt` and `retireControlReceiptToDebt` to return `null | reason`. Update the nine call sites listed in the parent consumer sweep to return `{ ok: false, reason }` with the reason received. In `compactGovernorReceipts` keep the trial early return for a missing target.
4. Add `"debt-journal-full"` to `RECOVERY_COPY` with copy `["Local coordination journal is full", "Retry automatically; older requests settle within an hour", "Journal full; retry"]`. Give it a retry time in `recoveryRetryAt`: earliest non-quiescent `group.at + IDENTITY_UNCERTAIN_MAX_MS` from the ledger summary when available, otherwise `nowMs + BUDGET_PROBE_MS`. Do not add it to `storageFailures` or to the hard list in `recoveryRetryAt`. Extend the D6 copy table and the clear-rule list in `test/recovery.test.mjs:64-83`.
5. Add the CHANGELOG Unreleased entries under Fixed: the deadlock, and the new transient notice. Review, repair, simplify, verify, record evidence in the notes file.

```text
@ mutateGovernor pipeline (changed section)
ctx: governor lock held; state loaded
do:
  1. reconcileBootDebt (existing)
  2. compactGovernorReceipts (existing)
  3. reconcileBootDebt (existing)
  4. compactQuiescentDebtGroups(state, at)  (new)
  5. migration = any changed ? clone : null (existing, extended)
br: compaction reason "accounting-overflow" -> return it before mutate
fx: compacted journal persists even when the mutator rejects
```

```text
@ recoveryRetryAt for "debt-journal-full"
pre: summary may be null (unreadable ledger)
do:
  1. lookup oldest non-quiescent group settle time from summary
  2. compute min(settle, nowMs + BUDGET_PROBE_MS), floor at nowMs + 1s
  3. emit finite time (never null)
```

## Automated acceptance

- AC-1, AC-2: the researched-shape test passes after the change and demonstrably failed on the baseline (record the baseline failure output in the notes).
- AC-3: `debt-journal-full` from a full non-quiescent journal; no write; finite retry; recovery after `IDENTITY_UNCERTAIN_MAX_MS + 1`.
- AC-4: skip during a live claim; compact after lease expiry; publish after compaction deletes the merged group and leaves `debt.*.quiescentUnits` at 0.
- AC-5: every state written by the new tests round-trips through `normalizeGovernorState` and `serializeGovernorState`; group count after compaction is ≤ 1 per bootId plus non-quiescent groups.
- AC-6: copy and clear-rule tests; `recordRuntimeRecovery` is exercised through the existing recovery suite patterns so the new code is classified transient.
- AC-8: `acknowledgeSealedGeneration` for a merged-away generation returns `{ status: "absent" }`.
- Existing suites unchanged: `test/governor.test.mjs:3774` (true overflow stays `accounting-overflow`), `test/scheduling-policy.test.mjs:458`, `test/fixtures/aged-governor-v6.mjs`.
- Gates, sequential: `npm run lint; node --check index.mjs; npm test; npm run test:efficiency`.

## Manual acceptance

None in this phase beyond reading the diff. The owner-machine check is in the parent's manual acceptance and runs after Phase 2.

## Stuck states and recovery

Parent table rows 1 to 3 and 5 apply. Each has a named test above. The hard `accounting-overflow` remains reachable only through safe-integer checks and keeps its existing test.

## Work units and gate

One sequential unit; not batch-eligible (one source file, overlapping tests). Independent read-only review checks snapshot safety (no compaction under a live claim), totals preservation and that no caller still maps a reason to the wrong code. No remote actions. Stop after gates and handoff for acceptance.
