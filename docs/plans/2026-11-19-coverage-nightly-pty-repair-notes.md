# Coverage nightly PTY failures: repair notes (2026-11-19)

## Objective and scope

`/rpi-fix-ci` for the failing nightly Coverage workflow on `develop`. Authorized scope: diagnose existing runs, repair locally, commit to a local branch and merge it into local `develop`. No push, rerun or hosted action was taken. The `develop` push needs separate owner authorization. Overlay read: `.rpi/project/rpi-fix-ci.md` (no declared overrides; push follows the playbook's failure handling).

## Failed runs (all on bb5b3ea7776fbc2d800a23f8d206b439f4fe5bcc)

Every failure was in the step `Measure PTY child-process coverage`. The unit coverage step passed (1118 of 1119; the remaining one is not a failure). Runs ended at about 51 to 53 minutes, inside the 60-minute limit, so these are test failures, not the earlier timeout.

| Run | Date | Failing tests |
|---|---|---|
| 43798936187 | 2026-11-16 | SET-01/02/07/11/12 manual setup ("No workflows found" barrier) |
| 44010437916 | 2026-11-17 | SET-08/11; CI partial attempt page; CI source refresh; CI forced run admission hold; CI forced jobs admission hold; CI context rejection; Jev Focus freezes manifest |
| 44451708832 | 2026-11-19 | PAGE-01 scrolling toward the end acquires one page |
| 43933968742 (CI #395, Dependabot PR #184, codeql.yml only) | 2026-11-16 | PAGE-01; CI forced run admission hold |

Coverage passed on 2026-11-15 and 2026-11-18 on the same commit.

## Findings and dispositions

- **F1, resolved: PAGE-01 dropped the demanded page.** The hosted symptom appeared twice: two `issues.page first=50 after=-` calls and no `after=cursor:50`. I reproduced it locally in 1 of 48 concurrent runs with temporary instrumentation. The demanded fetch had `pages: 2`. The governor scheduled page two 727.0098 ms ahead. After the wait, `startReservation` returned `{status: "waiting"}` because the clock was still short of the fractional `notBefore`. `resolveGovernorAdmission` called `start` only once, cancelled the intent, and `fetchGraphqlList` ended the walk silently. The cause: pacing gives `notBefore` a fractional millisecond, while `Date.now()` and Node timers resolve whole milliseconds. The reviewer measured early wakes on 37 of 200 and 39 of 200 trials with fractional targets, and 0 of 1500 with whole-millisecond targets. Fix: `resolveGovernorAdmission` sleeps off any remainder before `start`. The loop allows at most 3 extra sleeps and stops if the remainder exceeds `waitMs`. Regression: `test/governor.test.mjs` "a wait that wakes before the scheduled slot sleeps the remainder instead of being refused". Without the fix it fails with the production signature.
- **F2, unresolved, possibly related: CI forced run/jobs admission hold** (failed on 2026-11-16 and 2026-11-17). Its explicit retries use `runAdmittedOperation` with `waitMs: 2000`, which is the same single-start path. That makes F1 a plausible cause, but this is inferred and has no evidence yet. The hosted capture evidence is under the runner's `/tmp` and was not uploaded. Watch the next nightlies.
- **F3, unresolved, load-sensitive: the other failing tests** (SET-*, CI partial attempt, CI source refresh, CI context rejection, Jev Focus). Each failed once. They are UI barrier timeouts, and on 2026-11-17 they clustered within about 12 minutes, which suggests a slow runner period. No common code cause was found. This matches the known pattern in `ci-pty-flakes-are-preexisting`. No retry machinery or timeout loosening was added.
- **Sutura repair run 43940055211** ended `gave-up` (failure-identity stop) for CI #395. That run is owned by Sutura. It is reported here and was not changed.

## Checks (worktree `/Users/juan/code/gh-glance-wt-fixci`, branch `fix/page01-admission`, final code)

Sequential, Node v24, macOS, load average 12 to 19 during PTY:

- `npm run lint` 0; `node --check index.mjs` 0
- `npm test` 0: 1120/1120
- `npm run test:efficiency` 0: 9/9
- `npm run test:pty` 0: 265 tests, 264 pass, 1 skipped (opt-in `GH_GLANCE_BASELINE_ENTRY` baseline), 0 fail
- PAGE-01 stress with `NODE_V8_COVERAGE`, 48 concurrent runs: 48/48 pass after the fix. Before the fix, the same method failed 1 of 48. This is consistent with the fix but does not prove it.
- `CHANGELOG.md` gained an Unreleased entry while the gate was running. It is documentation only, and the gate result does not depend on it.
- Node 22.22.2: `node --test test/governor.test.mjs` 126/126, after the commit. The full suites were not run on Node 22, and the Coverage workflow itself was not run locally.

Independent review: no correctness defects. Two low-severity findings were applied: the remainder bound by `waitMs`, and corrected comments in the code and test.

## Next action

The owner authorizes the single `develop` push. Then watch the next nightly Coverage runs for PAGE-01 and F2. If F2 recurs, retain and upload its capture evidence before diagnosing.
