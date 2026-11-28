# Assessment: intermediate background refresh between `on-demand` and `all`

Date: 2026-11-28. Repository: `juan294/gh-glance`, branch `develop`, commit `154930d11cb83c25b6eae7adfcc366472a4ae0e4`, version 0.20.0. Workflow: `rpi-assess`. No project overlay exists at `.rpi/project/rpi-assess.md`. Descriptive baseline: [2026-11-28 research](2026-11-28-background-refresh-of-inactive-tabs-and-panes.md). No product code, configuration or remote state was changed. The assessment made four read-only GraphQL attempts: one malformed query that GitHub rejected and three 1-point successes. It made no REST calls. Owner review on the same day added two verification queries (see [Owner review and corrections](#owner-review-and-corrections-2026-11-28)). That section supersedes any figure below that it corrects.

Labels: VERIFIED means seen in this session (command output, file read or primary page). INFERRED means derived from verified facts. UNCONFIRMED means no primary evidence was found.

## Decision to support

Is there a middle path that keeps Issues, Pull Requests and Security close to current in unfocused panes and on unselected tabs, adds no perceived latency, and does not bring back the 2026-09 and 2026-10 rate-limit incidents? If so, which direction should be planned first?

## Recommendation

Plan a **"doorbell, then fetch" design in three layers**, in this order:

1. **Refresh on attention (terminal focus).** When a pane regains focus, revalidate its selected tab if the data is older than a minimum age, with a throttle. The cached rows stay on screen, so the user sees no added latency. Cost: one check per return to a pane.
2. **An account-wide change watermark.** One pane per account runs one GraphQL query every 60 s. It reads `totalCount` and the newest `updatedAt` of open Issues and open PRs for every repository with a live pane. A changed watermark marks that repository's tab as changed in the shared store. Only those tabs are fetched, at background priority. Measured cost: **1 point for 15 repositories**.
3. **A slow safety net.** Give secondary tabs a long maximum age (for example 15 to 30 minutes), admitted only above the reserve. Security belongs here, because its checks are conditional REST, where an unchanged `304` costs nothing.

Expected result (INFERRED, revised in owner review): the probe alone costs about 60 points per hour. That figure leaves out the safety-net sweep, focus checks and fetches triggered by changes, so it cannot be compared with the reserved figure for `--background all`. End-to-end refresh latency and real hourly spend are unmeasured. **Owner decision: plan layer 1 now. Keep layer 2 as a candidate, and defer the 60 s cadence and hidden-tab prefetch.**

## Evidence that the problem is real and current

- All 16 live panes run Homebrew 0.20.0 with no flags, so they run `on-demand` (VERIFIED: `ps`; the installed `index.mjs` differs from this checkout only in its shebang).
- **6 of the 14 cached Issues/PR views differ from GitHub right now.** Their last checks were 73 to 577 hours ago. A matching count and newest timestamp does not prove that the other 8 views are current. Examples: paisaxe shows 6 issues and 5 PRs while GitHub has 9 and 3. portfolio shows 4 and 4 while GitHub has 3 and 2 (VERIFIED: live watermark query against `dashboard-cache.json`, 2026-11-28 06:20 UTC).
- Across 28 cached Issues/PR tabs, the median last check is about 500 hours old (VERIFIED, same cache).
- ~~Changes are rare.~~ Corrected: a stale cache cannot measure change frequency. A live query across open and closed states found 63 issues and 63 PRs updated in the 7 days to 2026-11-28 06:23 UTC, 29 of them still open. No connection hit the 50-row cutoff (VERIFIED in owner review and reproduced in this session). These are counts of items, not of changes or of the fetches they would cause.

## Constraints from the current system

| Constraint | Evidence |
| --- | --- |
| On-demand sets an infinite interval for any secondary tab that has no pending request | `index.mjs:16107-16108`, `index.mjs:21400-21405` |
| Issues and PRs use GraphQL with no validator: the app reserves 2 points for each page, changed or not. GitHub charged 1 point for a real `ISSUE_PAGE_QUERY` page (VERIFIED in owner review) | `index.mjs:1094-1118`, `index.mjs:2739` |
| Actions and Security use conditional REST, and a `304` settles at 0 | `index.mjs:2104-2160`, `index.mjs:2738` |
| One shared store, read every 1 s, already delivers other panes' snapshots to subscribed tabs | `index.mjs:15312-15322`, `index.mjs:15392-15404` |
| The governor gives manual work priority 0, tab-switch 1, active 2 and background 3. It keeps a 20% reserve | `index.mjs:2843-2849`; 2026-11-11 research |
| One GraphQL observer per account already spends 1 point every 60 s | `index.mjs:1123`, `index.mjs:2769`, `index.mjs:2797` |
| The terminal lifecycle already turns terminal modes on and off (mouse reporting) | `index.mjs:23460-23475` |
| The input handler already receives unrecognized CSI tokens (Ink delivers `[I` and `[O`) | `index.mjs:20453-20461`; Ink `parse-keypress` returns code `[I`/`[O` (VERIFIED with Node) |
| ADR 0001 rejects collapsing the tab data layer into one GraphQL query, because workflow runs are not reachable in GraphQL | `docs/decisions/0001-keep-the-gh-cli-data-layer.md:1`, `:34-47` |
| On-demand was an owner decision on 2026-10-01, made to cut periodic traffic | `docs/plans/2026-09-28-durable-freshness-and-recovery-notes.md:6-13` |

Budget now (VERIFIED, `gh-glance --doctor`, 06:15 UTC): core 3,103 remaining and GraphQL 4,802 remaining, each with 1,000 reserved. Lifetime REST answers are 19,663 `200` against 1,560,341 `304`. Core is the busier budget today. GraphQL has wide headroom.

## External facts (retrieved 2026-11-28)

| Fact | Status | Source |
| --- | --- | --- |
| An authorized `304` does not count against the REST primary limit | VERIFIED | https://docs.github.com/en/rest/using-the-rest-api/best-practices-for-using-the-rest-api |
| REST secondary limit: 900 points per minute, 1 for each GET, at most 100 concurrent requests. Whether a `304` costs a secondary point is not documented | VERIFIED / UNCONFIRMED | https://docs.github.com/en/rest/using-the-rest-api/rate-limits-for-the-rest-api |
| GraphQL: 5,000 points per hour per user. Cost is the connection requests divided by 100, rounded, minimum 1. No conditional requests | VERIFIED / INFERRED (no conditional) | https://docs.github.com/en/graphql/overview/rate-limits-and-query-limits-for-the-graphql-api |
| A 15-repository watermark query (2 connections each, `first:1`, with `totalCount`) costs 1 point and takes 1.15 to 1.27 s, about 1.7 KB of response | VERIFIED live, 3 runs | this session |
| `GET /repos/{o}/{r}/issues` includes PRs and supports `sort=updated`, `state=all` and `since`. A live `304` for it was seen on 2026-10-25, but the per-endpoint page lists no `304` | VERIFIED | https://docs.github.com/en/rest/issues/issues#list-repository-issues; [2026-10-25 assessment](2026-10-25-gitcrawl-cache-ideas-assessment.md) |
| Repository events: ETag and `X-Poll-Interval` supported, "not built to serve real-time use cases", latency "30s to 6h", no security-alert events | VERIFIED | https://docs.github.com/en/rest/activity/events |
| Notifications: `Last-Modified` polling, a `304` is free, only threads the user receives, documented for classic PATs only. The user's own actions do not notify the user (INFERRED) | VERIFIED / INFERRED | https://docs.github.com/en/rest/activity/notifications |
| `gh webhook forward`: "only designed for use during testing and development", one forwarder per repository, admin required | VERIFIED | https://docs.github.com/en/webhooks/testing-and-troubleshooting-webhooks/using-the-github-cli-to-forward-webhooks-for-testing |
| xterm mode 1004 sends `CSI I` on focus and `CSI O` on blur, and works alongside mouse modes | VERIFIED | https://invisible-island.net/xterm/ctlseqs/ctlseqs.html (Patch #411) |
| **Rex delivers 1004 focus events** | VERIFIED live: a probe pane received `"\u001b[I"` and then `"\u001b[O"` when focused and left | this session |
| tmux passes focus events only with `focus-events on` | VERIFIED (default off is UNCONFIRMED) | https://man7.org/linux/man-pages/man1/tmux.1.html |
| SWR: `revalidateOnFocus` true, `focusThrottleInterval` 5 s, `dedupingInterval` 2 s, `refreshWhenHidden` false. TanStack Query: `refetchOnWindowFocus` true when stale | VERIFIED | https://swr.vercel.app/docs/api ; https://tanstack.com/query/latest/docs/framework/react/guides/important-defaults |
| Stale-while-revalidate: serve the stale copy and revalidate in the background | VERIFIED | https://www.rfc-editor.org/rfc/rfc5861.html |
| Change-token patterns: Kubernetes `resourceVersion` list+watch, Google Drive `getStartPageToken` / `changes.list` | VERIFIED | https://kubernetes.io/docs/reference/using-api/api-concepts/ ; https://developers.google.com/workspace/drive/api/guides/manage-changes |

### Architecture corpus (Archy)

The O'Reilly books are **not** in Archy's searchable Supabase store: its 59,544 documents include no `pdf` or `epub` source type (VERIFIED by read-only SELECT). The 28 ePUBs in the owner's Dropbox folder `Software Architecture 2024` were extracted and searched by keyword. *Designing Data-Intensive Applications* and *Release It!* are not in the corpus. Relevant passages:

- Newman, *Building Microservices* 2e, ch. 13 "Invalidation: Notification-based": notification limits the stale window to "the time taken for the notification to be sent and processed". The same chapter says a conditional GET still pays the round trip. This supports a cheap signal followed by a fetch, rather than more ETag polling.
- Newman, ch. 4: data shared through files is learned "via some sort of polling mechanism". It suggests pairing that with a separate "new data available" call. This is the doorbell pattern.
- Khononov, *Learning Domain-Driven Design*, ch. 15: an event notification carries little data, and the subscriber queries for current state when accuracy matters. This favours a thin watermark plus an explicit fetch over pushing whole lists.
- *Building an Event-Driven Data Mesh*, ch. 8: high-water-mark polling. The interval maps to a freshness SLA, and intermediate changes collapse into one result. That loss is acceptable for a list view.
- Burns, *Designing Distributed Systems*, ch. 9: a single owner removes the need for coordination among many readers. This matches one watermark owner per account.
- Newman, ch. 12 (bulkheads, after Nygard), and *Mastering API Architecture*, ch. 6 (token bucket, load shedding): keep background work in its own budget, below interactive work.

## Criteria

1. Perceived latency: no visible change may wait on background work.
2. Freshness: the age bound for Issues/PRs in hidden panes and on hidden tabs.
3. Quota: primary points, secondary points, and shared HTTP permit time across 16 panes.
4. Correctness: which changes are detected, and which are missed.
5. Risk: added complexity in the coordination layer, which caused the most past incidents.
6. Fit with ADR 0001, the governor and the on-demand decision.

## Alternatives

| # | Option | Freshness (hidden) | Added cost, 16 panes (INFERRED) | Main weakness |
| --- | --- | --- | --- | --- |
| A | Status quo `on-demand` | unbounded (seen: 577 h) | 0 | The problem itself |
| B | `--background all` (exists) | about 2 min, background tab rotation | about 1,920 *reserved* GraphQL points/h for hidden Issues/PRs (2 points reserved per page; about half that is actually charged), plus visible-tab polling | Pays 2 points for each unchanged check. The same traffic shape as the 2026-09 incidents (4 panes, 1,549 Issues/PR operations, 3,098 units in one hour; 2026-09-05 research) |
| C | Refresh on focus (SWR style) | fresh on return to the pane | 1 check per return | Hidden tabs and never-focused panes stay stale. Needs a 1004-capable terminal |
| D | Long max-age timer for secondary tabs | 15 to 30 min | 16 x 2 x 2 to 4 per hour x 2 points = 128 to 256 points/h | Coarse. Still pays for unchanged data |
| E | Per-pane conditional REST sentinel: `issues` and `pulls`, `per_page=1&sort=updated&state=all`, with ETag | about 60 s | 0 primary points when quiet. Corrected: the `issues` endpoint already includes PRs, so one request per minute per repository adds 900 requests/h for 15 repositories (about 52% of the 1,720 requests/h baseline). That gives a coarser signal and may still require checking both tabs. A `304` still occupies an HTTP slot, and the effect on Actions latency is unmeasured | Doubles request volume through the 3 shared HTTP permits, so it can delay active Actions polls. The `issues` `304` is undocumented |
| F | **Account-wide GraphQL watermark** (one owner, all live repositories, 60 s) | about 60 s plus one fetch | about 60 points/h for the probe alone, plus the safety-net sweep (128 reserved points/h at 30 min or 256 at 15 min for 16 panes), focus checks and fetches triggered by changes. Real spend unmeasured | New owner role and a published hint in the coordination layer. Covers Issues and PRs only |
| F' | Watermark for the pane's own repository only, no coordination | 60 s to 5 min | 192 to 960 points/h | 3 to 16 times the cost of F |
| G | Notifications API doorbell | about 60 s for watched threads | 1 free conditional request/min | Misses the user's own changes and depends on watch settings. Documented for classic PATs only |
| H | Repository events | 30 s to 6 h, as documented | free `304` per repository | Documented as unfit for real time |
| I | Webhooks / `gh webhook forward` | seconds | none | Dev-only, admin, one forwarder per repository. A full webhook collector already exists as opt-in |

## Comparison and rationale

- **C is the cheapest visible gain, and it is proven to work in the owner's terminal.** The 1004 probe in Rex succeeded, and the code already has both seams (terminal mode lifecycle and CSI input). It answers the most common complaint ("I switch to the pane and the list is old") with SWR defaults as precedent: throttle focus checks to at least 5 s apart, and skip them when the data is younger than a minimum age. On its own it does not refresh tabs nobody looks at, and it does nothing in terminals without 1004.
- **F gives the "background real time" feeling at the lowest cost.** Its cost does not grow with the number of panes until about 50 repositories, because the cost formula rounds the connection count divided by 100 (INFERRED; 15 repositories measured at 1 point). The store caps live targets at 32, so the query stays at 1 point. F also detects changes the user's own agents make, which G cannot. It fits the books' doorbell pattern. ADR 0001 still holds, because the probe carries no row data and every tab keeps its own data path.
- **F carries the most risk of any option.** It adds a role and a published hint to the coordination layer, which has had lock wedges, ledger saturation and the "corrupt" hold (2026-09-23, 2026-09-28 and 2026-11-11 research). A plan should limit F to an advisory hint: if the watermark is missing, old or failing, panes fall back to D, and nothing blocks. It should go through the governor as one declared GraphQL point.
- **E is the main alternative to F.** It needs no coordination, and quiet checks cost no primary quota. Its cost is request volume through the shared HTTP permits, which competes with active Actions polls. That conflicts with criterion 1. E becomes preferable if building F's coordination proves expensive, or if the cadence can be 2 to 5 minutes.
- **D remains as the bound.** It caps staleness when the watermark misses something, for example a change that moves neither `totalCount` nor the newest `updatedAt`, or a watermark outage. Security already uses ETags, so D for Security costs nothing when quiet.
- **B, G, H and I** are rejected for this goal on cost, coverage, documented latency and deployment scope, in that order.

### Perceived latency (criterion 1)

Every recommended layer keeps the current flow: cached rows render at once and a check runs behind them (`index.mjs:21436-21437`, `index.mjs:23002-23008`). Watermark-driven fetches use `background` priority 3, below manual (0) and tab-switch (1), and `pollSchedule` admits at most one inactive tab per wake (`index.mjs:16228-16233`). The open risk is HTTP permit contention, which is why F is preferred over E.

### Pre-fetch or counts only (a sub-decision for F)

When the watermark changes for a tab the pane is not showing, a pane can either fetch the rows at once (switching to the tab is then instantly current, at 2 points per change) or update only the tab-bar count from `totalCount` (free, but rows fetch on open). ~~The measured change rate makes pre-fetch cheap.~~ Corrected: 126 items changed in 7 days (see the evidence section), and the number of fetches they cause is unknown. Pre-fetch is deferred by owner decision. The count path needs care, because today's tab-bar count is the row count with a `+` suffix for truncation (`index.mjs:23057-23072`).

## Counterevidence and what would change the conclusion

- The watermark can miss changes. That `Issue.updatedAt` and `PullRequest.updatedAt` change on closing, labelling, review and new commits is INFERRED, not documented. A plan must verify each row-visible change against a test repository before relying on the watermark. If important changes do not move the watermark, F becomes an accelerator and D carries more weight.
- If a cross-repository GraphQL query at 32 repositories costs more than 1 point, or hits a node or timeout limit, F's cost advantage shrinks toward F'. Only 15 repositories were measured.
- If tmux or another terminal without 1004 is common for the owner, C helps less. Today the panes run in Rex, which supports it.
- If core budget pressure rises (it is the busier budget today), E's free `304`s become more attractive than F's GraphQL point.
- If the coordination change in F cannot be kept advisory, choose E at a 2 to 5 minute cadence instead.

## Uncertainties

- Whether a REST `304` costs a secondary-limit point (undocumented; INFERRED yes).
- Notifications API with the `gh` OAuth token (docs say classic PAT only; not tested, and G is not recommended).
- The GitHub web UI's actual mechanism for live updates was not examined (out of scope; the 2026-09-28 research recorded socket notifications).
- The watermark was measured once per run on a quiet Saturday morning. Latency under load is unmeasured.
- Security watermarking through GraphQL `vulnerabilityAlerts` covers Dependabot only. It is untested and not needed while Security stays on free conditional REST.

## Owner review and corrections, 2026-11-28

The owner reviewed this assessment against the session logs. Each finding below was checked in this session (VERIFIED) unless marked otherwise.

| Finding | Effect |
| --- | --- |
| A stale cache cannot establish change frequency. Live 7-day count: 63 issues and 63 PRs updated, 29 still open, no 50-row cutoff hit (VERIFIED by a reproduced query) | Removes the "changes are rare" basis for prefetch |
| The cost comparison mixed quantities: 60 points/h covers the probe alone, while 1,920 uses the app's 2-point reservation. A real page costs 1 point (VERIFIED). The safety net adds 128 or 256 reserved points/h for 16 panes | No claim of total spend is supported. Actual hourly spend is unmeasured |
| One probe per account crosses ADR 0004's boundary: tokens for one user share quota but "retain separate private-data partitions" (`docs/decisions/0004-quota-and-acquisition-identities.md:28-30`). Probe scope and published counts and timestamps must stay within one host and access key. A failed repository lookup must stay unknown without suppressing successful results for the others | Layer 2 needs ADR 0004 alongside ADR 0001 |
| A successful probe can still leave old rows on screen. The first probe records today's watermark while the pane shows last month's rows, and nothing rings again. Never-opened tabs have no subscription (`index.mjs:21584`, created lazily by `requestTab` at `index.mjs:22218`). On-demand gives a hidden tab an infinite deadline even when it is marked requested (`index.mjs:16107-16108`, `demand !== "active"`) | Layer 2 must compare the watermark with each pane's displayed rows, not with the previous probe. Its first test is startup with a stale cache, a never-opened tab and a deferred fetch |
| The REST alternative (E) was costed too narrowly: 900 requests/h for 15 repositories at 60 s, and a `304` still holds an HTTP slot | Corrected in the table |
| The assessment made four GraphQL attempts, not five | Corrected in the header |
| The Archy store holds project docs, source code, config, migrations, CI workflows, agent reports and health snapshots, not only project documents (the chat summary said "only project documents"). The books support the pattern but cannot establish which GitHub row changes this probe detects | Wording only |

Owner decision: plan refresh on focus (layer 1) now. Keep the shared GraphQL check (layer 2) as a candidate. Defer the 60 s default cadence and hidden-tab prefetch. Before choosing 15 or 30 minutes for the safety net, answer one question first: when a pane starts with stale rows, or a background fetch is deferred, can it still recognize which rows need refreshing, and catch up once admission resumes?

## Decisions needed from the owner (original list; item 1 decided above)

1. Accept refresh on focus (C) as a new default behavior for 1004-capable terminals.
2. Accept a cross-repository GraphQL watermark (F) as an advisory signal, recorded as an addendum to ADR 0001 (probe, not data layer).
3. Choose a target freshness for hidden Issues/PRs (this assessment assumes 60 s) and a safety-net maximum age (15 or 30 minutes).
4. Choose pre-fetch on change or counts only for hidden tabs.

## Handoff

- Objective and scope: evaluative assessment only. No implementation, configuration, dependency or remote write. GitHub reads: three 1-point GraphQL watermark queries and one query rejected for malformed aliases. A temporary Rex probe window ran a 12 s focus logger, then exited.
- Baseline: `develop` at `154930d11cb83c25b6eae7adfcc366472a4ae0e4`, main worktree `/Users/juan/code/gh-glance`, clean apart from the two new research documents. Installed Homebrew 0.20.0 matches the checkout `index.mjs` except the shebang.
- Delegated investigations (all completed, all results inspected):
  - GitHub API change-detection facts: web, read-only, about 24 fetches.
  - General polling patterns: web, read-only, about 27 fetches.
  - Archy corpus: read-only Supabase SELECTs, plus local ePUB text extraction into this session's scratchpad. No embeddings or LLM calls.
  - Gaps: the Archy vector store holds no books; DDIA and *Release It!* are absent from the corpus.
- Local evidence kept outside the repository: `watermark.graphql`, `watermark.json`, `focus-probe.mjs` and `focus.log` in the session scratchpad. They are raw, reproducible from the commands described, and not project artifacts.
- Next phase (updated after owner review): `rpi-plan` for refresh on focus only. Layer 2 stays a candidate gated on the stale-startup and deferred-fetch question. The original note follows: `rpi-plan` after the owner decides items 1 to 4. A plan should phase C first (local, smallest), then F with D as its fallback. It should include a verification step for each change type that the watermark detects, and keep the efficiency gate (`npm run test:efficiency`) and PTY coverage for the focus path. On resume, re-check the cited line numbers and re-measure the watermark cost at the then-current number of live targets.
