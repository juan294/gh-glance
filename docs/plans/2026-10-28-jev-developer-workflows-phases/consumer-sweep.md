# Consumer sweep and change ownership

Parent: [implementation plan](../2026-10-28-jev-developer-workflows.md). Baseline `0319c9c58d211867ec35776357259b02b235909f`. Graphify orientation was followed by source searches. References are existing source anchors, not proposed edit line numbers. P1–P5 refer to the separate phase files. Re-run searches against the implementation base; resolve newly discovered callers before changing the corresponding contract.

## Reproducible searches

```sh
rg -n '\b(parseArgs|validateArgs|KEY_TABLE|keyTableLines|activeKeyHints|contextHelpPages|reconcileSelectionViewport|openSelected)\b' index.mjs test scripts
rg -n '\b(execFileAsync|execFileSync|spawn|spawn_)\(' index.mjs
rg -n 'executeChild|process\.env|GH_ENV_OVERRIDES|ChildEnvironment|SshEnvironment' index.mjs
rg -n 'OPERATION_COSTS|operationCost\(|readGovernorState|writeGovernorState|migrateGovernorState|normalizeGovernorIntent|normalizeGovernorReservation' index.mjs test scripts
rg -n 'GOVERNOR_.*VERSION|acceptVersion|version.*[<>=].*[678]|shaped.version' index.mjs test scripts
rg -n 'ISSUE_ROW|PR_ROW|GRAPHQL_QUERIES|GRAPHQL_QUERY_VERSION|GRAPHQL_PAGE_POINTS|fetchGraphqlPage|readGraphqlDocument|identifyOracleRequest' index.mjs test scripts
rg -n 'setup:actions-workflows|tab:actions-runs|actions/jobs|actions/runs|--log|GH_MAX_BUFFER|runAdmittedOperation|actionsSetup' index.mjs test scripts
rg -n 'normalizeCachedItem|normalizeDashboardCacheEntry|COLLECTOR_ROW_KEYS|normalizeCollectorSnapshot|projectCollectorSnapshot' index.mjs test scripts
```

## Input, rendering and CLI

| Callers/writers | Disposition |
| --- | --- |
| `index.mjs:11588`, `:11656`, `:11893`, `:11906`, internal exports `:20851`, `:20852` | P2 CLI options/defaults/validation; help/version stay provider-free |
| `index.mjs:11725`, `:11740`, `:11741`, `:11747`, `:11766`, `:16110`, `:16770`, `:17148`, `:17600`, exports `:21175`, `:21234`, `:21236` | P1/P2/P3/P5 additive mode-aware help/key consumers; preserve normal help priorities |
| `index.mjs:7054`, `:17651`, `:17850`, `:17947`, `:17963`, `:20291`, `:20298`, export `:21223` | P1 feature dispatch/selection, P3 CI selection, P5 local composite attention identity; no global itemKey rewrite |
| `test/args.test.mjs:17`, `:28`, `:32`, `:267`, `:274`, `:310`; `test/doctor.test.mjs:873` | P2 expected default shape and real CLI/env behavior |
| `test/context-help.test.mjs:33`, `:45`, `:70`, `:75`, `:76`, `:83`, `:93`, `:106`; `test/actions-setup.test.mjs:19`; `test/unit.test.mjs:93`, `:3640`, `:3646`, `:3662` | P1/P2/P3/P5 key/help consumers; retain existing Actions setup bindings |
| `test/pagination.test.mjs:203`, `:208`; `test/runtime-remediation.test.mjs:405`, `:409`, `:413`, `:420`, `:426` | P1 selection and hints regressions; P5 mixed-kind queue tests add separate keys |
| Existing PTY normal navigation, width, mouse, help, pagination and lifecycle suites; proposed feature PTYs | All UI phases run full PTY; add explicit mode precedence/return/cancellation rather than changing ordinary fixture rows |
| `scripts/package-check.mjs:300`, `:322`; `scripts/test-select.mjs:20`, `:296`; `scripts/release.mjs:27`, `:817` | Excluded from app parseArgs mutation: separate parsers, not consumers of its returned shape |

## Child environment and credential propagation

All product child creation paths below are P2 owners of the same immutable filtering contract. Strip TYPESAFE_API_KEY even when env was copied before the key was captured; test import has no environment side effect. P3 preserves metadata child lifecycle and adds a separate bounded native log request with lexical credential access, never a gh log child.

