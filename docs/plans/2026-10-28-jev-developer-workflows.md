# Jev-assisted developer workflows

Date: 2026-10-28. Status: implementation specification; no implementation or live inference completed. Scope approved by the owner: **all three improvements, delivered in separate phases**. Planning baseline: `develop`, `0319c9c58d211867ec35776357259b02b235909f`, `/Users/juan/code/gh-glance`, package 0.17.1. All existing-source line references below refer to that baseline; new filenames/functions are explicitly proposed.

## Outcome and evidence

Make it easier to find related work, inspect a failed CI run, and see personal review/assignment work. Build useful local features first and add Jev only where a measured semantic benefit justifies it. Jev does not replace the governor, polling policy, identity checks, GitHub conclusions, freshness, or Sutura's CI routing authority.

The accepted [research](../research/2026-10-28-jev-capabilities-and-current-architecture.md) documents the current architecture and all 132 retrieved documentation resources. The [assessment](../research/2026-10-28-jev-opportunities-assessment.md) motivates Focus, CI diagnostics, and attention in sections A1–A3 (`docs/research/2026-10-28-jev-opportunities-assessment.md:30`, `:42`, `:54`). Developer benefit and runtime impact remain **UNMEASURED**. Account-specific retention/limits remain **UNAVAILABLE**; no account change is needed to write or implement the offline portions of this plan.

Current facts that shape this design:

- One Node ESM executable, no build step, Node >=22, no exported package API (`package.json:5`, `:9`, `:52`; `CONTRIBUTING.md:307`). All product helpers stay in `index.mjs`.
- Loaded Issue/PR rows have titles and limited metadata, not bodies or exact review/assignment relationships (`index.mjs:1070`, `:1085`, `:1941`, `:1950`). Actions rows lack SHA, attempt, jobs and logs (`index.mjs:1467`). Additional details must be acquired explicitly.
- Existing admission, source identity, unchanged-data rendering, and Actions setup lifecycle are reusable (`index.mjs:749`, `:16577`, `:16637`, `:19679`). Model work must not hold these locks or advance source freshness.
- Persisted intents and receipts validate operation names, making new GitHub operations a shared governor protocol change (`index.mjs:4111`, `:4171`). Phase 3 includes a same-path version 7→8 migration; it cannot be deferred to release cleanup.

