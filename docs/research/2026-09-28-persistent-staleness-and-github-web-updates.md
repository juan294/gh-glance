# Persistent staleness in 0.15.2 and GitHub website updates

Date: 2026-09-28. Repository: `juan294/gh-glance`. Checkout: `/Users/juan/code/gh-glance`, branch `develop`, commit `4fe713a2e5bb9c4280840ac19e92ee0c4ffc3fea`.

## Question and answer

Why do the supplied 0.15.2 panes show Actions observations that are 98h52m and 61h18m old when GitHub's Actions website continues updating, and what existing behavior explains persistence after the previous repairs?

**A reproducible local admission deadlock currently blocks the inspected personal-account panes.** Their shared quota ledger has reached its 512-record reservation limit: 511 records remain `started`, and one is `completed`. Of the started records, 510 have no live lease. The scheduler cannot grant more requests, and the REST observer cannot reserve the slot it needs to refresh quota evidence. Ordinary lease expiration and successful later quota epochs do not retire those started records. This condition is independent of GitHub refusing requests. [Limit](../../index.mjs:3584), [retention](../../index.mjs:3923), [scheduler cap](../../index.mjs:4550), [observer cap](../../index.mjs:3276).

GitHub's website has a different acquisition path: the inspected Actions page subscribes to socket notifications and fetches affected web fragments after notifications. gh-glance polls the public API through its own identity, quota, acquisition, and publication gates. Same account does not establish identical request volume, endpoints, or quota accounting. The current public website behavior is verified below; the employer's private browser session was not inspected.

The local blocker explains **why the inspected panes cannot recover now**. It does not prove the trigger of every earlier stale interval or that the work EMU screenshot has the same cause. The gh-glance snapshot stopped advancing before the most recent ledger saturation evidence. No historical transition trace establishes when the ledger first filled or why each abandoned record failed settlement.

## Baseline and evidence provenance

- Research was read-only except this document and isolated temporary evidence/reproductions. No product changes, live ledger edits, pane restarts, remote mutations, or release actions were performed.
- Local `develop` was already two commits ahead of `origin/develop`; unrelated untracked `.agents/skills/macos-rules/` existed and was preserved.
- Installed `gh-glance --doctor` reports 0.15.2. Node is v24.21.0; GitHub CLI is 2.101.0. Installed and checkout `index.mjs` have identical SHA-256 `a05d47418387e9ce30eec2e9c8cf5310f240ccb7bcbe523bfb7d392350a68f5a`. `git diff v0.15.2 -- index.mjs package.json` is empty. This binds the inspected implementation to the release; no process-memory dump was taken.
- Six live processes were found using the installed executable. Their working directories were gh-glance, Chapa, Sutura, Cirujano, Spoken Letter, and Spoken Letter Alexa. The gh-glance process started September 28 at 12:43:37 CEST, shortly before Image #1. The current stale condition therefore also affects a newly started pane.
- Graphify was queried before source tracing. Its graph generation was September 24; exact findings were confirmed against source and isolated execution.
- Private local copies of the acquisition metadata and quota ledger are under `/var/folders/h7/qgj9lrs10qg4z_gnxjqbt44h0000gn/T/gh-glance-research-20260928-rio48sa7`. Raw machine inventories are not project artifacts. The report records the material sanitized observations so it remains useful after temporary files expire.

## Observed current state

Observations were taken around 11:00–11:08 UTC on September 28. The processes continued running during inspection, so separate reads are point-in-time observations, not an atomic multi-file transaction.

| Evidence | Observation | What it establishes |
| --- | --- | --- |
| Acquisition metadata | File actively changing; 24 subscriptions across six processes | The old machine-wide frozen acquisition-file symptom is absent |
| Read-only doctor | Metadata healthy; lock unobstructed; Actions queries held for coordination | Parsing and lock-path health do not establish source freshness |
| gh-glance Actions snapshot | Last success `2026-09-24T07:51:10.591Z`; next due `07:51:40.591Z` | Approximately matches Image #1's 98h52m at 10:44 UTC |
| Other five active Actions snapshots | Last success September 26, between 04:00 and 04:38 UTC | Several repositories are held on old source observations |
| Shared quota ledger | Exactly 512 reservations: 511 started, one completed | The maximum reservation count has been reached |
| Started records | Oldest September 8 at 12:35:51 UTC; 510 absent-owner leases, one live lease | The ledger contains accumulated historical work, not 511 observed live requests |
| Registry | Zero identity attempts | Registry attempt cleanup cannot account for these records through matching attempts |
| Stored core budget | Observed `2026-09-26T05:54:28.215Z`; remaining 4441; reset already past | Local REST evidence has stopped advancing |
| Stored GraphQL budget | Observed `2026-09-28T11:01:22.177Z`; remaining 4916 | The observer loop is still active for GraphQL |
| Core observer | Repeated waiting claims, including one old reservation with a live lease | Recovery attempts still occur |
| Direct `gh api user` | `juan294` | Identity of the research CLI API check |
| Direct Actions request at 11:08:07 UTC | HTTP 200; core remaining 2759/5000; latest run `36386785075`, updated `2026-09-28T06:31:32Z` | GitHub's API currently accepts this account's Actions request and supplies newer data |

