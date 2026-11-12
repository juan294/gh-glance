# Budget observer window regression: implementation notes

Date: 2026-11-12. Phase 1 is complete and locally verified. This plan contains one phase.

## Scope and identity

The owner invoked `rpi-implement` for the approved plan, then requested all phases without stopping, a local merge to `develop`, and removal of the task worktree. This authorizes the local implementation and its plan/handoff commits. Push, release, and changes to live pane state remain outside scope.

Base and HEAD during verification: `24c67c577e987022cd8fc187adf95e9358fc78c0`. Branch: `fix/budget-observer-window`. Worktree: `/Users/juan/code/gh-glance-wt-budget-observer`. Integration target: `/Users/juan/code/gh-glance`, branch `develop`. A fresh `git fetch origin` confirmed `origin/develop` remained at that base before integration.

The tested candidate is SHA256 `5b5df213757a38bd387e1a1374ce4c18b86b0538dd457caaf1c13aadad558fef`: hash, in order, each filename, NUL, file bytes, NUL for `index.mjs`, `test/governor.test.mjs`, `test/doctor.test.mjs`, `CHANGELOG.md`. Runtime: Node v24.22.1, darwin arm64. Documentation completion updates do not change these inputs. The integration owner must confirm the same digest after the local merge; the full gates need no repetition when these inputs and the base are unchanged.

## Implementation and invariants

- `index.mjs:6172`: the claimed observer can replace an earlier reset only with evidence newer than the stored `observedAt`. Response headers retain their existing epoch restriction.
- `index.mjs:6276` and `index.mjs:6292`: invalid and ignored readings return `probe-failed`; missing budgets, wrong owner sources, and invalid external factors still return `corrupt`.
- `test/governor.test.mjs:2632`: the incident replay restores the real core window, permits a core grant, and pulls a future GraphQL observer deadline forward without preventing its claim. The other regression cases pin header authority, equal-timestamp rejection, and failure/retry cleanup.
- `test/doctor.test.mjs:993`: a valid ledger with a `probe-failed` journal cause reports the retry and existing recovery copy without repair advice.
- `CHANGELOG.md:10`: the change is recorded under Unreleased. No ledger schema, recovery code, hard-reason membership, or rendering/lifecycle implementation changes were made.

## Verification and failure history

Raw logs and the candidate/check records are preserved outside the disposable worktree at `/Users/juan/code/gh-glance/.git/rpi-evidence/budget-observer-2026-11-12/`.

| Check | Result | Evidence |
| --- | --- | --- |
| First pre-change focused run | Exit 1; 180 pass, 4 fail. Two test setup errors were found: the heartbeat used an invalid empty demand, and recovery presentation was read as an object rather than its returned lines. These were corrected before changing production behavior. | `red.log` |
| Corrected pre-change focused run | Exit 1; 181 pass, 3 fail: `OBS-REGRESS-01`, `03`, `04`. `03` and `04` return `corrupt`; `01` fails publication. `02` and `05` pass. | `red-2.log` |
| Initial post-change focused run | Exit 0; 184/184 pass. | `green.log` |
| Final focused run after tightening GraphQL setup | Exit 0; 184/184 pass. | `green-final.log` |
| `npm run lint` | Exit 0 (1.74 s). | `lint.log` |
| `node --check index.mjs` | Exit 0 (0.03 s). | `syntax.log` |
| `npm test` | Exit 0; 1111/1111 pass (147.37 s). Includes the sustained recovery oracle and package exercise. | `test.log` |
| `npm run test:efficiency` | Exit 0; 9/9 pass (56.78 s). | `efficiency.log` |

All final checks ran sequentially on the candidate above. Existing caller-contract corruption assertions and actual ledger corruption cases pass in the focused and complete suites. PTY was not required: no rendering or terminal lifecycle implementation changed. There is no typecheck or build step in this repository. No final gate failure remains.

## Independent review and simplify

Assignment `review_budget_fix`: independently inspect the complete diff against the plan and phase acceptance criteria; read-only access to the four changed implementation/test/changelog files, plan files, controlling instructions, and adjacent consumers. No edits, tests, services, commits, or publication. Resource limit: one reviewer, initially 15 minutes, then a bounded 5-minute follow-up. Terminal condition: return approval or actionable findings with source references, then stop. The parent retained all implementation and integration ownership.

The reviewer approved correctness and plan compliance. Finding R1: the first GraphQL assertion allowed a naturally due observer and did not independently prove pull-forward. Resolved by publishing GraphQL at `NOW + 119000`, asserting its next deadline exceeds `NOW + 120000`, then requiring the backwards core publication to make it due and claimable. The reviewer re-read the change and approved with no findings. No missing review result remains.

The parent then performed three separate simplify passes on the current diff: reuse (existing test helpers and epoch-change path), quality (guard, classifications, assertion specificity), efficiency (constant-time production guard and no extra runtime I/O). No additional improvement was warranted; no tested input changed during simplify. All final gates followed these passes.

## Deviations

- Plan said: directly exercise `refreshResourceBudget` and hard-reason exclusion. Found: neither internal symbol was exported. Chose: add named test exports for `refreshResourceBudget` and `HARD_STORAGE_REASONS` alongside the existing test seams. Why: exercise the real refresh/failure path and exact membership without mocks or new public package entry points (`package.json` retains `exports: {}`). These exports were present during RED and do not alter runtime behavior.
- Plan said: check GraphQL is due and its claim succeeds. Found: the original fixture was already due. Chose: establish a fresh future deadline before the backwards publication. Why: prove the intended pull-forward behavior rather than pass for an unrelated reason; independent review approved the stronger test.

## Preservation and next action

The task allocated no Docker/database stack or persistent service. Existing test commands own and clean up their disposable fixture processes and directories. The only task-owned ignored worktree entry is a `node_modules` symlink to the primary checkout; remove that symlink during task worktree removal, preserving the shared dependency directory. Test/check logs are retained in the Git common directory above and are not release artifacts.

The primary checkout's pre-existing research artifact remains untracked and unchanged. Original untracked copies of this plan and phase are to be backed up in the evidence directory before integration replaces them with the committed copies. No unrelated work is to be staged or removed.

Next action within the already authorized scope: commit the completed candidate and these curated notes, fast-forward local `develop`, verify source identity and preservation, then remove only `gh-glance-wt-budget-observer` and its merged task branch. There is no next implementation phase. Any publication requires a separate owner request; running installed 0.19.2 panes retain old behavior until a later release and restart.

## Validation follow-up (2026-11-12)

Validation of commit `143e104` passed all gates and raised two findings. The owner chose the recommended dispositions and asked for a direct fix.

- V1, resolved: a failed core check is hidden by the shared refresh when the GraphQL check succeeds, and the plan's claim about the origin of the `corrupt` label was unproven. Added `OBS-REGRESS-06` (a newer GraphQL observer reading may move its window backwards) and `OBS-REGRESS-07` (the shared refresh returns `probe-failed` when both readings are rejected) in `test/governor.test.mjs`. Both fail on the base commit `24c67c5` and pass on the fix. The plan's evidence table carries the correction. No product code changed.
- V2, accepted known behavior: a backwards window change clears a recorded secondary-limit or abuse-limit hold, as a forward change already does (`index.mjs:6191-6197`). Not observed. No change.
- V3, information: a 1 s reset jitter is now an accepted window change for either resource. No change.
