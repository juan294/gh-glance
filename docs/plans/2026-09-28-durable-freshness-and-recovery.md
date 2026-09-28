# Durable freshness and recovery

Date: 2026-09-28. Status: implementation specification; no implementation or activation performed.

## Objective and completion boundary

Run ordinary `gh-glance` with the existing `gh` login and keep Actions current across multiple repositories, long sessions, sleep, restarts and quota resets. Automatically recover from the accumulated state reproduced on 0.15.2. A cached screen with a functioning timer is not success.

The contract is **no indefinite internal admission deadlock, bounded recovery when service becomes available, and an actionable explanation whenever fresh data cannot be obtained**. Provider outages, authentication failures and actual quota restrictions can still prevent fresh data. They must remain visible and must not be confused with local recovery failures.

Planning does not authorize implementation, live-state migration, restarting existing panes, installation, pushes or publication. Implementation phases stop for acceptance unless continuation is explicitly authorized. The cross-environment issue remains open until Phase 4 proves the exact installed candidate on both personal GitHub and work EMU. An unavailable environment is `unmeasured`, not a waived gate.

## Evidence and baseline

- Integration checkout: `/Users/juan/code/gh-glance`, `develop`, base `d4edd744c010a2feddb29e2c6c34f1047a5b4b05`. Product remains 0.15.2; source SHA-256 `a05d47418387e9ce30eec2e9c8cf5310f240ccb7bcbe523bfb7d392350a68f5a`. Unrelated `.agents/skills/macos-rules/` remains untracked and outside scope.
- [Accepted research](../research/2026-09-28-persistent-staleness-and-github-web-updates.md:7) reproduces a 512-record quota ledger, including 511 started records, that prevents both data admission and the core observer. Advancing time and publishing later epochs do not remove the started records. Direct Actions REST returned newer data successfully.
- Started records survive normalization indefinitely ([index.mjs:3923](../../index.mjs:3923)); the scheduler and observer share the same capacity limit ([index.mjs:4550](../../index.mjs:4550), [index.mjs:3276](../../index.mjs:3276)). Settlement rejects expired leases ([index.mjs:5178](../../index.mjs:5178)), and several callers ignore its result.
- The earlier plan already chose default standalone operation and optional event infrastructure ([2026-09-05 plan:10](2026-09-05-multi-instance-efficiency.md:10)). Webhook invalidations use normal governed acquisition ([phase 10:23](2026-09-05-multi-instance-efficiency-phases/phase-10.md:23)); they cannot resolve this governor deadlock. The website distinction is established context, not a new remedy.
- The previous live gate was separate from offline validation ([prior validation:70](2026-09-23-restore-multi-pane-freshness-phases/phase-5-validation.md:70)). This plan makes its completion a requirement for resolving the user incident.
- Work EMU has screenshot evidence only. Its actual host, authentication class and causal failure must be captured in Phase 4; no common cause is assumed.

Source references describe this baseline. Rebase references and invalidate affected evidence when implementation changes them.

## Options and selected decisions

| Option | Trade-off | Decision |
| --- | --- | --- |
| Delete stale ledger records or reset local state | Temporarily frees slots but loses uncertain charges and can recur | Rejected |
| Require collector/webhooks/App, or reuse private browser sockets | Adds setup; current optional modes still share the governor; no supported public socket contract established | Rejected as a prerequisite |
| Repair receipt lifetime, settlement and observer independence in standalone mode | Changes one shared protocol and all its consumers; retains existing login and launch flow | Selected |

Keep `gh` as the default data layer, conditional REST, shared acquisition, the 20% reserve, resource isolation, optional providers, single-file product structure and Node's built-in test runner. No new service, mandatory flags or routine manual refresh. Amend ADR 0003 and ADR 0004 only where the new receipt lifecycle supersedes their current retention details; preserve their accounting, identity and publication safety properties. ADR 0005's provider boundary remains intact.

### D1. Separate receipt slots from unresolved charge

