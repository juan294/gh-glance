# Budget observer window regression: implementation plan

Date: 2026-11-12. Status: implemented and verified locally on 2026-11-12; owner authorized all phases, local merge to `develop`, and task worktree removal. See [implementation notes](2026-11-12-budget-observer-window-regression-notes.md). Phase file: [phase 1](2026-11-12-budget-observer-window-regression-phases/phase-1.md).

## Objective and scope

Fix finding F1 of [the 2026-11-11 research](../research/2026-11-11-allowance-efficiency-and-coordination-hold.md): on 2026-11-11 one rate-limit reading stopped all core requests on 15 panes for about 33.5 minutes and showed "Local coordination is corrupt", although the state file was valid.

In scope:

1. The claimed budget observer accepts a reading whose reset time is earlier than the stored one, so one contradictory reading can no longer block every later reading until the real window resets.
2. A reading that the governor rejects is reported as a failed budget check with automatic retry. It is no longer reported as `corrupt`, and doctor no longer prints the ledger repair advice for it.

Out of scope, with reasons:

- Rejecting the first contradictory reading (a later reset with a lower `used` before the stored reset has passed). An unused GitHub bucket legitimately reports a sliding reset, so a later reset cannot be refused in general. After this fix the wrong window lasts for one observer interval (60 s) and pacing limits the spend in that time.
- A counter or journal entry for how often a window regresses. It answers an open research question but adds ledger or journal vocabulary. It can follow separately.
- The `corrupt` returns for caller-contract violations (`index.mjs:6257`, `index.mjs:6267`) and for an invalid external factor (`index.mjs:6317`). Production readers do not produce the first two, and the third concerns stored values.
- Items 3 to 7 of the research report (memory, idle local work, faster run signal, webhooks, state directory). They need `rpi-assess` first.
- No ledger schema change, no new recovery code, no release, no push.

## Baseline (revalidated 2026-11-12)

- Repository `/Users/juan/code/gh-glance`, branch `develop`, commit `24c67c577e987022cd8fc187adf95e9358fc78c0`, v0.19.2. All `index.mjs` line numbers below refer to this commit.
- Working tree: two kinds of untracked files only, the research artifact and this plan with its phase file. Nothing is committed.
- Controlling contracts: `CLAUDE.md`, `AGENTS.md`, `.claude/rules/push-accountability.md`, `.claude/rules/rpi-details.md`, `.rpi/rules/testing.md`. Nothing here touches CI routing or `CI_CADENCE_MODE`.

## Evidence and decisions

VERIFIED means read or run in this session or in the research session. INFERRED is a conclusion that was not proven.

| Label | Evidence | Decision |
| --- | --- | --- |
| VERIFIED | `budgetFromObservation` returns `ignored` for any reading with `resetMs` below the stored one, for every source (`index.mjs:6172`). | Keep this rule for response headers. Lift it for the claimed observer only. |
| VERIFIED | The observer path calls it with `allowEpochChange: true` (`index.mjs:6268-6274`) and turns `ignored` into `{ ok: false, reason: "corrupt" }` (`index.mjs:6291`). `refreshResourceBudget` then calls `failProbeClaim` (`index.mjs:7232-7237`), which retries after 60 s (`index.mjs:6417-6423`). | Change the two reading-derived returns (`6275`, `6291`). |
| VERIFIED | Without a fresh reading, `availableForGrant` returns `mode: "probe", reason: "budget-stale"` after 65 s (`index.mjs:2920-2922`), so no core grant is possible for any pane. | No change here. Failing closed on old evidence stays. |
| VERIFIED | Incident data: stored reading `used 0, reset 10:27:19`, live header `used 323, reset 10:00:52`; hold from 09:28:10 to 10:01:44 UTC; it ended at the first reading after the real reset. | The regression test replays this sequence. |
| VERIFIED | `corrupt` is in `HARD_STORAGE_REASONS` (`index.mjs:16495`): the pane keeps it sticky (`index.mjs:20632-20635`), `recoveryRetryAt` returns no retry time (`index.mjs:16597-16598`), it is an action-level notice (`index.mjs:17003`), and doctor prints `LEDGER_REPAIR_ADVICE` (`index.mjs:11978-11979`, `index.mjs:12040`). | The rejected-reading case must leave this set. |
| VERIFIED | `probe-failed` already exists: copy "GitHub budget check failed" / "Retry automatically at the shown time" (`index.mjs:16524`), wait-level notice (`index.mjs:17015`), not a hard reason. | Reuse `probe-failed`. |
| VERIFIED | The recovery journal reader rejects the whole journal as `corrupt` when an entry holds a code that is not a `RECOVERY_COPY` key (`index.mjs:16893-16894`, `index.mjs:16931-16937`). | A new code would make the journal unreadable for 0.19.2 panes that still run after an upgrade. This is why no new code is added. |
| VERIFIED | Response-header observations call the same function without `allowEpochChange` (`index.mjs:6856-6861`) and can only refine the stored epoch (`index.mjs:6168-6170`). | They cannot move the window, so a stored `observedAt` newer than an observer read means the stored epoch has newer evidence. Use that as the guard. |
| VERIFIED | Only the forward direction is covered by tests: `test/governor.test.mjs:2632-2646` uses a later reset. No test covers an earlier reset on the observer path. | Add the tests in Phase 1 before the code change. |
| INFERRED | Which GitHub response delivered the untouched-bucket reading. The ledger keeps no raw headers. | Not needed for this fix. The fix does not depend on the origin. |

