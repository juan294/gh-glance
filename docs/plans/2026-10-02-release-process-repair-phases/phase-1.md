# Phase 1: one release procedure and accurate status

Parent: [release process repair](../2026-10-02-release-process-repair.md). Entry: accepted plan and authorization for local implementation. Status: planned.

## Outcome and scope

Resolve A04/A06/A07/A08 and G07/G08/G10 at the instruction and handoff layer. One short project procedure explains the complete release, its actual authority, evidence and stopping conditions. Historical release failures remain intact beneath a correct current status. This phase changes documentation and project adapters only; no release/settings action occurs.

Source contracts: [CLAUDE.md:49](../../../CLAUDE.md:49), [managed push policy:8](../../../.rpi/rules/push-accountability.md:8), [retained push policy:19](../../../.claude/rules/push-accountability.md:19), [native release skill:8](../../../.agents/skills/rpi-release/SKILL.md:8), [legacy release command:81](../../../.claude/commands/release.md:81), [legacy repair command:23](../../../.claude/commands/fix-ci.md:23), [original Phase 4:38](../2026-09-28-durable-freshness-and-recovery-phases/phase-4.md:38).

## Changes

1. Create `docs/release/release-playbook.md` with prepare → verify candidate → protected promotion → publish exact artifact → delivery/readback → owned cleanup. Explain implemented versus planned workflow behavior during transition. Until Phase 3/4 activation succeeds, the existing workflow/checks remain controlling executable gates.
2. Make the two native release adapters, retained release commands and migrated Codex command thin references to that procedure. Make fix-ci adapters dispatch to the native repair behavior and project policy. Remove source-only repairs, no-tests claims and unconditional fresh approval of already supplied version/scope. Keep a deliberate stop for a genuinely missing production decision.
3. Reconcile root and mirrored rules: no working-branch publication, no automatic repair-and-repush loop, local implementation acceptance separate from release progression, no batch mode that opens experimental PRs, and no routine broad pre-launch/charter prerequisite for process repairs. Align both `ci-workflow` and `rpi-fix-ci` adapters where needed. Keep generic templates available without imposing their whole procedure on this project.
4. Define the future optional one-corrective-push allowance exactly as parent D1. Make adoption and per-release authorization distinct. Fixture-only means no packaged behavior, dependencies, release identity or scope changed. Workflow permission/trigger/trust changes are material release-control changes and need review; the allowance cannot weaken protection or trust. No delegated agent independently decides to publish.
5. Update CONTRIBUTING and PR template guidance: preserve meaningful assertions, repair proven fixture assumptions, use fixture-driven validation by default, and request live checks only for a named integration risk with scope/budget. Remove the unconditional all-four-live-tabs requirement. Correct suite/timeout descriptions when Phase 2 supplies measured commands.
6. Put a compact current receipt at the top of `docs/release/2026-10-01-v0.16.0.md`: observed completion time, integration/production SHA, tag, publisher URL, artifact SHA/integrity/provenance and installed smoke results, plus F12/incident OPEN. Label the existing text as dated history so its former v0.15.2 claims cannot be mistaken for current status. Refresh the top of old Phase 4 validation similarly. Copy only redacted summarized facts from ignored receipts, not whole private logs.
7. Correct the incident handoff's current default-demand inventory: continuous Actions while active; separately requested secondary observations and no unsolicited polling. Preserve the original personal/work EMU duration requirements, historical failed windows and unavailable environment status. Explain that this plan does not complete qualification or retroactively validate an old forty-subscription run.
8. Record expected project-local managed customizations. Preserve `.rpi/manifest.json` upstream hashes and baselines. Run the installed read-only diagnostics and compare with the four known pre-existing modified files; no global installer or cc-rpi changes.

## Behavioral review oracle

Use R01 and R11 as a small table-driven review of both Claude and Codex entry paths. The reviewer follows actual links from each entry point and records the same outcome for: full supplied release authority; version supplied but publication authority absent; one permitted fixture correction; a second failure; a product change; tool denial; unavailable EMU; and an already delivered release with stale local status. No need to add tests that merely compare prose strings. The future driver makes the side-effect cases executable in Phase 4.

The correct outcome for supplied full authority is continuation through the covered ordinary release sequence. Missing authority names exactly the action that needs a decision. A canceled or failed test remains failed. Tool denial is reported as a tool restriction, not another request to approve the same release. Native diagnostic availability does not establish native hook enforcement.

## Verification and acceptance

Automated, sequential:

- Verify local links and referenced resources exist; check Markdown diff for whitespace and placeholders.
- Run `python3 .rpi/scripts/rpi-diagnostics.py --target <actual worktree> --cwd <actual worktree>`; retain actual exit/result and explain any worktree/installation limitation. No fabricated clean status.
- Run `npm run lint`, `node --check index.mjs`, and `npm test`, retaining each real exit. No PTY/efficiency run is needed for documentation-only changes under the path-specific rules. Do not use a later pass to erase an earlier failure.

Independent review: every policy consumer in the parent sweep points to the same procedure; full authority does not introduce extra routine prompts; new publication authority is never inferred from plan acceptance. Confirm current receipt matches the preserved evidence timestamp and explicitly distinguishes publication from operational acceptance. Resolve confirmed findings, perform a prose simplification pass, then integrate locally.

Manual acceptance: owner reviews the concrete playbook and future bounded authority policy. This is the phase acceptance boundary, not a request to run commands or a release authorization.

## Work units and handoff

Within this phase only, two units are `[batch-eligible]`: policy/adapters, and historical status documents. They have disjoint files; one parent integration owner reviews both. Work stays local and no unit opens a PR. Do not parallelize Phase 2 before this phase is accepted.

Save phase validation with all A/G dispositions, exact local commit/tree, diagnostic drift, checks and policy review outcomes. Next entry: accepted Phase 1, then Phase 2. Production behavior is still the old workflow until the later authorized activation.