Introduce governor protocol v7 at the existing canonical quota path. Bound detailed data receipts at 512, control receipts at one per resource, and tracked unresolved owner-generation groups at 128 total. Fixed aggregate debt fields per resource store remaining worst-case units and counts; overflow owners merge into an explicitly unknown-ownership group. Compaction seals an owner generation, fences all further dispatch in that generation, and records its residual units/count with owner process identity, boot identity and an unknown-child flag. New dispatch uses a newer generation. The owner can acknowledge a sealed generation only after every child and already-authorized start in it has ended; a single late receipt completion cannot acknowledge the group. Acknowledgements bind the sealed group nonce and cannot cover later debt. Known groups can become quiescent without reboot; overflow/unknown-child groups require verified process or boot evidence. No unbounded receipt tombstone list. Numeric overflow fails closed with an explicit cause; never clamp charge downward.

Compaction atomically moves the **residual** charge into debt before removing an expired or abandoned detailed receipt. It does not refund quota. Include aggregate debt and outstanding control costs in every admission calculation. With the captured 512-record shape, residual totals are core 456 and GraphQL 162, including the completed record. The sanitized fixture must independently recompute those totals; the research's core 455 refers only to started records. A fresh core observation of 5,000, less the 1,000 reserve and 456 retained units, leaves 3,544 units before any new requests. Recovery therefore does not require deleting uncertain costs.

### D2. Fence every transport and finish every admission

Each v7 receipt binds original scope, owner nonce, lease identity, operation allowance, dispatch sequence and an absolute operation deadline. Use the existing maximum operation envelope, currently 199 seconds ([index.mjs:12314](../../index.mjs:12314)); heartbeats cannot extend it. Each subprocess start validates the exact receipt, including nested pages/catalog requests. Persist `issued` before spawn. Persist `terminal` only after actual subprocess completion/close. A crash in the write-to-spawn interval remains uncertain. Merely setting a kill flag or reaching a timeout does not prove transport termination.

The existing budget-only start check ([index.mjs:684](../../index.mjs:684)) is insufficient. A missing, compacted, replaced or expired receipt must prevent further dispatch even after account changes, sleep or a new budget epoch. A process paused after authorization may still issue its already-authorized child; its retained uncertain charge covers that possibility. No debt is reconciled until this remaining dispatch authority is quiescent.

Use one idempotent terminalization interface for never-issued, measured, rejected and uncertain outcomes. Its result distinguishes `settled`, `retryable`, `compacted` and `blocked`; callers must handle each. A never-issued receipt releases its unused charge. An issued uncertain outcome retains worst-case debt. Settle using the immutable original receipt capability even after lease expiry or account switch; that capability does not permit publishing rows or expanding quota authority into the new account.

Retry failed completion writes without repeating HTTP. Bound retained completion evidence to the 512 outstanding detailed receipts per scope and prohibit additional dispatch by an owner that cannot retain its outstanding evidence. On process loss, persisted issued records supply conservative recovery; no durable extra queue is required. Retry at 1, 2, 4 and then 5 seconds with bounded jitter, and settle within 15 seconds after ordinary writable storage returns in the short-transport fixtures. A compacted receipt cannot be refunded again by a late completion.

### D3. Observer recovery must survive full data capacity

Allocate resource observer receipts separately from detailed data receipts. Replacing an uncertain expired control receipt first transfers its residual debt atomically. Preserve registry-to-quota lock ordering, one claimed observer per resource, shared HTTP serialization and all actual provider holds. Preserve existing exceptional bootstrap/recovery allowances of three attempts per credential/resource and twelve per host per rolling 15 minutes; these are not a new cap on normal healthy observers. Restarts cannot replenish them.

Observer publication may cover quiescent debt only when the claimed observation starts after its persisted quiescence barrier. Separate unresolved and quiescent aggregate buckets. At claim, snapshot exact quiescent units, count, maximum barrier and generation, bound to scope/resource/claim nonce. On matching publication, atomically subtract that captured amount exactly once, preserving postclaim additions; a changed current revision must neither erase new debt nor indefinitely prevent retirement of the captured portion. Keep the one outstanding snapshot inside the resource control slot, including across aggregation/overflow. Claim replacement cannot reuse its retirement authority. A reset or fresh response alone does not prove that an old suspended process cannot issue later.

Quiescence means terminal child completion and no further dispatch authority, or verified death of all associated transports and owners. Parent death alone is insufficient. Persist the coordination host's platform boot identity and process birth identity in v7 ownership records; an SSH client's boot is not proof about the collector host; unknown v6 ownership conservatively attaches to the migration boot. A verified subsequent boot can establish quiescence of that old boot. If the platform cannot supply a trustworthy boot identity, retain uncertainty and disclose it. Clock movement is never a substitute for this proof.

