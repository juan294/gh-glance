# Research: GitHub allowance use, freshness, multi-pane cost, and the 2026-11-11 "coordination is corrupt" hold

Date: 2026-11-11. Repository: `juan294/gh-glance`, branch `develop`, commit `24c67c577e987022cd8fc187adf95e9358fc78c0`, version 0.19.2 (`node index.mjs --version`). Runtime observed: Node v24.22.1, gh 2.103.3 (2026-10-26), macOS arm64. Installed copy used by the live panes: Homebrew `gh-glance` 0.19.2. Workflow: `rpi-research` (descriptive). No product code, configuration, dependency or remote state was changed.

## Research question

How does gh-glance acquire data, cache it, schedule refreshes, coordinate several panes, handle rate limits and staleness, and what does one pane cost in memory and local resources? The owner added a second question during the session, with a screenshot of a pane showing `Core: Local coordination is corrupt`: what causes that state and how does it clear?

## Summary

1. **The default mode is polling only, and most of it is free.** Actions and Security use conditional REST; a `304` costs no quota. Lifetime counters on this machine show 881,462 `304` answers against 13,250 `200` answers (98.5% free). Issues and Pull Requests use GraphQL, which has no validator and costs a declared 2 points per page.
2. **Freshness in standalone mode is bounded by fixed cadences.** A visible Actions tab checks every 5 s while a run is in progress or content is changing, and every 30 s after two unchanged results. In the default `--background on-demand` mode, Issues, Pull Requests and Security are checked once when opened and never again until `r`, `R` or a tab switch. No signal other than the timer exists in standalone mode.
3. **All panes of one account share one budget pool, one pacing lane per resource and three HTTP permits.** Panes on the same repository share one fetch (one producer, the others follow at zero requests). Panes on different repositories share only the budget, the transport and the store.
4. **The budget gate fails closed on its observer.** Data requests need budget evidence younger than 65 s (core) or 125 s (GraphQL). When the observer cannot publish, every pane of the account stops fetching that resource.
5. **The live hold (finding F1) is that gate closing on a contradiction in GitHub's own rate-limit headers.** The ledger accepted a core observation that described an untouched bucket (`used 0`, reset one hour ahead). Every later observation carries the real, earlier reset time, the governor ignores it as "going backwards", and the code path reports the ignored observation as `corrupt`. All 15 panes were held for core for about 33.5 minutes. The code has no early exit from this state; it cleared by itself at the first observation after GitHub's real window reset (observed at 10:01:44 UTC).
6. **Each pane uses about 257 MB of resident memory** (15 panes: 3.86 GB), against 89 MB for a bare Node process with Ink and React loaded. The code sets no heap limit and has no memory monitoring. The composition of the remaining memory was not measured.
7. **Push delivery exists only behind the opt-in collector.** Webhooks need a user-managed HTTPS reverse proxy and a registered GitHub webhook; neither webhooks nor the GitHub App provider are reachable from the default standalone mode.

All line references are `index.mjs` at the baseline commit unless a file is named. VERIFIED means the lines or the output were read in this session. INFERRED marks a conclusion that the evidence supports but does not show directly.

## F1. Live incident: `Core: Local coordination is corrupt` (2026-11-11, 09:29 UTC onward)

### What the user saw

`Core: Local coordination is corrupt` / `Run gh-glance --doctor; preserve the reported state file; next <1m` / `cached 18m12s`, on an Actions tab. The copy comes from the `corrupt` entry of the recovery table (16507). `corrupt` is in `HARD_STORAGE_REASONS`, described in code as "Reasons that no retry can clear: the ledger itself must be repaired" (16493-16495), and doctor prints the manual repair advice (16498-16500).

### Evidence (VERIFIED)

