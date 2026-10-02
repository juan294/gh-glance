# Release process repair: activation dossier

Status: **prepared locally; nothing activated.** This is the reviewable package for the owner's one release/activation decision (plan Phase 4, "Separately authorized activation"). It grants no authority by itself.

## What is ready locally

- On branch `release-process-repair` (local only), to be merged into local `develop` after Phase 4 acceptance: the playbook and adapters (Phase 1), explicit test selections and evidence (Phase 2), candidate artifact and workflow repair (Phase 3), and the release driver plus policy helpers (Phase 4). Exact commits, trees and check results are in each phase's validation note ([1](../plans/2026-10-02-release-process-repair-phases/phase-1-validation.md), [2](../plans/2026-10-02-release-process-repair-phases/phase-2-validation.md), [3](../plans/2026-10-02-release-process-repair-phases/phase-3-validation.md), [4](../plans/2026-10-02-release-process-repair-phases/phase-4-validation.md)).
- `origin/develop` gained `9915007` (Sutura pin, #148) while this work was local; the local integration merges it, and `prepare` refuses a candidate that does not contain it.
- `node scripts/release.mjs prepare|status|resume <version>` drives the playbook's ordinary sequence with readback before every action; `--dry-run <fixture>` traces it without external effects. `node scripts/release.mjs protection` prints the next protection step without changing anything.
- Publication route: the driver uses `gh`; if a genuine CLI failure blocks the GitHub release step, the permitted fallback is the GitHub web form for that same tag and notes, after which `resume` reads the release back and continues. A policy denial is reported as such, never routed around.

## Decision needed

One owner decision naming:

1. **Version and scope.** The first release carrying this repair is a broad-profile candidate (its diff touches workflows, scripts and tests). Suggested version: the next patch after the current `latest` (0.16.1), unless other changes land first. Preflight on 2026-10-02 (`release.mjs prepare 0.16.2`, read-only) also found that `origin/main` carries the v0.16.1 merge commit that `develop` lacks: merge it back locally first, as every release requires.
2. **Integration push and release.** The single `develop` push, the release PR, its protected merge, the tag and the GitHub release (which publishes to npm through the new `release.yml`).
3. **Protection migration** (settings change, add before remove):
   - Step 1, after `Release candidate` is observed succeeding on the release PR: add it to `main`'s required checks alongside the eight existing contexts (strict and admin enforcement unchanged).
   - Step 2, after readback shows it required: remove `Lint`, `Test (Node 22)`, `Test (Node 24)`, `Smoke (Node 22)`, `Smoke (Node 24)` and `PTY`, keeping `analyze (javascript-typescript)`, `dependency-review` and `Release candidate`.
   - Each step is one `PATCH repos/juan294/gh-glance/branches/main/protection/required_status_checks` with the body `release.mjs protection` prints; that endpoint changes only strict and the check list. Drift or a missing security context stops the migration. The legacy contexts may also simply stay required: they now carry real selected work.
   - `PTY` is currently bound to no app (`app_id: null`); the planned body sends `-1` ("any app") to keep that. This mapping is INFERRED from the REST documentation and is checked by the readback after step 1.
4. **Optional corrective allowance** for this release (0 or 1), per the playbook.
5. **Optional hardening** that closes the residual publisher risk recorded in the Phase 3 notes: environment `npm` deployment rules limited to `v*` tags, and/or a `v*` tag ruleset. Not required to release.

## Accepted limitations to state in the decision

- OIDC publication of a verified artifact, npm provenance for a tarball publish, the hosted artifact path, Linux GNU terminal smoke and the macOS hosted smoke are first exercised natively by this release. Local proof covers the pinned npm 11.21.0 publish path against a loopback registry, the decision code, the workflow structure and the driver's git adapter against a local bare remote; its GitHub and npm adapters were exercised read-only (`prepare`, `protection`, `status`), not their mutating calls.
- The publisher's residual risk recorded in the Phase 3 notes (a tag whose own `release.yml` was modified) stays open unless the optional hardening below is chosen.
- A failed hosted check is diagnosed from logs and repaired locally; only the granted corrective allowance permits a second push.
- F12 personal/work EMU qualification and the original incident stay **OPEN**. No live canary is needed for this process-only change.

## Measurements owed

On this and the next authorized release, record against the plan's targets: fast feedback (target 2 minutes or less), accepted candidate to delivery (15 minutes or less), coordination/recovery gates (30 minutes or less), plus queue time, repeated selection count and owner decision count. Report each as met, missed or unmeasured. Locally, the fast selection ran 756 tests in 24.3 s on Node 24.21.0 (Phase 2 validation); hosted timings are unmeasured.
