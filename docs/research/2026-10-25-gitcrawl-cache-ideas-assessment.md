# Assessment: Gitcrawl (OpenClaw) cache ideas for gh-glance rate-limit avoidance

Date: 2026-10-25. Repository: `juan294/gh-glance`, branch `develop`, commit `4b2a8d3cfdd12b6ac0b7a8a70bcd3bf6349e7aa9`, version 0.16.2 (`node index.mjs --version`). Runtime observed: Node v24.22.1, gh 2.103.2 (2026-10-23). Workflow: `rpi-assess`. No code, configuration, dependency or remote change was made. One read-only diagnostic (`node index.mjs --doctor`, no `--probe`) and two read-only GitHub REST requests were run for evidence; both are recorded below.

## Question

Does Gitcrawl, or anything in its ecosystem, offer a cache design that gh-glance should adopt to avoid GitHub rate limits, and are there other Gitcrawl ideas worth bringing into gh-glance?

## Conclusion

**No adoption is recommended for the rate-limit goal.** Every quota-saving mechanism in Gitcrawl's cache, and in Octopool (where that cache now lives), already exists in gh-glance in an equal or stricter form: conditional REST requests whose `304` answers cost nothing, a persisted validator store shared across panes, a shared quota ledger with a hard reserve, stale-on-failure display, stampede protection, and an optional separate acquisition process. Local evidence from the user's own machine shows the current design working: 389,711 of 396,183 counted REST answers (98.4%) were free `304`s, and the one remaining uncached path (Issues and PRs over GraphQL) spends from a separate GraphQL budget that is at 4,963 of 5,000 remaining right now.

The one structural difference that matters is that Issues and Pull Requests have no validator because GraphQL has none. A conditional-REST alternative for those two tabs is feasible (verified live today: the REST issues list returns an ETag and a `304`) but it would shift spend from the underused GraphQL budget onto the REST `core` budget that historically was the binding one, and it cannot supply `reviewDecision`. It is therefore an option to hold, not a recommendation.

Two small, independent findings surfaced while mapping the comparison and are worth a decision: the GraphQL budget observer is probably the largest single GraphQL consumer, and gh-glance does not read GitHub's `x-poll-interval` header. Both are detailed under Findings.

## Criteria

- Rate-limit effect: does the idea reduce primary REST `core` or GraphQL spend, or protect against secondary limits, beyond what gh-glance already does?
- Compatibility: fits ADR 0001 (keep the `gh` CLI data layer, no GraphQL consolidation), ADR 0003 (file-backed admission, no daemon, no new dependency), ADR 0005 (collector is explicit and provider-fenced), and the single-file no-build stance in `CLAUDE.md`.
- Correctness and freshness: must not turn failures into false successes or make old rows look fresh (README "Rate limit" section, lines 860 to 870).
- Maintenance and cost: solo project; reject machinery that adds gates, services or dependencies (memory note `no-release-pipeline-hardening`).
- Reversibility and migration risk.

## What Gitcrawl actually is (external facts)

Sources were read on 2026-10-25 through `gh api` against the public repositories. Versions and dates are from the repositories' own release lists and changelogs.

**Gitcrawl** (`https://github.com/openclaw/gitcrawl`, Go, MIT, 131 stars, latest release v0.17.0 published 2026-10-24, last commit f1c40bc on 2026-10-25). The README describes it as a tool that "mirrors GitHub issues and pull requests into local SQLite for maintainers and agents" with local search, clustering, JSON output and a terminal UI. Key mechanics that relate to quota:

- Incremental sync (`docs/sync.md`): fetches open threads plus a closed sweep bounded by a persisted watermark (`internal/syncer/syncer.go:288-309`); `--since` windows; comment reuse when the parent `updated_at` and comment count are unchanged (`syncer.go:1155`); honors `Retry-After` and rate-limit headers in the paginator.
- Rate-limit reserve guard (`internal/github/client.go:46-53, 206-224`): before each guarded request the client refreshes `/rate_limit`, keeps a configurable remaining floor, and stops acquisition with `stopped_reason: "rate-limit-reserve"` when the floor would be crossed. GraphQL keeps a 500-point floor (`docs/sync.md`, "Batched GraphQL history").
- Shared rate-limit ledger (`internal/cli/gh_rate_limit.go:20-70`): one JSON file per host and token hash under the cache directory, written by sync and read by other commands to decide "low budget".
- The TUI reads SQLite only, refreshes its view every 15 seconds and "does not call GitHub itself" (README, "Cluster and review").