## Options considered

1. **The claimed observer accepts an earlier reset as a window change, when its read is newer than the stored evidence. Chosen.** Three changed lines of logic, no stored-format change, and the hold ends at the next observer read (60 s at most). Cost: if GitHub alternates between two windows, each switch restarts the external-spend factor and the pacing lane, and pulls the GraphQL observer forward (1 point).
2. **Require two matching readings before a backwards switch.** Rejected. It needs a new ledger field, so a schema version change and a migration, to save one 60 s interval of possible over-allowance that the forward direction already has today.
3. **Accept a backwards reading only when it has less remaining than the stored one.** Rejected. It leaves the hold in place for the opposite case, and the observer is already the single authority for the window.
4. **A new recovery code such as `observation-rejected`.** Rejected because of the journal compatibility fact above. `probe-failed` gives correct copy today.

## Design

```
@ budgetFromObservation(raw, previous, nowMs, opts) -> { status, budget?, epochChanged? }
ctx: pure; callers hold the governor lock
pre: raw normalizes; resetMs > nowMs; source valid for resource
do:
  1. compute epoch = limit:resetMs
  2. validate non-observer sources stay inside the stored epoch
  3. lookup resetMs < previous.resetMs (window moved backwards)
  4. compute result as an epoch change when the observer read is newer
br: if backwards and (not allowEpochChange or receivedAt <= previous.observedAt) -> ignored; else -> accepted, epochChanged true
fx: none
risk: alternating windows restart factor and lane each switch
```

```
@ publishProbe(scope, leaseId, nonce, budgets, nowMs, resource) -> { ok, value | reason }
ctx: governor ledger (locked mutation)
pre: caller owns the live probe claim
do:
  1. validate claim, supplied budget and owner source (unchanged)
  2. compute observation via budgetFromObservation
  3. write budget, epoch and healthy observer when accepted (unchanged)
br: if observation invalid or ignored -> { ok: false, reason: "probe-failed" }
fail: caller-contract violation -> "corrupt" (unchanged)
fx: on failure the caller runs failProbeClaim; observer retries after 60 s
```

The seed path at identity admission (`index.mjs:3816`) uses the same function with `allowEpochChange: true` and takes the fix with no edit.

## Phase structure

One phase. Both changes are in `index.mjs` and share tests, so there is no `[batch-eligible]` unit. Details, test list and acceptance are in [phase 1](2026-11-12-budget-observer-window-regression-phases/phase-1.md).

## Stuck states and recovery