| Observation | Value | Source |
| --- | --- | --- |
| Live panes | 15, all started about 07:57 UTC | `ps`, doctor `live leases 15` |
| Ledger core budget | `limit 5000, remaining 5000, used 0, resetMs 1794392839000` (10:27:19 UTC), `observedAt 1794389240103` (09:27:20 UTC), `source core-observer` | `coordination-v2/quota-*.json` read at 09:47 UTC |
| Reset minus observation time | 3,599 s | computed from the two values above |
| Core observer state | `outcome failed`, retried every 60 s | ledger `observers.core`; `failProbeClaim` sets `nextAt = at + BUDGET_PROBE_MS` (6417-6423) |
| Recovery journal | `budget-reset` for core at 09:00:51 UTC; `clock-recovery` and `interrupted-request` entries 09:14 to 09:29; first `corrupt` (origin `coordination`, resource `core`) at 09:29:52, repeated at 09:33:20 and after | `quota-*.json.recovery.json` |
| Live core headers on `GET /user`, `200` at 09:47:51 UTC | `x-ratelimit-used 323, remaining 4677, reset 1794391252` (10:00:52 UTC) | `gh api -i user` |
| Live core headers on conditional `GET /user`, three `304` at 09:48:04 to 09:48:06 UTC | `used 338, remaining 4662, reset 1794391252` | `gh api -i user -H "If-None-Match: ..."` |
| Last successful Actions fetch reported by doctor | 09:28:08 to 09:28:10 UTC; `next due` 09:28:38 to 09:28:40 | `node index.mjs --doctor` at 09:46 UTC |
| Doctor counters during the hold | unchanged between two runs one minute apart (HTTP attempts 922,789) | two doctor runs |
| One account in `gh auth status` | one github.com account, active | `gh auth status` |

GitHub's real core window on this account began at 09:00:52 UTC and resets at 10:00:52 UTC. The ledger holds an epoch that resets at 10:27:19 UTC with nothing used.

### Code path (VERIFIED)

1. The core observer is a conditional `GET /user`; its rate-limit headers become the budget (11613-11625). `pickRateLimit` builds `{limit, used, remaining, resetMs}` from the headers (971-986).
2. `publishProbe` passes the observation to `budgetFromObservation` with `allowEpochChange: true` (6268-6274). The epoch is the string `limit:resetMs` (6164).
3. With `allowEpochChange`, an observation whose `resetMs` is later than the stored one is accepted as a new epoch (6190-6213). The function does not compare the new epoch against the time of the stored reset; an epoch can be replaced before its reset time has passed.
4. An observation whose `resetMs` is earlier than the stored one returns `{ status: "ignored" }` (6172).
5. Back in `publishProbe`, an ignored observation leaves `changedResources` empty, and the function returns `{ ok: false, reason: "corrupt" }` (6276-6291).
6. `refreshResourceBudget` then calls `failProbeClaim` (7232-7237), which marks the observer `failed` and schedules the next attempt 60 s later (6417-6423).
7. `availableForGrant` returns `mode: "probe", reason: "budget-stale"` once the stored observation is older than `budgetSnapshotTtl` (65 s for core, 2750) (2916-2922). No core reservation is granted in that mode.

Applied to the evidence: the stored `resetMs` is 10:27:19 UTC; every real response carries 10:00:52 UTC; step 4 ignores it; step 5 names the result `corrupt`; step 7 holds every core request for every pane on the account. The ledger file itself parses and normalizes (doctor read it; this session read it as valid JSON, version 8).

### Origin of the stored observation (INFERRED)

The stored observation has the signature of a bucket nothing has touched: `used 0`, `remaining` equal to `limit`, and a reset exactly one hour (3,599 s) after the observation. The project memory note `rate-limit-endpoint-reports-empty-bucket` (2026-08-29) recorded the same signature from `GET /rate_limit` on this account, with real endpoints sharing a different bucket with a fixed reset. In this incident the value entered through the `core-observer` source, which reads `GET /user`. Which response carried it is not recorded anywhere: the ledger keeps the parsed numbers, not the raw headers. A sampler in this session read conditional `GET /user` headers every 30 s from 09:48 UTC and saw only the real bucket (see "Sampler" below).

### Recovery as implemented, and visibility

- Automatic: none before the real window moves. The observer retries every 60 s and each retry takes the same path. After GitHub's real window resets (10:00:52 UTC here), a new real reset is one hour after the first charged request, or an untouched-bucket reading is "now + 3600 s"; either is later than 10:27:19 UTC, so step 3 accepts it. INFERRED from the code; the sampler result below records what happened.
- Manual: `r` and `R` do not bypass the budget gate (reported by the scheduling trace at 12499-12501). Doctor's repair advice is to quit every pane and move the state file, its `.recovery.json` and `registry.json` away (16498-16500).
- Visible: yes. Two status lines per tab, an Events entry, and doctor's `recovery reason core: corrupt`, `status stale`.
- Cached rows stay on screen with a `cached` age; they are not presented as fresh.

### Sampler result

A background loop in this session read conditional `GET /user` headers (free `304` answers) and the ledger's core entry about every 10 s from 09:48:41 to 10:23:50 UTC, 110 samples (VERIFIED, log kept in the session scratchpad).