Read-only planning checks confirmed the official SDK 0.7.0 has no runtime dependencies, supports Node >=22 and provides prebuilt ESM; its unpacked size is 338,733 bytes. These are package facts, not startup measurements. [Registry metadata](https://registry.npmjs.org/@typesafe-ai%2fsdk/0.7.0), [pinned package source](https://github.com/typesafe-ai/typesafe-sdk-js/blob/v0.7.0/package.json).

A bounded local probe of installed `gh 2.103.3` used isolated config, dummy tokens and two loopback origins. It confirmed cross-host authorization removal, final-storage-only response headers, partial stdout on maxBuffer failure, and signed query strings in transport-error stderr. It made no authenticated GitHub request. This is partial transport evidence; Phase 3 must turn it into reproducible tests before accepting log acquisition. The findings are recorded durably in [Phase 3](2026-10-28-jev-developer-workflows-phases/phase-3.md).

## Decisions and alternatives

| Decision | Selected design and trade-off |
| --- | --- |
| Delivery | Five sequential phases: local Focus; optional semantic Focus; CI evidence acquisition; semantic CI observations; attention queue and optional annotations. This separates useful local delivery from provider qualification. |
| Provider integration | Pin `@typesafe-ai/sdk` to **0.7.0** and model **jev-1.14.0**; lazy-load on explicit submission. A direct TypeSafe HTTP client saves one small package but duplicates SDK maintenance; a generic multi-provider framework is unnecessary. Reconsider only on concrete SDK incompatibility, recorded before dependent work. |
| GitHub log transport | Metadata stays on gh; job logs use one admitted native HTTPS API GET and at most one credential-free HTTPS storage GET, with no automatic redirects/retries. The CLI hides intermediate quota evidence and transport retry behavior, so it cannot supply this bound. Reuse existing identity/receipt primitives, not a second quota ledger. |
| Topology | Local Focus works over received rows in standalone/collector/SSH views. Jev, new CI detail acquisition and personal attention initially require interactive standalone mode. No hidden local acquisition fallback for connected clients. |
| Storage | Session-only overlays and bounded result cache. Ordinary rows, collector protocol and persisted source snapshots keep their current schemas (`index.mjs:7239`, `:8848`, `:13355`). Persistent enrichment would introduce migration and privacy work without a first-version benefit. |
| Inference trigger | Explicit uppercase `J` in a feature view; no calls on typing, startup, polling, tab entry, source refresh, or automatic retry. Local results render before inference. |
| Data permission | Session-only consent bound to exact host/repository/access partition/feature/data class. No persistent allowlist file, wildcard consent, repository-controlled permission or account-retention claim. CI requires an exact sanitized excerpt preview on every submission. |
| Attention scope | Loaded current-repository issues/PRs, verified human user, exact direct review/assignment/authorship facts. Team membership, cross-repository inbox, required-check rollups and semantic urgency are deferred. |
| Semantic authority | Advisory relevance, reported log observations and metadata badges only. No inferred ownership, root-cause assertion, workflow rerun, severity reduction, automatic action, or CI routing change. |

## Phase sequence and ownership

| Phase | Deliverable | Depends on | Plan |
| --- | --- | --- | --- |
| 1 | Keyboard Focus mode, useful local search, coverage and offline corpus | Baseline | [Phase 1](2026-10-28-jev-developer-workflows-phases/phase-1.md) |
| 2 | Optional Jev adapter, semantic Focus, privacy/bounds and evaluation command | 1 | [Phase 2](2026-10-28-jev-developer-workflows-phases/phase-2.md) |
| 3 | Governor compatibility migration and selected-run/job/log evidence view | 2 local acceptance; no live-model dependency | [Phase 3](2026-10-28-jev-developer-workflows-phases/phase-3.md) |
| 4 | Six evidence-backed CI observations, using the accepted adapter | 3 qualified log transport; 2 | [Phase 4](2026-10-28-jev-developer-workflows-phases/phase-4.md) |
| 5 | Exact personal attention queue with optional metadata annotations | 3 protocol; 1/2 UI and adapter; sequential acceptance after 4 | [Phase 5](2026-10-28-jev-developer-workflows-phases/phase-5.md) |

One implementation owner edits `index.mjs` and integrates each phase locally. Phase execution and acceptance are sequential. Independent fixture-authoring units are marked `[batch-eligible]` only where they have separate file ownership and a complete contract in this plan. They may use a second local worktree; no overlapping runtime edits, working-branch publication or automatic PRs. Independent read-only review is required after implementation, followed by repairs, simplify, and verification. Stop after each phase unless the owner expressly authorizes continuation.

## Interaction and identity contract

`/` opens Focus for the current Issues or PR tab. `Enter` submits local search; another `/` edits it. `J` explicitly enriches the current query, and `m` explicitly evaluates the next bounded semantic batch. `d` on a selected Actions run opens CI details; `l` fetches the selected job's log, and `J` offers the excerpt preview. `a` opens attention; `m` loads the next detail batch, `r` refreshes the needed source lists/details, and `J` adds optional annotations.

Text-entry mode receives printable characters, including `q`, before normal commands; Ctrl-C always quits. Escape cancels an edit to previous results, then leaves the feature view before the existing ordinary-view quit behavior. Outside text entry, `q` quits and cancels active work. Preserve mouse/CSI handling, help, narrow layouts and original row navigation (`index.mjs:11725`, `:16110`, `:16770`, `:17963`). Every view renders its completeness/retry message in the narrow layout. Use the existing same-host HTTPS browser URL validation (`index.mjs:7086`, `:7098`).

Separate feature state includes host, canonical repository, access partition, source-content digest, query/question version, generation and evaluated-at time. CI adds run ID/attempt/head SHA/job ID/excerpt hash; attention adds viewer identity and a frozen candidate manifest. A generation change aborts work; a late response must pass the complete identity comparison immediately before publication. Results never become source data. Feature state retires with existing scope retirement (`index.mjs:19201`). Ordinary rows remain available throughout provider failure.

## Shared Jev contract

`--jev` defaults false; a key alone never enables it. `--jev-max-requests` is an integer 1–10,000, default 100, and requires `--jev`. Reject Jev flags in noninteractive/collector-service/connected modes with a specific CLI explanation. Capture `TYPESAFE_API_KEY` in a private startup closure, without module-import environment mutations. Pass it directly to the SDK. Strip it from **every** child environment, including previously copied explicit env objects; retain required GitHub credentials. The [consumer sweep](2026-10-28-jev-developer-workflows-phases/consumer-sweep.md) enumerates the affected callers.

The client fixes API origin `https://api.typesafe.ai`, path `/v1/systemone`, exact model, logging off, compression false and retries zero. Ignore SDK environment overrides for base URL/model/logging. A custom fetch permits only that POST endpoint, rejects redirects, and bounds all response bodies to 128 KiB, counting actual streamed bytes. SDK JSON parsing is not domain validation ([client source](https://github.com/typesafe-ai/typesafe-sdk-js/blob/v0.7.0/src/client.ts#L313)); reject missing/extra answer IDs, wrong types/model, invalid probabilities and unknown Choice keys. Noul probabilities must be finite in [0,1]; Choice probabilities must have the exact option keys, sum within 0.001 of one, and select a maximum within 0.000001. Usage is nonnegative integer or null; unknown usage is never zero spend.

Each explicit operation has a **4-second total deadline**, including lazy loading, sequential chunks and body reads. Recheck cancellation/deadline before dispatch after a noncancellable module import. At most one HTTP request is in flight per process; equal explicit requests join, different requests cancel obsolete work, and no background queue exists. Each dispatched request consumes the session request cap, even if later canceled or errored; a cache hit does not. This is a per-process request bound, not an account-wide dollar limit. Display remaining calls; at exhaustion show the explicit restart/`--jev-max-requests` remedy, without an automatic reset. A 429/529 uses a Retry-After cooldown capped at 60 seconds, then permits an explicit retry; nothing retries automatically.

Memory-only LRU: at most 128 normalized results, 2 MiB total, age at most 10 minutes. Key by feature + host/repo/access partition + content digest + query + question version + pinned model. Raw query/log text, credentials, provider response bodies and signed URLs never enter persistent caches, doctor output or verbose diagnostics. The active CI excerpt is separately capped at 8 KiB. Closing a view, changing scope or revoking consent clears sensitive active state. Add a visible `x Revoke Jev permission` action to feature help; it aborts inference and clears that scope's consent/results.

Input bounds: query 256 UTF-8 bytes, projected item 1,024 bytes, complete serialized request 24 KiB, at most 15 items per HTTP batch and 60 items per explicit action. CI permits at most 40 spans, each at most 512 bytes, 8 KiB text total. Deliberate truncation is disclosed. Context rejection is unavailable/input-too-large, not a silent altered retry. Repository text is inert data; fixed questions and validated typed results never generate commands or authorization.

Initial Noul policy: `p > 0.70` positive, `p < 0.30` negative, inclusive middle uncertain. Freeze any development-set adjustment before held-out evaluation; update question version/cache identity together. Confidence is not truth or permission. [Noul](https://docs.typesafe.ai/primitives/noul.md), [Choice](https://docs.typesafe.ai/primitives/choice.md), [SDK config](https://docs.typesafe.ai/sdk/javascript/api/interfaces/TypeSafeClientConfig.md).

## Stuck states and recovery

Each row names a required recovery/disclosure test; phase files add feature-specific states. All states leave ordinary dashboard navigation available.

| State and audience | Visible behavior and way out | Required automated oracle |
| --- | --- | --- |
| User has disabled Jev, missing key, or unsupported mode | Explain exact missing prerequisite; local feature works; help shows standalone launch with `--jev` and `TYPESAFE_API_KEY` name without a value | No import/network; next correctly configured session can submit |
| No consent or revoked scope | Show provider, fields and exact scope; Send/Cancel, or `J` to grant again after revocation | Cancel sends zero; confirm sends once; revoke aborts and clears |
| Input too large or suspected CI secret | Explain the bound or suspected secret; retain local view; narrow query or review a smaller excerpt | Corrected bounded input succeeds; secret-blocked excerpt never sends |
| Request pending/canceled/stale | Pending does not capture ordinary rendering; Esc cancels; changed source shows “Data changed; run again” | Slow and late response tests; explicit new request recovers |
| Timeout, HTTP/network/schema/model error | Fixed safe message, local fallback, explicit Retry; unsupported pinned model instructs update rather than alias fallback | Error then valid reply; no negative classification or hidden retry |
| Provider cooldown/request cap | Show retry time or remaining-call exhaustion and explicit next action | Fake-clock cooldown ends; retry dispatches once; cap never resets itself |
| Partial semantic coverage/uncertainty | Show N/M and unknown count, `m` for remaining loaded candidates, ordinary list accessible | All-middle and unevaluated rows cannot produce “nothing needs attention” |
| Source list stale, missing, truncated or empty | Preserve source age/coverage; feature-specific Refresh/Open GitHub action | Empty-complete differs from empty-unloaded; refresh updates only source freshness |
| GitHub admission/permission/transport failure | Existing governor reason/retry time or permission explanation; explicit Retry/Open GitHub | Denial makes zero dispatch; permitted retry settles exactly once |
| Old live governor pane/protocol mismatch | “Restart all gh-glance panes with this version”; preserve ledger; waiting pane recovers after old lease ends | Same-path v7→8 recovery; future version refuses writes with actionable copy |
| Governor storage/backup failure | Existing storage remedy, no new admission; a conflicting backup names its path and instructs preserving it under an unused archival filename before retry; never delete the ledger | Failed backup cannot mutate ledger or spend; repaired/archived-conflict retry migrates once |

## Consumer sweep

The exhaustive grouped inventory and reproducible searches are in [consumer-sweep.md](2026-10-28-jev-developer-workflows-phases/consumer-sweep.md). It covers UI dispatch, child environments, shared protocol/cost writers, GraphQL and REST fixture writers, package/PTY helpers, and explicit source-schema exclusions. Re-run the searches at implementation entry; new consumers must receive a phase disposition before editing the shared contract.

## Acceptance and evidence policy

Behavioral changes use TDD at the real application policy/reducer layer, mocking only external transport/clock. No new test framework or build step. Run required checks sequentially and preserve failures; local results are not hosted proof. Every phase runs `npm run lint`, `node --check index.mjs`, `npm test`, and `npm run test:pty` because every phase changes UI behavior. Phases 3 and 5 additionally run `npm run test:efficiency`; add it to other phases only if their actual changes affect acquisition/scheduling/efficiency. Phase 2 validates the exact package install on Node 22 and 24; Phase 3 runs exact-old-reader compatibility and offline native HTTPS transport checks on both Node majors. Avoid duplicating a package test already covered by the same candidate's `npm test` invocation. No workflow or CI cadence edits are authorized.

All normal tests/evaluation default offline. Proposed `scripts/evaluate-jev.mjs` records corpus hash, model/question version, actual calls/usage/latency and outcomes; live mode requires explicit flags, a reviewed payload manifest and concrete call/byte/dollar limits. A first live contract probe is limited to 12 synthetic/public-only calls and 192 KiB serialized input, no retries. The dollar limit must be explicitly approved before running; implementation derives a conservative reservation from the selected model's documented token ceiling and current price, never treating missing usage as free. Stop before an unreservable call.

Live experimentation is **not authorized by this planning request**. The [TypeSafe skill](/Users/juan/.codex/plugins/cache/typesafe-ai/typesafe/0.6.2/skills/typesafe-ai/SKILL.md) requires: “Ask the user for permission first. Get a budget for experimentation” and disclosure of data and `TYPESAFE_API_KEY` use. Prepare exact synthetic/public payloads and cost bounds before that later decision. This does not block local implementation or deterministic features. Mark offline-complete cloud features **live contract UNVERIFIED** until a real probe passes; public cloud-feature qualification additionally requires the relevant held-out criteria below. No credential creation, account setting, push or release is implicit.

| Evaluation | Acceptance target, not a current measurement |
| --- | --- |
| Focus | 80 held-out queries, including >=30 synonym queries, >=20 no-match, >=10 ambiguous/truncated and >=10 non-English (slices may overlap); macro precision@k >=0.80 for k=min(3,relevant count), macro recall@5 >=0.85, synonym recall@5 gain >=10 percentage points over Phase 1, no-match specificity >=0.90; uncertainty reported separately |
| CI observations | >=20 positives/category for six categories and >=40 insufficient/ambiguous excerpts, including >=20 adversarial examples; precision >=0.90 and recall >=0.70/category, selected-span support >=0.95, false concrete category on insufficient excerpts <=5%; identity errors zero |
| Attention badges | >=80 metadata cases with >=20 labeled positives and >=20 labeled negatives per badge, >=20 ambiguous and >=20 non-English/adversarial (slices may overlap); precision >=0.90 and recall >=0.70 for each badge, false assertions on ambiguous cases <=5%; deterministic membership/order preservation 100% |
| Runtime | No model calls disabled, no extra GitHub calls for Focus, no inference wait on first paint; keypress-to-paint p95 <=100 ms pending inference; paired first-paint median regression <=5% plus 20 ms noise allowance; normalized cache <=2 MiB |
| Provider latency | Target completed-operation p95 <=1.5 s; hard terminal deadline 4 s regardless; report sample count and do not claim stable tails with <100 samples |

Metric definitions are part of the evaluator contract. Focus labels define relevant IDs after exact filters, using only available metadata; matching-query fixtures have one to five relevant items. Compute precision as relevant returned positive IDs in first k slots divided by fixed k=min(3,relevant count), and recall as relevant returned positive IDs in first five slots divided by all relevant IDs, then macro-average over matching queries only. Missing slots/uncertain/unavailable results do not earn credit. Compare the same query IDs for the synonym gain. Score zero-relevance queries separately: specificity is the fraction with a completed, all-negative classification and no positive result; abstention is reported separately and earns no specificity credit. Ambiguous gold labels are excluded from ranking truth denominators and scored for unsupported assertions, with counts published. Filter-only cases have deterministic oracles, not semantic accuracy credit.

For CI and attention, report each category/badge's TP, FP, FN and abstention counts; precision=TP/(TP+FP), recall=TP/(TP+FN), with uncertain/unavailable positives counted as FN. Zero emitted positives is not a passing precision result. Span accuracy is supported selections divided by all surfaced category selections; identity mistakes must be zero regardless of category accuracy. Keep all attempted examples in the report, including provider/schema failures, and publish per-slice denominators. Freeze labeled development/held-out partitions by related repository/item/log groups before tuning; do not tune on held-out failures. Include embedded instructions and incomplete evidence. Assess ranking/category correctness independently of confidence. All performance comparisons use identical fixtures, commands, runtime and candidate identity; report process-tree CPU/RSS if measured, without substituting the existing parent-only measurement (`scripts/measure-efficiency.mjs:1666`). A failed semantic gate keeps the useful local feature and leaves that semantic feature unqualified; it does not authorize relaxed truth/privacy rules. Time saved remains a hypothesis until measured developer behavior supports it.

Manual acceptance is limited to terminal visual inspection at narrow/wide sizes and, where necessary, installed-package inspection. Ranking, recovery, network bounds and data disclosures have automated assertions. User authorization for a live experiment is a separate decision, not a manual correctness test.

## Plan review dispositions

Three bounded independent read-only reviews covered provider/data/evaluation, attention/query/UI, and CI/protocol/acquisition. All results were received. Their concrete findings were resolved before finalizing:

| Finding | Resolution |
| --- | --- |
| R1: branch filter case could conflate distinct refs | Phase 1 preserves branch case and adds paired-ref oracle |
| R2: attention slot kind/initial node ID was underspecified | Phase 5 selects __typename, binds initial kind/number, then records/stabilizes returned node ID |
| R3: semantic Focus could lose exact filters | Phase 2 filters locally, sends topic text only, skips filter-only inference and retains nonlexical eligible candidates |
| R4: ranking denominators/abstention could make thresholds invalid | Evaluation defines matching/no-match denominators, fixed k, failure/abstention treatment and per-badge positive/negative counts |
| R5: opaque gh redirects/retries could exceed the reserved log cost | Phase 3 uses one controlled API GET plus one credential-free storage GET, preserving a one-unit declaration and ordinary pacing |
| R6: identity/App writers and mutator-first backup were missing | Consumer inventory includes all discovered entry points; Phase 3 requires a common backup-before-write descriptor/helper and read-only exclusions |
| R7: owner death alone did not resolve an unclosed native dispatch | Phase 3 retains existing unknown-dispatch debt/window recovery and tests/discloses its actual deadline; source verified at `index.mjs:4658`, `:4731` |

The first six resolutions received reviewer confirmation; R7 was corrected and checked directly against current source. No required investigator result or known design finding remains unresolved. These are plan-review results, not implementation-test passes.

Final planning validation passed: seven Markdown artifacts, all local links resolved, 133 explicit existing-source references checked for file existence and line bounds, six pseudocode blocks checked against the installed notation, no unresolved markers or trailing whitespace. Source/dependency diff is empty and HEAD remains the stated baseline. Product lint/unit/PTY/efficiency gates were not run for this documentation-only task; their required execution is specified per implementation phase.

## Durable handoff

Approved objective: all three features in separate phases. Final architecture decisions are recorded above; no unresolved design choice remains. Read-only investigations of SDK questions, attention GraphQL, CI transport and shared protocol were completed and incorporated. Graphify was queried at the baseline and confirmed against source. The dependency, transport and schema risks have explicit phase tests; no benchmark or product-test result is being claimed.

Current/base commit is `0319c9c58d211867ec35776357259b02b235909f` on `develop`. Planning adds only this plan/phase documents alongside the existing two uncommitted research documents. No product source, dependency, lockfile, account, provider or hosted state changed. Planning checks are source/reference review and local dummy-token probe only. Before implementation, inspect actual branch/SHA/status, preserve unexpected edits, read the selected phase and common contracts completely, and create an isolated local worktree. The next authorized workflow still requires the owner's implementation instruction; Phase 1 has no live-service prerequisite. Later live qualification and publication retain their separate authorization boundaries.
