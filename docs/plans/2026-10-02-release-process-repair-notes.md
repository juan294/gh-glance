# Release process repair implementation notes

## Deviations

### Integration baseline moved before implementation

- Plan said: baseline `develop` at `140c77f2bad6863481dfc941725b9567bb08b7c6`, `main` at `e53fb14d5ddd8c4995e8edd744be17f50104ad0b`, npm `latest` 0.16.0.
- Found: on 2026-10-02 implementation started from `develop` `73d23a25bd6f1ecf4a7be74a39b5057addb7356d`. v0.16.1 had been released in between (`main` `5647e41091d370f069ecd5f319747977db060485`, release workflow run 36998649214 success, npm `latest` 0.16.1, gitHead `5647e41`). The four intervening commits change `index.mjs`, `scripts/sustained-recovery.mjs`, three unit test files, the changelog and an ADR; none touches the workflows, policy files or test harness the plan edits.
- Chose: implement against the new baseline. Record v0.16.1 in the current status blocks; the v0.16.0 receipt required by Phase 1 item 6 is still written as planned. No v0.16.1 receipt is fabricated: its release report and delivery receipt do not exist in the repository, so only the read-only registry and workflow facts are cited.
- Why: the plan's findings and design do not depend on which patch release is current.

### Native release skills carry a project preamble

- Plan said: make the two native release adapters thin references (Phase 1 item 2) while keeping managed baselines intact (D1).
- Found: the native `rpi-release` SKILL.md copies are managed files; any reference adds local drift.
- Chose: a four-line override preamble in both copies, pointing to the playbook and replacing the generic `e2e-pro-playbook.md` reference. Diagnostics now report six local-modified managed files (the four pre-existing rule files plus these two). Manifest hashes and baselines are unchanged.
- Why: this is the documented expected-drift path in D1; rewriting the managed skill bodies would create larger drift on every upstream refresh.

### Phase 2: fixture gh call timing is not recorded per call

- Plan said: a failed capture retains "fixture gh call timings" (Phase 2 item 5).
- Found: the fixture `gh` is a POSIX `sh` script (`test/pty/fixtures/gh`); macOS `/bin/sh` has no sub-second clock, so a per-call timestamp means one extra process per fixture call in every PTY test, several of which assert on millisecond-scale pacing.
- Chose: retain the call log itself (order and arguments) plus capture-level start time, duration, timeout, runtime and platform; do not add a per-call clock.
- Why: perturbing the timing-sensitive fixtures to collect timing evidence would weaken the evidence those fixtures produce. Revisit if a future failure needs per-call timing.

### Phase 2: deferred and platform-limited items

- R10 offline canary readiness is implemented in Phase 4, where the plan places the driver and canary preparation (phase-4.md "Local verification").
- CI upload of retained failure evidence (seven-day, failure-only artifacts) is wired in Phase 3's workflows.
- Linux GNU `script(1)` smoke is UNVERIFIED locally (no Linux environment on this host); the Phase 3 candidate workflow runs the smoke on `ubuntu-latest` and `macos-latest`. Native macOS BSD smoke ran locally.

### Phase 2: CI-FIXTURE-02 is the coordination-blip test

- Plan said: the terminal smoke reuses existing "recovery" scenarios and CI-FIXTURE-02 is `status.test.mjs:867` (Paused then Watching).
- Found: line 867 is "a sub-threshold coordination blip stays silent", the Paused -> Watching case. An earlier smoke draft used the storage-pause test at line 720, which never returns to Watching.
- Chose: the smoke runs the blip test. All six CI-FIXTURE regressions remain unchanged in their files.

### Phase 3: the artifact download action already fails on a digest mismatch

- Plan said: G02, the built-in download digest mismatch "only warns", so a hard check must be added.
- Found: `actions/download-artifact` v8.0.1 (pinned `3e5f45b2cfb9172054b4087a40e8e0b5a5461e7c`) defaults `digest-mismatch` to `error` (read from its `action.yml` at that commit on 2026-10-02).
- Chose: set `digest-mismatch: error` explicitly and keep the independent hard checks anyway: every candidate job compares the downloaded tarball's SHA-256 with the pack job's output, and the publisher recomputes the archive digest against GitHub's recorded digest plus the manifest's SHA-256/SHA-512.
- Why: the plan's invariant (hard failure on any mismatch) holds either way; the explicit input documents it and survives a default change.

### Phase 3: candidate artifacts are named by the tested tree