| Time (UTC) | Live header | Ledger core entry | Observer |
| --- | --- | --- | --- |
| 09:48:41 to 09:52:44 | `used` 359 to 489, reset 10:00:52 | `used 0`, reset 10:27:19, observation 21 to 25 min old | failed |
| 10:01:02 | `used 0`, reset 11:01:02 (new real window) | unchanged, observation 2,022 s old | failed |
| 10:01:44 | `used 8`, reset 11:01:02 | `used 9`, reset 11:01:02, observation 0 s old | healthy |
| 10:02 to 10:23 | `used` 14 to 137 | tracks the header within 1 to 4 units | healthy |

- The hold cleared by itself at the first observer attempt after GitHub's real window reset, with no manual action. This matches the code reading above. The hold lasted from the last successful fetch at 09:28:10 UTC to 10:01:44 UTC, about 33.5 minutes.
- No sample in the 35 minutes showed the untouched-bucket signature while the real bucket was in use. The only `used 0` sample is the true start of the new window at 10:01:02.
- A second, short observer failure appeared at 10:13:49 UTC (observation 86 s old, past the 65 s limit) and was healthy again at 10:15:56. Its cause was not examined.
- Doctor at 10:24 UTC: `status healthy`, `recovery reason none recorded`, core `4863 remaining`, HTTP attempts 922,997 (208 more than during the hold).

### Other observations from the same window (VERIFIED)

- Core `used` rose from 323 to 466 between 09:47:51 and 09:51:51 UTC (143 units in 4 minutes, a rate of about 2,100 per hour) while every gh-glance pane was held for core. A `gh run watch <id> --exit-status --interval 30` process owned by another session was running on the same account; one gh-glance child (`gh api -i graphql`) appeared in 20 s of process sampling. The account has consumers other than gh-glance (VERIFIED); that `gh run watch` accounts for most of the 143 units is INFERRED, since no other `gh` process was seen in the sample.
- GraphQL was not held: `graphql 4951 remaining`, observer age 40 s at 09:46 UTC. On an Actions tab only core matters.
- `clock-recovery` entries are produced when the wall-clock gap between two liveness wakes exceeds `max(30 s, 3 x interval)` or goes backwards (16626-16630). Eleven of the last 25 journal entries carry that code between 09:14 and 09:29 UTC. What stalled the panes' timers during that period was not determined.

## How data is acquired today

### Transport (VERIFIED)

One `gh` subprocess per request (`execFile`, 30 s timeout, SIGKILL, 16 MiB buffer; 178, 186, 842-848). REST is `gh api -i <path> [--jq]` plus `If-None-Match` when a validator exists (1008-1014). GraphQL is `gh api -i graphql --input -` with no validator (1169-1171). A `304` arrives as a non-zero `gh` exit and is recovered from stdout (1017-1036). Every request takes one of three machine-wide HTTP permits with a 250 ms start gap (3344-3346) and a governor dispatch before the spawn (824-835). No persistent `gh` process or HTTP keep-alive exists (grep, 0 matches).

### Requests per tab

| Tab | Request | Conditional | Declared cost | When |
| --- | --- | --- | --- | --- |
| Actions | `actions/runs?exclude_pull_requests=true&per_page=60` with a `--jq` projection | yes | 1 core | every cycle (113, 1510-1525, 2206) |
| Actions | `actions/workflows?page=1&per_page=100` (catalog) | yes | 1 core | only for a run with no name and an unknown workflow id, at most every 15 min (118, 2017-2023, 2241-2258) |
| Actions detail | `actions/runs/{id}` then `.../attempts/{n}/jobs` | no | 1 + 1 core | user opens CI detail (1678-1683, 1929-1949) |
| Actions log | `actions/jobs/{id}/logs` over native HTTPS | no | 1 core | user opens a job log (1684-1689, 1813-1815) |
| Issues | `ISSUE_PAGE_QUERY`, 50 rows, `UPDATED_AT DESC`, with a `rateLimit` field | no | 2 points per page | 1 page by default; up to 3 pages when the cursor nears the loaded end (1070, 1080-1093, 2388, 2470-2530) |
| Pull Requests | `PULL_PAGE_QUERY`, same shape | no | 2 points per page | same (1095-1108) |
| Security | Dependabot, code scanning and secret scanning alerts, `per_page=100`, in parallel | yes | 1 core each | every cycle unless the source is in capability backoff (127-134, 2619-2672, 7388) |
| Security lanes | severity-filtered second requests | yes | 1 core each | only when a base page returns 100 rows (7261-7273, 7381) |

