# Research: "Local coordination accounting overflow" pins every pane (debt-journal deadlock)

Date: 2026-10-26
Source commit: 0fb18b9 (develop, v0.17.0)
Evidence: a work machine's quota ledger (`coordination-v2/quota-ef8cf9d6….json`, revision 1279954, version 7), its recovery journal, and `gh-glance --doctor` output, all captured 2026-10-26 11:12 local. Copies live on that machine's Desktop (`gh-glance-ledger.tgz`, `gh-glance-doctor.txt`).

## Symptom

Three panes (avolta-ag/clubavolta-cli, wechat-miniapp, norman; GitHub EMU account on github.com) show `Core: Local coordination accounting overflow / Run gh-glance --doctor; preserve the reported state file; next 2m` with data cached since 2026-10-19 09:03 local (07:03Z). Doctor reports `recovery reason core: accounting-overflow`, `core debt units 8`, `graphql debt units 120`, `graphql observer age 169h28m`, one live lease.

## Ledger state (verified by replay against 0fb18b9)

| Field | Value |
|---|---|
| `debtGroups` | 128 of `GOVERNOR_MAX_DEBT_GROUPS` (128, `index.mjs:3891`), all `quiescent: true` |
| group units | 120 groups with 1 GraphQL unit, 8 with 1 core unit; 126 have a known owner (`unknownChild: false`), 2 are unknown-child groups (one is `UNKNOWN_DEBT_GROUP_ID`, `index.mjs:4543`) |
| group creation window | 2026-10-19 07:14:15Z to 08:43:41Z (89 minutes); bursts of one group every 0.3 to 1 s, for example 70 groups between 08:01:02Z and 08:03:40Z |
| `controlReceipts.core` | `started`, one dispatch with `terminalAt` set, generation `8e8da878…` has no debt group |
| `controlReceipts.graphql` | `started`, one dispatch with `terminalAt` set, generation `e669df4f…` has no debt group |
| `reservations` | 6, all `completed` / `measured-success` with `actualCosts` 0 |
| `debt` totals | core 0 unresolved + 8 quiescent; graphql 0 unresolved + 120 quiescent; consistent with the groups |
| `observers.graphql` | `at` 2026-10-19 08:43:41Z, never since |
| `observers.core` | `at` 2026-10-26 10:12:10Z (retries every 60 s, each fails) |

`readGovernorState` accepts the file and `governorChargedCost` returns 9 (core) and 121 (graphql), both safe integers. The loader and `governorAccountingSafe` (`index.mjs:2445`) are not what fails.

Reproduction (scratch script, copy of the ledger under a sandbox scope created with `createGovernorScope`):

```
registerLease           -> ok
claimProbe("graphql")   -> { ok: false, reason: "accounting-overflow" }
claimProbe("core")      -> ok (this path does not retire the core control receipt)
```

## Failure path

1. `claimProbe` for GraphQL finds the outstanding GraphQL control receipt and calls `retireControlReceiptToDebt(state, "graphql", at)` (`index.mjs:5456-5461`). `failProbeClaim` does the same (`index.mjs:5806`). For core, `startIdentityControl` retires the core control receipt the same way (`index.mjs:3520-3523`).
2. `retireControlReceiptToDebt` (`index.mjs:4673-4690`) calls `transferReceiptToDebt(state, control, at, generation)` (`index.mjs:4683`) because the dispatch was issued (one dispatch, terminal).
3. `transferReceiptToDebt` (`index.mjs:4599`) asks `debtGroupTarget` (`index.mjs:4583-4597`) for a group. The dedicated generation has no group; `count < GOVERNOR_MAX_DEBT_GROUPS - 1` is false at 128; no shared group qualifies because the shared lookup requires `!group.quiescent` and every group is quiescent; `count >= GOVERNOR_MAX_DEBT_GROUPS` returns `null` (`index.mjs:4595`).
4. `transferReceiptToDebt` returns `false`; the mutator returns `{ ok: false, reason: "accounting-overflow" }`; `mutateGovernor` (`index.mjs:5190-5235`) discards the mutation and writes nothing (`index.mjs:5223-5224`), so the next attempt sees the identical state.

Quiescent groups are deleted only in `retireClaimedQuiescentDebt` (`index.mjs:5609-5635`), which runs inside `publishProbe` (`index.mjs:5686`). Publishing requires a claim, and the claim is what fails in step 1. The journal can therefore never drain: a full journal blocks the only operation that empties it.

