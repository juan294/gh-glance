# First-run experience assessment

Date: 2026-10-25

## Question and scope

How should gh-glance explain an empty Actions tab and freshness warnings to someone opening a newly created repository? The supplied screenshot shows v0.16.2, Actions (0), an empty table with “no runs”, “0 of 0”, and “Watching”. The user also reports stale-data messages on Issues after pushing a few times.

This assessment recommends product behavior and copy. It does not implement changes or diagnose the unidentified repository's live state.

Baseline: `develop`, commit `4b2a8d3cfdd12b6ac0b7a8a70bcd3bf6349e7aa9`, workspace `/Users/juan/code/gh-glance`; package version 0.16.2. Existing untracked `supabase/` was left untouched. The screenshot's version matches the package version, but its installed executable identity and cache are unverified.

## Criteria

- A newcomer can tell which repository is selected, whether a check succeeded, what the tab covers, and whether they need to act.
- Zero results, unknown results, cached results, missing access, and missing configuration remain distinct.
- Useful content stays visible during recovery; no unsupported reassurance or hidden freshness failure.
- The experience fits narrow terminals, supports screen readers, and preserves quiet settled rendering.
- Additional discovery is bounded, cached, admitted through the existing request governor, and optional for basic dashboard usefulness.
- Authentication remains delegated to gh. No mandatory collector or account setup is introduced. Sutura retains CI routing ownership; explaining Actions does not authorize workflow creation or routing changes.

## Current evidence

