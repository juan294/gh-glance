# Dependency PR queue implementation plan

Date: 2026-11-05. Status: Phase 1 accepted, Phase 2 authorized. Outcome and deviations: [notes](2026-11-05-dependency-pr-queue-notes.md).

## Objective and baseline

Clear the open PR queue on `juan294/gh-glance` and leave `develop` carrying every update, with no open PRs, no open issues and no open code-scanning alert.

Revalidated baseline, read on 2026-11-05:

- `origin/develop` is `1f395d3`. `origin/main` is `1bb40ed`, one commit behind.
- **6 open PRs, not 8.** `gh pr list` and the search API agree. All six are Dependabot PRs targeting `develop`. No other open PR exists in this repository, and no evidence accounts for the other two. Recently closed #157 and #158 are duplicates of #179 and #178.
- **0 open issues.** No PR links an issue, so there is no issue to close.
- 1 open code-scanning alert: #8, `js/incomplete-url-substring-sanitization`, `test/pty/context-help.test.mjs:131`. It is the only open item that resembles an issue, so it is included here. 0 open Dependabot alerts and 0 secret-scanning alerts.
- The main clone held another session's uncommitted `Events` rename during planning (`CHANGELOG.md`, `README.md`, `index.mjs`, `test/notifications-view.test.mjs`, `test/pty/cache.test.mjs`, `test/pty/notifications.test.mjs`, `test/pty/status.test.mjs`). This plan works in a separate worktree and leaves those paths alone.

Controlling contracts: `CLAUDE.md`, `AGENTS.md`, `.claude/rules/push-accountability.md`, `.claude/rules/rpi-details.md`, `.rpi/rules/testing.md`, `.rpi/rules/deployment-safety.md`, and the 2026-10-16 Sutura CI-routing owner decision. Nothing here changes `CI_CADENCE_MODE`, routing or cadence.

## The queue

| PR | Change | Head | Hosted result | Cause | Disposition |
| --- | --- | --- | --- | --- | --- |
| #145 | `brace-expansion` 5.0.9 to 5.0.12 | `452db79` | Green | None | Close. No change to land. |
| #141 | `eslint` 10.12.0 to 10.14.0, lockfile only | `74ee72c` | Red: PTY | Rotating PTY failure | Land in batch |
| #160 | `react` 19.3.0 to 19.3.1, lockfile only | `fc41bd0` | Red: PTY | Rotating PTY failure | Land in batch |
| #177 | `download-artifact` 8.0.1 to 8.0.2 | `f1c3a3d` | Red: Test, PTY | `WF-13`, deterministic, plus rotating PTY failure | Land in batch with digest refresh |
| #178 | `codeql-action/init` to 4.39.1 | `702879c` | Red: CodeQL, PTY | Half of a required pair, plus rotating PTY failure | Land in batch with #179 |
| #179 | `codeql-action/analyze` to 4.39.1 | `13b6383` | Red: CodeQL, PTY | Half of a required pair, plus rotating PTY failure | Land in batch with #178 |

All hosted results are from runs on 2026-11-02, based on `12e1f17` or older.

## Evidence and decisions

VERIFIED means read or run in this session. INFERRED is a conclusion drawn from that evidence and not proven.

