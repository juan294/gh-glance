# Plan: efficient standalone and shared GitHub acquisition

Date: 2026-09-05  
Source: `develop` at `b819f42e87922671a35bb72052bd0ede445b74be` (0.11.2)  
Research: [multi-instance API efficiency and architecture](../research/2026-09-05-multi-instance-api-efficiency-and-architecture.md)  
Status: Implementation underway; phase 1 completed and locally verified.

## Outcome and scope

Keep many terminal dashboards useful without each pane repeating GitHub work, and make throttling recover promptly when capacity returns. Cover all ten research findings, the local broker, cross-computer collection, webhook invalidation, and optional GitHub App installation authentication. Optional means disabled unless configured by the user, not omitted from this plan.

The default remains a standalone CLI using the user's existing `gh` login. A user can optionally run one foreground collector and connect local or remote panes to it. The remote transport is SSH to a user-controlled computer. Webhook reception is an additional collector option behind a user-managed HTTPS reverse proxy. GitHub App authentication is a collector credential provider, not mandatory onboarding.

These transport/extension defaults were proposed during planning; no alternative was supplied before drafting. They avoid requiring hosted infrastructure. Creating an App, installing it, configuring SSH/reverse proxies, publishing a release, and operating a remotely accessible collector are separate user setup/activation actions. This plan implements and tests the capabilities locally; it does not authorize those remote actions.

## Current implementation anchors

| Concern | Current implementation |
|---|---|
| Subprocess/header boundary | `index.mjs:630`, `index.mjs:651`, `index.mjs:707` |
| Actions/GraphQL/Security fetchers | `index.mjs:985`, `index.mjs:1153`, `index.mjs:1188`, `index.mjs:3459` |
| Operation costs and quota scheduling | `index.mjs:1318`, `index.mjs:1473`, `index.mjs:1720` |
| Scope, state, lock, migration | `index.mjs:1905`, `index.mjs:1972`, `index.mjs:2211`, `index.mjs:2406` |
| Observations, settlement, cooldown | `index.mjs:2706`, `index.mjs:2766`, `index.mjs:3073`, `index.mjs:3169` |
| Observers and diagnostic probes | `index.mjs:3247`, `index.mjs:3950`, `index.mjs:4036`, `index.mjs:4122` |
| Cache, identity, polling | `index.mjs:5872`, `index.mjs:5888`, `index.mjs:5930`, `index.mjs:6183` |
| CLI dispatch and UI acquisition | `index.mjs:4334`, `index.mjs:4533`, `index.mjs:7327`, `index.mjs:7891` |
| Independent fixture and concurrent tests | `test/pty/fixtures/gh-state.mjs:491`, `test/governor.test.mjs:1`, `test/pty/governor.test.mjs:190` |

Implementation must re-read these functions after preceding phases; the references describe the baseline, not future line numbers.

## Selected design and alternatives

| Decision | Selected design | Tradeoff |
|---|---|---|
| Core acquisition | One reusable acquisition engine, independent of React, still in `index.mjs` | A behavioral extraction is required, with PTY parity tests |
| Default local sharing | Private file-backed entity store and producer claims | No background service; followers inspect bounded generation metadata |
| Optional broker | Same engine hosted by a foreground local collector | Adds lifecycle/protocol code, but no second polling implementation |
| Remote connection | SSH stdio bridge to the collector's private local socket | Reuses OS login and transport encryption; remote binary and SSH must be configured |
| HTTPS client API | Not a second client transport in this plan | SSH fulfills cross-device collection; webhook ingress alone uses HTTP behind TLS |
| GraphQL | Explicit, bounded per-tab/page queries through `gh api -i graphql` | Own selected query fields, gain actual counters/cost; no combined-tab completion barrier |
| Primary versus secondary limits | Conservative primary reservations plus independent HTTP permits | 304 refunds improve scheduling without treating the next conditional request as free |
| Credentials | Separate quota principal, effective credential, and response-access identity | More explicit state; same user budget never implies identical private-data access |
| App auth | Collector-only optional provider; native crypto and one narrow token-mint HTTP adapter | Explicitly expands the old no-token-reading/no-native-network security model |

