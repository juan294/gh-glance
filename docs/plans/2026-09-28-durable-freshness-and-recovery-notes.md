# Durable freshness and recovery implementation notes

## Deviations

### Phase 4 unavailable Security capability, decision pending

- Found: the corrected, authorized ten-pane attempt stopped before measurement on a Chapa Security HTTP 403. Its exact subendpoint is not logged and its cost remains unknown. A separate bounded read-only request verified that Chapa code scanning currently returns an explicit disabled-feature response, with available Core quota.
- Proposed: qualify accessible source data and verify explicit unavailable notices for disabled Security capabilities. Preserve D6: partial Security must never advance complete source freshness or count as complete Security coverage. Do not silently remove the failed windows, change repository settings or waive unexplained internal stalls.
- Decision: pending user response. The full-Security cohort contract is incompatible with an explicitly disabled source; changing that acceptance requirement needs the owner's decision before dependent monitor or relay work. Product and helper behavior remain unchanged.

### Phase 4 personal harness startup allowance

- Plan said: prepare a bounded ten-pane window with all forty subscriptions registered before 1,800 seconds of strict measurement. The prepared helper allowed only sixty seconds outside measurement, shared between setup and end comparisons.
- Found: the authorized attempt stopped at its sixty-second setup deadline before creating a monitor manifest. The production bootstrap registers the active tab only (`index.mjs:19306`). Background deadlines open at one, two and three multiples of four refresh floors (`index.mjs:18426`); at the selected ten-second floor, the inactive tabs become due approximately forty, eighty and 120 seconds after bootstrap. Their subscriptions are created on the corresponding request path (`index.mjs:18817`). Requiring all forty subscriptions within sixty seconds contradicts that normal startup schedule. This is a harness design defect; the previous offline registration fixtures did not cover the production delay.
- Chose: preserve the failed attempt and prepare a separate helper revision with at most 180 seconds for setup, 1,800 seconds of strict measurement and sixty seconds for end capture, inside an immutable 2,040-second outer bound. Keep the 1,200 request and per-resource cost caps and the 2,000-unit remaining floor. Review and verify locally before requesting authorization for the longer operational window. Do not change the application startup schedule or extend an active run.
- Why: the existing 31-minute authorization cannot fit the application's normal startup plus the complete measurement and end comparisons. A stopped attempt is incomplete, not a qualifying shorter window. The final interrupted GraphQL request retains unknown cost and its conservative reservation.

### Phase 4 terminal-test observation contracts

- Plan said: verify reset recovery and governed failure diagnosis through the full terminal suite.
- Found: the complete native run passed 145 terminal tests, failed two and skipped the expected opt-in baseline. The reset case recovered Actions but rejected one GraphQL observer where it assumed two; the unchanged isolated case passed with two. The first GraphQL publication can legitimately fall before or after the Core reset grace boundary. The inaccessible-repository capture stopped after seven seconds without reaching its Issues failure, and its repository-context assertion still checked the retired `repo view` command. A preserved isolated replay reached the expected Failed frame.
- Chose: assert changed Core epoch and healthy observer publications after the reset boundary, while retaining bounded shared observations, reservation timing, duplicate-work and reserve checks. Wait for the actual Failed frame under a 20-second bound and verify current GraphQL repository-context requests against their admitted reservation receipts. Independent review approved both test repairs and found no additional simplify change.
- Why: terminal tests must observe the required behavior and current transport without depending on an incidental observer count or startup timing. Application source remains unchanged at SHA-256 `a7a442c1c4083b7b6f85e7871b023d65e9c348a2a729ad6fdf77ff7c4cf687ae`; the complete repaired terminal gate remains required before integration.

### Phase 4 shared-account impact reported by the user

- Plan said: qualify the installed candidate on the personal account while preserving its existing login and conservative quota accounting.
- Found: the user reported a verified personal-token rate-limit failure in coach-upptime and the same exposure in spoken-letter-upptime. They separately reported fixing workflow approval blocks in archy-upptime and paisaxe-upptime by updating Upptime workflows; those approval blocks are distinct from quota exhaustion. Their 20-second process sample attributed substantial traffic to candidate panes. At the initial report this session could not independently inspect ancestry because `/bin/ps` was denied; a later approved passive sample after pane closure found no candidate processes or API calls and cannot reconstruct earlier ownership. The installed executable contains no literal `actions/runners` endpoint. Raw request counts alone do not establish charged primary units because authenticated conditional 304s are uncharged.
- Chose: stop further live qualification and diagnostic GitHub API calls during the audit. The user closed the candidate panes. Keep other GitHub tasks and Upptime configuration unchanged. Require verified request ancestry and charged-unit accounting, including identity/observer traffic, through a bounded one-pane diagnostic before considering multi-pane activation. Do not attribute unaccounted demand exclusively to Cirujano or require moving Upptime credentials as a prerequisite to fixing the candidate.
- Why: the live experiment must not compromise other account workloads. Current local counters are partial evidence: over a 35.5-second snapshot interval acquisition recorded three GraphQL requests and two observer calls; the cached Core counter advanced 211 units between observations 60.609 seconds apart. The intervals do not align and the counters do not cover every possible call, so exact client attribution remains unmeasured. No live qualification or candidate restart should resume on the strength of offline passes alone.

### Phase 4 combined repair review