The reservation charged before a tab fetch is the declared maximum: Actions 1 core, Issues 2 points, Pull Requests 2 points, Security 6 core (2683-2691). A `304` settles at 0 and returns pacing credit (2068-2071, 6834-6916). The `--jq` projection runs inside `gh`, so the full REST payload is downloaded before projection; a code comment records 729,866 bytes reduced to 15,261 for 100 Dependabot alerts (2612-2622).

### Control requests

| Request | Endpoint | Conditional | Cost | Cadence |
| --- | --- | --- | --- | --- |
| `budget-core-observer` | `GET /user` | yes, validator in the ledger | 0 on `304`, 1 on `200` | 60 s, one owning pane per account (2749, 6350-6360, 11613-11635) |
| `graphql-observer` | `query{rateLimit{...}}` | no | 1 point | 60 s, one owning pane; also due at a core reset (1113, 6040-6060, 6374-6382) |
| GitHub status | `githubstatus.com/api/v2/summary.json` by `fetch` | yes | no GitHub API quota | 10 min per pane, not shared between panes (17342-17350, 17483-17571) |

Doctor reported 137,174 observer calls over the life of the store. The 2026-10-25 assessment recorded the GraphQL observer as the probable largest GraphQL consumer (its finding F2); `--doctor` still does not split GraphQL units by operation.

### Validators and caches

- Validators and bodies are kept per `tab\0path` in memory (`entityRef`) and travel inside the shared acquisition snapshot, so a new pane or a restart starts with them (2043-2104, 14680-14691, 21464-21467). A `304` with no usable cached body drops the validator (2072-2083).
- `r` stays conditional; `R` drops validators and clears capability backoff (16039-16055).
- Last-known-good rows are kept in `dashboard-cache.json` (32 targets, 60 rows per tab; 13922-13924) and shown labelled as cached or stale.

### Absent in the code (grep results, VERIFIED)

`x-poll-interval`, `Last-Modified` / `If-Modified-Since`, `since=`, the `/events` endpoints and the `/notifications` endpoint have no occurrence. No GraphQL document covers more than one repository; Issues and Pull Requests are separate documents by a recorded decision (1076-1079). `fs.watch` and `watchFile` have no occurrence. No terminal focus reporting (`?1004`) or `SIGCONT`/`SIGTSTP` handling exists.

## When each tab refreshes

All intervals come from `pollPolicyInterval` (15990-16011). The floor is `--refresh` / `GH_GLANCE_REFRESH`, default 5 s, range 2 to 3,600 s (77, 12209-12210).

| Tab state (floor 5 s) | `on-demand` (default) | `all` | `off` |
| --- | --- | --- | --- |
| Visible Actions, a run not completed | 5 s | 5 s | 5 s |
| Visible Actions, content changing | 5 s | 5 s | 5 s |
| Visible Actions, 2 or more unchanged results | 30 s | 30 s | 30 s |
| Visible Issues, Pull Requests, Security | one check when opened or on `r`, then none | 5 s, then 30 s (Security 60 s) | same as `all` |
| Hidden tab | none | 120 s (Security 300 s), one hidden tab per wake | none |

- "Unchanged" is equality of the comparison string (`pollResultTransition`, 17944-17974). A change, a tab switch or an Actions row that is not `completed` returns the tab to the floor (16008, 16020-16032).
- A new workflow run on a quiet visible Actions tab is seen at the next 30 s check; no faster path exists for a just-pushed commit (VERIFIED by the scheduling trace: no git, file or focus signal feeds the scheduler).
- The governor can stretch these intervals: `callsPerMs = spendable / (reset - now) / min(externalFactor, 4)`, with `spendable = remaining - ceil(0.2 x limit) - charged` (2743-2744, 2952, 3022-3023). All panes of the account queue on the same lane per resource (3316-3321).
- Stale label: `lastOk + max(30 s, 6 x granted cadence)` (18350-18373). `lastOk` advances on every successful check, including a `304`.

### Holds and their recovery