### D4. Upgrade existing state automatically and conservatively

Read v6 without pruning away evidence, atomically convert its receipts and retain cooldowns, budgets, provenance, epochs and registry allowances. Compact legacy started receipts into bounded debt, including live legacy ownership; only proven never-issued scheduled work may be released. Version fencing prevents an older binary from writing v7 ([index.mjs:3880](../../index.mjs:3880)); a process already past its last fence remains covered by retained debt. Test concurrent v6/v7 writers and kill points around atomic replacement.

Do not create a new empty quota namespace to bypass old debt. Do not erase the registry or credentials. Eliminate bootstrap's broad age-based deletion of unmatched receipts ([index.mjs:3066](../../index.mjs:3066)); use the same lifecycle accounting in registry import, attempt retirement and ordinary cached-identity recovery. Keep one private pre-migration backup for diagnosis; never roll back the live ledger to that stale budget. A rollback binary must understand v7 or remain safely blocked; simply reinstalling 0.15.2 is not a recovery plan.

Unknown legacy debt may remain disclosed while normal work proceeds. If it alone exhausts conservative capacity, expose the exact retained amount and the verified recovery boundary. Closing known old sessions can help only when child quiescence is proven. Unknown child ownership requires a verified new boot; the UI must say so rather than repeatedly recommending `r`, login or deletion. This exceptional legacy boundary is not required for the captured incident to resume.

### D5. Acquisition uncertainty cannot create another publication cap

The acquisition store separately caps uncertain receipts at 1,024 ([index.mjs:9951](../../index.mjs:9951)); publication and failure settlement can reject at that cap ([13541](../../index.mjs:13541), [13629](../../index.mjs:13629)). Its current reconciliation accepts epoch/timestamp evidence alone ([13924](../../index.mjs:13924)). Change this together with quota v7, not as a later diagnostic cleanup.

Make acquisition store v2 a consumer of quota reconciliation, not a second authority for outstanding charges. Remove per-request uncertainty retention as a precondition for claim start, failure settlement or acquisition publication. Preserve request counters and data/claim fencing, but replace the growing uncertainty receipt list with bounded projections of authoritative v7 quota-scope totals/revisions. At most 128 active scope projections; eviction marks an inactive projection unavailable rather than zero. Report scope-wide outstanding quota separately from per-query request metrics so shared scopes are not double counted. A stale/missing projection is labeled stale/unavailable and refreshed automatically; it does not block valid source publication or permit HTTP outside the governor.

Migrate v1 uncertainty to a fixed diagnostic legacy summary, retain cached snapshots/counters, and fence old producer claims/version writers. Unmapped legacy diagnostic units remain explicitly unverified; never add them to v7 debt a second time or treat their disappearance as forgiveness. Matching v7 evidence replaces the corresponding projection rather than incrementing it. Read quota evidence outside the acquisition lock and apply only monotonic matching-scope revisions; no network or reverse lock ordering. Replace epoch-only reconciliation and every claim-associated uncertainty-release caller with this projection contract. Diagnostic synchronization failure must not turn successful source publication into a capacity failure.

### D6. Source freshness and visible progress are distinct

Only a validated successful source observation, including a valid conditional 304, advances freshness. Partial Security data, lease heartbeats, cache adoption, observer samples and retry scheduling do not manufacture source success. Preserve the original cause through generic observer waiting ([index.mjs:16186](../../index.mjs:16186)). Within the existing two-second sustained notice threshold, show affected resource, cause, cached-data age, next attempt/hold deadline and any required action. Never show only `Stale` indefinitely.

Add bounded redacted diagnostics: current recovery reason, last failed transition, receipt/debt totals, oldest unresolved age, observer age, next retry and terminalization backlog. Keep local-only details in `--doctor`; ordinary UI uses plain language. Read-only doctor may inspect cached identity/ledger without `--probe`, but performs no credential/API probe or state write. If it cannot safely identify the scope, say which evidence is unavailable.

## Behavioral acceptance contract

These are implementation oracles, not results already obtained. Test external IO/clock at the boundary; execute real production coordinator, transport and runtime code.