**The cache feature.** The thing most people mean by "Gitcrawl's cache to avoid gh rate limits" is the `gitcrawl gh` shim: a `gh`-compatible binary that answered read-only `gh` commands from SQLite or from a persistent response cache and fell through to the real `gh` otherwise. Its history, from `CHANGELOG.md`:

| Version | Date | Cache behavior added |
|---|---|---|
| 0.2.0 | 2026-05-05 | Canonicalized cache keys, per-command TTLs, stale-on-rate-limit fallback, mutation invalidation, hit/miss counters, lock-file stampede protection |
| 0.2.1 | 2026-05-05 | Stale-while-revalidate reads, finer Actions and API TTLs, `xcache snapshot` |
| 0.3.2 | 2026-05-10 | Shared token rate-limit budget awareness; serve stale successful reads more aggressively when the pooled budget is low |
| 0.3.3 | 2026-05-11 | Liveness tombstones after mutating `gh run`, `gh workflow`, `gh release` calls so immediate reads bypass stale entries; `--live` bypass |
| 0.4.5 | 2026-05-23 | Hit-rate improvements for API projections and run lists |
| 0.5.0 | 2026-05-27 | **Retired.** "move the `gitcrawl gh` compatibility cache to Octopool, with a migration error that points users at `octopool login`" |

The retired implementation (read at tag v0.4.5: `internal/cli/gh_shim_cache.go`, `gh_shim_cache_policy.go`, `gh_shim_liveness.go`, `docs/gh-shim.md`) was a TTL cache keyed by a SHA-256 of the canonical argument vector plus config path, working directory and `GH_HOST`. Default TTLs were command-aware: active run lists 30 s, completed run views 12 h, workflow and search reads 15 m, repo and release metadata 1 h, read-only GraphQL 6 h. Three stale paths existed: stale-while-revalidate behind a lock file while one peer refreshed; stale served after a rate-limit error from the backend; and stale served before any request when the shared ledger said the budget was low. Repeat read errors were cached, with rate-limit errors capped at 2 minutes. Only a handful of lines in the read path mention ETags (`gh_shim_cache.go` 3 matches, `gh_shim_cache_policy.go` 2 matches); the design was time-based, not validator-based. Current Gitcrawl docs now say: "Gitcrawl no longer owns a GitHub CLI compatibility cache ... Octopool owns the org-authenticated shared GitHub cache and pooled read relay" (`docs/gh-shim.md`, main).

**Octopool** (`https://github.com/openclaw/octopool`, TypeScript Cloudflare Worker plus Go CLI, 139 stars, v0.9.10 published 2026-10-25). README: "Pool your org's GitHub identities behind a shared Cloudflare cache." Mechanics from `README.md`, `docs/relay.md` and `docs/token-free.md`:

- A Worker in front of GitHub with a D1 shared cache; a Durable Object per pool coalesces identical misses and picks the pooled PAT or GitHub App installation with the most remaining budget ("Five PATs + one GitHub App ≈ five-plus-one combined headroom").
- Cache policy: 60-second stale-while-revalidate window and a five-minute outage stale window (`docs/relay.md:317-318`); callers bound staleness with `cache-control: max-age=N`; caller-supplied `if-none-match` validators bypass the shared cache (`relay.md:38-41`); responses report `cache: hit|stale|miss|bypass` and `stale_ok`.
- Token-free transports: anonymous `api.github.com` reads (which still consume the anonymous per-IP quota, including `304`s) and no-quota `github.com` page and Git smart-HTTP reads for diffs, refs and some run summaries (`docs/token-free.md`).
- Scope: org-gated, public repositories only; "If you're not running a maintainer team and you don't care about GitHub rate limits, you don't need this." Requires a Cloudflare Workers Paid plan, a domain, D1 and Worker secrets.

**CrawlKit** (`github.com/openclaw/crawlkit` v0.17.3) is the shared Go library; its `cache/` package is a SQLite-backed store, not an HTTP validator cache.

## What gh-glance does today (current state, cited)

All references are to `index.mjs` at the baseline commit unless stated.