An earlier `GET /rate_limit` overview reported core 5000/5000. The later Actions response headers are the authoritative evidence for that request; the overview is not used to claim an exact continuously available budget. Both checks contradict current primary exhaustion as a necessary explanation. GitHub documents response-header precedence and says secondary limits cannot be inspected through a remaining-counter endpoint. [GitHub rate-limit documentation](https://docs.github.com/en/rest/using-the-rest-api/rate-limits-for-the-rest-api).

## R1: Reservation retention makes the cap persistent

The governor removes expired leases and pending intents during normalization, but retains every `started` and `completed` reservation regardless of age. `reservationCost` also continues charging the residual cost of a started record without comparing its epoch to the current resource epoch. The captured started records carry 455 core and 162 GraphQL units of declared cost in total, separate from the record-count limit. [Normalization](../../index.mjs:3910), [reservation cost](../../index.mjs:2252).

At capacity, scheduling passes `maxGrants: 0`. New requests remain pending, and absence of a more specific denial becomes `budget-unknown` with no retry deadline. This applies even when the stored budget is fresh and has thousands of units available. [Grant limit](../../index.mjs:4518), [pending decision](../../index.mjs:5020).

The core observer has an additional dependency: `runGh` calls `startIdentityControl` before its HTTP request. That admission returns `identity-capacity` when the same ledger has 512 records. The request that could refresh the quota sample therefore cannot start. `readCoreBudget` catches the error and returns null; observer refresh converts the missing result to generic stale failure. [Transport admission](../../index.mjs:766), [capacity rejection](../../index.mjs:3257), [error handling](../../index.mjs:9793), [observer failure](../../index.mjs:5516).

Successful quota publication retires completed reservations covered by the observation. It does not retire started reservations. An actual reset of GitHub's hourly counter is therefore insufficient to clear this local state. [Completed selection](../../index.mjs:4836), [retirement](../../index.mjs:4878).

Recovery paths currently present:

- Normal shutdown removes scheduled reservations, retaining started work. [Release](../../index.mjs:5294).
- Ordinary restart reuses the cached credential-to-identity mapping and the same persisted ledger. [Cached identity](../../index.mjs:3184).
- There is age-based orphan cleanup inside identity-debt import, reached during a new identity bootstrap. Cached identity refresh bypasses that path. This documents an existing code path, not an instruction to delete authentication or ledger files. [Cleanup](../../index.mjs:3060), [bootstrap call](../../index.mjs:3116), [cached return](../../index.mjs:3205).
- Manual `r` and `R` can request a probe; neither bypasses reservation or observer gates. [Manual admission](../../index.mjs:17291), [transport start](../../index.mjs:17436).

## R2: How started records can outlive their work

The captured metadata proves accumulation but does not record the original reason for each missed completion. Current source contains concrete paths that retain started reservations:

1. Governor admission marks a reservation started before the acquisition claim is persisted as started. If that subsequent claim operation fails, the runtime deliberately retains the governor charge and calls pending cancellation. Cancellation only removes pending intents or scheduled reservations; it cannot cancel a started reservation. [Governor start](../../index.mjs:5128), [acquisition start](../../index.mjs:16840), [failure policy](../../index.mjs:16894), [cancellation](../../index.mjs:5064).
2. Settlement with budget observations rejects work whose owner lease has expired. A delayed or resumed process can therefore receive `stale` while its persisted reservation remains started. [Settlement guard](../../index.mjs:5167).
3. Process loss can leave a started record whose HTTP outcome is unknown. The source intentionally retains uncertain charges; normal normalization has no age/epoch retirement for that record class. [Uncertainty policy](../../index.mjs:5254), [retention](../../index.mjs:3923).

These are verified mechanisms, not proof that a specific one created all 511 records. Records already existed from September 8, so all debt cannot be attributed to the 0.15.2 changes.

The core observer waits for live-lease started work, but its drain is bounded at 30 seconds. One old reservation still attached to a live lease can repeatedly add that delay. The finite drain alone is not the permanent blocker; capacity rejection remains after draining. [Drain selection](../../index.mjs:4680), [bounded wait](../../index.mjs:5428).

## R3: Why the screen does not show the blocking condition

The scheduler can keep claiming/retrying acquisition work while no transport is admitted. Rotating claims and fresh store modification times are therefore insufficient evidence of live data. [Claim before admission](../../index.mjs:17302), [transport fence](../../index.mjs:17436).

When an observer handoff returns waiting, `publishControlStatus` can replace the active decision with `mode: waiting, probing: true`. That decision lacks the `coordinationError` flag required for the explanatory banner. The status formatter calls waiting “Watching”; source age then changes it to “Stale.” This is a source-confirmed route to the screenshot's unexplained stale footer. It does not establish the exact render branch at screenshot capture. [Waiting decision](../../index.mjs:16186), [formatter](../../index.mjs:15050), [notice condition](../../index.mjs:17908), [stale conversion](../../index.mjs:17989).

The age is based on successful source observations, including unchanged results, rather than the age of the newest workflow row. Thus old workflow timestamps alone would not cause this status; the retained source-success timestamp matters. [Successful unchanged observation](../../index.mjs:16440), [age calculation](../../index.mjs:17976).

## R4: Why GitHub's website differs

Sources below were retrieved September 28, 2026. The inspected frontend was the public GitHub.com Actions page for `cli/cli`, using its actual HTML and shipped JavaScript, without logging into a browser or capturing private work content.

| Aspect | GitHub Actions website observed | gh-glance 0.15.2 |
| --- | --- | --- |
| Change discovery | Socket topic subscriptions trigger `socket:message` events | Scheduled acquisition through `gh api` |
| Data refresh | Affected web fragments fetched after notification | Conditional public REST workflow-run list request |
| Batching | List advertises 10 seconds; individual rows 30 seconds | Active busy Actions floor 5 seconds; quiet active Actions 30 seconds after unchanged observations, subject to admission |
| Sharing | Shipped client prefers a SharedWorker for socket sessions | File-backed identity, quota and acquisition coordination |
| Local prerequisites | Does not read gh-glance's ledger | Valid identity, available reservation slot, fresh quota evidence, acquisition ownership and publication fence |

The Actions list has `js-socket-channel js-updatable-content`, a web-fragment `data-url` ending `/actions/workflow-runs?page=1`, and `data-batched="10000"`. Individual run elements have their own fragment URL and `data-batched="30000"`. The behaviors asset subscribes topics, handles socket messages, batches affected elements, and invokes content updates. Those intervals batch received notifications; they do not establish unconditional REST polling. Signed channel values were omitted from this report. [Actions HTML](https://github.com/cli/cli/actions), [GitHub behaviors asset `6b4787453c593932`](https://github.githubassets.com/assets/behaviors-6b4787453c593932.js).

gh-glance requests `repos/{owner}/{repo}/actions/runs?exclude_pull_requests=true&per_page=60`, with conditional validators when available, and can separately request the workflow catalog. Its local policy also reserves 20% of quota and denies requests when required evidence is unavailable. [REST arguments](../../index.mjs:1357), [conditional headers](../../index.mjs:890), [Actions acquisition](../../index.mjs:1598), [catalog fallback](../../index.mjs:1645), [cadence](../../README.md:766), [reserve and evidence](../../README.md:800).

GitHub documents aggregation of authenticated user API requests and some secondary limits shared with web UI actions. It does not document the socket/fragment traffic as consuming the same public REST bucket in the same way. The website is not established to be unlimited; the user's identical-quota premise is also not established. Authenticated conditional 304 responses do not consume primary REST quota, and gh-glance already implements validators. [Rate limits](https://docs.github.com/en/rest/using-the-rest-api/rate-limits-for-the-rest-api), [REST conditional request guidance](https://docs.github.com/en/rest/using-the-rest-api/best-practices-for-using-the-rest-api).

No supported public socket API usable with the existing `gh` credential was established by this research. The browser acquisition path is descriptive evidence, not a selected replacement design.

## R5: What 0.15.2 fixed and what validation proved

The release includes `1f641f8` (bounded multi-pane freshness repairs) and `3ee884a` (Security status precedence). Its changes include acquisition-lock recovery, bounded live claims, resource-specific observer readiness and recurring wake recovery. The previous repair was broader than a footer-only change. [Release record](../../CHANGELOG.md:10), [shared lock](../../index.mjs:13096), [resource readiness](../../index.mjs:14244), [recurring wake](../../index.mjs:17750).

Those repairs do not remove old started governor reservations. The acquisition claim's hard lifetime and the governor reservation's lifetime are separate state machines. A claim can expire and retry while its earlier started governor record remains. [Claim lifetime](../../index.mjs:12309), [reservation retention](../../index.mjs:3923).

The prior phase-5 report records a simulated mixed-tab hour, focused fault fixtures, and sequential candidate gates. It explicitly says those checks do not prove installed live panes and calls for separate 30-minute and 24-hour activation evidence. Its recorded source hash differs from the final source examined here; its results are historical candidate evidence. No completed 24-hour activation trace was established in this investigation. [Prior validation](../plans/2026-09-23-restore-multi-pane-freshness-phases/phase-5-validation.md:1), [activation boundary](../plans/2026-09-23-restore-multi-pane-freshness-phases/phase-5-validation.md:70).

Existing tests verify that requests wait when 511 completed records plus one scheduled reservation fill the 512-record ledger, and that a straddling started reservation survives a reset. Those cases do not demonstrate recovery after accumulated abandoned started reservations consume all slots. Existing stale-notice PTY tests inject acquisition/governor locks, rather than this observer-capacity condition. [Cap test](../../test/governor.test.mjs:2701), [reset test](../../test/governor.test.mjs:2078), [stale notice test](../../test/pty/status.test.mjs:743).

## Isolated verification performed

A temporary script imported real functions from the unchanged checkout, used an injected clock and synthetic identity response, and copied the captured ledger into its own private directory. It made no GitHub request and did not write to live coordination files. The parent reran it and inspected the result.

| Experiment | Result |
| --- | --- |
| Core observer admission against captured 512-record ledger | `identity-capacity` |
| Advance clock 24 hours | 512 records retained; 511 started; zero remaining leases; same denial |
| Register a new manual Actions intent | Pending, `budget-unknown`, no retry deadline |
| Directly inject three successful new core epochs | All 511 started records survive; only the completed record is retired |
| Restore count to 512 with fresh 4999/5000 core budget | Manual Actions intent still pending with `budget-unknown` |

Reproduction script: `/tmp/gh-glance-observer-repro.mjs`. Parent replay directory: `/var/folders/h7/qgj9lrs10qg4z_gnxjqbt44h0000gn/T/gh-glance-observer-repro-HbU3lm`. Injected successful publication bypasses the blocked observer solely to test retirement behavior; it is not evidence that the live observer recovered.

Six existing targeted tests passed on the current source: recurring liveness rejection, heartbeat rearming, overlapping reset wakes, overdue polling retry, follower reinspection and the hard unstarted-claim lifetime. Command: `node --test --test-name-pattern='recurring liveness wake|heartbeat wake rearms|overlapping reset|persistently overdue|healthy-resource follower|heartbeats cannot extend' test/governor.test.mjs test/acquisition.test.mjs`. No product code changed; the full implementation/release gates were not rerun or claimed.

## Remaining uncertainty and durable handoff

| ID | Disposition and boundary |
| --- | --- |
| R1 | Confirmed current personal-host blocker; isolated causal reproduction complete |
| R2 | Retention and missed-settlement paths confirmed; historical trigger of each abandoned record unknown |
| R3 | Missing observer/capacity diagnosis path confirmed in source; exact screenshot render branch not captured |
| R4 | Public website socket/fragment path verified; internal quota accounting and employer website deployment unverified |
| R5 | Shipped fixes and relevant test boundaries verified; completed 24-hour production freshness evidence not established |

Image #2 establishes work-repository staleness and version 0.15.2, but it does not expose host, CLI identity, quota ledger or cause. EMU can use GitHub.com or GHE.com; EMU alone establishes neither a particular API host nor a higher token allowance. The private work environment was not available among the six inspected panes. Its causal diagnosis remains open. [EMU documentation](https://docs.github.com/en/enterprise-cloud@latest/admin/concepts/identity-and-access-management/enterprise-managed-users), [data-residency hosts](https://docs.github.com/en/enterprise-cloud@latest/admin/data-residency/about-github-enterprise-cloud-with-data-residency).

The inspected gh-glance snapshot's last successful source observation is September 24, while the inspected ledger contains subsequent activity through September 26. The present cap explains persistent failure today, but does not establish the historical trigger of that older snapshot. A current state snapshot cannot reconstruct the missing admission and settlement history.

Authorized scope was research. Three bounded read-only assignments covered scheduling/UI, website transport, and observer/ledger recovery; all returned results, and the parent checked the source and replayed the causal reproduction. This document is the curated local output. Baseline/current product commit remains `4fe713a2e5bb9c4280840ac19e92ee0c4ffc3fea`; no implementation, recovery mutation, push or release is included. A subsequent planning phase can use these findings after revalidating source identity and live state. Research stops here without choosing a future architecture.
