# Research: how inactive tabs and unfocused panes refresh

Date: 2026-11-28. Repository: `juan294/gh-glance`, branch `develop`, commit `154930d11cb83c25b6eae7adfcc366472a4ae0e4`, version 0.20.0. Workflow: `rpi-research` (descriptive). No project overlay exists at `.rpi/project/rpi-research.md`. No product code, configuration or remote state was changed.

All line references are `index.mjs` at this commit unless another file is named. VERIFIED means the code or output was read in this session. INFERRED marks a conclusion drawn from the code without a runtime trace.

## Research question

When a gh-glance pane sits in an unfocused terminal pane, or shows one tab while another tab (for example Issues) holds older data, what decides whether and when that data refreshes? The owner wants background refresh closer to real time with no added user-perceived latency. This document records the current mechanism so that a later assessment or plan can start from it.

## Summary

1. **gh-glance cannot tell whether its terminal pane is focused.** It has no terminal focus reporting (`CSI ?1004`), no `SIGCONT`/`SIGTSTP` handling and no file or Git watch. A focused and an unfocused pane behave identically. The only visibility concept is the selected tab inside the pane (VERIFIED: grep for `1004`, `FocusIn`, `SIGCONT`, `fs.watch`, `watchFile` returns no matches).
2. **The live panes run the default `--background on-demand` mode.** 16 `gh-glance` processes run from Homebrew 0.20.0 with no flags. The installed `index.mjs` differs from this checkout only in its shebang line (VERIFIED: `ps`, `diff`).
3. **In on-demand mode, Issues, Pull Requests and Security are never refreshed by a timer, even while visible.** They get exactly one check when opened (tab switch or startup) or when `r`/`R` is pressed. After that observation arrives, the tab's deadline is set to infinity and the view is labelled `Cached` / "Saved Issues view". Only Actions polls automatically, and only while it is the selected tab (`pollPolicyInterval`, 16107-16108; one-shot clear, 21400-21405).
4. **An inactive tab can still update for free, but only from another pane on the same repository.** Once a pane has requested a tab, its acquisition subscription stays registered and reads the shared store every 1 s. If another pane on the same repository publishes a newer snapshot of that tab, this pane adopts it without a request (15312-15322, 15392-15404). The live panes are each on a different repository, so this path rarely applies to them (INFERRED from the process list).
5. **The opt-in `--background all` mode polls every tab automatically.** A visible secondary tab checks at the 5 s floor, then every 30 s after two unchanged results (Security 60 s). An inactive tab is considered every 120 s (Security 300 s), at most one inactive tab per wake (153-167, 16110-16112, 16230-16233).
6. **Issues and Pull Requests are the expensive surfaces to refresh.** They use GraphQL with no validator, so every check reserves a declared 2 points, even when nothing changed (GitHub charged 1 point for a real page in the same-day owner review). Actions and Security use conditional REST, where a `304` settles at zero cost (1094-1118, 2738-2739).

## Detailed findings

### Modes and cadence constants

| Item | Value | Evidence |
| --- | --- | --- |
| Floor (`--refresh`, `GH_GLANCE_REFRESH`) | 5 s default, 2 to 3,600 s | 77, 12300, 12544-12548 |
| Background modes | `all`, `off`, `on-demand` | 12299, 12403-12404 |
| Default mode | `on-demand` | 227, 12684 |
| Running Actions cadence | 5 s | 148 |
| Unchanged results before slowing | 2 | 152 |
| Quiet cadence | Actions/Issues/PRs 30 s, Security 60 s | 153-159 |
| Inactive-tab cadence (`all` only) | max(12 x floor, 120 s); Security 300 s | 140, 162-167, 16110-16112 |
| Stale label threshold | `lastOk + max(30 s, 6 x granted cadence)` | 208, 18507-18530 |

The help text states the on-demand contract: "on-demand watches active Actions; other tabs refresh when opened or with r, then keep cached results" (12550-12556, 12584-12590).

### The single cadence decision: `pollPolicyInterval`

`pollPolicyInterval` (16098-16121) is the one function that returns a tab's next interval. In on-demand mode it returns infinity unless the tab is the selected tab **and** either it is Actions or it carries a one-shot `requested` flag (16107-16108). `inactive` demand returns infinity in on-demand and off modes, and the background cadence in `all` mode (16110-16112). Running Actions take the 5 s cadence; two unchanged results take the quiet cadence (16115-16117).