- Plan said: the publisher selects the exact successful run/attempt and validates artifact identity and tree.
- Chose: the pack job uploads `release-candidate-<tested merge tree SHA>` once (`overwrite: false`). The publisher lists successful same-repository `pull_request` runs of `ci.yml` for the merged PR head and accepts only a run with exactly one artifact named for the production merge tree; several runs of the identical tree are equivalent and the newest is taken. The manifest inside must still name that run, attempt, PR, head and tree.
- Why: the name binds selection to the one fact that must match (tree equality) before any download, so a base update that changes the merge tree can never select an older candidate.

### Phase 3: legacy context names and exact runtime pins

- Found: pinning the test/smoke matrices to `22.22.2`/`24.21.0` would rename the required contexts `Test (Node 22)` etc.
- Chose: `matrix.include` carries the major for the job name and the exact version for `setup-node`. WF-02 renders the names and asserts they equal the required contexts.

### Phase 3: the original smoke's refusal checks moved into the package exercise

- The old `Smoke (Node N)` job asserted exit 1 for a non-TTY stdout and exit 2 for an unknown flag on the checkout. `scripts/package-check.mjs` asserts both on the installed candidate for every Node it runs, so the job no longer repeats them on the source tree.

### Phase 3: publisher bootstrap trust boundary

- Plan said: a read-only bootstrap establishes the tag's protected-main merge association before executing tagged code; an unprotected tag with a modified verifier must execute neither tag code nor publication.
- Found: on a `release` event GitHub runs `release.yml` from the tagged commit itself. Environment `npm` has no protection rules or deployment policy, and the repository has no tag rulesets (read-only API, 2026-10-02). Develop commits are ancestors of `main` too, because releases use merge commits.
- Chose: before the tagged commit is checked out, the `verify` job checks out protected `main` (scripts only) and runs its tested `bootstrap` (`bootstrapDecision`): the tag points at the triggering commit, the commit is on `main`, and it is the merge commit of exactly one merged same-repository `develop` -> `main` PR. Only then does it check out the tagged commit and run its verifier. Checked read-only against the real repository: v0.16.1 passes; a develop commit (an ancestor of `main`) is rejected.
- Residual risk, UNVERIFIED as a property: a tag on a commit whose own `release.yml` was modified would run that modified file, so "an unprotected tag executes no tag code" cannot be guaranteed by workflow code. The trusted-publisher binding fixes the file name and environment, not the commit. Closing this needs environment `npm` deployment tag rules and/or a `v*` tag ruleset, an owner settings decision listed in the Phase 4 activation dossier. Today only the owner can push tags.
- Native evidence: OIDC publication, provenance and the hosted artifact path remain UNVERIFIED until the first authorized release that carries these workflows. The pinned npm 11.21.0 publish path was verified locally against a loopback registry on Node 22.22.2 and 24.21.0, including publishing from a checkout whose own lifecycle scripts must not run. Those local runs omit `--provenance`, which needs a hosted OIDC identity.

### Phase 3: gitHead is absent with a tarball publish

- Found: `npm pack` does not write `gitHead`, and publishing a tarball path sends none (npm 11.19.0, verified locally by the reviewer; INFERRED for 11.21.0 hosted). Directory publishes such as v0.16.1 carried the production commit.
- Chose: record the registry `gitHead` (expected empty) in the delivery receipt without requiring it, and bind the production commit through the SLSA provenance statement (`resolvedDependencies[].digest.gitCommit`), together with the subject SHA-512, repository, `release.yml` and `refs/tags/vX.Y.Z`. `verifyProvenance` was checked against the real v0.16.1 attestation (accepts it; rejects a wrong commit or version). The tarball is never rewritten to manufacture a `gitHead` (plan D3).

### Phase 3: protection transition work moves to Phase 4

- Plan said: Phase 3 saves the old/new expected contexts and an exact add-before-remove payload, and tests the interrupted transition (R06).
- Chose: implement both in Phase 4's `scripts/release-policy.mjs` with the driver and activation dossier, where the payload is used. Phase 3 keeps the legacy context names producing real work (WF-02) so nothing is required yet.

### Phase 3: candidate runs are bound to the PR through the manifest

- Found (review): GitHub empties a workflow run's `pull_requests` once its PR merges, so a run cannot be matched to the PR number after the merge.
- Chose: select runs by repository, workflow, event, head SHA, branch and the tree-named artifact; offer every eligible run newest first and accept the first whose manifest names the merged PR (and passes every other check). Another PR's same-tree run fails closed in `verifyArtifact`. RC-04 now uses the real post-merge run shape.
- Note: the publisher reads job results for the run attempt that produced the artifact (`attempts/{n}/jobs`). After a partial re-run of failed jobs, jobs that succeeded in an earlier attempt may be absent there and the candidate fails closed; hosted re-runs are already outside the playbook.

### Phase 3: simplify pass shaped the workflow layer