| Hold | Shown as | Recovery in code |
| --- | --- | --- |
| Budget reserve or reset | Paused or Watching with `reset Nm` / `next Nm` | automatic at the next grant or at reset + 2 s; `r`/`R` cannot spend the reserve |
| Lock contention | "Coordinating with your other panes" after 800 ms | automatic retry (250 ms lock wait) |
| Authorization failure | "GitHub authorization failed" | 30 s retry; `r`/`R` |
| Secondary throttle | "GitHub request limit" | server `Retry-After`, otherwise 1, 2, 4, 8, 15 min ladder (4149-4157) |
| Throttle paused after 5 | "Repeated GitHub request limit ... Press r" | `r`/`R`, or after the primary reset (4321-4327) |
| Observer failure: `corrupt`, `unwritable`, `capacity`, `accounting-overflow` | "Local coordination is ..." with doctor advice | sticky by design (16493-16495); see F1 for the one case observed live |
| Unknown reason | "Local coordination unavailable" | none specific (16564-16566) |

## How panes share the allowance and the data

- **Scope.** One ledger per GitHub user id per host per OS user per machine (`quotaKey`, 3798; `coordination-v2/quota-<key>.json`, 3836-3838). Nothing is shared across machines without the collector; spend from another machine or tool appears only as lower `remaining` and as the external factor.
- **No per-pane share.** One pool per resource, a 20% reserve, round-robin by lease within each priority, priorities manual 0, tab-switch 1, active 2, background 3 (2795-2801, 3094-3154). After 3 consecutive manual grants one active grant goes first (4388). Active CI changes only the poll interval, not the priority.
- **Same repository, same tab.** One pane is the producer; the others return `follower` before any intent is registered and adopt the published snapshot (15734-15771, 22069-22093). Followers read `acquisition.json` every 1 s.
- **Different repositories.** Separate records in the same store. They share the ledger, the three HTTP permits and the store limits (32 live targets, 128 subscriptions, 32 MiB; 14284-14288).
- **External consumers.** At each observer publication the governor computes `(used - baseline.used) / local units` and divides the pacing rate by it, capped at 4, when at least 5 local units are in the sample (2787, 2958-2977, 6305-6318). The reserve does not change.
- **Fail closed.** Missing, future-dated, stale or past-reset evidence yields `mode: "probe"` and no grant (2916-2923, 3244-3250).

## Local cost of a pane

### Memory (measured 2026-11-11, 09:46 UTC)

| Measurement | Value |
| --- | --- |
| Resident set size, 15 panes after 1 h 49 min | 209 to 267 MB each, mean 257 MB, total 3.86 GB (`ps`) |
| Physical footprint of one pane | 207 MB, peak 246 MB (`vmmap --summary`) |
| Bare Node 24 | 43 MB |
| Node 24 with `ink` and `react` imported, `NODE_ENV=production` | 89 MB RSS, 19 MB heap used |
| CPU time per pane in 1 h 49 min | 36 to 59 s |

`NODE_ENV` defaults to `production` as the first statement (23). No `--max-old-space-size`, `memoryUsage` or heap statistics call exists in the file. Retained application data is bounded: 60 Actions rows, 150 Issues and Pull Request rows, 100 alerts per lane, 512 entities of at most 1 MiB, a 500-entry event log, a 128-entry recovery journal (113, 122, 127, 14285-14286, 17028, 16490). The 24,001-line module is parsed and compiled in every pane. The split of the 257 MB between V8 heap, compiled code and native memory was not measured.

### Timers and file I/O (VERIFIED by trace)

| Loop | Period | I/O |
| --- | --- | --- |
| Acquisition engine | 1 s, never stops while subscribed | reads and parses `acquisition.json` each tick; locked transaction every 10 s (15235-15296) |
| Governor heartbeat | 20 s | lock, read, whole-file rewrite of the ledger (22711-22720, 5992-6000) |
| Liveness wake | min(refresh, 5 s) | none itself |
| Budget observers | 60 s (one owner per account) | ledger transaction |
| Spinner | 200 ms, only while a spinner shows | none |

Every state write serializes the whole JSON document to a temporary file and renames it; no `fsync` on these paths (5473-5478, 14999-15000). The lock wait is a blocking `Atomics.wait` polled every 5 ms for up to 250 ms (4397, 5701-5711). With 15 panes that is 15 parses of `acquisition.json` (62 KB at 09:46 UTC) per second and about 45 ledger rewrites per minute from heartbeats alone (INFERRED from the periods; not counted on disk). Ledger revision was 11,475,340.

### Disk (measured)

`~/Library/Application Support/gh-glance` holds 130 MB in 24,308 files. `dashboard-cache.json` is 1.09 MB (pretty-printed). `coordination-v2` holds the 14 KB ledger, the 62 KB store and its snapshot artifacts. Most of the 130 MB is under `installations/`, `candidates/`, `qualification/`, `smoke/`, `snapshots/` and `cutovers/` (dated 2026-09-29 to 2026-10-01, including five copies of `index.mjs` and `node_modules`), plus seven `rate-governor-v1-*.json` files dated August to October. Which code writes those directories was not traced.