| ID | Required behavior and evidence |
| --- | --- |
| F01 | Ordinary packed CLI boots against sanitized aged v6 511-started/one-completed state, automatically observes budget and renders a newer Actions run without `r`, login, state deletion or a daemon; short-response fixture deadline 60 seconds |
| F02 | Compaction preserves exact residual units, keeps 512/2/128 limits and bounded serialized storage; neither 512 quota records nor 1,024 legacy acquisition receipts blocks observer or subsequent publication solely for receipt capacity |
| F03 | Pause before dispatch, after issued persistence and during child execution; resume after lease expiry/reset; no unauthorized second request or stale publication, and every possible issued request remains charged |
| F04 | Fail acquisition-start persistence and completion writes; zero HTTP for proven unissued work; exactly one HTTP for completed work; eventual single settlement within 15 seconds of writable storage returning |
| F05 | Kill/restart, change identity/repo and expire leases; old settlement stays in old scope and cannot publish into a new generation; unknown outcomes remain conservatively bounded |
| F06 | Observer-before-quiescence cannot retire debt; matching publication retires its captured quiescent amount while retaining additions; two same-owner receipts with one paused remain charged, and replayed group acknowledgement cannot retire newer debt; late completion, registry cleanup and repeated migration cannot double refund |
| F07 | Core failure leaves healthy GraphQL work live and vice versa; actual provider backoff is respected; retry after availability returns publishes within 60 seconds in short-response fixtures |
| F08 | Every row of the stuck-state table has both safety and recovery/disclosure coverage in normal/narrow/NO_COLOR/screen-reader modes |
| F09 | Simulated 72 hours, at least 10,000 admitted operations, at least 1,000 faulted/interrupted operations, many resets and process churn; state stays bounded and all oracle charges reconcile; include 1/6/10 panes, duplicate/distinct repositories and mixed tabs |
| F10 | Independent freshness deadline is expected cadence plus `max(2 × cadence, 15 seconds)` overdue allowance; first active observation/recovery deadline is 60 seconds in healthy short-response scenarios; production `nextDueAt` cannot expand the oracle |
| F11 | Full-duration monitor fails on early stop, missing cohort members, unexplained sampling gaps, regressing/future timestamps, zero new source observations or concealed internal holds; externally evidenced outage time is reported separately |
| F12 | Separate installed-candidate personal and EMU 30-minute then 24-hour evidence, including quota resets and observed workflow transitions, exact source hash and rendered-payload comparison; required to resolve the incident |

For F09/F10 choose feasible declared demand: 5,000-unit fixtures with six mixed repositories and conditional unchanged responses; 15,000-unit fixtures for ten continuously changing repositories, plus oversubscribed fixtures that must show actual budget pacing. No claim that ten distinct busy repositories can all consume one 200 response every five seconds under a 5,000-unit quota. Provider-imposed delays remain visible. Healthy recovery bounds assume no existing provider hold, responsive API, available conservative capacity and ordinary storage; tests explicitly declare these preconditions. Local capacity, observer bugs and coordination failures are never excluded as provider outages.

## Stuck states and recovery

All affected panes retain cached rows and honest age. Diagnostic wording below is the required meaning, not a rigid string snapshot.