- Shell logic in YAML moved into tested helper subcommands: `pack`, `use-candidate` (digest check, optional install, environment export), `bootstrap`, and `aggregate` with an `only` filter for the legacy `PTY` context. The PTY shards are the selector's `pty:governor` / `pty:rest`, proven to partition the full selection.
- A develop push while the release PR is open is planned as `covered` (only the aggregate runs), removing the push/PR duplicate the postmortem counted. Main pushes run only the promotion identity check and the aggregate. Recovery and efficiency share one `Recovery and efficiency` job. Delivery is one job: one registry readback, one provenance check, one fresh install exercised on both Node versions.
- Every `node-version` and `npm@` literal in the workflows is held to `PINS` (WF-07), and every job name the publisher requires is checked against the rendered `ci.yml` names (WF-02).
- Not changed: the pack job keeps `npm ci` (plan item 4 says locked install); nightly coverage is not skipped for an unchanged head.

### Phase 3: CLI glue covered by review readback rather than fake-API tests

- The `plan-ci`, `manifest`, `verify-candidate`, `registry-state` and `deliver` subcommands wrap tested pure functions. The reviewer exercised the read paths against the real repository and registry (artifact zip digest equals the API digest; `commits/<sha>/pulls` finds the merged release PR; registry match/absent/collision; delivery of 0.16.1). The write paths (upload, publish) are first exercised natively by the first authorized release.

### Phase 3: push runs report under their own names

- Found (review): check runs from a develop push and from the release PR land on the same head commit under the same names (two `Lint` and two `PTY` on `73d23a2`, read-only). With the new routing a push run's checks can be skipped (`covered`) or quicker than the candidate's.
- Chose: only `pull_request` runs carry the required names (`Lint`, `Test (Node N)`, `Smoke (Node N)`, `PTY`) and `Release candidate`; push runs render "(push)" names and "Push checks", and `PTY` does not run on push. WF-02 renders every job name for both events and fails if a push run could produce a required name (mutation-checked).
- UNVERIFIED: how branch protection chooses between same-named check runs from different suites. The change removes the question rather than relying on an answer.

### Phase 4: protection migration is planned by the driver, applied under activation authority

- Plan said: the driver carries existing authority through ordinary steps; protection changes add before remove and wait for explicit activation authority.
- Chose: `release.mjs protection` is read-only. It reads `main`'s required checks and the latest candidate runs and prints the single next `PATCH .../branches/main/protection/required_status_checks` body (add `Release candidate` once observed succeeding; then retire the six legacy contexts, keeping CodeQL, dependency review, strict and app bindings), or why to wait or stop. Applying a step is one `gh api` call made under the activation decision, then the command is run again for readback.
- Why: settings changes are the one activation step outside the ordinary release sequence; keeping them out of `resume` means release authority can never imply a protection change. PROT-01..03 simulate the transition, interruption and drift from the captured eight-context shape.

### Phase 4: R09 and R10 are proven against simulated boundaries

- R09: every external side effect is followed by a simulated crash in DRV-03; resume reads back and never repeats push, PR creation, merge, tag or release. The lock tests inject process liveness rather than killing real processes.
- R10: `planCanary` and `canaryMayAdmit` prepare and bound a canary offline (one running Actions pane, five minutes, 20 admissions per resource above max(40% of the limit, the product reserve), unknown charge stops, one-shot secondary checks) and validate the manifest with the monitor's own `validManifest`. No live canary runner exists or was run; none is needed for this process-only change. The monitor's schema is unchanged; G08 is addressed by declaring only continuously active Actions (README).
- Real read-only use: `prepare 0.16.2`, `protection` and `status` ran against the live repository on 2026-10-02 (no mutation); `prepare` found the next release's real prerequisite (merge `origin/main`'s v0.16.1 commit back into `develop`).

### Phase 4: what "no publication authority" permits

- Plan said: R01, "absent publication authority performs no mutation".
- Chose: the merge into `main` is a publication stage (`main` tracks released state), so without publication authority the driver stops before the merge, tag and release. Pushing the reviewed candidate to `develop` and opening the release PR are integration steps and need explicit `integration` authority; with neither, nothing moves (DRV-02).
- Why: it keeps protected `main` and npm unchanged without publication authority, while letting an owner authorize the hosted candidate gate on its own.

### Phase 4: the corrective allowance is test-only and reviewed

- The playbook allows fixture/harness/workflow-wiring repairs that leave packaged behavior unchanged. The driver enforces the narrow, mechanically checkable subset: after failed required checks only, a new candidate that changes nothing outside `test/` (rename-proof `git diff --no-renames`), with `--correction-review` naming its independent review and local gate. Workflow, script, dependency and packaged-file repairs need a new decision even when the playbook would call them wiring, because the driver cannot verify that they leave release control unchanged.