| Path | Evidence and affected tests |
| --- | --- |
| runGh injected/default child + merged overrides | `index.mjs:617`, `:833`, `:838`; `test/identity-transport.test.mjs:311`, `test/governor.test.mjs:700` |
| Local token and verified user bootstrap | `index.mjs:3014`, `:3015`, `:3462`, `:3463`; identity/transport tests |
| Boot/process-start probes | `index.mjs:4557`, `:4577`; governor/recovery tests and new dummy-env assertions |
| Browser launch, gh version, git repository preflight | `index.mjs:7130`, `:7178`, `:7191`; Actions setup/unit fixtures and new dummy-env assertions |
| SSH child and allowlisted env | `index.mjs:7267`, `:7314`; `test/ssh-transport.test.mjs:66` |
| GitHub App scoped child env | `index.mjs:7594`; `test/app-auth.test.mjs:276`, `:281`, `:298` |
| Git remote discovery, including fallback | `index.mjs:10861`, `:10872`, `:10875`; unit/identity setup fixtures |
| Interactive gh repo create | `index.mjs:20739`, `:20741`; onboarding PTY plus key-presence-only child fixture |
| Doctor summary and module export boundary | `index.mjs:10770`; P2 adds only safe booleans/counters if needed, never serializes provider settings or key; package exports remains empty |

Developer scripts launching the product are not shipped runtime children; their existing test env isolation remains. Proposed live evaluation captures its own explicitly authorized key and applies the same no-log/no-child propagation rule. Test-only transport preloading is scoped to `test/pty/capture.mjs:461` and proposed Jev fixture; it does not create a configurable production endpoint.

P3 extracts lexical credential access from `resolveEffectiveCredential` (`index.mjs:3002`) without changing its returned metadata contract; `createIdentityCoordinator` (`index.mjs:3430`) and `test/identity.test.mjs` remain token-free consumers. New native log use must match the captured digest/revision and pass no token to the storage request. Existing native App-token request (`index.mjs:7681`) is a pattern only; its provider/account behavior is not changed. Add native log closure/permit/death tests to identity-transport and governor coverage, using existing receipt helpers (`index.mjs:6104`, `:6146`, `:6159`) and permitted null child fields (`index.mjs:4171`). No generic direct-network escape from admission is introduced.

## Shared governor operations, protocol and writers

P3 covers every registry-dependent runtime branch found: `index.mjs:685`, `:751`, `:816`, `:2278`, `:2309`, `:4115`, `:4173`, `:4175`, `:4294`, `:4353`, `:4360`, `:4423`, `:5309`, `:5329`, `:5918`, `:6105`, `:11309`, `:15714`, `:16391`, `:16606`, export `:20863`. Review derived maximum atomic cost/fairness even if the added two-point operation does not increase the existing maximum. Existing operation values are unchanged; new operation names are strict, never arbitrary accepted strings.

P3 covers ledger readers/writers/migration callers: `index.mjs:3167`, `:3190`, `:3191`, `:3279`, `:3314`, `:3364`, `:3372`, `:3504`, `:3538`, `:3565`, `:3582`, `:4395`, `:4485`, `:4891`, `:4905`, `:4919`, `:4926`, `:4964`, `:5273`, `:5292`, `:5300`, `:6428`, `:6493`, `:7753`, `:7755`, `:7806`, `:16285`, exports `:20921`, `:20923`. Canonical same-path migration and legacy identity-path migration are different entry points; neither may bypass the live-old-lease hold. Read-only `persistMigration:false` callers must report the hold without mutation. The updater remains under the existing lock. Identity bootstrap, debt import and control completion (`:3314`, `:3364`, `:3372`, `:3504`, `:3538`, `:3565`, `:3582`) and App quota initialization (`:7753`, `:7755`) use the same backup-before-first-write contract; quota diagnostics (`:6493`) stay genuinely read-only.

| Consumer | Phase disposition |
| --- | --- |
| `test/governor.test.mjs:254`, `:529`, `:625`, `:881`, `:901`, `:917`, `:2981`, `:3037`, `:3047`, `:3151`, `:3524`, `:4439` | P3 ledger fixtures, protocol6 literal fix, real7 preservation/restart and added operations; actual old-reader command complements these tests |
| `test/scheduling-policy.test.mjs:483`, `:486`, `:501`; `test/identity.test.mjs:261`, `:316`, `:361` | P3 version mismatch, same-path versus old-path migration, no quota split |
| `test/recovery.test.mjs:34`; `test/unit.test.mjs:2900`, `:2941`; identity-transport tests at `:278`, `:548` | P3 recovery contract, operation completeness, child closure and conservative settlement |
| `index.mjs:4907`, `:5292`, `:5300`; identity/App quota writers above | P3 explicit mutator-first backup oracle, including a rejected mutation that still persists migration; read-only diagnostics create neither backup nor ledger writes |
| `scripts/freshness-monitor.mjs:11`, `:170`; `test/freshness-monitor.test.mjs:349` | P3 read-only ledger consumer must disclose restart/version mismatch; never persist migration from monitoring |
| `scripts/sustained-recovery.mjs:13`, `:390`; existing governor fixture writers in recovery/PTY tests | P3 preserve shape7 accounting semantics in version8; literal historical fixtures remain historical |
| `index.mjs:15795`, `:15815`, `:15850`; doctor/remediation/help and README | P3 mismatch/restart/storage copy; no advice to delete ledger for version mismatch |