| State | What the user sees | End or visible action | Proof |
| --- | --- | --- | --- |
| Full/aged quota or acquisition receipt store | Recovering local request queue | Automatic migration/compaction, independent observer and acquisition publication; diagnostics never create a second capacity gate | F01/F02 |
| Temporary lock or settlement write contention | Saving request result; retry time | Bounded automatic retry; never repeat HTTP | F04 |
| Expired owner, interrupted transport, suspension | Recovering interrupted request | Fence future dispatch, retain debt, obtain fresh source when capacity allows | F03/F05 |
| Unknown legacy debt with available capacity | Optional concise recovery notice; doctor gives reserved units | Continue refreshing; retire only with valid quiescence evidence | F01/F06 |
| Unknown legacy debt consumes all capacity | Older requests still reserve N units; closing known sessions or verified restart boundary explained | Verify associated children ended; for unidentifiable legacy children explicitly explain system restart and recheck boot identity | F06/F08 |
| Observer unavailable or exceptional allowance exhausted | Budget check failed for core/GraphQL; actual next attempt time | Retry at finite persisted deadline, after rolling allowance renews; healthy resource continues | F07/F08 |
| Primary quota / local reserve pacing | GitHub quota or local reserve pacing, identified separately; next grant/reset | Automatically reobserve at permitted deadline | F07/F10 |
| Secondary hold / repeated-secondary circuit | GitHub request limit; retry time, or explicit refresh action when policy requires it | Preserve Retry-After; disclose and exercise existing manual/reset circuit recovery | F07/F08 |
| Network/API outage | Connection/service failure, retry time | Bounded backoff and automatic recovery | F07/F08 |
| Authentication/permission/provider mismatch | Affected host and supported login/permission action | Revalidate after existing gh auth flow; continue unrelated eligible work | F05/F08 |
| Corrupt/unwritable ledger, disk full, unsafe permissions, numeric overflow | Local coordination cannot be read/written; doctor identifies path and exact reason | Retry after storage/permission repair; corruption/overflow cannot be reset safely, so show explicit support/diagnostic action and retain evidence | F08 |
| Mixed protocol versions / unsafe downgrade | Older session/version cannot share current coordination; restart using current binary | New binary recovers; legacy writer stays fenced; old uncertain charge retained | F02/F08 |
| Collector/SSH disconnected or App authentication unavailable | Existing mode and provider cause; retry/action | Restore selected connection/auth; never silently fall back to separate GitHub requests | F07/F08 |
| Incomplete Security or inaccessible tab | Data incomplete / permission cause | Existing endpoint retry or permission action; never claim complete source success | F08/F10 |
| Clock rollback / sleep or missing monitor coverage | Recovery in UI; explicit coverage gap in evidence | Fence stale generations and reobserve; restart uninterrupted measurement when required | F03/F11 |
| Monitor interrupted / EMU unavailable / no real transitions | Acceptance incomplete with named missing evidence | Complete a new valid window or obtain missing environment/transition evidence; no success inference | F11/F12 |

## Consumer sweep

Searches run on the baseline (use `-a` for source containing embedded NUL bytes):

```sh
rg -an 'reservations\[|delete .*reservations|startIdentityControl\(|settleIdentityControl\(|normalizeGovernorState\(|writeGovernorState\(|startReservation\(|completeReservation\(|settleReservationWithBudgetObservations\(' index.mjs
rg -an 'runAdmitted|requestIdentityStorage.run|refreshSharedBudget\(|readIntentDecision\(' index.mjs
rg -l 'reservations|reservationId|GOVERNOR_STATE_VERSION|writeGovernorState' test scripts
rg -an 'uncertainReceipts|normalizeAcquisitionReceipt|addAcquisitionReceipt|removeAcquisitionReceipt|reconcileUncertainty|releaseAcquisitionUncertainty|releaseKnownAcquisitionUncertainty|ACQUISITION_STORE_VERSION' index.mjs
rg -l 'uncertainReceipts|uncertainCoreUnits|reconcileUncertainty|ACQUISITION_STORE_VERSION' test scripts
```