`pollIntervalFor` (21774-21784) feeds it the per-pane state: `demand` is active only for the selected tab, `requested` is `requestedTabs.has(key)`. `rescheduleTab` (21786-21794) converts the interval into a deadline in `pollDueAt`.

### The one-shot `requested` flag in on-demand mode

- `requestedTabs` is a per-pane `Map` whose comment says "One-shot demand survives admission delays, but ends when an observation arrives" (21396-21397).
- It is set for the selected tab at startup (`openPollDeadlines`, 21804) and on every tab switch, manual `r` and `R` (`fetchTabRef.current`, 22602-22613). A tab switch clears every other entry first (22611).
- It is deleted when a snapshot whose `lastSuccessAt` is newer than the request is adopted, and the tab's deadline becomes infinity (21400-21405). A follower that receives a `fresh` shared snapshot also deletes it (22242).

Result (VERIFIED by reading; INFERRED as runtime behavior, no trace taken): a visible Issues tab receives one observation and then stays idle until the user acts. A tab that is not selected is never scheduled.

### Tab switch and manual refresh paths

- A change of `activeIndex` calls `fetchTabRef.current(key, { kind: "tab-switch" })` (23002-23008). The comment records the intent: "the tab you switch to refreshes straight away rather than showing old data".
- A tab switch resets the unchanged counter so the opened tab checks at the floor (22603-22608), moves the active deadline (`replaceActivePoll`, 22150-22154, 22618) and cancels pending active work for other tabs (22621-22628).
- The previous rows stay in `data[key]` and render immediately; the check runs behind them (INFERRED: `setData` is only called on new rows, 21436-21437; no code clears rows on switch was found).
- `r` is manual and conditional; `R` also drops validators (`refreshIntent`, 16146 onward; comment at 22156-22159).
- Governor priorities: manual 0, tab-switch 1, active 2, background 3 (2843-2849). `requestTab` assigns `manual`, `active` or `background` to the intent (22281).

### Scheduling loop

`runDataWake` (22714-22770) inspects the governor, computes held resources, and calls `pollSchedule` (16216 onward) with each tab's `requested`, unchanged count and in-progress state. `pollSchedule` admits the active tab and at most one inactive tab per wake, round robin (16228-16233). Due tabs go to `requestTab` (22160 onward), which ensures a subscription, asks the acquisition engine for producer or follower ownership (22218-22226), then registers a governor intent.

### Cross-pane sharing and the 1 s store read

- Subscriptions are created lazily by `requestTab` through `ensureAcquisitionSubscription` (21584-21625, called at 22218). Startup and control wakes subscribe only the selected tab (22823, 22944). A tab never opened in a pane has no subscription.
- Once created, a subscription is not removed on tab switch; its demand is updated to inactive (21614-21622). Demand for a query is aggregated across panes: active if any pane is active (15206-15216).
- The engine's timer runs every `ACQUISITION_INSPECT_MS` = 1 s and heartbeats every 10 s (14382-14383, 15392-15404). Each inspect calls `deliver` for every local subscription. A newer generation is passed to `adoptAcquisitionSnapshot`, which updates rows, validators and `lastOk` with no GitHub request (15312-15322, 21399-21437).
- A same-repository pane that is producing a tab therefore refreshes the other panes' copies within about 1 s. Different repositories share only the quota ledger, the HTTP permits and the store limits (summary of the 2026-11-11 research, section "How panes share the allowance and the data", consistent with the code above).

### Freshness labels a user sees

- On a settled on-demand secondary tab the status becomes `Cached` (18392, 23105-23109) and the panel reads "Saved Issues view" with "Press r to check again. This view checks when opened or refreshed." (16849-16852, 19955-19956).
- A 1 s display-only clock advances the cached age while that label shows. It does not schedule requests (23112-23120).
- The overdue/stale label uses `freshnessDeadline` (18507-18530). On-demand suppresses the overdue headline for secondary tabs (16846).

### Request cost per check