## GitHub queries, REST routes and fixture producers

| Consumer | Phase disposition |
| --- | --- |
| `index.mjs:1008`, `:1116`, `:1126`, `:1130`, `:1892`, `:16390`, `:16577` | P3 gh JSON detail adapter and separately admitted native log accounting; P5 static attention query with explicit GraphQL metrics; preserve generic callers |
| `test/graphql.test.mjs:42`, `:49`, `:51`, `:58`, `:59`, `:66`, `:157`, `:296` | P5 query registry/finite bounds/meter validation, partial errors and overrun; existing source query version unchanged |
| `test/fixtures/request-oracle.mjs:79`, `:114`, `:124`, `:139`, `:146` | P5 strict new grammar for fixed aliases/inline fragments/directives, scalar variables, independent cost classification |
| `test/fixtures/request-oracle.mjs:236`, `:242`, `:294`, `:324`; `test/request-oracle.test.mjs:117`, `:156`, `:271`, `:284`, `:295` | P3 exact run/attempt/jobs paths and separate native log event classification; reject gh log invocation; P5 attention query classification; no production-parser reuse as truth oracle |
| `test/pty/fixtures/graphql-response.mjs:31`, `:71`, `:94`, `:106`; `test/pty/fixtures/graphql.mjs:6`, `:12`; `test/pty/fixtures/gh-state.mjs:14`, `:90` | P5 explicit per-candidate details, own cost/meter fixtures; source row projectors unchanged |
| `test/pty/fixtures/gh-state.mjs:108`, `:123`, `:314`, `:330`; `test/pty/fixtures/gh:306`, `:324`; `test/pty/fixture-api.test.mjs:215`, `:239` | P3 metadata/error/partial routing; gh log attempts are forbidden; proposed `test/pty/fixtures/ci-https.mjs` handles native API/storage responses and separate attempt counters, with the real adapter exercised |
| `test/pty/graphql-budget.test.mjs:45`; `test/pagination.test.mjs:63`; `test/acquisition.test.mjs:1010`; `test/app-auth.test.mjs:418` | P5 regression: ordinary list projection/request counts stay unchanged; new detail costs separately asserted |
| `scripts/measure-efficiency.mjs:43`, `:220`, `:237`, `:254`, `:542`, `:662`, `:873`; `test/fixtures/capture-request-baseline.mjs:105` | P3/P5 count new explicit detail operations distinctly; ordinary idle has none; keep historical list counters meaningful |
| `scripts/release-candidate.mjs:465`, `:475` | Excluded: existing release metadata reader, not reusable runtime transport or newly authorized release work |
| `test/pty/actions-setup.test.mjs:65`, `:151`, `:191`; `test/pty/remote-collector.test.mjs:88` | P3/P5 preserve setup lifecycle; connected mode explicitly unsupported with browser fallback and zero local detail/model calls |

## Source schema exclusions, package and discovery

No source row, cache or collector schema change is planned. Keep `index.mjs:1941`, `:1950`, `:7239`, `:8848`, `:8862`, `:8884`, `:8886`, `:8903`, `:9024`, `:9074`, `:13355`, `:13428`, `:14021`, `:14028`, export `:21050` unchanged in semantic contract. Read/source-regression coverage includes `test/app-auth.test.mjs:616`, `test/collector-protocol.test.mjs:112`, `:196`, `scripts/measure-efficiency.mjs:1216`, `test/acquisition.test.mjs:46`, `:1429`, `test/collector.test.mjs:20`, `:1040`, `test/webhooks.test.mjs:29`, `:799`, `test/cache.test.mjs:59`, `test/graphql.test.mjs:134`, `test/poll-policy.test.mjs:372`, `test/freshness-monitor.test.mjs:349`. Existing PTY source writers in onboarding, status, help, identity-migration, cache, conditional-polling, shared-acquisition, adaptive-polling, identity-switch, throttle, governor, runtime, e2e, background-progress and pacing-credit require no payload rewrite. Full required gates catch accidental format changes.

P2 updates dependency/lockfile only, preserving exact shipped application files and empty exports (`package.json:9`, `:10`). Exact-package install exercises validate both supported Node majors; do not add source exports or shipped fixture/evaluation files to make tests easier. New normal `test/*.test.mjs` and PTY files are already discovered (`package.json:21`, `scripts/test-select.mjs:59`, `:71`); **do not change CI routing/selector policy**. Proposed compatibility/transport scripts are explicit local sequential gates, not new hosted workflows.

P1–P5 update README feature/key/limitation documentation as each feature becomes available. CONTRIBUTING documents only added test/evaluation commands and evidence requirements. Release version/tag/changelog publication and hosted CI remain outside implementation authority; locally record the mandatory all-panes restart in the migration phase documentation for later release preparation.