- **Conditional REST with zero-cost `304`.** `ghApiArgs` adds `If-None-Match` when a validator exists (`index.mjs:999-1005`); `ghApi` branches on the parsed status line and records `rest304` (`index.mjs:1008-1040`); `fetchConditionalEntity` sends the cached ETag unless forced, charges a `304` as cost 0, and drops a validator whose entity is unusable so the next check is unconditional (`index.mjs:1564-1618`). Actions and the three Security sources use it (`index.mjs:1707-1800`, `index.mjs:6657-6870`). A single `304` is not treated as quiet; two unchanged observations are required (`index.mjs:146`, `POLL_QUIET_AFTER = 2` at `index.mjs:149`).
- **Validators persist and are shared across panes.** The acquisition store at `<config>/gh-glance/coordination-v2/.../acquisition.json` (`acquisitionStorePath`, `index.mjs:13435`) keeps each query's snapshot with its `entities` array of `{key, etag, body}` (`normalizeAcquisitionSnapshot`, `index.mjs:13857-13885`; publication at `index.mjs:18394-18405`). A new producer loads them (`index.mjs:9645`). Panes subscribing to the same query act as followers of one producer and reuse a fresh snapshot without any request (`index.mjs:14862-14900`); a query with no subscribers is retained as `cache-only` (`index.mjs:13528`). This is the "shared cache plus coalesced misses" of Octopool, implemented with files and leases instead of a Worker.
- **Shared quota ledger with a hard reserve.** ADR 0003 and ADR 0004: per-principal ledgers, atomic reservations charged before a subprocess starts, `reserve = ceil(limit * 0.2)`, fail-closed on missing or stale evidence (README "Rate limit", `BUDGET_SAFETY = 0.8` at `index.mjs:2247`). Core evidence comes from real response headers through a conditional `/user` observer (`readInstallationCoreBudget`, `index.mjs:7918-7932`; observer scheduling `index.mjs:3302`). Gitcrawl's reserve guard (`client.go:206-224`) is the same idea but advisory and per-process, refreshed from `/rate_limit`, which gh-glance deliberately treats as non-authoritative (README lines 818 to 822; memory note `rate-limit-endpoint-reports-empty-bucket`).
- **Stale-on-failure display.** Last-known-good rows stay visible under a live error and after restart, labelled `stale`; "cached data never turns a failure into a false success" (README lines 860 to 870; dashboard cache at `index.mjs:13092-13370`, scoped by repository, host, provider and access partition, README lines 588 to 620). This is Gitcrawl's "stale-on-rate-limit" and Octopool's `stale_ok`, with stricter labelling.
- **Low-budget behavior.** Where Gitcrawl served stale before calling GitHub when the shared ledger said "low", gh-glance denies admission when the declared cost does not fit above the reserve and keeps showing cached rows (README lines 795 to 808). Same outcome, enforced rather than advisory.
- **Cadence.** Quiet tabs back off to 30 s, 60 s, 120 s or 300 s depending on tab and activity; `--background on-demand` (default) does not poll Issues, PRs or Security at all until the tab is opened (README lines 326 and 768 to 793).
- **Issues and Pull Requests are GraphQL without validators.** Explicit documents `ISSUE_PAGE_QUERY` and `PULL_PAGE_QUERY` select 50 rows ordered by `UPDATED_AT` with a `rateLimit` envelope (`index.mjs:1075-1100`, `GRAPHQL_PAGE_SIZE = 50` at `index.mjs:1059`, declared `GRAPHQL_PAGE_POINTS = 2` at `index.mjs:1055`). Unchanged-frame suppression compares serialized payloads after the fact (`index.mjs:2071-2080`); the request itself is always paid. The 2026-08-29 plan kept them on GraphQL because "GraphQL has no ETag, and reimplementing their `--search sort:updated-desc` queries by hand is a much larger change for no rate-limit benefit" (`docs/plans/2026-08-29-conditional-polling-and-calm-status.md:142-146`). The hand-written reimplementation has since happened (the explicit documents above replaced `gh issue list` and `gh pr list`), so only the "no ETag" reason remains.
- **GraphQL budget observer.** `query{rateLimit{...}}` (`GRAPHQL_OBSERVER_QUERY`, `index.mjs:1102`) is the only claimed GraphQL observer, declared at 1 point (`GRAPHQL_OBSERVER_POINTS = 1`, `index.mjs:1056`), scheduled every `BUDGET_PROBE_MS = 60_000` (`index.mjs:2253`, `index.mjs:5747`) by one owning pane.
- **Separate acquisition process.** ADR 0005: `--serve` runs the same machinery as a foreground collector over a Unix socket; `--connect local|ssh:<alias>` clients make zero GitHub requests. This is the gh-glance analogue of Gitcrawl's "TUI reads SQLite, sync writes it" split and of Octopool's remote relay, without a service dependency.
- **Diagnostics.** `--doctor` reports HTTP attempts, REST 200/304 counts, proven units per resource, outstanding units, cache hits and joined followers (README lines 805 to 808). Gitcrawl's `xcache stats` reported the same categories for its shim.
- **`x-poll-interval`.** No occurrence in `index.mjs` (`grep -ai poll-interval`, zero matches).

