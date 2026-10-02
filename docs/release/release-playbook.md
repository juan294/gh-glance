# gh-glance release playbook

This is the one project procedure for a gh-glance release; every release
command, skill and rule routes here, and it replaces the generic cc-rpi release
playbook for this repository.

History only, not required reading for a release: the
[v0.16.0 postmortem](../research/2026-10-02-v0.16.0-release-postmortem-assessment.md)
and the [repair plan](../plans/2026-10-02-release-process-repair.md).

## Topology

- `develop` is the unprotected integration branch. `main` is protected (strict
  up-to-date checks, admins included, PR-only) and is the released state.
- A release is one `develop` -> `main` pull request merged with a **merge
  commit** (never squash, never `--delete-branch`), then an annotated tag on
  the resulting `main` commit and a published GitHub release.
- Publishing the GitHub release triggers `.github/workflows/release.yml`
  (environment `npm`), which publishes through **OIDC trusted publishing**.
  There is no npm token and there must never be one. Never run `npm publish`
  from a workstation.
- Repository auto-merge is disabled. Merge the release PR explicitly once
  every required check on its exact head is green.

## Authority

One owner decision covers one named release. It states the version, the
reviewed scope or candidate, accepted limitations, the publication
destination (npm via the release workflow) and whether the optional
corrective allowance below applies. With that decision, the whole ordinary
sequence below is covered: the single integration push, the release PR, the
protected merge, the tag, the GitHub release, delivery verification and owned
cleanup. Do not ask again for a
step the decision already covers.

Here, publishing the GitHub release **is** npm publication: without npm
publication authority, stop before the tag and release.

Ask only for a genuinely missing decision, and name it exactly: for example
"publication to npm was not authorized" or "the corrective allowance is
exhausted". Plan acceptance, implementation approval, a receipt field or a
command-line flag never creates release authority.

**Optional corrective allowance.** When a release's decision grants it, it
permits **one** corrective push after a hosted candidate failure, and only when
the repair:

- is confined to test fixtures, the test harness or workflow wiring;
- leaves the five packaged files, dependencies, version and release scope
  unchanged;
- changes no workflow permission, trigger, environment or trust binding
  (those are release-control changes that need their own review and decision);
- was independently reviewed and passed the complete applicable local gate.

There are **zero** blind hosted reruns. A second failure, a product or
dependency change, new live or paid scope, or a materially different candidate
needs a new owner decision. No delegated agent decides on its own to push,
merge, tag or publish.

## Procedure

### 1. Prepare (local)

1. Work in an owned worktree from current `develop`; never pull through a
   dirty shared checkout. Fetch, then confirm `origin/main` is an ancestor of
   `develop`. If it is not (every previous release leaves its merge commit only
   on `main`), merge `origin/main` into `develop` **locally**. It ships in the
   single `develop` push of stage 2, pushed plainly: `git pull --rebase` would
   flatten the merge and leave the release PR BEHIND.
2. Bump with `npm version <x.y.z> --no-git-tag-version`; add the
   `## [x.y.z] - YYYY-MM-DD` changelog section. Diff `CHANGELOG.md` against the
   previous tag so in-flight entries do not land under an already published
   heading. Grep the old version across tracked files.
3. Run the complete applicable local gate sequentially, keeping every exit
   status: `npm run lint`, `node --check index.mjs`, `npm test`, plus
   `npm run test:efficiency` and `npm run test:pty` when the change touches
   their areas. `npm run test:fast`, `test:recovery`, `test:package` and
   `test:pty:smoke` are named subsets for quick feedback, not substitutes. A
   later pass never erases an earlier failure.
4. Get an independent review of the release diff. A routine release does
   **not** require a fresh broad pre-launch audit or exploratory charter; use
   independent review for substantial changes and keep useful charter
   scenarios as regressions.
5. Confirm tool readiness before the first remote action: `gh auth status` and
   the workflow triggers. CLI is the first route; permitted browser automation
   is the fallback only for a genuine CLI failure. A tool or policy denial is
   reported as that restriction, never routed around and never turned into
   another request to approve the same release.

### 2. Verify the candidate (hosted)

1. Push `develop` once. Open the release PR if none exists
   (`gh pr list --base main --head develop` first).
2. Observe what gates the merge with
   `gh pr checks <number> --required --watch`, and confirm every context `main`
   protection requires appears in it (a context that never reports is missing,
   not passing). Missing, skipped, canceled or failed required checks block.
   For a failure, find its run with
   `gh run list --commit <full-sha> --event pull_request` (a short SHA silently
   matches nothing) and read `gh run view <id> --log-failed`; diagnose and fix
   locally. Never rerun a hosted job to collect evidence.
3. Sutura and the coverage workflow (push and scheduled) are optional observers.
   They never block a release and are never waited for. Correlate a Sutura run
   through its triggering run ID, not its own default-branch SHA, and report its
   actual repair result; never merge its output automatically.