| Label | Evidence | Decision |
| --- | --- | --- |
| VERIFIED | `git merge-tree --write-tree origin/develop 452db79` returns develop's own tree, `216d5e8`. `package-lock.json:720` already has 5.0.12. Dependabot alerts 1-3 were fixed on 2026-10-26. | #145 is a no-op. Close it. |
| VERIFIED | CodeQL logs on #178 and #179: `Loaded a configuration file for version '4.39.0', but running version '4.39.1'`, and the reverse. | The two PRs can only pass together. |
| VERIFIED | The same split occurred in #70/#71 and #157/#158. The CodeQL error recommends a Dependabot group. | Add a `codeql-action` group so the split stops recurring. |
| VERIFIED | `test/workflows.test.mjs:42-46` compares `native-policy.json` `blobSha` with `ci.yml`. #177 fails with `7db2b39...` against `f72b4cf...`. The dry run reproduced the failure and fixed it. | #177 cannot pass alone. The digest changes with the pin, in one commit. |
| VERIFIED | Sutura `scripts/fleet-native-verification.mjs:125-127` requires the producer blob to match at both the policy commit and the run head. | One commit keeps both refs consistent. A split would leave a window where they differ. |
| VERIFIED | `.sutura.json` `sourceInputs` hash `package.json`, `package-lock.json`, `scripts/test-select.mjs` and `ci.yml`. At `1f395d3`, `package.json` and `package-lock.json` are already stale. `1a194e2` records that staleness stops `pty:rest` repairs with `reproduction-profile-stale`. | Refresh all digests as the last edit. |
| VERIFIED | Dry run on a disposable clone of `1f395d3`: all five commits apply without conflict; `npm ci` resolves `react` 19.3.1 and `eslint` 10.14.0; `npm run lint` exits 0; `node --check` passes; after the refresh, `workflows`, both Sutura test files and `test-select` pass 50/50. | The batch is mechanically sound. The full gate is still required. |
| VERIFIED | `download-artifact` v8.0.2 resolves to `9000827`. `codeql-action` v4.39.1 dereferences to `9b32540`. Both equal the PR pins. | Pins are authentic. |
| VERIFIED | The classifier reports `broad` for this path set: `lint syntax package fast pty:smoke recovery efficiency pty`. | That is the local gate. |
| VERIFIED | `planCi` in `.github/workflows/ci.yml:3-20`: ordinary `develop` pushes run quick checks. PTY last ran hosted on release PR #161, on 2026-10-27. | Hosted CI will not cover PTY after the push, so the local gate is the PTY evidence. Green `develop` CI says nothing about PTY. |
| VERIFIED | The five PR runs failed five different test sets: `SET-01` (#160, #178), `CI exact selected attempt` (#177), `cache-hydrated adapted check` (#141), `attention 25/25` (#178), `PAGE-01` (#179). Runs on 10-26, 10-27 and 10-29 failed other names. #178 and #179 change only `codeql.yml`. | The red PTY results are not caused by these PRs and do not block landing them. |
| VERIFIED | Local run of the four failing files on an export of `1f395d3` at load 25-86: `ci-details` 14/14, `actions-setup` 13/13, `adaptive-polling` 11/11. `runtime-remediation` failed twice at load 48-50, with `spawnSync /bin/sh ETIMEDOUT` from `capture.mjs:537` at file load, which is not the hosted failure. | Three of four do not reproduce. The fourth is unresolved until it runs at normal load, which Phase 1 requires. |
| INFERRED | Failures rotate, they include release-PR attempts, and several screens show `API budget paused` or `GitHub admission is paused` against a fixture `gh`. | Timing on hosted runners is the likely cause. Why the app pauses in those runs was not established. This plan does not fix it. |
| VERIFIED | Dependabot `minimatch` security jobs fail with `security_update_not_possible`: lowest fixed version 11.0.1, blocked by `@eslint/config-array` `^10.2.4`. No `minimatch` alert exists. | No action. The failure is upstream and nothing user-facing is open. |
| VERIFIED | `package.json` `files` excludes `package-lock.json`. `react` is `^19.2.8`. | The React bump changes this repository's test baseline, not the published artifact. No changelog entry and no release is needed. |
| VERIFIED | Precedent: `df91521` batched action and lockfile updates locally on `develop`. | The chosen option matches practice here. |
| VERIFIED | Memory "No release-pipeline hardening": reject new gates and test machinery. | No retries, no timeout changes, no new script. |

## Options considered

1. **One local batch commit, one push, then close the PRs. Chosen.** It handles every coupled change in one commit, needs a single push, and spends one local gate instead of repeating hosted runs. Its cost is that the PRs close unmerged, so GitHub shows no merge on them.
2. **Merge each PR on GitHub.** Rejected. #177 needs a commit on a bot branch, which conflicts with keeping working branches local and stops Dependabot rebasing it. #178 and #179 stay red until both land. Five rebased PRs repeat five PTY runs of about 35 minutes each, with a rotating failure.
3. **Add the Dependabot group and wait for regenerated PRs.** Rejected as the main path. It repairs only the CodeQL pair, waits for the next Monday run, and leaves #177 and the digests broken. Its grouping step is kept in option 1.

## Scope and phase gates

1. [Phase 1: local batch candidate](2026-11-05-dependency-pr-queue-phases/phase-1.md). Local only.
2. [Phase 2: push, observe and close the queue](2026-11-05-dependency-pr-queue-phases/phase-2.md). Outward-facing. Needs explicit authorization for the push and the six PR closures.

Each phase stops for acceptance. There are no `[batch-eligible]` units, because every change feeds the final digest step.

Out of scope: a release, any edit to `main`, fixing the PTY flakiness, CI routing or cadence, Sutura-side changes, new test harness or gates, the `minimatch` upstream block, and PRs in other repositories.

## Stuck states and recovery

| State | Who sees it and what they see | How it ends | Proof |
| --- | --- | --- | --- |
| Digest stale after a later edit | `WF-13` fails locally and in CI with the expected and actual blob | Recompute, as in Phase 1 step 5 | `WF-13` in `fast`; dry run showed fail then pass |
| `.sutura.json` stale | Sutura stops a repair with `reproduction-profile-stale` in its audit | Refresh digests, as in `1a194e2` | Fresh digest comparison in Phase 1 criteria |
| Local PTY failure under load | Failed attempt in the gate output | Record it and re-run the unchanged candidate once when 15-minute load is at or below 12. A repeat at normal load stops the phase | Gate receipt and recorded attempts |
| `runtime-remediation` `ETIMEDOUT` persists at normal load | Gate output names `capture.mjs:537` | Treat as a real finding, stop Phase 1 and report before pushing | Same gate |
| `develop` moves before the push | Non-fast-forward rejection | Rebase and follow the Phase 2 step 1 table | `merge-base --is-ancestor` |
| Hosted run fails after the push | Red run for the exact SHA | Stop, diagnose from logs, repair locally, ask for a new push. PRs stay open, so the queue remains accurate | Phase 2 closes PRs only after green |
| Dependabot rejects the new group | `Dependabot Updates` run fails in Actions | Correct `.github/dependabot.yml` in a follow-up. Pins and PTY are unaffected | The next Dependabot run is the only proof available |
| Alert 8 stays open | `gh api .../alerts/8` still reports `open` | Check that the CodeQL push run analyzed the commit, then report it. A dismissal needs owner approval | Phase 2 step 5 |

## Consumer sweep

The change alters stored digests. Readers found with `git grep -n -E 'sutura\.json|native-policy\.json|sourceInputs|receiptProducers' -- . ':!docs'` here, and the same pattern with `blobSha` in `/Users/juan/code/sutura`.

| Reader | Coverage |
| --- | --- |
| `test/workflows.test.mjs:42-46` | Covered by `fast` in Phase 1 |
| `.github/workflows/ci.yml:650`, which resolves the policy source for the native receipt | Runs for Sutura repair integration only, and reads the updated file. Not exercised by an ordinary push |
| Sutura `scripts/fleet-native-receipt.mjs:17-18`, `scripts/fleet-native-verification.mjs:116-131` | Consistent because digest and workflow change in one commit. Excluded from local verification: Sutura-owned |
| Sutura reproduction-profile validation of `.sutura.json` `sourceInputs` | Fresh digest comparison in Phase 1. Excluded from hosted verification: no repair runs in this plan |
| `test/sutura-pilot.test.mjs`, `test/sutura-native-routing.test.mjs` | Passed in the dry run; they run again in `fast` |

## For Sutura review

Report only. No change is made from this repository.

1. **Every `ci.yml` edit fails `WF-13` until `native-policy.json` is refreshed**, so each Dependabot action bump touching `ci.yml` arrives red. Repository `juan294/gh-glance`, commit `f1c3a3d`, [run 41505174476](https://github.com/juan294/gh-glance/actions/runs/41505174476).
2. **`.sutura.json` goes stale on every release**, because it hashes `package.json` and `package-lock.json`. Commit `1f395d3`, source `.sutura.json:16-37`, precedent `1a194e2`.
3. **Sutura repair ran on Dependabot PR failures and gave up**: `Sutura required fixed but produced gave-up`, diagnosis `infra`, on all five red PRs. [Run 41510771259](https://github.com/juan294/gh-glance/actions/runs/41510771259) for #160 is one example.
4. **`pty:rest` fails on most hosted PR runs since 2026-10-26, with a different test each time.** [Run 41505207571](https://github.com/juan294/gh-glance/actions/runs/41505207571) is one example. Quick `develop` pushes do not run PTY, so these failures appear only on PR runs.

## Handoff

- **Approved scope:** owner request of 2026-11-05: all phases, then merge to `develop` and prune. That covers the one push and the six PR closures in Phase 2.
- **Base:** `develop` at `1f395d3`, main clone `/Users/juan/code/gh-glance`. No worktree is allocated yet. Phase 1 creates `/Users/juan/code/gh-glance-deps-2026-11` on `deps-2026-11`.
- **Evidence limits:** the dry run covered apply, install, lint, syntax and 50 targeted tests. It did not run the full gate. The local PTY run was on `1f395d3` without the bumps, at load far above 12. The Dependabot group is unverified until a real Dependabot run.
- **Resources:** no Docker, database or service allocated. Disposable dry-run and export copies live in the session scratchpad only.
- **On resume:** re-read PR heads, `origin/develop` and `git status`. If a PR head changed, update the Phase 1 cherry-pick list. Digest values in Phase 1 apply to base `1f395d3` and must be recomputed on any other base.
- **Next action:** see the notes file. This handoff records the planning state; the notes record what happened.