- Plan said: preserve actionable recovery causes until matching evidence proves recovery.
- Found: the pending scheduled-disclosure experiment cleared coordination-origin recovery after inspecting a null acquisition hold, although the missing hold could itself be caused by a failed write.
- Chose: combine the three pending repairs on local branch `integrate/recovery-repairs`, then require a successful guarded hold write and a known transient coordination cause before scheduled progress clears recovery. Retain hard storage, quota, observer, debt, source and backlog causes. An independent reviewer approved the corrected boundary.
- Why: future scheduling and a readable empty hold do not prove storage recovery. The red regression, 88 acquisition/recovery tests, four pacing regressions and four-pane pacing PTY fixture pass on the repaired combined source, but full native gates remain pending because local listeners and boot identity reads are still denied. Source commit `96f4b853f05d6dc54b1d248ccb825166d6e03221` remains unmerged and uninstalled; Phase 4 validation records the execution prerequisite.

### Phase 4 retained debt and unused pacing

- Plan said: preserve conservative retained debt while permitting bounded recovery and valid conditional observations.
- Found: the scheduler includes retained debt when it prices a grant, but `returnPacingCredit` in index.mjs:5097 calculates unused-slot credit with `chargedCost: 0`. With a stable budget and retained debt, a zero-cost completion leaves a delay for quota it never consumed. The live external multiplier magnifies that discrepancy.
- Chose: reproduce the mismatch through production grant/start/settlement in an isolated local fixture, then make credit use the same authoritative charge calculation as admission. Preserve the reserve, debt, external factor, shared transport floor, credit cap and start-time affordability check.
- Why: this repairs the existing pacing-credit contract without requiring Cirujano to stop or changing the selected authentication setup. Local replay and any passing regression do not replace the required installed personal and EMU windows.
- Disposition: independently approved repair retained on local branch `investigate/pacing-recovery` at `a881d1d60df0ab666b8983e452c0955f07fc404b`. The three red regressions pass after repair, lint and syntax pass, and the existing four-pane pacing PTY fixture passes. Complete local verification remains failed/incomplete, including explicit socket restrictions in all three failed efficiency cases. See the Phase 4 validation for all outcomes. Do not merge or install this repair until those gates pass.

### Phase 4 advisory recovery journal clock skew

- Plan said: retained recovery diagnostics disclose current cause and retry information without blocking source publication.
- Found: a same-cause event with an earlier `at` than the previous `firstAt` produced a journal that the strict reader rejected. The installed candidate's retained Core event has this exact shape, so plain doctor reports a corrupt diagnostic journal despite a separately readable quota ledger.
- Chose: preserve a red-then-green repair on local branch `fix/recovery-journal-clock-skew` at `47d1b2b`. It clamps only the known timestamp skew on read and write, keeps all retained events and rejects other invalid fields. The branch is unmerged because the complete local gate could not pass in the managed sandbox.
- Why: deleting or overwriting the live journal would discard evidence, while leaving the writer unchanged would recreate the same invalid shape after any later event-clock rollback. The advisory repair must be fully verified before it can become a new installed candidate.

### Phase 4 cutover snapshot

- Plan said: capture a private snapshot after stopping all old panes and before migration.
- Found: Ghostty session replacement required the user to close and reopen the panes. The user completed both actions before the agent could capture an intervening quiet snapshot.
- Chose: preserve the earlier read-only, non-atomic v6 reference snapshot and record the missing quiet cutover snapshot in Phase 4 validation. Do not restore it over v7 state.
- Why: a later snapshot cannot reconstruct the exact quiet migration boundary, and representing the earlier copy as atomic would overstate its evidence.

### Phase 4 shared acquisition artifact read

- Plan said: qualify the exact installed candidate with independent source and quota monitoring after normal startup migration.
- Found: metadata replacement followed by artifact cleanup can race with a concurrent snapshot hydration in both the runtime and monitor. A live read reproduced an ENOENT for an artifact after metadata advanced.
- Chose: repair the shared read path with bounded metadata revalidation, retain failure for a missing current artifact, add a concurrency regression test, and rerun local gates before packaging a new candidate.
- Why: a monitor-only retry would conceal the same race in the running app and could leave an internal coordination hold.

### Phase 4 monitor first observation and quota clock

- Plan said: a healthy first active observation has a 60-second bound; background source freshness follows its declared cadence and overdue allowance.
- Found: the strict monitor applied 60 seconds to every first observation, including 120-second and 300-second background tabs. It also read quota using a clock captured before acquisition hydration, so a newer valid quota record could be rejected.
- Chose: retain 60 seconds for active demand, use cadence plus allowance for background demand, and validate quota against a fresh post-hydration clock.
- Why: the previous monitor could fail a valid background interval and could report quota unavailable during a concurrent valid write.

### Phase 4 subscription remap and source-read clock

- Plan said: one shared acquisition query survives repository identity discovery, and the strict report rejects genuinely future source timestamps.
- Found: a concurrent canonical query-key remap can occur after a subscription commits or after its snapshot hydrates, leaving a local first refresh on the old key. A source publication during monitor hydration can also be newer than the sample-start clock while remaining valid at read completion.
- Chose: register a cleanup owner before subscription hydration, follow the authoritative shared subscription key in setup and first refresh, and record a separate source-read completion time for validation and JSONL audit.
- Why: a committed subscription must not be orphaned by a remap, and a valid concurrent source publication must not fail the entire strict window as a future timestamp.

### Phase 4 completed native gates, 2026-09-30

- The combined source now has valid sequential local results: lint and syntax passed, 713 unit tests passed, nine efficiency tests passed, and the repaired complete terminal suite passed 147 tests with one expected skip and zero failures. The terminal rerun ended at 06:12:32Z; its source hash is unchanged from the earlier unit and efficiency checks.
- These results supersede the native execution blocker recorded above. They permit local integration of the reviewed source and test repairs. They do not waive the failed personal windows or the unmeasured work EMU qualification.
- The immutable package and bounded one-pane request-accounting diagnostic are recorded in Phase 4 validation. Cirujano and Upptime configuration remain unchanged; broad candidate activation is not authorized by a passing offline gate.