### 3. Promote (protected)

Merge with `gh pr merge <number> --merge` once all required checks are green.
Read back the merge commit on `main` and confirm its tree matches the tested
candidate and that the merged PR head is the approved candidate.

### 4. Publish

Create the annotated tag on the verified `main` merge commit and push it by
full ref (`git push origin refs/tags/vX.Y.Z`; never `--tags`). Then
`gh release create vX.Y.Z --verify-tag --title vX.Y.Z --notes-file <notes>`.
That publication triggers the release workflow; observe it by run ID.

Until the candidate-artifact repair is active, the publisher re-packs the tag
and skips an existing version without comparing bytes (see
[Transition](#transition-current-versus-planned-workflows)). A logged "already
published" is therefore not proof of a match: compare the registry against the
reviewed tag in step 5 and treat any difference as a collision.

### 5. Delivery and readback

Read the registry once: `npm view gh-glance@x.y.z version dist.integrity
dist.shasum gitHead dist-tags --json`. `gitHead` must be the tagged `main`
commit and `latest` the new version. `dist.shasum` must equal the full
`npm notice shasum` line in the release workflow log (that log truncates the
integrity, so record the full `dist.integrity` from `npm view`); once the
repair is active, both must equal the accepted candidate's. Install the exact
version once into an empty owned directory, run the installed binary's
`--version` and `--help` with Node 22 and with Node 24, and run
`npm audit signatures` there to verify provenance. Registry lag is normal:
retry with capped backoff for at most five minutes, then report **published;
delivery unverified** and resume read-only later. Never republish to "fix"
lag.

### 6. Receipt and owned cleanup

Write the current status at the top of the release report under
`docs/release/`: version, integration and production SHAs, tag, release and
publisher run URLs, artifact integrity, provenance and installed smoke
results, and every accepted limitation. Keep earlier failure history beneath
it, labeled as dated history. A receipt-only follow-up commit goes into the
next ordinary integration, not into the released candidate and not into an
extra push. Then remove only paths, branches and worktrees this release
created; preserve unrelated untracked files.

## Transition: current versus planned workflows

The [repair plan](../plans/2026-10-02-release-process-repair.md) changes the
hosted gates, including test selection, in two later steps; until each is
activated, the current executable workflow is what controls.

| Area | Current workflow | After activation |
| --- | --- | --- |
| Candidate CI | Full suites on every `develop` push, PR and `main` push; required contexts are the eight legacy names | Release PR owns one selection, packs once and uploads the tarball; an always-running `Release candidate` aggregate joins the required contexts before legacy ones retire |
| Publisher | Re-tests, re-packs the tag, floating npm, skip-on-existing without byte comparison | Downloads the accepted tarball by run and artifact ID, verifies tree and digests, pinned npm, publishes `./artifact.tgz` with `--ignore-scripts`, and blocks on a byte mismatch |
| Delivery | Manual readback (step 5) | Bounded registry, provenance and installed-binary verification in a separate unprivileged job |

## Outcomes are separate

A release outcome (published and delivered), a canary outcome (a named live
risk observed under a finite budget) and an incident outcome (F12 personal
and work EMU qualification) are independent. A successful publication never
closes F12 or the original freshness incident, and a missing live window never
blocks an otherwise verified release unless the release decision says so.

Routine releases have **no live soak**. If a change carries a named live risk,
declare it and the exact environment first, then use at most one already
running Actions pane, five minutes, no new panes or restarts, and no more than
20 extra admitted calls per resource while keeping
max(40% of the observed limit, the product reserve) remaining. Unknown cost
stops new requests. Never pause other fleet tools or migrate credentials as an
implicit prerequisite.

## Failure handling

- A failed or canceled check stays failed in the record, even after a later
  local repair passes.
- Repair proven fixture assumptions; never delete or weaken a meaningful
  assertion to obtain a pass.
- After a hosted failure, follow stage 2 step 2, reproduce and fix locally and
  run the complete local gate. Then use the corrective allowance if it was
  granted and the repair qualifies; otherwise present the repaired candidate
  for a decision.
- An interrupted step is resumed by reading GitHub and npm state first. Tag,
  release and version are immutable identities; a wrong target or a registry
  version with different bytes is a collision that blocks, never something to
  overwrite.

## Project-local customization of managed files

The native `rpi-release` skill copies carry a short project preamble pointing
here. These and the four pre-existing customized rule files
(`.claude/rules/{testing,deployment-safety}.md`,
`.rpi/rules/{testing,deployment-safety}.md`) are expected local drift reported
by `.rpi/scripts/rpi-diagnostics.py`; upstream baselines and manifest hashes
are left untouched. The retained `/release` and `/fix-ci` commands and their
migrated Codex skills are project-owned and are thin routes to this page and to
the native `rpi-fix-ci` skill.