| State | Who sees what | How it ends | Test |
| --- | --- | --- | --- |
| Stored window is wrong and later readings have an earlier reset (the F1 hold). | Before: every pane, "Local coordination is corrupt", for up to one hour. After: nothing; the next observer read replaces the window. | Automatic, at the next observer read (60 s at most). | `OBS-REGRESS-01` proves the reading is published and a core grant follows. |
| Observer reading rejected (invalid, duplicate, or older than stored evidence). | Wait-level notice "GitHub budget check failed", action "Retry automatically at the shown time". Doctor shows `core: probe-failed` and the next retry time, without repair advice. | Automatic retry after 60 s (`failProbeClaim`). If rejections continue for more than 65 s, panes show the existing "GitHub budget evidence is old" wait state, which also retries by itself. | `OBS-REGRESS-03` and `OBS-REGRESS-04` prove the reason and the retry time; `OBS-REGRESS-05` proves the copy and that no repair advice is shown. |
| Real ledger corruption (unparseable or invalid file). | Unchanged: "Local coordination is corrupt" with doctor repair advice. | Manual step shown by doctor. | Existing `test/doctor.test.mjs` D6 and `test/governor.test.mjs:3041-3132` stay green. |

## Consumer sweep

Command: `grep -an 'budgetFromObservation\|publishProbe\|"probe-failed"\|HARD_STORAGE_REASONS' index.mjs` and `grep -rln 'budgetFromObservation\|publishProbe' test scripts`.

| Consumer | Location | Disposition |
| --- | --- | --- |
| Identity admission seed | `index.mjs:3816` | Covered. Takes the backwards acceptance; it already skips a non-accepted result. |
| `publishProbe` | `index.mjs:6268`, `6275`, `6291` | Covered. Phase 1. |
| Reservation settlement (response headers) | `index.mjs:6856` | Excluded. No `allowEpochChange`; behavior unchanged and pinned by `OBS-REGRESS-02`. |
| `refreshResourceBudget`, `refreshSharedBudget`, collector refresh | `index.mjs:7085`, `7062`, `17821` | Covered. They pass the publish result through; only the reason string changes. |
| Runtime recovery recording, `recoveryRetryAt`, notices | `index.mjs:20622`, `16595`, `17014-17015` | Covered by reuse. `probe-failed` is already classified. |
| Doctor | `index.mjs:11978-11990`, `12040` | Covered. `probe-failed` is not a hard reason, so no repair line. |
| Existing `probe-failed` producer (deferred background denial) | `index.mjs:5941` | Excluded. Same meaning class; unchanged. |
| Tests that assert `corrupt` from `publishProbe` | `test/governor.test.mjs:1974`, `2646` | Excluded. Both are caller-contract cases that stay `corrupt`. Phase 1 confirms by running them. |
| Fixtures and scripts | `test/fixtures/governor-worker.mjs`, `test/fixtures/populated-governor-v7.mjs`, `scripts/measure-efficiency.mjs`, `scripts/sustained-recovery.mjs` | Excluded. They do not depend on a backwards reading being refused; `npm test` and `npm run test:efficiency` run them. |

## Acceptance criteria

Automated, run sequentially on the Phase 1 candidate:

- `node --test test/governor.test.mjs test/recovery.test.mjs test/doctor.test.mjs` passes, including the five new `OBS-REGRESS` tests, which fail before the code change.
- `npm run lint`, `node --check index.mjs`, `npm test`, `npm run test:efficiency` all exit 0.

Manual: none required. Optional observation after a later release: `gh-glance --doctor` on the workstation shows `recovery reason none recorded` across a full hour that includes a window reset.

## Risks

- Alternating windows (INFERRED possible, not observed): each switch restarts the external factor and lane and costs 1 GraphQL point. Pacing and the 20% reserve still bound spend.
- Running 0.19.2 panes keep the old behavior until they are restarted with the new version. This is the normal upgrade step and needs no ledger change.

## Handoff

- Approved scope: this plan only, after owner acceptance. Implementation is a separate `rpi-implement` session in a worktree or temporary branch created from `develop` at the baseline commit or later; revalidate line numbers if `develop` moved.
- Not authorized: commit of these documents, push, release. Each needs an explicit request.
- Evidence limits: the origin of the bad reading is unknown; the fix does not depend on it.
- Entry condition for Phase 1: owner accepts the chosen option 1 and the reuse of `probe-failed`.
