# Phase 1 validation: one release procedure and accurate status

Status: **locally verified after independent review, repair, re-review and simplify.** Documentation and agent-instruction changes only; no workflow, product, test or remote setting changed. No push, PR, release or settings action occurred.

- Worktree `/Users/juan/code/gh-glance-release-repair`, branch `release-process-repair`, based on `develop` `73d23a25bd6f1ecf4a7be74a39b5057addb7356d` (see the baseline deviation in the [notes](../2026-10-02-release-process-repair-notes.md)). The plan and assessment were committed first as `84fd0a8`.
- Authority: the owner's `/rpi-implement` request authorized all four phases locally, then a local merge to `develop` and worktree cleanup. It did not authorize a push, PR, protection change or release.

## Items

| Item | Result |
| --- | --- |
| 1 Playbook | `docs/release/release-playbook.md`: topology, authority, prepare → hosted candidate → protected promotion → publish → delivery/readback → receipt and cleanup, plus a current-versus-planned transition table that describes today's re-test/re-pack/skip-on-existing publisher honestly. |
| 2 Thin adapters | `.claude/commands/{release,fix-ci}.md` and `.agents/skills/source-command-{release,fix-ci}/SKILL.md` only route to the playbook and native `rpi-fix-ci`. Both native `rpi-release` copies carry a four-line override that replaces the generic `e2e-pro-playbook.md`. Source-only repair, "no test script exists", STOP-for-supplied-version and auto-push text is gone. |
| 3 Rules | `.claude/rules/push-accountability.md` drops the background repush loop; `.claude/rules/rpi-details.md` drops PR-opening batch mode and the routine pre-launch prerequisite; AGENTS.md project section points to the playbook. Managed `.rpi/rules/*`, `ci-workflow` and `rpi-fix-ci` were already consistent and are unchanged. |
| 4 Corrective allowance | Playbook Authority section: one push, granted per release, fixture/harness/workflow-wiring only, no trust/trigger/permission change, zero hosted reruns, no delegated publish decision. |
| 5 CONTRIBUTING / PR template | "Delete the offending assertion" and the unconditional four-tab live check are replaced by fix-the-cause and fixture-by-default guidance. Suite descriptions wait for Phase 2 commands. |
| 6 v0.16.0 receipt | Current-status table at the top of `docs/release/2026-10-01-v0.16.0.md`, copied from the retained completion receipt (2026-10-02T07:41:39Z) with a fresh `npm view` readback of integrity and gitHead; old text labeled dated history. Old Phase 4 validation has a current-status block (v0.16.0 and v0.16.1 published, F12 OPEN). |
| 7 Demand inventory | Old Phase 4 validation now states the on-demand default (continuous active Actions only; secondary views on open or `r`; forty-subscription cadence only for `--background all`) without claiming or invalidating any qualification. |
| 8 Managed drift | Diagnostics exit 0, `missing_resources: []`, six local-modified managed files: the four pre-existing rule files plus the two `rpi-release` preambles. Manifest hashes and baselines untouched. |

## Review and simplify

- Independent review (fresh context, read-only) ran the R01/R11 table on both the Claude and Codex entry paths and the plan's consumer `rg` sweep. First verdict: CHANGES REQUIRED with two majors (a push hidden inside local preparation; the playbook described the planned publisher as current) and six minors (GitHub release equals npm publication; coverage also runs on push; AGENTS.md pointer; CLAUDE.md rebase recipe; v0.16.0 wording around renewed authorization; no provenance check). All were fixed. Re-review: APPROVE, with one wording suggestion (compare `dist.shasum` because the workflow log truncates integrity), also applied.
- Behavioral oracle outcome after repair, both paths: full authority continues without re-prompting; missing npm authority stops before tag/release with no mutation; one qualifying fixture correction is honored; a second failure or product change needs a new decision; tool denial is reported as a restriction; unavailable EMU leaves F12 OPEN without blocking release; delivered-release status is current.
- Simplify (four read-only angles): adapters reduced to pure routes; duplicated authority, waiver and failure-handling prose replaced by playbook links; generic 1,541-line reference explicitly not read; history links marked not required; CI observation uses `gh pr checks --required --watch` (verified against PR #146, which also showed the duplicated push/PR runs Phase 3 removes); registry readback is one `npm view` call and one install. Skipped with reason: moving the live-check budget into CONTRIBUTING and a separate adaptation-profile section (the plan places the live budget in the release procedure, D5); retiring the legacy commands (D1 retains them); a v0.16.1 receipt (no delivery evidence exists to copy).
- Verified commands used in the playbook: `npm audit signatures` on a lockfile-less install of gh-glance@0.16.1 (39 signatures, 3 attestations, exit 0); `gh pr checks --required` exists and lists required contexts; combined `npm view ... dist-tags --json` returns all fields.

## Checks (sequential, exits retained)

| Check | Result |
| --- | --- |
| `npm run lint` | 0 (13:00Z run; rerun 0 after the last edit) |
| `node --check index.mjs` | 0 |
| `npm test` | 0; 742 passed, 0 failed, 426.6 s on Node 24.21.0 under host load average ~40 |
| Link, anchor, line-range and whitespace check of every changed Markdown file | 0 broken |
| `rpi-diagnostics.py --target <worktree>` | exit 0, as above |

Every edit after the `npm test` run touched Markdown only, so the unit result covers the unchanged code inputs. PTY and efficiency did not run: no rendering, terminal or acquisition input changed.

## Handoff

Next entry: Phase 2, from this commit. Production behavior is still the old workflow until Phase 4's separately authorized activation.
