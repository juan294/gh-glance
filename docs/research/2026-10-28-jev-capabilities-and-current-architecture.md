# Jev capabilities and gh-glance's current architecture

Date: 2026-10-28. Repository: `/Users/juan/code/gh-glance`. Branch: `develop`. Baseline: `0319c9c58d211867ec35776357259b02b235909f`, initially clean. Package version: 0.17.1 (`package.json:3`). Inspected runtime: Node v24.22.1; GitHub CLI 2.103.3. This is descriptive `$rpi-research`; the separately requested evaluation is in [the assessment](2026-10-28-jev-opportunities-assessment.md).

## Question and answer

What information and decisions exist in gh-glance, and which capabilities does Jev document that could operate on that information?

gh-glance collects bounded GitHub observations, coordinates their acquisition, and renders four terminal tabs. It currently has deterministic polling, quota admission, error classification, severity ordering, and navigation. Its issue/PR data is mostly display metadata; its Actions rows contain status rather than failure logs. Jev supplies typed semantic judgments over data an application sends, rather than fetching GitHub evidence or generating explanations. These are complementary capabilities, but documentation alone establishes no improvement in application performance or developer outcomes. Repository evidence follows below; external capabilities are separately attributed.

## Evidence scope and provenance

The public documentation inventory was retrieved on 2026-10-28 from [llms.txt](https://docs.typesafe.ai/llms.txt) and checked against [sitemap.xml](https://docs.typesafe.ai/sitemap.xml): all 131 documentation pages matched. The snapshot also includes the linked [OpenAPI specification](https://api.typesafe.ai/openapi.json), for 132 indexed resources with successful downloads. The coverage appendix records every resource. Documentation prose, API contracts, and relevant example logic were reviewed; embedded third-party sample corpora and repeated generated SDK declarations were not independently validated as datasets. Recipes were read, not executed.

Three bounded read-only assignments covered core API/model/legal facts, cookbooks/SDKs, and repository acquisition/performance behavior. The parent inspected the UI/data projections, source references, and returned findings. Raw snapshots, hashes, graph results, and investigator notes remain local under `/tmp/gh-glance-jev-research-20261028/`; this document preserves the conclusions and source inventory without committing copied documentation.

The configured `graphify_local` server was queried over its existing stdio entry point because no callable Graphify connector was exposed. `graph_stats`, `god_nodes`, and `query_graph` used `project_path=/Users/juan/code/gh-glance`. The graph reported the exact baseline commit, 3,168 nodes and 7,145 edges. The broad orientation query was truncated; source reads supplied the behavioral evidence. No graph memory or mutation operation ran.

The signed-in console could not be inspected: browser tooling returned `The browser access host is unavailable`. No API key was read or created, no inference request was sent, and no project data was uploaded to TypeSafe. Account limits, billing arrangements and retention settings remain unknown.

## Repository observations

### R1. Runtime and public surface

The package is plain Node ESM, exposes one executable, blocks package imports, and depends on Ink and React (`package.json:5`, `package.json:9`, `package.json:55`). The four tabs are Actions, Issues, Pull requests, and Security (`index.mjs:12683`). The key map provides navigation, opening items, refresh/resynchronization, Actions setup inspection, width adjustment, and contextual help (`index.mjs:11725`). The keyboard dispatch implements those operations without a text-search or model-query input (`index.mjs:17963`). Product source and dependencies contain no Jev/TypeSafe integration.

Rows are displayed in the fetched order and sliced to the visible viewport (`index.mjs:20291`). Selection follows item identity, not row position (`index.mjs:7050`, `index.mjs:7054`). Opening a row uses an already known, HTTPS, same-host URL and a fixed platform argument vector (`index.mjs:7086`, `index.mjs:7098`, `index.mjs:7114`). A missing URL produces a refresh-and-retry error; opener errors appear in the tab error surface (`index.mjs:7122`, `index.mjs:17955`).

### R2. Available evidence is deliberately small

| Surface | Data currently selected | Material information absent from this projection |
| --- | --- | --- |
| Actions | Run ID/number, title, workflow ID/name, branch, status/conclusion, timestamps and URL | Failed jobs/steps, log excerpts, source SHA, run-attempt identity |
| Issues | Number, title, author, first label, update time and URL | Body, comments, all labels, assignees and relationships |
| Pull requests | Number, title, author, branch, draft/review state, update time and URL | Body, patch, changed files, review requests, checks and mergeability |
| Security | Alert identity/type, reported severity, short summary, package or path, creation time | Dependency reachability, exploitability evidence, full source context |

Evidence: Actions projection and parsing at `index.mjs:1467` and `index.mjs:1560`; issue/PR queries at `index.mjs:1070` and `index.mjs:1085`, row mappers at `index.mjs:1941`; alert projections at `index.mjs:2195`. These are statements about gh-glance's selected data, not the full GitHub API capability.

Actions requests 60 runs; Issues/PRs use 50-row pages up to a 150-row cap, with more pages demanded near the end of the loaded list (`index.mjs:110`, `index.mjs:119`, `index.mjs:1060`, `index.mjs:1965`, `index.mjs:1977`). Security uses bounded newest and priority lanes (`index.mjs:121`, `index.mjs:6720`). Counts preserve a truncation marker, and a blind Security observation displays `?` (`index.mjs:20226`). None of these lists establishes exhaustive repository coverage.

Text sanitation strips terminal controls/bidirectional overrides and caps fields at 300 codepoints (`index.mjs:305`). This is a terminal-safety boundary, not a secret-redaction or semantic-evidence completeness guarantee. The documented Security model describes this distinction's terminal context (`SECURITY.md:72`).

### R3. Current decisions use explicit source facts

Issues and PRs arrive ordered by GitHub update time (`index.mjs:1076`, `index.mjs:1091`). Security sorts by a fixed severity rank, then creation time (`index.mjs:6956`, `index.mjs:7020`); secret-scanning rows are always critical (`index.mjs:2238`). PR review labels come from GitHub's review state (`index.mjs:12589`). The Actions warning marker checks the newest fetched run's status/conclusion (`index.mjs:20247`); it is not an exact-commit release assessment.

Fetch errors are classified in a fixed precedence: missing remote, rate limit, authentication, unavailable, unusable output, then other (`index.mjs:476`). Known states map to recovery copy. Unknown errors retain their message rather than inventing a remedy (`index.mjs:494`). This classifier governs application transport/recovery; it does not analyze failed workflow logs.

### R4. Acquisition and rendering already avoid repeated work

The polling policy uses requested demand, active/inactive status, unchanged observations and in-progress CI. On-demand secondary views do not acquire periodically; active Actions use the appropriate floor and quiet cadence (`index.mjs:15294`). Errors and blind/unusable observations do not count as successful evidence of quiet (`index.mjs:15321`). REST fetches have conditional-entity handling (`index.mjs:1631`). Shared acquisition has its own identity, snapshot and engine machinery (`index.mjs:13807`, `index.mjs:14021`, `index.mjs:14470`).

An unchanged raw response avoids parsing; blind or unusable results cannot become ordinary changed data (`index.mjs:16637`). Row components are memoized (`index.mjs:12673`). Animation is conditional on visible activity and parks on a stable frame at rest (`index.mjs:20199`). These mechanisms provide specific existing baselines for a future comparison; no new runtime measurement was collected here.

The transport and governor record request costs and require admission (`index.mjs:2248`, `index.mjs:16577`). Control probes, data demand and recovery are separate from display relevance. The source retains independent source freshness and failure presentation (`index.mjs:15936`, `index.mjs:15979`). Busy/shared work retries automatically; quota holds wait for their recovery time; repeated throttle can require `r`. Hard storage corruption, unwritable state, capacity and accounting overflow remain sticky and point to `--doctor`, which supplies repair advice (`index.mjs:15790`, `index.mjs:15798`). These causes and actions are visible through `presentRecovery` (`index.mjs:15936`).

The optional collector uses the same acquisition engine (`index.mjs:9609`). Collector snapshots accept an exact field set and exact per-tab row schema, project only display data, and preserve source observation time rather than substituting client receipt time (`index.mjs:8848`, `index.mjs:8884`, `index.mjs:10495`). Disconnection reconnects that transport (`index.mjs:10616`); the accepted topology prohibits local GitHub fallback in connected modes (`docs/decisions/0005-local-collector-and-provider-boundary.md:39`). Webhooks authenticate and queue invalidations rather than becoming authoritative display rows (`index.mjs:8516`, `index.mjs:8632`; `docs/decisions/0005-local-collector-and-provider-boundary.md:67`). No generic semantic-enrichment field exists in the current collector schema.

### R5. Existing verification is an available contract, not a result of this research

The package defines lint, syntax-compatible direct execution, Node unit tests, a dedicated efficiency workload, and PTY suites (`package.json:16`). Contributor guidance specifies independent request accounting, last-good snapshots, bounded collector protocol behavior, process-level concurrency and unchanged-payload redraw suppression (`CONTRIBUTING.md:113`, `CONTRIBUTING.md:151`, `CONTRIBUTING.md:172`, `CONTRIBUTING.md:140`, `CONTRIBUTING.md:236`). These are existing verification mechanisms; no product tests or performance benchmark ran during this read-only investigation.

Current diagnostics count HTTP attempts, REST 200/304, quota units, failures, observers, cache hits and joined followers (`index.mjs:11136`). The sustained offline efficiency test exercises production coordination against an independent oracle (`test/efficiency.test.mjs:120`), with mixed-tab freshness coverage (`test/efficiency.test.mjs:270`). Its resource measurement explicitly covers parent-process CPU/RSS, not the entire process tree (`scripts/measure-efficiency.mjs:1671`). This is a measurement limitation, not a new failure finding.

## External observations

### J1. Typed judgments and their limits

Jev accepts supplied state and named questions. Choice selects from supplied candidates; Noul estimates a yes/no proposition; Score returns a distribution over ordered descriptive levels. It does not supply a generated explanation or fetch missing evidence. [Introduction](https://docs.typesafe.ai/introduction.md), [coding agents](https://docs.typesafe.ai/introduction/coding-agents.md), [primitives](https://docs.typesafe.ai/primitives.md).

A Choice has at most 255 candidates and always selects one. The documentation recommends a separate existence/match question for cases where nothing fits. A Noul has no separate confidence field. Score's average can conceal a split distribution. [Choice](https://docs.typesafe.ai/primitives/choice.md), [Noul](https://docs.typesafe.ai/primitives/noul.md), [Score](https://docs.typesafe.ai/primitives/score.md).

Confidence summarizes distribution concentration; it is not an individual correctness guarantee. Questions within one request share state but cannot see one another's answers. State can be structured and questions bundled, while dependent stages need another request. [Confidence](https://docs.typesafe.ai/confidence.md), [state](https://docs.typesafe.ai/concepts/state.md), [fan-out](https://docs.typesafe.ai/patterns/fan-out.md).

### J2. Relevant documented patterns

| Pattern | Documented mechanism | Evidence limit |
| --- | --- | --- |
| Semantic search | Rank supplied evidence IDs and separately ask whether any answer exists | Only supplied candidates are searchable |
| Reranking | Retrieve a shortlist first, then judge query-candidate relevance | Published legal-search results are not developer-workload results |
| Composite scoring | Ask independent dimensions and combine them in code | The application owns weights and final policy |
| Entity alignment | Judge whether candidate pairs refer to the same entity | A semantic match is not proof of common cause |
| Extraction/citation checks | Select or check supplied spans/claims | No general-purpose text generation |
| Cascades | Use bounded judgments to decide whether another processor is needed | Multiple stages add work and failure modes |
| Parallel questions | Read shared state once for independent judgments | Published speedups compare particular example arrangements |

Sources: [semantic find](https://docs.typesafe.ai/cookbooks/semantic_find.md), [reranking](https://docs.typesafe.ai/cookbooks/rerank_typesafe.md), [composite scoring](https://docs.typesafe.ai/patterns/composite-scoring.md), [entity alignment](https://docs.typesafe.ai/cookbooks/entity_alignment.md), [pre-parsed extraction](https://docs.typesafe.ai/cookbooks/pre_parsed_value_extraction_cookbook.md), [citation checks](https://docs.typesafe.ai/cookbooks/citation_check.md), [SDE cascade](https://docs.typesafe.ai/cookbooks/sde_cascade.md), [parallel questions](https://docs.typesafe.ai/cookbooks/parallel_questions.md). Cookbook results are vendor examples, sometimes cached and using older models; none was reproduced here.

### J3. Current integration and operating facts

The model page lists `jev-1.14.0` (released 2026-10-14), USD 0.042 per million input tokens and free output. Default limits are 64k tokens per request and 32k for state plus one question. Organization quotas use requests/second and tokens/second. Moving aliases can change outputs; replies identify the resolved version. [Models](https://docs.typesafe.ai/models.md).

The JavaScript SDK documentation describes Node 22+, ESM support and version 0.7.0. It exposes cancellation and configurable retries. Defaults include a 10-second per-attempt timeout and two retries; per-attempt timeout is not a total operation deadline, and debug logging can include unredacted payloads. [JavaScript SDK](https://docs.typesafe.ai/sdk/javascript.md), [SDK changelog](https://docs.typesafe.ai/sdk/javascript/changelog.md), [client configuration](https://docs.typesafe.ai/sdk/javascript/api/interfaces/TypeSafeClientConfig.md), [request options](https://docs.typesafe.ai/sdk/javascript/api/interfaces/RequestOptions.md), [retry policy](https://docs.typesafe.ai/sdk/javascript/api/interfaces/RetryPolicy.md).

The HTTP interface is `POST /v1/systemone`; its current specification reports OpenAPI document version 0.2.0. Errors distinguish invalid/authentication requests, rate limiting and overload. [API](https://docs.typesafe.ai/api/system-one.md), [OpenAPI](https://api.typesafe.ai/openapi.json), [errors](https://docs.typesafe.ai/api/errors.md).

Images and Box are expressly experimental and require an opt-in header. General text-only descriptions conflict with these newer detailed pages; they do not establish production image readiness. [Images](https://docs.typesafe.ai/images.md), [Box](https://docs.typesafe.ai/primitives/box.md), [System One](https://docs.typesafe.ai/concepts/system-one.md). The only indexed jaggedness page concerns 1.13; its warnings about arithmetic, irrelevant context and adversarial inputs are version-specific, not proof of 1.14's exact behavior. [Jev 1.13 jaggedness](https://docs.typesafe.ai/model-jaggedness/jev-1.13.md). The retrieved Python basic-usage page contains an image-status date of 2026-11-14, later than this research date; that is a documentation provenance inconsistency, not evidence of a future release. [Python basic usage](https://docs.typesafe.ai/sdk/python/usage/basic.md).

### J4. Data handling is an integration boundary

TypeSafe states customer requests/responses are not training data and offers enterprise zero data retention. Neither statement establishes ZDR for this account. [Legal](https://docs.typesafe.ai/legal.md). The public DPA, updated 2026-04-24, describes purpose-based retention rather than one fixed deletion period. [DPA](https://typesafe.ai/legal/data-processing). The privacy policy, updated 2025-11-19, describes US hosting and service-provider processing. [Privacy](https://typesafe.ai/legal/privacy-policy). The linked MCA and AUP were also reviewed; account-specific contractual terms were not inspected. The linked subprocessor page returned no readable content. [MCA](https://typesafe.ai/legal/mca), [AUP](https://typesafe.ai/legal/acceptable-use-policy), [subprocessors](https://trust.typesafe.ai/subprocessors).

## Historical context and handoff

ADR 0001 records the independent-tab completion rationale and warns that old request-count projections were corrected; its historical timing is not a current benchmark (`docs/decisions/0001-keep-the-gh-cli-data-layer.md:22`). The Copilot assessment records the later owner decision to keep active Actions automatic and secondary views on demand (`docs/research/2026-10-01-copilot-cli-tabs-assessment.md:91`), now directly reflected in `index.mjs:15294`.

Completed scope: current-state research and primary-source capability review. R1–R5 and J1–J4 are observations, not product changes or approval to integrate a service. The same user request authorizes the companion evaluation; no planning, implementation, account change, paid experiment, remote publication or CI routing change is authorized by this artifact. Sutura remains the owner of CI cadence/routing under the supplied owner instruction and `/Users/juan/code/AGENTS.md:3`.

Material unknowns: Jev accuracy on developer data, end-to-end latency and tails, actual token counts, account limits/retention, and measured benefit over keyword or deterministic ranking. The console access failure limits account evidence but does not invalidate the public-document review. A future planner must recheck the branch/commit, available data projections, current API/model contracts and any selected feature's data authorization. No test-pass claim should be inferred from this document.


## Coverage appendix

All entries below were retrieved on 2026-10-28 and reviewed within the scope stated above. The 131 documentation pages match the sitemap; the additional entry is OpenAPI. Linked legal policies are cited in J4. Documentation versions are only asserted where exposed; no generic last-updated date was supplied by the inventory.

### Concepts, API, models and other references (27)

- [Introduction](https://docs.typesafe.ai/introduction.md)
- [Quick start](https://docs.typesafe.ai/introduction/quickstart.md)
- [Jev with coding agents](https://docs.typesafe.ai/introduction/coding-agents.md)
- [Example use cases](https://docs.typesafe.ai/concepts/use-case-map.md)
- [System One](https://docs.typesafe.ai/concepts/system-one.md)
- [State](https://docs.typesafe.ai/concepts/state.md)
- [Primitives (Questions)](https://docs.typesafe.ai/primitives.md)
- [Choice](https://docs.typesafe.ai/primitives/choice.md)
- [Score](https://docs.typesafe.ai/primitives/score.md)
- [Noul](https://docs.typesafe.ai/primitives/noul.md)
- [Box](https://docs.typesafe.ai/primitives/box.md)
- [Advanced: structure](https://docs.typesafe.ai/primitives/advanced.md)
- [Images](https://docs.typesafe.ai/images.md)
- [Confidence](https://docs.typesafe.ai/confidence.md)
- [How to build with TypeSafe](https://docs.typesafe.ai/concepts/how-to-build-with-system-one.md)
- [AI primer](https://docs.typesafe.ai/introduction/machine-learning-primer.md)
- [Demos](https://docs.typesafe.ai/demos.md)
- [Smart home assistant demo](https://docs.typesafe.ai/demos/smart-home.md)
- [Models](https://docs.typesafe.ai/models.md)
- [Agent skill](https://docs.typesafe.ai/agent-skill.md)
- [Legal](https://docs.typesafe.ai/legal.md)
- [Jev 1.13 jaggedness](https://docs.typesafe.ai/model-jaggedness/jev-1.13.md)
- [System One](https://docs.typesafe.ai/api/system-one.md)
- [List models](https://docs.typesafe.ai/api/list-models.md)
- [Request rules and errors](https://docs.typesafe.ai/api/errors.md)
- [Client SDKs](https://docs.typesafe.ai/sdk.md)
- [openapi](https://api.typesafe.ai/openapi.json)

### Patterns (5)

- [Patterns](https://docs.typesafe.ai/patterns.md)
- [Speculative fan-out](https://docs.typesafe.ai/patterns/fan-out.md)
- [Confidence-gated routing](https://docs.typesafe.ai/patterns/confidence-routing.md)
- [Composite scoring](https://docs.typesafe.ai/patterns/composite-scoring.md)
- [Intent routing](https://docs.typesafe.ai/patterns/intent-routing.md)

### Cookbooks (22)

- [Cookbooks](https://docs.typesafe.ai/cookbooks.md)
- [Function calling](https://docs.typesafe.ai/cookbooks/function_calling.md)
- [Skill suggestion](https://docs.typesafe.ai/cookbooks/skill_suggestion.md)
- [Guardrails for LLMs](https://docs.typesafe.ai/cookbooks/llm_guardrails.md)
- [Double-checking citations](https://docs.typesafe.ai/cookbooks/citation_check.md)
- [Classifying RAG passages](https://docs.typesafe.ai/cookbooks/classifying_rag_passages.md)
- [Simple memory system](https://docs.typesafe.ai/cookbooks/basic_memory.md)
- [Hierarchical classification](https://docs.typesafe.ai/cookbooks/hierarchical_classification.md)
- [Classification using confidence](https://docs.typesafe.ai/cookbooks/classification_using_confidence.md)
- [Twitch chat filter](https://docs.typesafe.ai/cookbooks/twitch_chat_filter.md)
- [SDE cascade](https://docs.typesafe.ai/cookbooks/sde_cascade.md)
- [Date extraction](https://docs.typesafe.ai/cookbooks/date_extraction_cookbook.md)
- [Pre-parsed value extraction](https://docs.typesafe.ai/cookbooks/pre_parsed_value_extraction_cookbook.md)
- [Structure recovery](https://docs.typesafe.ai/cookbooks/autoformat.md)
- [Re-ranking](https://docs.typesafe.ai/cookbooks/rerank_typesafe.md)
- [Line-by-line search](https://docs.typesafe.ai/cookbooks/semantic_find.md)
- [Knowledge graph entity alignment](https://docs.typesafe.ai/cookbooks/entity_alignment.md)
- [Intelliprompter](https://docs.typesafe.ai/cookbooks/intelliprompter.md)
- [Self-consistency: choices](https://docs.typesafe.ai/cookbooks/consistency_choice_cookbook.md)
- [Self-consistency: nouls](https://docs.typesafe.ai/cookbooks/consistency_noul_cookbook.md)
- [Parallel questions](https://docs.typesafe.ai/cookbooks/parallel_questions.md)
- [Autoresearch feature discovery](https://docs.typesafe.ai/cookbooks/autoresearch_feature_discovery.md)

### Python SDK (14)

- [TypeSafe Python SDK](https://docs.typesafe.ai/sdk/python.md)
- [Basic usage](https://docs.typesafe.ai/sdk/python/usage/basic.md)
- [Advanced usage](https://docs.typesafe.ai/sdk/python/usage/advanced.md)
- [Changelog](https://docs.typesafe.ai/sdk/python/changelog.md)
- [API reference](https://docs.typesafe.ai/sdk/python/api.md)
- [Asynchronous client](https://docs.typesafe.ai/sdk/python/api/clients/async.md)
- [Synchronous client](https://docs.typesafe.ai/sdk/python/api/clients/sync.md)
- [Questions](https://docs.typesafe.ai/sdk/python/api/types/questions.md)
- [Assets](https://docs.typesafe.ai/sdk/python/api/types/assets.md)
- [Answers and responses](https://docs.typesafe.ai/sdk/python/api/types/responses.md)
- [Retries](https://docs.typesafe.ai/sdk/python/api/retries.md)
- [Common types](https://docs.typesafe.ai/sdk/python/api/types/common.md)
- [Exceptions](https://docs.typesafe.ai/sdk/python/api/exceptions.md)
- [Constants](https://docs.typesafe.ai/sdk/python/api/constants.md)

### JavaScript SDK (64)

- [JavaScript SDK](https://docs.typesafe.ai/sdk/javascript.md)
- [Changelog](https://docs.typesafe.ai/sdk/javascript/changelog.md)
- [API reference](https://docs.typesafe.ai/sdk/javascript/api.md)
- [Class: APIConnectionError](https://docs.typesafe.ai/sdk/javascript/api/classes/APIConnectionError.md)
- [Class: APIError](https://docs.typesafe.ai/sdk/javascript/api/classes/APIError.md)
- [Class: APIPromise<T>](https://docs.typesafe.ai/sdk/javascript/api/classes/APIPromise.md)
- [Class: APITimeoutError](https://docs.typesafe.ai/sdk/javascript/api/classes/APITimeoutError.md)
- [Class: APIUserAbortError](https://docs.typesafe.ai/sdk/javascript/api/classes/APIUserAbortError.md)
- [Class: AuthenticationError](https://docs.typesafe.ai/sdk/javascript/api/classes/AuthenticationError.md)
- [Class: BadRequestError](https://docs.typesafe.ai/sdk/javascript/api/classes/BadRequestError.md)
- [Class: Image](https://docs.typesafe.ai/sdk/javascript/api/classes/Image.md)
- [Class: InternalServerError](https://docs.typesafe.ai/sdk/javascript/api/classes/InternalServerError.md)
- [Class: NotFoundError](https://docs.typesafe.ai/sdk/javascript/api/classes/NotFoundError.md)
- [Class: PermissionDeniedError](https://docs.typesafe.ai/sdk/javascript/api/classes/PermissionDeniedError.md)
- [Class: RateLimitError](https://docs.typesafe.ai/sdk/javascript/api/classes/RateLimitError.md)
- [Class: TypeSafeClient](https://docs.typesafe.ai/sdk/javascript/api/classes/TypeSafeClient.md)
- [Class: TypeSafeError](https://docs.typesafe.ai/sdk/javascript/api/classes/TypeSafeError.md)
- [Class: UnprocessableEntityError](https://docs.typesafe.ai/sdk/javascript/api/classes/UnprocessableEntityError.md)
- [Interface: BoxCoordinates](https://docs.typesafe.ai/sdk/javascript/api/interfaces/BoxCoordinates.md)
- [Interface: BoxQuestion](https://docs.typesafe.ai/sdk/javascript/api/interfaces/BoxQuestion.md)
- [Interface: BoxResponse](https://docs.typesafe.ai/sdk/javascript/api/interfaces/BoxResponse.md)
- [Interface: ChoiceQuestion<T>](https://docs.typesafe.ai/sdk/javascript/api/interfaces/ChoiceQuestion.md)
- [Interface: ChoiceResponse<T>](https://docs.typesafe.ai/sdk/javascript/api/interfaces/ChoiceResponse.md)
- [Interface: Logger](https://docs.typesafe.ai/sdk/javascript/api/interfaces/Logger.md)
- [Interface: ModelCard](https://docs.typesafe.ai/sdk/javascript/api/interfaces/ModelCard.md)
- [Interface: Models](https://docs.typesafe.ai/sdk/javascript/api/interfaces/Models.md)
- [Interface: NoulQuestion](https://docs.typesafe.ai/sdk/javascript/api/interfaces/NoulQuestion.md)
- [Interface: NoulResponse](https://docs.typesafe.ai/sdk/javascript/api/interfaces/NoulResponse.md)
- [Interface: Questions](https://docs.typesafe.ai/sdk/javascript/api/interfaces/Questions.md)
- [Interface: RequestOptions](https://docs.typesafe.ai/sdk/javascript/api/interfaces/RequestOptions.md)
- [Interface: RetryPolicy](https://docs.typesafe.ai/sdk/javascript/api/interfaces/RetryPolicy.md)
- [Interface: ScoreQuestion<T>](https://docs.typesafe.ai/sdk/javascript/api/interfaces/ScoreQuestion.md)
- [Interface: ScoreResponse<T>](https://docs.typesafe.ai/sdk/javascript/api/interfaces/ScoreResponse.md)
- [Interface: SystemOneRequest<Q>](https://docs.typesafe.ai/sdk/javascript/api/interfaces/SystemOneRequest.md)
- [Interface: SystemOneResult<Q>](https://docs.typesafe.ai/sdk/javascript/api/interfaces/SystemOneResult.md)
- [Interface: TextWithAssets](https://docs.typesafe.ai/sdk/javascript/api/interfaces/TextWithAssets.md)
- [Interface: TypeSafeClientConfig](https://docs.typesafe.ai/sdk/javascript/api/interfaces/TypeSafeClientConfig.md)
- [Interface: Usage](https://docs.typesafe.ai/sdk/javascript/api/interfaces/Usage.md)
- [Interface: WithResponse<T>](https://docs.typesafe.ai/sdk/javascript/api/interfaces/WithResponse.md)
- [Type Alias: Asset](https://docs.typesafe.ai/sdk/javascript/api/type-aliases/Asset.md)
- [Type Alias: ChoiceCriteria](https://docs.typesafe.ai/sdk/javascript/api/type-aliases/ChoiceCriteria.md)
- [Type Alias: Compression](https://docs.typesafe.ai/sdk/javascript/api/type-aliases/Compression.md)
- [Type Alias: ContentValue](https://docs.typesafe.ai/sdk/javascript/api/type-aliases/ContentValue.md)
- [Type Alias: Description](https://docs.typesafe.ai/sdk/javascript/api/type-aliases/Description.md)
- [Type Alias: EntryType](https://docs.typesafe.ai/sdk/javascript/api/type-aliases/EntryType.md)
- [Type Alias: EnvVar](https://docs.typesafe.ai/sdk/javascript/api/type-aliases/EnvVar.md)
- [Type Alias: Fetch](https://docs.typesafe.ai/sdk/javascript/api/type-aliases/Fetch.md)
- [Type Alias: JsonValue](https://docs.typesafe.ai/sdk/javascript/api/type-aliases/JsonValue.md)
- [Type Alias: LogLevel](https://docs.typesafe.ai/sdk/javascript/api/type-aliases/LogLevel.md)
- [Type Alias: Question](https://docs.typesafe.ai/sdk/javascript/api/type-aliases/Question.md)
- [Type Alias: ResultFor<T>](https://docs.typesafe.ai/sdk/javascript/api/type-aliases/ResultFor.md)
- [Type Alias: ScoreCriteria](https://docs.typesafe.ai/sdk/javascript/api/type-aliases/ScoreCriteria.md)
- [Type Alias: ScoreLegend<T>](https://docs.typesafe.ai/sdk/javascript/api/type-aliases/ScoreLegend.md)
- [Type Alias: ScoreOf<T>](https://docs.typesafe.ai/sdk/javascript/api/type-aliases/ScoreOf.md)
- [Type Alias: SentContent<T>](https://docs.typesafe.ai/sdk/javascript/api/type-aliases/SentContent.md)
- [Variable: ENV](https://docs.typesafe.ai/sdk/javascript/api/variables/ENV.md)
- [Variable: LOG_LEVELS](https://docs.typesafe.ai/sdk/javascript/api/variables/LOG_LEVELS.md)
- [Variable: noul](https://docs.typesafe.ai/sdk/javascript/api/variables/noul.md)
- [Variable: score](https://docs.typesafe.ai/sdk/javascript/api/variables/score.md)
- [Variable: VERSION](https://docs.typesafe.ai/sdk/javascript/api/variables/VERSION.md)
- [Variable: withAssets](https://docs.typesafe.ai/sdk/javascript/api/variables/withAssets.md)
- [Function: box()](https://docs.typesafe.ai/sdk/javascript/api/functions/box.md)
- [Function: choice()](https://docs.typesafe.ai/sdk/javascript/api/functions/choice.md)
- [Function: image()](https://docs.typesafe.ai/sdk/javascript/api/functions/image.md)
