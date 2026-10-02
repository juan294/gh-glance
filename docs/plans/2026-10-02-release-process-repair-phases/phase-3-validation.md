# Phase 3 validation: candidate artifact and workflow repair

Status: **locally verified after independent review (four rounds), repair and simplify.** Workflows, release helpers, tests and documentation; `index.mjs` and the terminal tests are unchanged. Nothing was pushed and no workflow ran on GitHub: every hosted claim below is UNVERIFIED until the first authorized release.

- Worktree `/Users/juan/code/gh-glance-release-repair`, branch `release-process-repair`, on top of the Phase 2 commit `8bf3e1f`. Final tested tree: `29f4572eadead5fcbb3a700531bb00225f86a792`.

## Items

| Item | Result |
| --- | --- |
| 1 Helpers | `scripts/release-candidate.mjs`: pure decisions (`planCi`, `aggregate`, manifest schema, `selectCandidate`, `verifyPromotion`, `verifyArtifact`, `checkCandidateJobs`, `verifyProvenance`, `bootstrapDecision`, `classifyRegistry`, `publishDecision`, `pollRegistry`, `deliveryCheck`) and a thin CLI (`plan-ci`, `pack`, `manifest`, `use-candidate`, `aggregate`, `verify-promotion`, `bootstrap`, `verify-candidate`, `registry-state`, `deliver`). |
| 2 Inputs | Immutable manifest (schema 1, strict keys, no self-reported outcome, no upload ID/digest) plus a trusted envelope read from GitHub: artifact ID/name/digest/expiry, run/attempt and the run's job results. The verifier joins them in `candidate-receipt.json`. |
| 3 Routing | `planCi`: release PR = candidate (one selection); develop push = quick checks, or only the aggregate while the release PR is open; other PRs read-only; main push = promotion identity only. Always-running `Release candidate` aggregate; legacy contexts carry real work; only `pull_request` runs use required check names. No `pull_request_target`. |
| 4 Pack | Pinned Node 22.22.2 / npm 11.21.0, `npm ci`, one `npm pack --ignore-scripts --json` (`pack` subcommand), upload `release-candidate-<tested tree>` with manifest, 30 days, no overwrite. Smoke and terminal smoke download by ID, `digest-mismatch: error`, and `use-candidate` hard-checks the pack job's SHA-256. The smoke runs the package selection (including installed collector routes) on that tarball and may not repack. |
| 5 Selections | Fast on Node 22/24; recovery + efficiency once (`Recovery and efficiency`); full PTY as the selector's `pty:governor` / `pty:rest` shards (a proven partition); terminal smoke on Linux, plus macOS for candidates; failure evidence uploaded for 7 days. |
| 6 Coverage | Scheduled and manual only, Node pinned; the existing coverage tests were updated to that contract. CodeQL, dependency review and Sutura unchanged. |
| 7 Publisher | Read-only `verify` job: protected-`main` `bootstrap` before any tagged checkout, then the tagged verifier finds the eligible runs by tree-named artifact, reads each run's job results, checks GitHub's archive digest before unzip, requires exactly `artifact.tgz` + `manifest.json` as regular files, verifies manifest, tarball digests, tree, PR and run, and passes the bytes on by artifact ID. |
| 8 Promotion | Tree equality (not commit equality) between the tested PR merge and production, tag = merge commit, tag/package/changelog version, merged same-repository `develop` -> `main` PR. Main push runs this check alone. |
| 9 Publish | Pinned Node/npm, OIDC only, `npm publish "$GH_GLANCE_PACKAGE_TARBALL" --ignore-scripts --provenance --access public`, package-level concurrency without cancellation, registry classified after entering the slot (absent publishes; exact match skips; collision, unknown answer or older-than-latest blocks); a failed publish reads back as "publication unknown". |
| 10 Delivery | One unprivileged job: five-minute bounded readback with Retry-After, integrity and `latest`; SLSA provenance bound to these bytes, `release.yml` at the tag and the merge commit; one fresh install run on Node 22 and 24 with gh-glance's own verified attestation; receipt uploaded for 90 days. `gitHead` recorded, not required. |

## Review

Independent security/identity review, four rounds:

1. CHANGES REQUIRED, six majors: package selection no longer ran in CI; bootstrap only checked ancestry (develop commits are ancestors of main); provenance checked for presence only; playbook required a `gitHead` a tarball publish lacks; candidate job results unread; R06 work absent. Plus minors (docs-profile contexts, re-run of failed jobs, shell interpolation, zip entry checks, tie-break, version regex, publish from a checkout). All fixed; R06 moved to Phase 4 (deviation).
2. CHANGES REQUIRED, one blocker: requiring `run.pull_requests` would reject every merged release (GitHub empties it after merge; verified on run 36996522942). Fixed by binding the PR through the manifest and trying eligible runs newest first.
3. CHANGES REQUIRED, one major: push runs posted required check names on the release head. Fixed with event-dependent names.
4. CHANGES REQUIRED, one major: a job skipped by its `if` still posts a check run, so `PTY` also needed a push name. Fixed; then APPROVE.

Simplify (two combined angles): YAML shell moved into tested subcommands (`pack`, `use-candidate`, `bootstrap`, `aggregate --only`); PTY shards from the selector; duplicate develop-push CI removed while the release PR is open; main push no longer re-lints; one delivery job; recovery and efficiency share a runner; artifacts found by name in one query; registry read once through `fetch`; pins held to `PINS`; publisher job names derived and checked against `ci.yml`. Skipped: dropping `npm ci` from pack (plan requires a locked install), nightly coverage skip for an unchanged head.

## Evidence

- Red before green: workflow oracles WF-01..06 and NPM-01 failed against the pre-repair workflows (genuine assertion failures, after an initial run whose "red" was a fixture path error and was redone). Helper tests were written with the helper; the new negative cases (RC-02..RC-11) each pin a failure path.
- Real read-only checks this session: `verifyProvenance` against the v0.16.1 attestation (accepts; rejects wrong commit/version); `bootstrap` accepts v0.16.1 and rejects develop commit `73d23a2`; `package-check --installed gh-glance@0.16.1` verifies gh-glance's own attestation; `npm audit signatures --json` lists verified package names. The reviewer additionally read back artifact zip digests, PR lookup, run and job shapes, and registry states against the live API.
- Pinned npm 11.21.0 (installed into a private prefix) publishes exactly the verified bytes to a loopback registry with no lifecycle scripts, also from a checkout with its own lifecycle scripts, and a refused publish fails, on Node 22.22.2 and 24.21.0. `--provenance` is not exercised locally (needs hosted OIDC).
- `actionlint` (with shellcheck) passes on all workflows.

## Checks (sequential, exits retained)

| Check | Result |
| --- | --- |
| First gate, tree `a96ff14` | lint 0, syntax 0, actionlint 0; `npm test` **1** (782/784: two `coverage-reporting` tests still asserted the old push-triggered coverage workflow, a consumer missed in Phase 3 and then updated); `npm run test:efficiency` 0 (9/9, 204 s); `npm run test:pty` **1** (158 passed, 1 skipped, 1 failed: CI-FIXTURE-02 "a sub-threshold coordination blip stays silent", see below) |
| Final gate, tree `29f4572` | `npm run lint` 0; `node --check index.mjs` 0; `actionlint` 0; `npm test` 0 (784/784, 338 s); `npm run test:pty` 0 (160 tests: 159 passed, 1 known optional baseline skip, 0 failed, 1,980 s) |
| Efficiency on the final tree | Reused from the first gate: the only files changed between the two trees are `.github/workflows/ci.yml`, `test/coverage-reporting.test.mjs` and `test/workflows.test.mjs`, none of which the efficiency selection reads |
| Targeted | release-candidate, workflows, npm-publish, test-select, package-check: all pass; npm-publish 4/4 with pinned npm 11.21.0 on Node 22.22.2 and 24.21.0 |

The first gate's PTY failure stays failed in this record. Mechanism, from the retained evidence bundle and the test's own timing line: the product shows the coordination notice after 800 ms (`COORDINATION_NOTICE_AFTER_MS`, `index.mjs:210`); the test measured 747 ms from the *rendered* Paused frame to Watching, while the app's hold timer starts earlier, at lock acquisition, so at a host load average near 70 the real hold crossed 800 ms and the notice correctly appeared. Phase 3 changed neither `index.mjs` nor any terminal test or fixture (`git diff 8bf3e1f -- index.mjs test/pty` is empty). The same case passed 6/6 in isolation (253-579 ms) and in the final gate (464 ms). It is a narrow pre-existing timing margin under extreme load, not a regression; no timeout or assertion was loosened.

## Handoff

Next entry: Phase 4 from this commit. The workflows take effect only with the first authorized push; branch protection still requires the eight legacy contexts.