### Live evidence gathered today

**Read-only doctor on this machine** (`node index.mjs --doctor`, 2026-10-25, around 10:49 UTC; six live pane leases):

| Metric | Value |
|---|---|
| HTTP attempts (lifetime of the acquisition store) | 424,098 |
| Failed requests | 1,003 |
| REST actual 200 / 304 | 6,472 / 389,711 |
| Proven actual units | 6,471 core + 26,925 GraphQL |
| Observer calls | 90,772 |
| Cache hits / joined followers | 3,365 / 0 |
| Core budget now | 4,893 remaining, 1,000 reserved |
| GraphQL budget now | 4,963 remaining, 1,000 reserved |

So 98.4% of counted REST answers were `304`s that cost nothing, and total proven core spend over the whole store lifetime is about 1.3 hours' worth of a 5,000-unit budget. GraphQL spend is roughly four times core spend over the same period. The doctor does not split GraphQL units between Issues and PR pages and the observer; see finding F2.

**Live conditional REST probe on a public repository of the user** (`gh api -i repos/juan294/gh-glance/issues?state=open&per_page=50&sort=updated`, then the same with `If-None-Match`):

```text
HTTP/2.0 200 OK   Etag: W/"76b58e4f..."   X-Ratelimit-Used: 99   X-Ratelimit-Remaining: 4901
HTTP/2.0 304 Not Modified                 X-Ratelimit-Used: 99   X-Ratelimit-Remaining: 4901
```

The `304` did not move `X-Ratelimit-Used`. This matches GitHub's documentation, read today: "Making a conditional request does not count against your primary rate limit if a `304` response is returned" when the request is authenticated (`https://docs.github.com/en/rest/using-the-rest-api/best-practices-for-using-the-rest-api`). The GraphQL documentation read today describes no conditional or cached mechanism and states the minimum query cost is 1 point (`https://docs.github.com/en/graphql/overview/rate-limits-and-query-limits-for-the-graphql-api`).

**Repository visibility** (`gh repo list juan294`): 11 active private repositories (including archy, chapa, clarity, coach, portfolio, spoken-letter) and 22 public ones. This matters for the token-free transport question below.

## Idea-by-idea comparison

| # | Gitcrawl / Octopool idea | gh-glance today | Verdict |
|---|---|---|---|
| 1 | TTL response cache per command shape | Validator cache (`304` = 0 cost) plus `nextDueAt` reuse by followers | Already present in a stronger form; a TTL cache would make the pane show older data for no quota gain, since `304`s are already free |
| 2 | Stale-while-revalidate with lock-file stampede protection | Producer claim with lease; followers reuse the snapshot | Already present |
| 3 | Serve stale on rate-limit error | Last-known-good rows under the live error, `stale` label | Already present, with stricter labelling |
| 4 | Serve stale when shared ledger says budget is low | Governor denies admission below the reserve; cached rows remain | Already present, enforced not advisory |
| 5 | Shared per-token rate-limit ledger file | Per-principal ledger with atomic reservations (ADR 0003/0004) | Already present; gh-glance's is authoritative (headers) where Gitcrawl's reads `/rate_limit` |
| 6 | Reserve floor before dispatch | 20% hard reserve, fail closed | Already present |
| 7 | Liveness tombstones after mutations | gh-glance performs no GitHub mutations | Not applicable |
| 8 | Negative (error) caching | Negative-result and capability backoff (`docs/research/2026-09-05-...`) | Already present |
| 9 | Cache statistics (`xcache stats`) | `--doctor` acquisition metrics | Already present |
| 10 | Display process never calls GitHub (TUI reads SQLite) | `--connect local` / `ssh:` clients make zero requests (ADR 0005) | Already present as opt-in |
| 11 | SQLite mirror for offline and restart | `dashboard-cache.json` (32 targets, 60 rows per tab) plus `acquisition.json` entities | Present at the scale needed; SQLite would add a dependency or `node:sqlite` coupling for no quota benefit |
| 12 | Coalesced identical misses across machines (Octopool Worker, D1) | SSH collector shares one acquisition scope across machines | Present for the one-user case; a hosted relay contradicts ADR 0003 and the no-service stance |
| 13 | Pooled identities (several PATs plus an App) | GitHub App provider in the collector has its own installation budget | Partially present; pooling several personal tokens is not useful for one account, since GitHub's user budget is per user, not per token |
| 14 | Token-free transports (anonymous API, `github.com` pages, Git smart HTTP) | None | Not recommended: anonymous API is 60 requests per hour per IP; page transports are HTML and Git-protocol parsers for diffs and refs, not for runs, alerts or PR review state; half of the user's watched repositories are private |
| 15 | Incremental `--since` windows and watermarks | `UPDATED_AT DESC` pages with demand-driven paging; unchanged-count backoff | Different problem (full mirror versus top-N view); not applicable |
| 16 | Honor `x-poll-interval` | Not read | Small compliance gap; see F3 |
| 17 | Validators for Issues and PRs | None (GraphQL) | The only real structural gap; see F1 |