1. **Actions means workflow runs, not pending personal tasks.** The request projects workflow-run status and conclusion without an in-progress-only filter (`index.mjs:1466`). Its zero result does not explain why no runs were returned. GitHub documents that workflow files and matching event triggers are required for a push to produce a run: [GitHub workflows](https://docs.github.com/en/actions/concepts/workflows-and-actions/workflows), retrieved 2026-10-25.
2. **The empty display is generic.** The renderer uses loading, budget waiting, unavailable security sources, or `no ${tab.countLabel}` (`index.mjs:19982`). It still renders column headings (`index.mjs:19959`) and a `0 of 0` viewport count (`index.mjs:19765`). These occupy space without answering setup questions.
3. **Zero runs does not prove no workflows.** Workflow catalog demand exists to resolve missing names on returned runs (`index.mjs:1526`); an empty run array produces no catalog demand. The existing catalog projection only retains workflow IDs and names (`index.mjs:1482`). Its parsed representation can also retain an empty map after an unusable response (`index.mjs:1508`). Do not reuse an empty names map as proof of missing setup.
4. **There is already useful state machinery.** Counts remain unknown before data arrives; loading and failure suffixes are distinct (`index.mjs:16329`). Refresh status distinguishes Checking, Paused, Disconnected, Stale, Failed, Limited, Cached, Shared, and Watching (`index.mjs:16479`). A failed first fetch suppresses the empty-result claim (`index.mjs:19992`). Build on these distinctions.
5. **Freshness is source-check age, not issue activity.** The stale deadline derives from the last successful check and allowed cadence (`index.mjs:16644`, `index.mjs:19688`), and can use persisted cache timestamps (`index.mjs:17119`). No prior successful timestamp yields no freshness deadline. The reported Issues warning is therefore not evidence that a new repository itself is “stale”. Its actual cause remains unknown.
6. **Recovery language can imply nonexistent cached data.** `presentRecovery` renders “cached age unavailable” when there is no source timestamp (`index.mjs:15763`), and exposes Core/GraphQL and coordination terminology. The underlying cause/action mapping is rich enough to support more direct user language (`index.mjs:15626`).
7. **Identity and help are insufficiently visible.** The panel identifies repositories only for explicit `--repo` or `GH_REPO` targets (`index.mjs:19779`), and drops the target when it cannot fit. `?` already opens help (`index.mjs:11564`), but the regular footer hints omit it (`index.mjs:16403`). Existing no-remote setup already has a dedicated explanatory screen (`index.mjs:16436`).

Graphify was queried first through the repository's own graph. The broad result was truncated and used only as an orientation index; current source reads establish the findings above. Historical memory supplied authentication and freshness cautions, not proof of this incident's cause.

## Recommended experience

Use contextual onboarding in the dashboard. Answer four questions in order: **Where am I? Did the check work? What does this result mean? What happens next?** Avoid a mandatory tour or persistent first-run wizard state. Empty screens should also help experienced users opening another new repository.

### Actions after a successful empty result

Replace the empty table body, headings, and `0 of 0` with a compact explanation. Example copy (repository and timestamp are illustrative):

```text
Actions · owner/new-project

No workflow runs found
GitHub returned no runs for this repository.

Actions shows automated checks and jobs, including completed runs.
A push creates a run only when a workflow is configured to run on it.

Checked just now · Watching for updates
? Help   r Refresh   q Quit
```

“No workflow runs found” is safer than “No workflow runs yet”: it does not claim the repository has never had runs. Render the successful-check statement only for an actual successful observation, and qualify old cached emptiness with its original check time. Do not label the entire dashboard connected or healthy because one endpoint succeeded.

Display the verified target for inferred repositories too, reusing identity already obtained by acquisition where possible. Show the host when needed to distinguish GitHub Enterprise. If identity is not resolved, say so; never invent it from the local directory name. At narrow widths, retain the short state and a discoverable help/details route to the full target and explanation.

### Optional setup diagnosis

Provide a contextual, read-only “Check Actions setup” action. It can establish whether accessible workflows are listed, report known disabled workflow states, and offer an “Open Actions on GitHub” link/action. It must have its own loading/error state and must not block the successful run-list result.

- A successful, complete workflow discovery with zero workflows can say “No workflows found. Actions workflows are optional; Issues and Pull requests work independently.”
- Workflows found with zero runs can say “Workflows found; no runs returned.” Do not invent a trigger mismatch or say a workflow has never run. Finding the exact reason a push did not trigger a run requires more evidence.
- Failed or incomplete discovery says “Could not check Actions setup”, retaining the known run-list result.
- Absence of a local `.github/workflows` directory does not establish the remote repository's configuration. Disabled Actions and permission errors need their own evidence.

Use explicit discovery completeness, identity, timestamp, and capability state rather than overloading the current workflow-name cache. Preserve rate accounting and cache invalidation across identity/repository changes. Do not add a workflow request to every refresh. Guidance and navigation do not create workflows, enable Actions, or alter CI routing.

### First load, waiting, and freshness

| Evidence/state | Primary message | Supporting explanation |
| --- | --- | --- |
| First request in flight, no successful snapshot | Checking Issues… | Fetching this repository's open issues. |
| No successful snapshot, temporarily waiting | Waiting to check Issues | Explain the known wait; show the scheduled retry if available. |
| First request failed | Could not load Issues | Show the actual cause and the supported recovery action. |
| Successful empty snapshot | No open issues | GitHub returned no open issues; show the last successful check. |
| Existing snapshot, refresh pending | Updating Issues… | Showing the result checked at the recorded time. |
| Existing snapshot past its freshness deadline | Could not refresh Issues | Last checked at the recorded time; show cause if known and retry behavior. |
| On-demand cached view | Saved Issues view | Last checked at the recorded time; refresh on activation according to the current policy. |

The stale row's wording must match reality: if there was no failed attempt and data is merely overdue, prefer “Issues needs an update” rather than claiming a request failed. Never describe data as current just because the app is retrying. Never show “cached age unavailable” as a substitute for “Not checked yet”.

Surface consequences and recovery first: for example, “GitHub request limit reached. Retrying after 11:20.” Only show a deadline when known, and distinguish a GitHub limit from gh-glance's own request pacing. Put protocol names, reservation accounting, and storage details in optional diagnostics. Keep actionable authentication and local-storage errors visible. A new-user grace period must not conceal a real failure or reset source freshness.

For Pull requests use “No open pull requests” after success. For Security distinguish “No alerts returned by the checked sources” from unavailable/disabled sources and partial coverage; never imply a full security clearance from a zero count.

## Alternatives and trade-offs

| Option | Benefit | Limitation | Disposition |
| --- | --- | --- | --- |
| Replace only “no runs” | Small change; no added requests | Cannot answer setup or stale-data concerns | Useful first improvement, insufficient alone |
| Contextual states plus optional setup check | Addresses uncertainty where it appears; preserves normal workflow | Requires careful state precedence and bounded discovery | Recommended |
| Mandatory setup wizard | Can walk through prerequisites | Interrupts already configured repositories and requires persistence/reset rules | Reserve dedicated setup screens for actual prerequisites |
| Automatically inspect setup on every launch | Can explain configuration without a keypress | Extra calls, permissions failures, cache complexity and startup latency | Reconsider after measuring demand; never poll setup every refresh |
| Hide freshness warnings for newcomers | Quieter first screen | Conceals real uncertainty | Reject |

Prioritize truthful state-specific copy and discoverable help, followed by optional configuration diagnosis. More ambitious discovery is justified if observation shows users still cannot explain their empty Actions state. A verified first-load scheduling defect would require a separate source fix; copy alone cannot repair it.

## Acceptance criteria for a later implementation

- A fresh successful empty result, never-loaded waiting state, first-fetch error, cached empty result, stale populated result, and incomplete Security result render distinct truthful messages.
- No setup or repository-wide health claim is inferred solely from a zero run count.
- Both inferred and explicit targets are understandable; changing account, host, or repository cannot reuse the wrong setup evidence.
- Newcomers can discover help, understand what Actions counts, and know whether recovery is automatic or requires action.
- Content fits supported small terminal dimensions without losing required quit/refresh controls; screen-reader and no-color output remain understandable.
- Settled rendering stays quiet. Additional discovery is bounded, governed, and cached with failure and pagination handling.
- Behavioral tests precede implementation; required local lint, syntax, unit, and PTY checks follow it, plus efficiency checks if acquisition/scheduling changes. Tests were not run for this assessment.

## Uncertainties and handoff

The affected repository name, exact Issues message, elapsed time, access state, cache, and installed executable SHA are unavailable. No live reproduction or user testing was performed. The screenshot establishes the confusing presentation, not a missing workflow, auth fault, or governor defect. Proposed copy is a design recommendation, not validated usability evidence.

Completed: source-backed assessment and public GitHub documentation verification. Findings 1–7 remain assessed, not implemented. No application/configuration changes, remote mutations, commits, or publication occurred. No plan was invoked; this artifact ends the assessment boundary.

Next: decide the implementation scope (recommended: contextual state presentation, target/help visibility, and a separately bounded optional setup check). A later planner must recheck branch, SHA, dirty state, and relevant source lines. Diagnose the reported Issues incident separately if its target and runtime evidence become available; do not assume the historical governor incident recurred.
