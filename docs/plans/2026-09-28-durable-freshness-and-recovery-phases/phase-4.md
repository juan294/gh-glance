# Phase 4: exact candidate activation and personal/EMU proof

Parent: [durable freshness and recovery](../2026-09-28-durable-freshness-and-recovery.md). Entry: accepted Phases 1–3 with every applicable local gate green. Status: required, unmeasured.

## Purpose and authorization

F12 is required to resolve the original user incident. The previous report's separation between offline success and installed evidence is explicit at [prior phase-5 validation:70](../2026-09-23-restore-multi-pane-freshness-phases/phase-5-validation.md:70). Do not turn this phase into optional instructions left for the user to run.

This plan alone does not authorize live migration, installation, session restarts, workflow dispatch, push, release or changes to employer infrastructure. Prepare the exact candidate and read-only environment evidence first. Obtain any missing operational authorization only for the concrete next action. Once authorized, use CLI first, then browser where needed; execution stays with the agent. No collector/webhook/App setup is required.

## Procedure

1. Discover the actual personal and work environments: effective API host, authenticated class, installed executable/source hash, expected pane cohort and current source/ledger state. Use redacted evidence. Diagnose the work screenshot's current causal state before replacing it; compare with R1–R3 rather than assuming the personal diagnosis applies.
2. Prepare a private immutable packed candidate and provenance manifest from the accepted source. Run a local smoke from an empty directory to avoid repository executable resolution. Preserve one private pre-migration state snapshot and list active binary versions. The rollback procedure must preserve v7 accounting: use a compatible repaired candidate, or leave an older version safely blocked. Never restore an old budget ledger over newer activity.
3. With explicit activation authorization, install/launch that candidate using the normal standalone command and existing `gh` credentials. Verify executable resolution in each shell/session. Migrate through normal startup, not a repair script. Record recovery from retained stale state, request/observer diagnostics and rendered new Actions data. Restart only the agreed sessions; old-version panes must be reported until replaced.
4. For **each environment**, run a 30-minute initial window then a full uninterrupted 24-hour window using Phase 3's strict monitor. Declare every expected pane/repo/tab and cadence before measurement. Include source observations throughout, quota reset boundaries and independently verified workflow status transitions. Sample actual displayed Actions rows at startup, each observed transition and end; compare with bounded direct API checks whose quota costs are included in the measurement inventory.
5. Capture sleep/resume recovery separately; sleep or unobserved gaps restart the uninterrupted qualification window. Known provider outages must be reported and independently evidenced; they cannot be silently subtracted to claim 24 healthy hours. Obtain a complete qualifying window before closure. No workflow dispatch merely to manufacture evidence without separate authorization; if natural transitions are absent, transition evidence remains missing.
6. If work access is unavailable, record the precise unavailable environment and F12 as unmeasured. Finish all available work, preserve evidence and leave incident acceptance incomplete. Do not ask the user to run commands that supported CLI/browser access can execute.
7. After both candidate environments qualify, prepare any separately authorized release using repository release policy. No working-branch experiments or workstation npm publication. Inspect exact pushed/merged SHA workflows and package provenance. If released bytes differ in behavior from the qualified candidate, invalidate and rerun affected qualification; version-only metadata differences require documented source-byte equality plus an installed smoke. Do not equate package publication with operational success.

## Automated/live acceptance

- F01 recovery is observed on the installed personal candidate without deleting accumulated state. Work recovery is tied to its captured cause; any different defect blocks completion and requires a documented plan adjustment before repair.
- Personal and EMU each have complete 30-minute and 24-hour reports with exact binary/source/package hashes, real host/authentication class, cohort coverage, source success timestamps, reset boundaries, observed run transitions, rendered comparisons and zero unexplained internal stalls.
- All exclusions have external evidence. Local observer/coordination holds fail acceptance. A healthy footer without matching source/render evidence fails acceptance.
- Any candidate-changing repair goes back through local gates and restarts invalidated live evidence. No remote rerun/fix-and-repush loop without new authority.

## Accepted capability scope adjustment, 2026-10-01

The user approved qualifying accessible data while verifying explicit unavailable notices for disabled Security features, followed by the bounded ten-pane rerun. Retain all ten repositories and forty subscriptions and the complete uninterrupted source-monitor window. A Security observation establishes freshness only for its accessible subset; unavailable endpoints never count as complete Security coverage. Report the endpoint inventory and each unavailable capability separately. Keep full personal and work EMU requirements separate.

Accept a disabled endpoint only with a current, endpoint-bound provider refusal that explicitly identifies the feature as disabled and a matching visible notice in the actual captured Security tab. Generic 403/404, authentication failures, rate limits, transport errors, missing headers, internal holds and stale capability notes cannot supply this evidence. Accessible endpoints require successful response evidence and existing freshness bounds. If a capability becomes accessible, validate its new data rather than retaining an exclusion. Never change repository settings to obtain a pass.

The bounded rerun retains 180 seconds maximum setup, 1,800 seconds strict measurement and a 2,040-second immutable outer deadline including end capture. All setup, polling and comparison requests share the 1,200-admission and 1,200-unit per-resource caps and 2,000-unit remaining floor. A recognized disabled-endpoint response without an exact measured charge must retain its conservative one-Core-unit allowance in the bounded ledger, distinctly labeled rather than reported as measured cost. All other unknown outcomes stop admission. No active-run extension, budget reset, automatic full-day run or publication is authorized.

Before activation, complete independent review and offline regression checks for the revised qualification helpers. Actual terminal captures must establish unavailable notices; application snapshot flags alone are insufficient. Earlier failed windows remain failed. This adjustment does not waive source stalls or invent complete Security freshness.

## Manual success criteria (unchanged)

Only visual judgment that automated PTY/render comparisons cannot measure may be manually confirmed. User satisfaction can supplement evidence but cannot substitute for missing windows. All routine inventory, installation, monitoring and readback should be automated after authorization.

## Completion and durable handoff

Save `phase-4-validation.md` with separate personal and EMU tables, exact tested identity, measured latencies and window duration, external events, review findings, authorization/actions and released-versus-local status. Mark the incident resolved only when both environments pass; otherwise label the candidate `locally verified` or `partially live verified` with the missing gate. Keep unresolved observations visible. No batch-eligible implementation units; independent environment monitoring can run concurrently once both are authorized and isolated.
