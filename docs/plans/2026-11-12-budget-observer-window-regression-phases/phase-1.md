# Phase 1: observer accepts a backwards window; rejected readings are `probe-failed`

Plan: [budget observer window regression](../2026-11-12-budget-observer-window-regression.md). Baseline commit `24c67c577e987022cd8fc187adf95e9358fc78c0`; line numbers refer to it.

## Order of work

Follow `.rpi/rules/testing.md`: write the tests first and see them fail, then change the code. Work in a worktree or temporary branch from `develop`. No unit is `[batch-eligible]`; one owner edits `index.mjs`.

## Step 1: failing tests

Add to `test/governor.test.mjs`, with the existing helpers `sandbox`, `registerLease`, `lease`, `publishInitial`, `claimNow`, `budgets` (`test/governor.test.mjs:165-185`). Use `test/governor.test.mjs:2632-2650` as the pattern for a single observer publication.

| ID | Arrange | Assert |
| --- | --- | --- |
| `OBS-REGRESS-01` | Publish core `used 323, remaining 4677, resetMs NOW + 33 min`. At `NOW + 60 s` publish `used 0, remaining 5000, resetMs NOW + 60 s + 3,599 s`. At `NOW + 120 s` publish `used 330, remaining 4670, resetMs NOW + 33 min`. | Third publication returns `ok: true`. Ledger `budgets.core.resetMs` equals `NOW + 33 min`, `used` equals 330, `observers.core.outcome` is `healthy`. A core intent registered at `NOW + 121 s` is `scheduled`, not denied with a probe reason. |
| `OBS-REGRESS-02` | After an initial publication, settle a reservation with a `response-header` observation whose `resetMs` is 60 s earlier than stored. | Settlement succeeds and `budgets.core.resetMs` and `epochs.core` are unchanged. |
| `OBS-REGRESS-03` | Stored core budget with `observedAt = T`. Publish an observer reading with an earlier `resetMs` and `receivedAt = T` (not newer). | Returns `{ ok: false, reason: "probe-failed" }`. Stored budget unchanged. |
| `OBS-REGRESS-04` | Through `refreshResourceBudget` with an injected `readBudgets` that returns a core reading with `resetMs` equal to `now` (invalid). | Result reason is `probe-failed`. `observers.core.outcome` is `failed` and `observers.core.nextAt` equals the failure time plus 60,000 ms. `probeClaims.core` is `null`. |

Add to `test/recovery.test.mjs` or `test/doctor.test.mjs`, next to the existing copy and doctor cases (`test/recovery.test.mjs:86-95`, `test/doctor.test.mjs:294-302`):

| ID | Arrange | Assert |
| --- | --- | --- |
| `OBS-REGRESS-05` | A recovery journal whose current core cause is `probe-failed` on a valid ledger; run doctor against that state root. | Output has `core: probe-failed` as the recovery reason and no line that starts with `repair`. `HARD_STORAGE_REASONS` does not include `probe-failed`. |

Run `node --test test/governor.test.mjs test/recovery.test.mjs test/doctor.test.mjs`. Expected before the code change: `OBS-REGRESS-01`, `03` and `04` fail (`corrupt`), `02` passes, `05` passes or fails depending on the fixture; record the actual result.

## Step 2: code change in `index.mjs`

`budgetFromObservation`, replacing the unconditional rule at line 6172:

```
@ budgetFromObservation(raw, previous, nowMs, opts) -> { status, budget?, epochChanged? }
ctx: pure; callers hold the governor lock
pre: raw normalizes; resetMs > nowMs; source valid for resource
do:
  1. lookup resetMs < previous.resetMs
  2. validate allowEpochChange and receivedAt > previous.observedAt
  3. compute the budget on the existing epoch-change path (lines 6190-6212)
br: if backwards and either check fails -> ignored; else -> accepted, epochChanged true
fx: none
```

Update the comment at lines 6165-6167 to state that the claimed observer may move the window in either direction and why the `observedAt` check exists. Keep the comment short and factual.

`publishProbe`:

- Line 6275: return `{ ok: false, reason: "probe-failed" }` for an `invalid` observation.
- Line 6291: return `{ ok: false, reason: "probe-failed" }` when the observation was ignored.
- Lines 6257, 6267 and 6317 stay `corrupt`.

Do not change `RECOVERY_COPY`, `NOTICE_WAIT_CODES`, `HARD_STORAGE_REASONS` or the ledger schema.

Check while editing: the GraphQL pull-forward at lines 6374-6383 uses `supersededCoreResetMs`. On a backwards change that value is in the future, so `observedSinceReset` is false and the GraphQL observer becomes due once. That is intended; confirm `OBS-REGRESS-01` leaves `observers.graphql.nextAt` at or before the publication time and does not fail the GraphQL claim.

## Step 3: changelog

Add one entry under `## [Unreleased]` in `CHANGELOG.md` (`CHANGELOG.md:8`), in the file's existing style: a single contradictory rate-limit reading no longer pauses all panes until the hourly reset, and a rejected budget reading is shown as a failed budget check that retries, not as corrupt coordination state. Confirm with `git diff` that the entry is under `Unreleased` and not under `0.19.2`.

## Step 4: review, simplify, verify

Run the project's atomic loop (independent review, repair, simplify), then, sequentially:

```bash
npm run lint && node --check index.mjs && npm test && npm run test:efficiency
```

A later success does not erase an earlier failure; report every failure with its output.

## Acceptance

Automated:

- All five `OBS-REGRESS` tests pass and the recorded pre-change run shows `01`, `03` and `04` failing.
- `test/governor.test.mjs:1974` and `test/governor.test.mjs:2646` still assert and receive `corrupt`.
- The four gate commands above exit 0 on the final candidate.

Manual: none.

## Stop condition

Stop after this phase and report: changed files, the pre-change and post-change test output, gate results with the tested commit or tree identity, and any deviation from this file. Do not commit to `develop`, push or release without an explicit request.


## Completion (2026-11-12)

The owner invoked this implementation and then authorized all phases, local integration into `develop`, and task worktree removal. That authorization supersedes the original stop condition above. No push or release is authorized.

- [x] Add five `OBS-REGRESS` cases; corrected RED fails exactly `01`, `03`, `04` before the behavioral change.
- [x] Accept a newer backwards observer reading, preserve response-header authority, and classify rejected readings as `probe-failed`.
- [x] Keep caller-contract corruption, recovery vocabulary, and the ledger schema unchanged.
- [x] Put the changelog entry under Unreleased.
- [x] Obtain independent review, resolve the GraphQL test coverage finding, and obtain approval again.
- [x] Complete reuse, quality, and efficiency simplify passes; no additional changes required.
- [x] Focused suite: 184/184. Lint, syntax, full unit suite (1111/1111), and efficiency (9/9) all exit 0.

Exact candidate identity, failure history, deviations, reviewer assignment, and preservation details are in the [durable handoff](../2026-11-12-budget-observer-window-regression-notes.md).