## Findings

### F1. Issues and PRs could use conditional REST, but the trade is not clearly positive

Observation. The REST issues list carries an ETag and returns a free `304` (verified above). `GET /repos/{o}/{r}/issues?state=open&sort=updated&per_page=50` returns issues and PRs together (PR rows carry a `pull_request` key) with `labels`, `user`, `updated_at`; `GET /repos/{o}/{r}/pulls?state=open&sort=updated` returns `draft`, `head.ref`, `user`, `updated_at` (field list verified live). Neither returns `reviewDecision`, which the PR tab renders (`index.mjs:1093`, `index.mjs:7096`, `index.mjs:12436`).

Inference. On a quiet repository the two tabs would cost 0 instead of 1 to 2 GraphQL points per poll. On an active repository they would cost 1 REST unit each per change, on the `core` budget that the 2026-08-10 incident showed to be the binding one, while GraphQL has never been observed near its reserve (research 2026-08-10, lines 72 to 82; today's doctor: 4,963 of 5,000 remaining). `reviewDecision` would need either removal from the PR tab or a GraphQL follow-up gated by a changed REST ETag (a hybrid: validator on REST, detail on GraphQL only after a change). That hybrid is coherent with ADR 0001 (no consolidation) but is new acquisition code with its own tests, oracle and efficiency gate updates.

Disposition. Hold. Revisit only if `--doctor` or the efficiency measurement shows GraphQL approaching its reserve, or if `--background all` becomes the common configuration. What would reverse this: evidence that Issues or PR polling, not the observer, dominates GraphQL spend (F2) and that it matters operationally.

### F2. The GraphQL budget observer is probably the largest GraphQL consumer

Observation. `GRAPHQL_OBSERVER_QUERY` is 1 point per call, scheduled every 60 seconds by one owning pane while any pane is alive (`index.mjs:1056`, `index.mjs:2253`, `index.mjs:5747`). The doctor reports 90,772 observer calls and 26,925 proven GraphQL units over the store lifetime; the default `on-demand` mode polls Issues and PRs only while those tabs are open.

Inference (not separable from the doctor output). At one owner per minute the observer alone costs up to 60 points per hour, about 1.2% of the GraphQL budget, and a large share of the 26,925 units is plausibly the observer rather than tab pages. This is not a rate-limit risk. It is a design note: the observer exists because GraphQL has no response-header owner (`index.mjs:2254-2257`), and the Issues and PR pages already carry a `rateLimit` envelope that constrains the same epoch (`index.mjs:1081`, `index.mjs:1096`). A cheap improvement would stretch the observer interval while a recent page envelope is fresh, or run it only when a pane actually has GraphQL demand. The expected saving is tens of points per hour.

Disposition. Optional, low priority. Needs a measurement first: the `measure:efficiency` report or a per-operation split in `--doctor` would confirm the share before any change.

### F3. `x-poll-interval` is not honored

Observation. GitHub's best-practice page (read today) says to wait at least the number of seconds in any `x-poll-interval` header when polling. `index.mjs` never reads it. The live issues response today did not include the header for that endpoint; GitHub documents it mainly for the events and notifications endpoints, which gh-glance does not call.

Disposition. Compliance nicety with no measured quota effect on the endpoints gh-glance uses. Cheap to add (parse header in `ghApi`, feed the per-operation floor), but not justified by evidence alone.

### F4. Nothing in Gitcrawl's retired shim is time-based caching that gh-glance lacks

Observation. The shim's three stale paths and its TTL table are all reproduced or exceeded by gh-glance's validator cache, governor and last-known-good store (table rows 1 to 6). The shim had no cross-process atomic admission; gh-glance has it. Gitcrawl itself abandoned the shim after three weeks in favor of a hosted relay.

Disposition. Rejected with evidence. Adding a TTL cache in front of free `304`s would reduce freshness without reducing spend.

### F5. Octopool's hosted relay and token-free transports do not fit

Observation. Octopool requires a paid Cloudflare plan, an org, a domain and public repositories (README "Deploy it"). Its token-free page transports cover diffs, refs and run summaries for public repositories only (`docs/token-free.md`); 11 of the user's watched repositories are private.

Disposition. Rejected. Contradicts ADR 0003 (no service), ADR 0005 (no hosted infrastructure in the default path) and the project's one-user scope.

## Recommended direction

1. Make no cache change for rate limits. The current design already achieves what Gitcrawl's cache and Octopool aim for, and today's local evidence shows 98.4% free REST answers with both budgets far above their reserves.
2. If anything is pursued, pursue measurement first: a per-operation GraphQL split in `--doctor` or the efficiency report, so F1 and F2 can be decided on numbers. That is an observability change, not a cache change.
3. Keep F1 (REST validators for Issues and PRs with a GraphQL `reviewDecision` follow-up) as the documented fallback if GraphQL ever becomes the binding resource.

## Counterevidence and uncertainties

- The doctor figures are lifetime totals of one acquisition store on one machine, not a current hourly rate, and they include periods before the 2026-09-28 ledger-saturation repair. They cannot show what the hourly spend is today.
- The GraphQL split between observer and tab pages (F2) is inferred from constants and call counts, not measured.
- The REST issues and pulls field lists were taken from one public repository. GitHub Enterprise or EMU hosts were not checked.
- Gitcrawl, CrawlKit and Octopool were read from their repositories on 2026-10-25; their docs sites (`gitcrawl.sh`, `docs.octopool.dev`) were not fetched separately. Their behavior may change; the version and dates above bound the claims.
- The retired shim's code was inspected at tag v0.4.5 through file listings, the policy file, the cache read path function list and its documentation; the whole shim was not read line by line.

## Decision needed

None to proceed with the recommendation (do nothing). A decision is needed only if the user wants the optional measurement change (per-operation GraphQL split) planned, or wants F1 planned despite the budget trade described above.

## Handoff

- Objective and scope: evaluative assessment only, as requested through `rpi-assess`. No planning or implementation authorized. No release involved.
- Baseline: `develop` at `4b2a8d3cfdd12b6ac0b7a8a70bcd3bf6349e7aa9`, worktree `/Users/juan/code/gh-glance`, version 0.16.2. Untracked at the time: `supabase/`, `docs/plans/2026-10-25-first-run-experience*`, `docs/research/2026-10-25-first-run-experience-assessment.md` (unrelated, preserved).
- Findings and dispositions: F1 hold; F2 optional, measure first; F3 optional, low value; F4 rejected with evidence; F5 rejected.
- Decisions and invariants relied on: ADR 0001, 0003, 0004, 0005; no new dependency or service; `304` is a valid new source observation but never freshens failed rows.
- Checks run: `node index.mjs --version`, `node index.mjs --doctor` (plain, read-only), two read-only `gh api` requests against `juan294/gh-glance`, `gh repo list juan294`, read-only `gh api` reads of `openclaw/gitcrawl`, `openclaw/octopool`, `openclaw/crawlkit`, two WebFetch reads of GitHub documentation, one `graphify_local` query for orientation. No tests were run because no code changed.
- External sources: `https://github.com/openclaw/gitcrawl` (v0.17.0, 2026-10-24; `docs/gh-shim.md`, `docs/sync.md`, `CHANGELOG.md`, `internal/github/client.go`, `internal/cli/gh_rate_limit.go`, tag v0.4.5 `internal/cli/gh_shim_*.go`); `https://github.com/openclaw/octopool` (v0.9.10, 2026-10-25; `README.md`, `docs/relay.md`, `docs/cli.md`, `docs/token-free.md`); `https://github.com/openclaw/crawlkit` (v0.17.3); GitHub REST best practices and GraphQL rate-limit pages (retrieved 2026-10-25).
- Delegation: none. All reads were performed by the parent session.
- Next action: none required. If the user chooses the measurement option or F1, start a separate `rpi-plan` session against this document.