| Tab | Transport | Validator | Declared cost per check | Evidence |
| --- | --- | --- | --- | --- |
| Actions | REST `actions/runs` | ETag | 1 core, 0 on `304` | 2738 |
| Issues | GraphQL `ISSUE_PAGE_QUERY`, 50 rows, `UPDATED_AT DESC` | none | 2 points reserved per page (1 charged, owner review) | 1094-1105, 2739 |
| Pull Requests | GraphQL `PULL_PAGE_QUERY`, same shape | none | 2 points reserved per page | 1107-1118, 2739 |
| Security | 3 REST alert sources plus severity lanes | ETag | 6 core reserved (`tabRequestCost("security")` returns `{ core: 6 }`, run this session), 0 on `304` | 2730-2738 |

Validators and bodies travel in the shared snapshot (21433-21435), so a `304` is possible across panes and restarts for REST tabs. The 2026-11-11 research measured 98.5% of REST answers on this machine as `304`.

## Historical context

- On-demand became the default on 2026-10-01 by owner decision, after the Copilot CLI assessment. Its stated reason: "a tab bar and cached counts need not create periodic API traffic." `all` and `off` were kept for continuous polling (`docs/plans/2026-09-28-durable-freshness-and-recovery-notes.md:6-13`; `docs/research/2026-10-01-copilot-cli-tabs-assessment.md:91-93`; commit `96bd5ef`; `CHANGELOG.md:299-301`).
- At the time, multi-pane load and quota exhaustion were active problems (`docs/research/2026-09-23-multi-pane-staleness-root-causes.md`, `docs/research/2026-09-28-persistent-staleness-and-github-web-updates.md`). The 0.20.0 live baseline memory records 15 panes at about 1,720 requests per hour.
- Commit `77e6f4b` ("perf: wake cold panes at their first eligible poll deadline") changed scheduling after the 2026-11-11 research; the on-demand rule itself is unchanged since `96bd5ef` (VERIFIED: `pollPolicyInterval` at 16098-16121 matches the 2026-11-11 table).
- GitHub's own website uses socket notifications, while gh-glance polls (2026-09-28 research). The 2026-11-11 research found no `/events`, `/notifications`, `x-poll-interval` or `If-Modified-Since` use; the push path exists only behind the opt-in collector with webhooks.

## Arithmetic for orientation (INFERRED, not measured)

With the live 16 panes, each on its own repository, and `--background all`: inactive Issues and PRs at 120 s give 30 checks per hour per tab, 2 points each, so 120 points per hour per pane and about 1,920 points per hour for 16 panes, before the selected tab and the GraphQL observer. The GraphQL primary limit for a user is 5,000 points per hour (external fact from prior project research, not re-verified today). Security in the background is mostly `304` and near zero cost. Correction (owner review, same day): these are *reserved* points; GitHub charged 1 point per page, so actual spend is about half. See the assessment's owner-review section.

## Unresolved questions

- **Real change rate of Issues/PRs per repository.** Unknown. It decides how much a timer-based GraphQL check spends on unchanged data. No measurement exists in this session.
- **Whether the owner's terminal (Rex) can deliver focus events.** Not checked. gh-glance has no focus handling either way.
- **Exact per-pane GraphQL spend in `all` mode on the live fleet.** Only the arithmetic above; `--doctor` does not split GraphQL units by operation (2026-11-11 research).
- **Perceived latency on tab switch.** Code shows cached rows render first and the check runs behind them; no PTY timing for this path was taken today.

## Handoff

- Objective: describe current inactive-tab and unfocused-pane refresh behavior. Scope: read-only research; this document is the only write.
- Baseline: `develop` at `154930d11cb83c25b6eae7adfcc366472a4ae0e4`, clean tree, main worktree `/Users/juan/code/gh-glance`. Installed Homebrew 0.20.0 matches this `index.mjs` except the shebang.
- Delegation: none; all reads were done in the parent session.
- Findings: descriptive only, no defects or proposals recorded. Evaluating options (for example a background cadence for secondary tabs, conditional REST for Issues, focus-driven refresh, or push signals) belongs to `rpi-assess` or `rpi-plan`.
- Resources: none allocated.
- Next phase: owner chooses `rpi-assess` (compare approaches) or `rpi-plan` (if a direction is already chosen). On resume, re-check `pollPolicyInterval` and `requestedTabs` line numbers against the then-current commit.