ADR 0001's independent completion and `gh` data transport remain. ADR 0002's terminal ownership remains; its deferred acquisition extraction is now performed for shared behavior. ADR 0003's local-only scope exclusion is superseded only for opt-in collection. Add ADRs 0004 (quota/acquisition identities and accounting) and 0005 (collector and optional providers) during their owning phases; update `SECURITY.md` wherever its existing guarantees change (`docs/decisions/0001-keep-the-gh-cli-data-layer.md:22`; `docs/decisions/0002-own-the-terminal-lifecycle.md:77`; `docs/decisions/0003-file-backed-api-coordination.md:134`; `SECURITY.md:167`).

## Non-negotiable invariants

1. Every data HTTP request is declared and obtains a fresh, start-time-validated worst-case quota reservation plus an HTTP permit. Pagination is explicit; no hidden `--paginate` or porous porcelain fetcher remains in acquisition.
2. A 304 refunds proven primary cost only. Failed, interrupted, unobserved, or process-lost work retains its conservative charge. Never infer one request's cost from the account-wide used delta when external clients may contribute.
3. Authoritative observations cannot be replaced by `/rate_limit`. Only the resource's claimed observer establishes a new epoch; same-epoch observations monotonically constrain remaining capacity.
4. Known quota data work never enters the 20% reserve. A shared, bounded bootstrap/reset observer is the explicitly documented control-plane exception; known exhaustion waits for its reset. Other machines and unrelated clients remain outside the local guarantee.
5. One producer owns a query generation and its quota settlements. Followers neither call GitHub for that generation nor settle its reservation. No filesystem lock is held across network I/O.
6. Quota identity can be shared more broadly than response identity. Payloads, capability results, validators, and retained rows remain authorization-partitioned and fenced against old completions.
7. Last successful source observation and last content change are distinct. Cache reads, collector receipt, reconnect, and errors do not create source freshness.
8. Terminal restore, stable frame geometry, selection identity, sanitized fields, unchanged-frame suppression, and CLI-only package exports remain tested contracts.
9. No silent remote-to-local polling fallback. A disconnected collector client keeps known rows, shows their age, and reconnects without multiplying API demand.
10. All scenarios run against independent local fixtures first. No real account stress loop, preview deployment, remote experimental branch, or CI-driven debugging.

## Data and request contracts

```text
credential = resolveEffectiveCredential(host, explicit provider, gh/env precedence)
credentialKey = privateDigest(host, effective credential bytes or provider identity)
quotaKey = privateDigest(host, principalKind, verified principalId)
accessKey = privateDigest(credentialKey, authorizationGeneration, repository policy)
queryKey = privateDigest(host, canonical repository ID, accessKey,
                         resource, queryVersion, filters, pageSize, cursorGeneration)

request = { operation, quotaKey, accessKey, queryKey,
            worstCost:{core,graphql}, secondaryPoints, priority, deadline }
response = { httpStatus, selectedHeaders, graphqlErrors, observedCost,
             budgetEvidence, validatedPayload, etag, receivedAt }
snapshot = { schema, producerEpoch, queryKey, generation, rows, pageInfo,
             lastSuccessAt, lastChangedAt, nextDueAt, hold, capabilities }
```

Private digests are never collector wire identifiers or public diagnostics. The wire uses opaque session IDs and validated resource subscriptions. Canonical repository IDs come from admitted repository evidence, with a local remote-derived alias used before resolution. Repository renames update aliases, not data ownership.

GraphQL response bodies can contain errors with HTTP 200. Ingest trustworthy budget evidence even when data is unusable, but never publish a partial/malformed response as a complete fresh tab. An unexpectedly higher actual cost is recorded in full and disables that operation until its bound is corrected; it must not be discarded because it exceeds a reservation.

## Product policy defaults

`--refresh` remains a minimum interval, not a promise of an exact frequency. Add `--background all|off` (default `all`). Active subscription demand is aggregated per query; inactive demand does not create another producer.

| Resource state | Earliest normal check, assuming sufficient budget |
|---|---|
| New subscription or changed active data | Immediately once, then at the configured floor |
| Running or queued Actions | `max(floor, 5s)` |
| Actions quiet for two successful observations | `max(floor, 30s)` |
| Active Issues/PRs unchanged twice | `max(floor, 30s)` |
| Active Security unchanged twice | `max(floor, 60s)` |
| Inactive Actions/Issues/PRs | `max(12 × floor, 120s)` |
| Inactive Security | `max(12 × floor, 300s)` |
| No subscriptions | No data polling; collector engine idles |

Ordinary `r` joins/coalesces a fresh conditional check and replaces the next automatic deadline. Outside Width mode, add uppercase `R` for a one-generation resynchronization that drops validators and capability backoff only after admission. In Width mode, preserve both existing width-reset key meanings and perform no refresh. Both refresh actions preserve the reserve and secondary cooldown. Automatic corruption repair is bounded to one separately admitted unconditional retry.