| Caller/writer or contract | Disposition |
| --- | --- |
| Transport preflight/control settlement [index.mjs:684](../../index.mjs:684), [747](../../index.mjs:747), [824](../../index.mjs:824) | Phase 1 exact receipt binding, issued/terminal evidence |
| Registry attempt cleanup/import, bootstrap/cache, control receipts [index.mjs:2863](../../index.mjs:2863), [3043](../../index.mjs:3043), [3184](../../index.mjs:3184), [3257](../../index.mjs:3257), [3290](../../index.mjs:3290) | Phase 1 unified accounting; preserve allowances |
| Cost/schema/read/migrate/write/mutate [index.mjs:2252](../../index.mjs:2252), [3697](../../index.mjs:3697), [3807](../../index.mjs:3807), [3880](../../index.mjs:3880), [3948](../../index.mjs:3948), [4038](../../index.mjs:4038), [4055](../../index.mjs:4055), [4092](../../index.mjs:4092), [4117](../../index.mjs:4117), [4429](../../index.mjs:4429) | Phase 1 v7 and safe migration |
| Scheduler/lease/probe/intent/start/settlement/release [index.mjs:4518](../../index.mjs:4518), [4587](../../index.mjs:4587), [4608](../../index.mjs:4608), [4646](../../index.mjs:4646), [4788](../../index.mjs:4788), [4980](../../index.mjs:4980), [5032](../../index.mjs:5032), [5064](../../index.mjs:5064), [5085](../../index.mjs:5085), [5134](../../index.mjs:5134), [5167](../../index.mjs:5167), [5294](../../index.mjs:5294) | Phase 1 every mutation and admission includes debt |
| App ledger initialization [index.mjs:6589](../../index.mjs:6589); App budget reader [8491](../../index.mjs:8491); collector acquisition [8620](../../index.mjs:8620), [8626](../../index.mjs:8626), [8639](../../index.mjs:8639), [8649](../../index.mjs:8649), [8680](../../index.mjs:8680) | Phase 1 shared protocol and completion handling; App authentication JSON writer [6631](../../index.mjs:6631) excluded from quota-schema migration because it stores a separate auth schema |
| Doctor admitted probes [index.mjs:10079](../../index.mjs:10079), [10106](../../index.mjs:10106), [10108](../../index.mjs:10108); nested operations [14388](../../index.mjs:14388), [14748](../../index.mjs:14748) | Phase 1 settlement/binding; Phase 2 read-only local diagnostics |
| Failure context/catalog/later pages [index.mjs:1294](../../index.mjs:1294), [1645](../../index.mjs:1645), [1874](../../index.mjs:1874); resource readers [9793](../../index.mjs:9793), [9819](../../index.mjs:9819) | Phase 1 nested receipts and structured causes; no bypass |
| Standalone commit success/error [index.mjs:16323](../../index.mjs:16323), [16477](../../index.mjs:16477), acquisition start [16840](../../index.mjs:16840), admission/resume [17378](../../index.mjs:17378), [17436](../../index.mjs:17436), [17539](../../index.mjs:17539), control/shutdown [17667](../../index.mjs:17667), [17826](../../index.mjs:17826) | Phase 1 immutable settlement and bounded retry; Phase 2 cause propagation |
| Acquisition uncertain result producers/forwarders [index.mjs:1641](../../index.mjs:1641), [1899](../../index.mjs:1899), [8406](../../index.mjs:8406), [8438](../../index.mjs:8438), [8922](../../index.mjs:8922), [8940](../../index.mjs:8940), [8963](../../index.mjs:8963), [14788](../../index.mjs:14788), [16355](../../index.mjs:16355), [16392](../../index.mjs:16392), [16407](../../index.mjs:16407), [16803](../../index.mjs:16803) | Phase 1 remove duplicate uncertainty authority from success/error transport envelopes; preserve actual request metrics and v7 settlement outcomes |
| Acquisition state construction/receipt helpers/invalid publication [index.mjs:12337](../../index.mjs:12337), [12368](../../index.mjs:12368), [12383](../../index.mjs:12383), [12394](../../index.mjs:12394), [12493](../../index.mjs:12493), normalizer [12892](../../index.mjs:12892), mark-started capacity [13710](../../index.mjs:13710), exported version [18831](../../index.mjs:18831) | Phase 1 v2 migration and projection contract; uncertainty diagnostic capacity must not block claim start either |
| Acquisition schema/cap [index.mjs:9950](../../index.mjs:9950), receipt release [12418](../../index.mjs:12418), [12431](../../index.mjs:12431), publication/failure [13541](../../index.mjs:13541), [13629](../../index.mjs:13629), reconciliation [13924](../../index.mjs:13924), evidence construction [16263](../../index.mjs:16263), doctor metrics [10205](../../index.mjs:10205) | Phase 1 acquisition v2 migration and bounded authoritative projections; Phase 2 truthful outstanding metrics; Phase 3 preseeded 1,024-receipt recovery |
| Status/doctor/uncertainty receipts [index.mjs:14560](../../index.mjs:14560), [15000](../../index.mjs:15000), [16186](../../index.mjs:16186), [17908](../../index.mjs:17908), [17976](../../index.mjs:17976) | Phases 1–2 consume new receipt outcomes and diagnostics |
| `test/{governor,identity,identity-transport,acquisition,scheduling-policy,unit,graphql,collector,doctor,pagination,app-auth,webhooks,ssh-transport}.test.mjs` | Phase 1 contract fixtures and regression tests; Phase 2 status/diagnostic assertions |
| `test/pty/{governor,identity-migration,identity-switch,throttle,shared-acquisition,status,collector,remote-collector}.test.mjs`; `test/pty/fixtures/known-identity.mjs` | Phase 1 shared schema and process fences; Phase 2 disclosure; Phase 3 sustained CLI cases |
| `test/fixtures/{governor-worker,acquisition-worker}.mjs`; `scripts/measure-efficiency.mjs:932` | Phases 1/3 worker protocol and inspection; preserve real state transitions |
| `test/fixtures/legacy-governor-v2.json` | Intentionally retain historic bytes; add v6 fixture, do not silently rewrite legacy migration input |
| `scripts/freshness-monitor.mjs:159`, `:218`, `:252`, `:326`; `scripts/measure-efficiency.mjs:93`; `test/{efficiency,freshness-monitor}.test.mjs` | Phase 3 independent oracles, duration and exclusion rules |

