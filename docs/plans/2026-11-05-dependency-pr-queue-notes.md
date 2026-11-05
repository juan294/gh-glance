# Notes: dependency PR queue

> Plan: [`2026-11-05-dependency-pr-queue.md`](2026-11-05-dependency-pr-queue.md)
> Implementation worktree: `/Users/juan/code/gh-glance-deps-2026-11`, branch `deps-2026-11`, from `develop` @ `1f395d3450cfd4c6e9b64df61231a7e48ebe05a3`.
> Authorization: owner request of 2026-11-05, "All phases, no stopping. When you're done, merge to develop and prune the tree", which selects Phase 2 and so covers its one push and six PR closures.

## Deviations

### Phase 1

- **Gate command.** Plan said `node scripts/test-select.mjs run lint syntax package fast pty:smoke recovery efficiency pty`. Found the selector exits 2 with `unknown selection lint`: `lint` and `syntax` are profile entries in `PROFILE_SELECTIONS`, not selections, so nothing ran. Chose `npm run lint`, then `node --check index.mjs`, then the selector with the remaining names. Why: same checks, and the first run's wrapper reported 0 while the selector reported 2, so each exit status is now captured separately.
- **`plan` before the commit.** Plan ran `plan --head HEAD` in step 7 and commits in step 8, when `HEAD` still equals the base. Chose a dangling `git commit-tree` of the index (tree `ac6f261ba3d152e3200ee71b5c3970fc0c7b8f4c`) as `--head`. Why: it proves `broad` for the exact tree.
- **Second session in this worktree.** At 07:47 CET, while this session's gate ran, the session that holds the `Events` rename committed the staged index here as `afdabec` (`chore: land the dependency queue as one batch`), after the owner told it to merge and prune. This session did not notice until 08:51 and had reported the candidate as uncommitted, which was wrong. The commit's tree is `ac6f261`, the tree gated here, so the evidence stands. Its message differs from the one Phase 1 prescribes. From 08:05 that session ran its own full gate on the same tree.
- **Plan text left as written.** Review findings about the plan body are recorded below instead of rewriting it. Only its status lines and handoff change.

## Review findings

Independent review of the staged diff, fresh context, read-only. No blocking findings. Path set, cherry-pick bytes, lockfile (only `eslint` and `react` change), pins against upstream tags, and digests recomputed from staged blobs all matched.

| ID | Finding | Disposition |
| --- | --- | --- |
| F1 | The parent plan's consumer sweep calls `test/sutura-pilot.test.mjs` and `test/sutura-native-routing.test.mjs` digest readers. Neither reads a digest, and nothing in this repository validates `.sutura.json` hashes. `WF-13` covers only `blobSha`. | Accepted as a plan correction. A stale `.sutura.json` passes the whole gate, so the Phase 1 digest comparison is the only check. |
| F2 | The post-push CI run will not execute `download-artifact` v8.0.2. Two uses need `pack`, selected only for release candidates, and the third is in `native-receipt`. | Accepted residual risk. First hosted use is the next release PR. Upstream change is small: `@actions/artifact` 6.3.1 and 429 retry handling. |
| F3 | `# v4` beside the CodeQL pins does not name the pinned version, although `ci.yml:37-40` calls the trailing comment load-bearing. | Left unchanged. It predates this work and the PR bytes carry it. It has no functional effect. |
| F4 | Staged plan files still said "planned, not started". | Resolved: status lines and handoff updated at commit. |
| F5 | Alert 8 has instances on `develop`, `main` and `refs/pull/159/merge`. | Phase 2 expectation: `fixed` is expected because the alert follows the default branch (INFERRED). The `main` instance may stay until the next release. |
| F6 | `v4.39.2` and `v4.39.3` already exist, so a grouped CodeQL PR will follow. With no `applies-to`, the group covers version updates only (INFERRED). | No action. Phase 2 already allows for a new PR, which is reported by number. |

## Gate evidence

All of it on tree `ac6f261ba3d152e3200ee71b5c3970fc0c7b8f4c`, base `1f395d3`, darwin-arm64, Node 24.22.1 unless stated. The landing commit adds only plan documents to that tree. No test reads them. Local evidence only: hosted `develop` CI does not run PTY.

| Check | Run by | Load (1/5/15) | Result |
| --- | --- | --- | --- |
| `npm run lint`, `node --check index.mjs` | this session | 71 / 70 / 61 at start | exit 0 |
| `package`, `fast`, `recovery`, `efficiency` | this session | 71 / 70 / 61 to 94 / 107 / 117 | pass; `fast` 1101/1101 |
| `pty:smoke`, attempt 1 | this session | above 100 | **FAIL**: 1 failed, 5 passed, 1 skipped |
| `fast` on Node 22.22.2 | this session | 89 / 103 / 115 to 392 / 294 / 209 | 1103/1103, including `WF-13` |
| `plan` on the tree | this session | not load-sensitive | `broad` |
| `npm ci`, lint, syntax, `npm test` (1103/1103) | `Events` session | from 08:05 | exit 0 |
| `pty:smoke`, attempt 2 | `Events` session | high, not sampled | 7/7 |
| `recovery`, `efficiency`, `package` | `Events` session | high, not sampled | pass |
| `pty` | `Events` session | 84 / 119 / 187 to 31 / 50 / 65 | 264 passed, 0 failed, 1 skipped, 2863 s |

- **Failed attempt.** `the app reaches the data layer at all` failed in `pty:smoke` at 07:33 CET: `expected the Actions tab to fetch on first paint`. The capture's fixed 7-second settle ended while the app was still on its startup `gh` calls, and it never reached the Actions fetch (retained capture: `fixture-calls.txt`, `exitCode` 143). The same tree passed on attempt 2, so this is a timing failure under load (INFERRED from those two runs).
- **Skipped test.** `unmodified 0.15.2 stays source-stale on the same valid aged v6 ledger` needs `GH_GLANCE_BASELINE_ENTRY`. It is an environment skip, not a result.
- **Simplify pass.** No application code changed. The diff is upstream pin and lockfile bytes, digests and a one-line assertion, so there was nothing to reduce.

## Further Phase 1 deviations

- **PTY ran above the load threshold.** Plan said start `pty` at a 15-minute load of 12 or lower. Found the machine at 15-minute 187-317 with 0.44% CPU idle at worst, from unrelated fleet work plus this batch's two gates. Accepted a pass at higher load. Why: the threshold exists to prevent false failures, and fixed settle windows only get harder as load rises. The plan's single normal-load re-run was not needed.
- **Evidence came from two sessions.** Plan assumed one owner. The owner chose on 2026-11-05: the `Events` session finishes its running gate and stops, this session takes the result, runs Phase 2 and prunes. A duplicate PTY run was not started.
- **Commit replaced.** `afdabec` was unpushed and carried a message without the PR references Phase 1 requires. It was re-committed on the same tree plus plan documents. `afdabec` itself never left this machine.