Actions uses a stable 60-row request variant and the run's `name` when present; the workflow catalog is a conditional fallback with a 15-minute TTL. Issues/PRs start with 50 rows; scrolling near the last ten loaded rows acquires another explicit 50-row page, capped at the existing 150-row total. A first-page change invalidates later cursors/generations. Extra pages are refreshed only while demanded and retain truthful incomplete markers. Security keeps the existing bounded severity lanes.

Retained display targets increase from 5 to 32. Shared storage additionally has a 32 MiB total bound, a 1 MiB per-entity bound, 512 entities, at most 32 distinct live targets and 128 total active resource subscriptions. Evict inactive least-recently-used data first. Live targets are pinned within these caps; if all entries are pinned, reject new storage/subscription demand clearly instead of evicting live evidence or polling without safe ownership. Admission state is never evicted as cache data.

## Phases and coverage

All phases execute sequentially. None is `[batch-eligible]`: production changes overlap `index.mjs`, fixture changes also overlap, and later phases depend on earlier contracts. Independent review/research agents are useful; parallel implementation branches are not.

| # | Phase | Depends on | Research coverage |
|---|---|---|---|
| 1 | [Independent request oracle and regression scenarios](2026-09-05-multi-instance-efficiency-phases/phase-1.md) | — | Measurement/test gaps |
| 2 | [Credential/quota identities and controlled migration](2026-09-05-multi-instance-efficiency-phases/phase-2.md) | 1 | 5, 9 |
| 3 | [Authoritative GraphQL and explicit request costs](2026-09-05-multi-instance-efficiency-phases/phase-3.md) | 2 | 2, 9 |
| 4 | [Recovering scheduler and resource-specific observers](2026-09-05-multi-instance-efficiency-phases/phase-4.md) | 3 | 3, 4, 6, 7 |
| 5 | [Adaptive demand, smaller queries, refresh semantics](2026-09-05-multi-instance-efficiency-phases/phase-5.md) | 4 | 8 |
| 6 | [Shared acquisition, validators, capabilities, retention](2026-09-05-multi-instance-efficiency-phases/phase-6.md) | 5 | 1, 8, 10 |
| 7 | [Freshness and cost diagnostics](2026-09-05-multi-instance-efficiency-phases/phase-7.md) | 6 | Observability across all findings |
| 8 | [Optional local collector](2026-09-05-multi-instance-efficiency-phases/phase-8.md) | 7 | Local broker option |
| 9 | [SSH clients and cross-computer sharing](2026-09-05-multi-instance-efficiency-phases/phase-9.md) | 8 | Multi-computer architecture |
| 10 | [Webhook-assisted invalidation](2026-09-05-multi-instance-efficiency-phases/phase-10.md) | 9 | Optional event-driven extension |
| 11 | [GitHub App installation provider](2026-09-05-multi-instance-efficiency-phases/phase-11.md) | 10 | Optional installation authentication |
| 12 | [Sustained acceptance and release readiness](2026-09-05-multi-instance-efficiency-phases/phase-12.md) | 11 | All scenarios and documentation |

Phases 1–7 form a useful standalone milestone, 8–9 add shared collection, and 10–11 add opt-in integrations. Milestones permit review; they do not authorize partial remote pushes or releases. The requested complete scope is all 12 phases.

## Migration, rollback, and compatibility

Changing only the filename hash would create a second governor. Phase 2 therefore introduces an explicit migration gate and a stable versioned coordination root. Do not claim safe arbitrary coexistence with old binaries: their code cannot honor new sentinels. Refuse transition while discoverable legacy leases are live, require restarting old panes, preserve legacy evidence, and obtain clean observations after outstanding legacy uncertainty is reconciled or its window ends. Old versions in another root remain external consumers. Never kill user panes automatically.

Incompatible new state fails closed. A rollback requires stopping new producers/collector, preserving their ledgers, and honoring outstanding charges/cooldowns through clean reconciliation or the affected reset before older software is restarted. Never recover by deleting state or ignoring reservations. A shared data cache may be discarded with matching validators; quota authority may not.