The file groups above are explicit edit/review scope, not claims that every file needs a diff. Implementation must rerun the sweep, classify any new consumer and record excluded unchanged consumers with evidence.

## Sequential phases and verification

1. [Phase 1: bounded accounting and complete runtime recovery](2026-09-28-durable-freshness-and-recovery-phases/phase-1.md). Schema, transport fencing and every settlement consumer form one atomic phase; enabling compaction before fencing is prohibited.
2. [Phase 2: visible causes and usable diagnostics](2026-09-28-durable-freshness-and-recovery-phases/phase-2.md).
3. [Phase 3: accumulated-state and sustained acceptance](2026-09-28-durable-freshness-and-recovery-phases/phase-3.md).
4. [Phase 4: exact candidate activation and personal/EMU proof](2026-09-28-durable-freshness-and-recovery-phases/phase-4.md).

No implementation units are batch-eligible: phases share `index.mjs`, fixture protocols or prior evidence. Independent read-only review can proceed in parallel with disjoint documentation inspection. One integration owner; local isolated worktrees; no working-branch PRs or pushes.

Every implementation phase uses red → green → independent review → repair → simplify → sequential verification. Required local gates: `npm run lint`, `node --check index.mjs`, `npm test`, `npm run test:efficiency`, `npm run test:pty`. Run all, retain every failure, repair and rerun invalidated gates. Report exact tested SHA/tree and commands; do not cite this plan as test evidence. No typecheck/build step is invented. Phase 4 reuses gates only for unchanged inputs and adds package/live evidence.

## Durable handoff and planning review

Accepted design decisions are D1–D6; implementation entry is Phase 1 after plan acceptance. Research R1–R3 are covered by Phases 1–3. R4's website comparison is contextual, with no private-browser transport selected. R5's verification gap is covered by Phases 3–4. Historical causes of individual abandoned records remain unknown; tests cover all source-confirmed paths without claiming a reconstructed history. EMU causal diagnosis and live qualification remain required Phase 4 evidence, not an unresolved architectural choice.

Two read-only planning assignments examined accounting/migration and runtime/acceptance; both returned evidence and the consumer sweep above. Independent review identified three specification gaps: P1 owner-generation quiescence, P2 immutable observer debt snapshots, and P3 acquisition receipt-cap recovery. The specification now includes sealed groups, exact snapshot subtraction and acquisition v2 projections; both reviewers reread the amendments and reported no remaining blockers in their assigned scopes. P1, P2 and P3 are resolved in the specification; correctness remains subject to implementation evidence. Product code and installed runtime are unchanged. No fresh implementation test pass is claimed.

On resume, inspect actual branch/status/HEAD and source hash, read this parent and the next phase completely, compare with the research baseline and preserve unrelated work. Each phase validation artifact must record base/current SHA, worktree, changes, finding dispositions, exact checks, remaining gates and external authorization. Any new technical finding that invalidates D1–D6 requires a documented plan adjustment before dependent work.

Planning-only verification: all five document links/phase references and pseudocode block lengths were checked; `npm run lint` and `node --check index.mjs` passed on the unchanged product source. No implementation tests, live qualification, migration or release were performed during planning. The three prior research agents were reused for bounded read-only accounting and acceptance assignments, then independent review; no agent edited product code.
