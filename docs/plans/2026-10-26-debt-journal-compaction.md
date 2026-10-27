# Debt-journal compaction implementation plan

Date: 2026-10-26. Status: planned, not started. Research: [accounting-overflow debt-journal deadlock](../research/2026-10-26-accounting-overflow-debt-journal-deadlock.md).

## Objective and baseline

Stop a full quiescent debt-group journal from pinning every pane of a host+identity scope behind `Local coordination accounting overflow`. After this plan, a ledger in the researched shape recovers on the first mutation after upgrade, a journal that is genuinely full reports its own transient reason instead of borrowing the hard `accounting-overflow` one, and `--doctor` shows journal occupancy and the manual remedy for the hard reasons that remain.

Revalidated baseline: `develop` at `d46132e` (one CI-pin commit after the research's `0fb18b9`; `index.mjs` unchanged, every cited line re-anchored on 2026-10-26), `/Users/juan/code/gh-glance`, package 0.17.0, Node v24.22.1. Untracked at planning start: the research document only. Preserve it. The work machine's ledger copies stay outside the repository (its Desktop and this session's scratchpad); the plan reproduces their shape synthetically.

Controlling contracts: `CLAUDE.md`, `AGENTS.md`, the RPI and push-accountability rules, `.rpi/rules/testing.md` (TDD for behavioral change), the rpi-plan skill and its pseudocode and handoff references. Single-file runtime, Node test runner, no build step. Sutura owns CI routing: no workflow, routing, settings, credential or publication changes. Implementation happens in a local worktree or temporary branch; no push or PR is authorized by this plan.

## Evidence and decisions

| Evidence | Decision |
| --- | --- |
| `GOVERNOR_MAX_DEBT_GROUPS = 128` at `index.mjs:3891`; `debtGroupTarget` returns `null` at `index.mjs:4595` when every group is quiescent; the only deletion of groups is `retireClaimedQuiescentDebt` at `index.mjs:5609-5635`, reachable only through `publishProbe` at `index.mjs:5686` | Add a compaction step that merges quiescent groups before the cap is reached, so retirement never depends on a probe that the full journal blocks. |
| Reproduction on the real ledger: `claimProbe("graphql")` returns `accounting-overflow` while `readGovernorState` and `governorChargedCost` succeed (research, "Ledger state") | The regression oracle is a synthetic ledger with 128 quiescent single-unit groups plus a started control receipt with one terminal dispatch; `claimProbe` for GraphQL must succeed after the change. |
| `retireClaimedQuiescentDebt` compares a claim-time snapshot (`index.mjs:5471-5486`) with eligibility recomputed at publish (`index.mjs:5613-5620`); a mismatch returns `false` and becomes `accounting-overflow` | Compaction runs only when no probe claim is live for any resource, so no snapshot can be invalidated. A merged group takes `barrierAt = max`, `barrierRevisions = max per resource`, so a later claim sees it as eligible exactly when every member would have been. |
| Group validation at `index.mjs:4293-4312` requires `ownerNonce`/`ownerPid`/`ownerBirth` nullable, `unknownChild`/`sealed`/`quiescent` booleans, and totals equal to the group sums at `index.mjs:4315-4325` | A merged group is `{ ownerNonce: null, ownerPid: null, ownerBirth: null, bootId, unknownChild: true, sealed: true, quiescent: true }` with summed units/counts. Totals are unchanged, so no state-version bump and no migration. |
| `acknowledgeSealedGeneration` looks a group up by generation and returns `absent` when missing (`index.mjs:6100-6101`); the dispatch release path only acknowledges when the group still exists (`index.mjs:784-786`) | Merging quiescent groups away is safe for owners: an absent group is already the acknowledged outcome. Non-quiescent groups are never merged. |
| `transferReceiptToDebt` and `retireControlReceiptToDebt` return booleans (`index.mjs:4599`, `4673`); every caller maps `false` to `accounting-overflow` (`index.mjs:3307`, `3522`, `3578`, `4736`, `4744`, `4768`, `4777`, `5459`, `5807`) | Return a failure reason instead of a boolean: `null` on success, `"debt-journal-full"` when no slot exists, `"accounting-overflow"` for a safe-integer failure. Callers pass the reason through. |
| `recoveryRetryAt` returns `null` for `accounting-overflow` (`index.mjs:15792-15796`); `recordRuntimeRecovery` lists it in `storageFailures` (`index.mjs:18045`); `RECOVERY_COPY` tells the user to run doctor (`index.mjs:15710`) | `debt-journal-full` is a transient coordination reason with retry copy. It is not added to the hard-failure lists. Its retry time is the earliest moment a non-quiescent group can settle (`group.at + IDENTITY_UNCERTAIN_MAX_MS`, `index.mjs:2926`), capped at one `BUDGET_PROBE_MS` (`index.mjs:2321`). |
| Doctor prints per-resource debt units from `recoveryLedgerSummary` (`index.mjs:11338-11350`, `16186-16211`) and the state-file path only when the cached read failed (`index.mjs:11328`) | Add journal occupancy to the summary and one `debt groups` line to the governor section. When the current recovery reason is a hard storage reason, print the state-file path and the manual remedy (quit panes, move the ledger, its `.recovery.json` and `registry.json` aside). |
| `readIdentityQuotaState` returns `corrupt` for a missing ledger whose `quotaKey` the registry still knows (`index.mjs:3278-3283`); observed 2026-10-26 on the work machine after moving only the two quota files. A missing `registry.json` starts empty (`withIdentityRegistry`, ENOENT branch) and the identity re-derives the same `quotaKey` (`index.mjs:3387-3388`) | The disclosed remedy must name all three files. The guard itself stays: it is what stops a deleted ledger from silently dropping debt. |
| Observed burst: 120 GraphQL groups in 89 minutes at sub-second spacing; the probe backoff is 60 s (`index.mjs:5813-5818`) | INFERRED: the groups came from sealed data-receipt generations (`compactGovernorReceipts`, `index.mjs:4760-4777`), one per hung `gh` child past `ACQUISITION_STARTED_DEADLINE_MS` (`index.mjs:13492`), not from the observer alone. The plan makes any such storm harmless; it does not change sealing or deadlines. A separate trace is needed before touching those. |
| Memory: "No release-pipeline hardening" rejects new gates and machinery | No new CLI flag. Recovery is automatic; the manual remedy is disclosure in the existing doctor report. |

## Options considered

1. Raise `GOVERNOR_MAX_DEBT_GROUPS`. Delays the deadlock without removing it; the file grows and the same publish dependency remains. Rejected.
2. Let `debtGroupTarget` reuse a quiescent group when full. Breaks `retireClaimedQuiescentDebt`'s invariant that quiescent units are frozen under a snapshot, and would re-open a group an owner already acknowledged. Rejected.
3. Compact quiescent groups into one aggregate per boot while no claim is live, and give a full journal its own transient reason. Keeps every existing invariant, needs no migration, and heals ledgers already wedged in the field on their first mutation after upgrade. Selected.
4. A `--doctor --repair` flag that quarantines the ledger. Adds a destructive CLI path for a state option 3 already recovers from. Rejected; doctor discloses the manual remedy instead for the hard reasons that remain.

## Scope and phase gates

1. [Phase 1: journal compaction and the `debt-journal-full` reason](2026-10-26-debt-journal-compaction-phases/phase-1.md).
2. [Phase 2: doctor occupancy and remedy disclosure](2026-10-26-debt-journal-compaction-phases/phase-2.md).

Both phases edit `index.mjs` and `test/governor.test.mjs`-adjacent suites, so there are **no batch-eligible units**. One implementation owner per phase; independent read-only review before acceptance; phases accepted sequentially. No push, PR or release is part of this plan.

Out of scope: changing `ACQUISITION_STARTED_DEADLINE_MS`, receipt sealing, probe cadence, the reservation cap, state version, collector protocol, CI, or a release. The cause of the 2026-10-19 probe failures stays an open research item.

## Shared behavior contract

```text
@ compactQuiescentDebtGroups(state, at) -> { changed }
pre: debt totals equal group sums (loader invariant); no probeClaims[r] with leaseUntil > at
do:
  1. count groups; return unchanged when count < DEBT_JOURNAL_COMPACT_AT (64)
  2. select quiescent groups, bucket by bootId
  3. for each bucket with 2+ members: write one merged group (sum units/counts, max at/barrierAt/barrierRevisions, ownerNonce null, unknownChild true, sealed true, quiescent true)
  4. delete merged members; keep non-quiescent groups untouched
br: live claim for any resource -> return { changed: false } (snapshot safety)
fx: mutates state.debtGroups only; debt totals and revisions unchanged
fail: a merged sum that is not a safe integer -> return { changed: false, reason: "accounting-overflow" }
risk: UNKNOWN_DEBT_GROUP_ID is a member like any other; the merged group gets a fresh governorId
```

```text
@ transferReceiptToDebt(state, receipt, nowMs, groupId) -> null | reason
ctx: debtGroupTarget, existing unit arithmetic
do:
  1. compute units (unchanged)
  2. lookup target group; none -> "debt-journal-full"
  3. validate safe-integer sums; failure -> "accounting-overflow"
  4. apply charge (unchanged)
br: all units zero -> null without lookup
fx: same mutations as today
```

`retireControlReceiptToDebt` returns the same `null | reason`. `mutateGovernor` runs `compactQuiescentDebtGroups` after the second `reconcileBootDebt` (`index.mjs:5212-5214`) and includes its `changed` flag in the migration write, so a rejected mutation still persists the compacted journal.

## Automated acceptance (plan level)

- AC-1: a synthetic ledger with 128 quiescent single-unit groups (120 GraphQL, 8 core, two unknown-child among them, one at `UNKNOWN_DEBT_GROUP_ID`) and started core/GraphQL control receipts with one terminal dispatch each: `claimProbe(scope, lease, now, "graphql")` returns `ok: true`, the persisted journal has at most one quiescent group per bootId plus the new dedicated group, and `debt` totals equal the sums before and after.
- AC-2: the same ledger before the change fails with `accounting-overflow` (the test is written first and fails on the baseline).
- AC-3: 128 non-quiescent unknown-child groups: a transfer returns `debt-journal-full`, the file is byte-identical afterwards, `recoveryRetryAt` returns a finite time, and after advancing the clock past `IDENTITY_UNCERTAIN_MAX_MS` the next mutation quiesces, compacts and succeeds.
- AC-4: compaction is skipped while any `probeClaims[r].leaseUntil > at`; after the lease expires the next mutation compacts; a claim taken after compaction publishes and `retireClaimedQuiescentDebt` deletes the merged group entirely.
- AC-5: `normalizeGovernorState` accepts every compacted state produced by the tests; `serializeGovernorState` round-trips it.
- AC-6: recovery copy for `debt-journal-full` matches `/journal/i` and `/retry/i`; `shouldClearRecoveryCause` and `recordRuntimeRecovery` treat it as transient (not in `storageFailures`).
- AC-7: doctor prints `debt groups  <n>/128 (<q> quiescent)`, and for a current hard reason prints the state-file path and remedy line; snapshot tests at `test/doctor.test.mjs:333-374` still pass.
- AC-8: the acknowledgement path with a merged-away generation returns `absent` and does not throw.
- Gates per phase, sequential: `npm run lint; node --check index.mjs; npm test; npm run test:efficiency` (Phase 1 touches governor scheduling); `npm run test:pty:smoke` for Phase 2 (doctor output is rendered by the binary).

## Manual acceptance

Run `node index.mjs --doctor` in a checkout against a scratch `XDG_CONFIG_HOME` containing a copied wedged ledger (the researched one is available on the owner's work machine) and confirm the governor section reads `debt groups 128/128 (128 quiescent)` before the first run of the dashboard and at most `2/128` after one refresh. Then confirm the three avolta-ag panes refresh. This is the only acceptance step that needs the owner's machine; record its outcome in the notes file.

## Stuck states and recovery

| State | Who sees what | How it ends | Proof |
| --- | --- | --- | --- |
| Journal full of quiescent groups (field ledgers from 0.17.0 and earlier) | Nothing: the first mutation after upgrade compacts before the claim | Automatic | AC-1, AC-2 |
| Journal full of non-quiescent groups (128 unsettled generations, no compaction candidates) | Pane notice `Local coordination journal is full / Retry automatically; older requests settle within an hour`, next retry time shown | Automatic once groups pass `IDENTITY_UNCERTAIN_MAX_MS` or an owner acknowledges them | AC-3 |
| Live probe claim prevents compaction at the cap | Same notice while the claim lease (70 s) lasts | Automatic on lease expiry | AC-4 |
| Genuine safe-integer overflow in debt arithmetic | Existing `accounting overflow / Run gh-glance --doctor` notice | Manual: doctor now prints the ledger path and the quarantine steps (ledger, its journal and `registry.json`) | AC-7 |
| Ledger moved aside while `registry.json` still lists its identity | `Local coordination is corrupt. No successful check is available yet.` | Manual: the same doctor remedy names `registry.json`; AC-7 asserts the line | AC-7 |
| Compaction produces a state the loader rejects | Would surface as `corrupt` | Prevented, not recovered: AC-5 asserts acceptance for every produced shape | AC-5 |

## Consumer sweep

Search commands run 2026-10-26 on `d46132e`: `grep -an "transferReceiptToDebt\|retireControlReceiptToDebt\|debtGroupTarget" index.mjs`, `grep -an "debtGroups" index.mjs test/*.mjs test/fixtures/*.mjs`, `grep -an "accounting-overflow" index.mjs test/*.mjs`, `grep -an "recoveryLedgerSummary\|recoveryDetails" index.mjs`.

| Consumer | Disposition |
| --- | --- |
| `retireControlReceiptToDebt` call sites `index.mjs:3522`, `3578`, `5458`, `5806` | Phase 1: pass the returned reason through. |
| `transferReceiptToDebt` call sites `index.mjs:3306`, `4683`, `4727-4737`, `4744`, `4768` | Phase 1: pass the reason; the trial branch at `4727` keeps returning `{ ok: true, changed: false }` for a missing target. |
| `compactGovernorReceipts` sealed path `index.mjs:4773-4777` and `reconcileBootDebt` `index.mjs:4695-4709` | Phase 1: unchanged semantics; `makeDebtGroupQuiescent` failures stay `accounting-overflow`. |
| `mutateGovernor` pipeline `index.mjs:5190-5235` | Phase 1: new compaction step and migration flag. |
| `acknowledgeSealedGeneration` `index.mjs:6097-6115`, dispatch release `index.mjs:784-786` | Phase 1: no code change; AC-8 covers the merged-away case. |
| `recoveryLedgerSummary` `index.mjs:16186-16211` and its spread into `recoveryCause` at `index.mjs:18059` | Phase 2: new `debtGroups`/`quiescentGroups` fields; `recoveryCause` destructures named fields only, so journal entries keep their exact-key shape (`index.mjs:16118-16128`). |
| `RECOVERY_COPY` `index.mjs:15702`, `recoveryRetryAt` `index.mjs:15792`, `recordRuntimeRecovery` `index.mjs:18045-18056` | Phase 1: add the transient reason; leave the hard lists unchanged. |
| Legacy v1 import `index.mjs:3296-3308` | Phase 1: reason pass-through only; the import itself is unchanged. |
| `acquisitionOutstandingText` `index.mjs:13682`, outstanding projection `index.mjs:15118-15121` | Excluded: these sum charged costs and report a true overflow. |
| Tests: `test/governor.test.mjs` (33 `debtGroups` references incl. `testDebtGroup` at `:238`, overflow test at `:3774`), `test/recovery.test.mjs:64-83`, `test/doctor.test.mjs:333-374`, `test/scheduling-policy.test.mjs:458`, `test/fixtures/aged-governor-v6.mjs` | Phase 1 extends governor and recovery tests; Phase 2 extends doctor tests. The v6 fixture and scheduling test construct fewer than 64 groups and are below the compaction threshold; they must pass unchanged. |
| `README.md`, `docs/` | No current mention of the overflow copy or debt groups (grep empty). Phase 2 adds the CHANGELOG entries only. |

## Handoff

Accepted decisions: option 3; threshold 64; merge only quiescent groups, only with no live claim, one aggregate per bootId; new reason `debt-journal-full` is transient; doctor disclosure instead of a repair flag; no state-version change. Evidence limits: the burst cause is inferred, and the live-machine acceptance needs the owner. Entry condition for Phase 1: an isolated worktree on `d46132e` or later `develop` with the research and this plan preserved. Record implementation notes in `docs/plans/2026-10-26-debt-journal-compaction-notes.md`.