The code calls this condition `accounting-overflow`, the same reason used for genuine safe-integer overflow (`index.mjs:4628-4634`, `4652-4656`, `5479`, `4863`). The runtime treats that reason as a hard storage failure: `recoveryRetryAt` returns `null` for it (`index.mjs:15792-15796`), `recordRuntimeRecovery` lists it among `storageFailures` (`index.mjs:18045`) so contention never clears it, and `RECOVERY_COPY` tells the user to run doctor and preserve the file (`index.mjs:15710`). Doctor reports the condition (`index.mjs:11328`) and offers no repair. Panes still re-attempt every 60 s (`BUDGET_PROBE_MS`, `index.mjs:2321`; observer `at` advances), which is why the notice says `next 2m` while nothing can succeed.

## How the journal filled

Each group holds exactly one unit and has a known owner, which is the shape `failProbeClaim` leaves behind: a GraphQL observer claim issues one dispatch, the probe fails, the control receipt is retired into a dedicated group (`index.mjs:4683`), and because the owner is known the group is made quiescent immediately (`index.mjs:4685-4688`). 120 such groups in 89 minutes, in sub-second bursts, means the GraphQL observer failed repeatedly on 2026-10-19 between 07:14Z and 08:43Z and no GraphQL publication succeeded in that window (the last GraphQL observation is 08:43:41Z, the same instant as the last group). The 8 core groups come from the equivalent core control-receipt path.

The cause of those probe failures is not recoverable from the files: the recovery journal keeps only the last 128 entries (`RECOVERY_JOURNAL_MAX_ENTRIES`, `index.mjs:15699`), and all 128 are from 2026-10-26, alternating `core corrupt` and `core accounting-overflow` every 1 to 15 minutes. Doctor's acquisition metrics show 1272 failed requests out of 92079 HTTP attempts over the ledger's life. The actions data stopped at 07:03:15Z, eleven minutes before the first surviving group, so the data outage preceded the journal growth.

Observed and not explained by the ledger alone: the sub-second spacing between groups. `failProbeClaim` schedules the next observer attempt `BUDGET_PROBE_MS` (60 s) later (`index.mjs:5813-5818`), so the burst rate implies several panes, or a claim path other than the observer backoff, retiring one receipt per attempt. This needs a separate trace.

## Related code the plan will touch

- `debtGroupTarget` / `transferReceiptToDebt`: `index.mjs:4583-4647`
- `retireControlReceiptToDebt`: `index.mjs:4673-4690`
- `retireClaimedQuiescentDebt` (only deletion of groups): `index.mjs:5609-5635`
- `compactGovernorReceipts` (runs before every mutation, could compact groups): `index.mjs:4711`
- `acknowledgeDebtGroup` quiescence by owner, sensitive to group identity: `index.mjs:6100-6115`
- Recovery classification: `index.mjs:15702-15716`, `15792-15796`, `18045-18056`
- Doctor governor section: `index.mjs:11300-11360`
- Existing test for genuine overflow: `test/governor.test.mjs:3774`
- Recovery copy tests: `test/recovery.test.mjs:64-83`

## Unblock on the affected machine (manual, data loss limited to coordination accounting)

Quit all gh-glance panes, then move `quota-ef8cf9d6….json`, `quota-ef8cf9d6….json.recovery.json` **and `registry.json`** out of `~/Library/Application Support/gh-glance/coordination-v2/`. The next launch creates a fresh registry and ledger for that identity. Dashboard cache, preferences and the acquisition state are untouched.

Moving only the two quota files is not enough (observed 2026-10-26 on the work machine: the pane then showed `Local coordination is corrupt. No successful check is available yet.`). `readIdentityQuotaState` (`index.mjs:3278-3283`) treats a missing ledger whose `quotaKey` the registry still lists under `identities` or imported `attempts` as `corrupt`, by design, so that a deleted ledger cannot silently drop debt. With the registry gone, `withIdentityRegistry` starts from `emptyIdentityRegistry()` on `ENOENT`, the identity is re-resolved with one `gh api user` call, the same `quotaKey` is derived (`createQuotaScope`, `index.mjs:3387-3388`), and the missing ledger is accepted as fresh.