## Opt-in modes beyond polling

| Mode | What changes | Setup documented in README |
| --- | --- | --- |
| Local collector (`--serve`, `--connect local`) | one process makes all GitHub requests; clients make none and receive pushed snapshot frames (10181, 9538-9565) | mode-0600 JSON config, a second terminal (README 463-489) |
| SSH collector (`--connect ssh:<alias>`) | same, across machines | SSH alias, remote `gh-glance` already serving (README 638-654) |
| Webhooks | a delivery invalidates the matching tab after a 1 s coalesce; covered quiet resources reconcile every 300 s instead of 30 or 60 s (7784-7785, 8669-8706, 9275-9280) | secret file, loopback listener, user-managed HTTPS reverse proxy, user-registered GitHub webhook (README 555-626) |
| GitHub App provider | collector authenticates as an installation with its own ledger (8136-8187) | user-created App, private key file, IDs and permissions (README 500-551) |

Webhook ingress and the App provider are constructed only inside the collector service (10058, 10239). No forwarding helper (`gh webhook forward`, smee, tunnel) exists in the code. The event never becomes rows; it triggers a governed fetch.

## Historical context

- ADR 0001 keeps the `gh` CLI data layer; ADR 0003 and 0004 define file-backed admission and quota identities; ADR 0005 defines the collector boundary.
- `docs/research/2026-10-25-gitcrawl-cache-ideas-assessment.md` compared the cache with Gitcrawl and Octopool and recommended no cache change. It held a conditional-REST path for Issues and Pull Requests (no `reviewDecision` in REST) and noted the unread `x-poll-interval` header.
- `docs/research/2026-10-31-astra-performance-caching-realtime-review.md` found 12 items, all fixed in v0.18.1 (#163 to #174). None concerns a backwards reset or the untouched-bucket reading.
- No test or document in `test/governor*.test.mjs`, `test/recovery.test.mjs` or `docs/` matched a search for a reset moving backwards within the observer path. This is a search result, not proof of absence.

## Unresolved questions

| Question | Practical impact |
| --- | --- |
| Which response delivered the untouched-bucket reading at 09:27:20 UTC, and how often GitHub returns one on `GET /user` | determines how often F1 can recur; the ledger does not keep raw headers |
| Why panes logged repeated `clock-recovery` between 09:14 and 09:29 UTC on a machine in use | may be related to F1's timing or independent |
| Current hourly spend per resource and per operation | lifetime totals exist; the counters did not advance during the hold, so no rate was measured |
| What makes up the 257 MB per pane beyond the 89 MB runtime baseline | needed before any memory work can be scoped |
| Whether `installations/`, `candidates/`, `qualification/` and the v1 governor files are still written or are leftovers | 100+ MB of the state directory |
| Cold-start and warm-start request counts before the first frame | traced only in part |

## Handoff

- Objective and scope: descriptive research only. No planning or implementation is authorized. The owner's message asked what could be improved; that evaluation belongs to `rpi-assess` or `rpi-plan` and is not part of this artifact.
- Baseline: `develop` at `24c67c577e987022cd8fc187adf95e9358fc78c0`, worktree `/Users/juan/code/gh-glance`, clean at session start. The only file added is this document.
- Findings: F1 (observer rejects a backwards reset and reports `corrupt`, holding all core requests), unresolved, cause in code VERIFIED, origin of the bad reading INFERRED. All other sections describe current behavior and carry no disposition.
- Checks run: `node index.mjs --version`, `node index.mjs --doctor` (twice, read-only), `ps`, `vmmap --summary` on one pane, `gh auth status`, `gh api -i user` (two `200`, 1 core unit each) and conditional `gh api -i user` samples (`304`, no cost), read-only copies of the ledger, recovery journal, registry and store. No test was run because no code changed.
- Evidence kept locally (not tracked): a copy of the four coordination files taken at 09:46 UTC and the sampler log, in the session scratchpad.
- Delegation: five read-only tracing assignments (request inventory, scheduling and staleness, multi-pane coordination, memory and local cost, collector and push modes). All five returned. Their stated gaps are folded into "Unresolved questions"; the dispatch functions at 6643-6725, acquisition `publish` at 15466-15690 and ADR texts were not re-read in this session.
- Live state: no gh-glance state file was modified. The panes were left running.
- Next action: owner decision on whether to assess or plan against F1 and the described behavior.