The package remains Node >=22, ESM, one production `index.mjs`, no build/typecheck/test framework and no new runtime dependency. New named exports remain private test seams. Mode-specific entry dispatch must initialize its dependencies before execution and allow non-TTY collector modes without loading terminal lifecycle state. Initial collector hosting/stdio bridge support is macOS/Linux private Unix sockets; Windows hosting rejects the optional mode explicitly rather than using an insecure IPC fallback. Existing standalone behavior is retained. This platform boundary is part of the selected implementation scope, not an unresolved IPC design.

## Local gates required for every implementation phase

Follow the repository implement → independent review → fixes → quality/simplification review → verification loop. All commands run sequentially. A phase file's targeted criteria supplement this common gate:

```sh
npm run lint
node --check index.mjs
npm test
npm run test:coverage
npm run test:pty
git diff --check
```

Run the Node 22 and 24 unit/smoke selection locally: version/help, unknown argument exit 2, dashboard non-TTY exit 1, preflight failures, and mode-specific tests added by the plan. Capture each runtime version and result. Phase 12 adds the full sustained workload command and packed-artifact coverage. `npm run test:coverage:runtime` remains informational; run it for the final candidate and report actual coverage without inventing a threshold. Package boundary tests already exercise packing/installing (`test/package-boundary.test.mjs:37`). There is no build or typecheck step (`CLAUDE.md:10`, `CLAUDE.md:26`; `.github/workflows/ci.yml:42`).

A targeted PTY pass is never a substitute for canonical `npm run test:pty`. Do not weaken geometry or reserve assertions to fit new behavior; update transport-specific expectations where the intended API contract changes and add equivalent independent evidence.

Implementation takes place in isolated local worktrees/branches. Preserve this plan and research before creating them. After each approved phase, integrate verified work locally into `develop`; keep later work local through completion. Stop at each phase gate unless the user explicitly authorizes continuation. After all requested work and local gates pass, inspect triggers and push only completed `develop` once under the owner's policy. No feature pushes or remote PRs. Production stays a separately authorized `develop` → `main` release flow; no preview deployments.

## Final acceptance targets

Targets apply to deterministic fixtures with admitted capacity and 100 ms response latency unless noted. They are test contracts, not claims of GitHub latency guarantees:

- Ten identical panes generate one data request per due query/page generation after canonical identity resolution; ten different repositories produce ten attributable streams.
- A 3+4 split of clients across two config roots generates zero client-side GitHub requests and one collector stream per query.
- Running CI changes appear within the configured running interval plus 2 seconds; quiet-list changes within their policy interval plus 2 seconds; followers receive published generations within 2 seconds. Held-budget tests instead assert honest staleness, bounded work, and fair progress after recovery.
- A known primary reserve is never crossed by admitted data work. All 200/304, GraphQL cost, observer, secondary, timeout, and process-loss events reconcile with the independent oracle.
- Small-sample external throttling recovers within five minutes of verified quiet external use, with no optimistic budget increase. Secondary waits honor server deadlines even across resource resets.
- A 60-minute simulated workload of ten repositories preserves reserve and progresses across changing CI, mixed REST responses, GraphQL spend, external burn, reset, producer death, and subscriber churn.
- Ten-project restarts retain last-good rows; compatible validators survive; old producers and wire generations cannot overwrite newer data.
- Optional webhook/App features pass offline signature, delivery, token-expiry, permission-isolation, and no-secret-output tests.

Record requests, charged units, observers, coalesced consumers, queue wait, source-to-display p50/p95, subprocess count, elapsed time and CPU/RSS. Request and correctness thresholds are gates; CPU/RSS are measured comparisons to a locally captured baseline, not arbitrary universal percentages.

## Completion tracking

Planning review is complete. Independent controller and whole-plan reviews identified and resolved bootstrap allowance, phase prerequisite, installation observer, provider/socket routing, chunked-frame, reconnect freshness, Width-mode key precedence, and webhook deadline issues. Plan links, phase dependencies, code-reference ranges, Markdown fences and unresolved-marker checks were verified locally. This review validates the specification; implementation/runtime acceptance remains unchecked below.

- [x] Phase 1
- [ ] Phase 2
- [ ] Phase 3
- [ ] Phase 4
- [ ] Phase 5
- [ ] Phase 6
- [ ] Phase 7
- [ ] Phase 8
- [ ] Phase 9
- [ ] Phase 10
- [ ] Phase 11
- [ ] Phase 12

No unresolved design questions. User setup values (SSH alias, repository allowlist, App installation ID and private-key path, webhook secret and reverse-proxy endpoint) are runtime configuration inputs, not placeholders in the implementation design. No live setup is required to complete its local automated acceptance.
