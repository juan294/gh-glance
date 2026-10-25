# First-run experience implementation plan

Date: 2026-10-25. Status: All three phases accepted locally. See [implementation notes](2026-10-25-first-run-experience-notes.md).

## Objective and baseline

Make a new repository's dashboard explain the selected target, whether a check succeeded, what an empty result means, and whether the user needs to act. Implement the direction accepted in [the assessment](../research/2026-10-25-first-run-experience-assessment.md:40), including contextual empty states, freshness explanations, discoverable help, and optional Actions setup diagnosis.

Revalidated baseline: `develop` at `4b2a8d3cfdd12b6ac0b7a8a70bcd3bf6349e7aa9`, `/Users/juan/code/gh-glance`, package 0.16.2. No tracked changes at planning start. The assessment and unrelated `supabase/` directory were untracked; preserve both. The screenshot's executable SHA and the reported Issues incident remain unverified. This plan fixes presentation contracts, not an assumed governor defect.

Controlling contracts: `AGENTS.md`, `CLAUDE.md`, the already-read RPI and push-accountability rules, `.agents/skills/rpi-plan/SKILL.md`, its pseudocode and handoff references, and `.rpi/rules/testing.md`. Planning uses integration; implementation uses an isolated local worktree/branch. Retain the single-file runtime and Node test runner. Sutura owns CI routing; no workflow, routing, settings, credential, or publication changes are included.

## Evidence and decisions

| Evidence | Decision |
| --- | --- |
| Generic empty renderer and unconditional headers at `index.mjs:19959` and `index.mjs:19982` | Replace empty table chrome with a state-specific panel; keep populated tables. |
| Data is `null` before success and `[]` after a successful empty response at `index.mjs:16978`; first-load detection at `index.mjs:19550` | Preserve unknown versus zero; do not use row count alone to determine truth. |
| Freshness uses source timestamps at `index.mjs:16644` and `index.mjs:19688` | Do not reset timestamps or extend freshness thresholds for onboarding. |
| Recovery presentation at `index.mjs:15763` | Add explicit snapshot presence to presentation; no snapshot means “Not checked yet”; future/unknown timestamps with retained data mean “Last-check time unavailable”, not “Not checked yet”. |
| Default on-demand behavior at `README.md:326`; cached status override at `index.mjs:19710` | Explain saved results on Issues/PRs/Security without calling intentional on-demand inactivity an outage. |
| Repository resolvers already exist at `index.mjs:1273` and `index.mjs:1282` | Display the selected host/repository using the existing resolver, with no extra identity lookup. Selection is not proof of access. |
| Help and input dispatch at `index.mjs:11564`, `index.mjs:17446`; footer hints at `index.mjs:16403` | Make `?` visible and add contextual paginated help while preserving quit, refresh, row-open and width-mode behavior. |
| Workflow-name fallback at `index.mjs:1529` and `index.mjs:1753` | Keep its request, parser, and cache unchanged; create a separate bounded setup observation. |
| Declared operation costs at `index.mjs:2211`; admission/settlement at `index.mjs:16219` | Setup is one explicit governed operation, never an unaccounted gh call or periodic poll. |
| Collector snapshot exact-key contract at `index.mjs:8698`; connected client acquisition at `index.mjs:18262` | No collector protocol expansion. Explain that in-app setup checks are available in standalone mode; connected clients can open the target's Actions page. Never fall back to local credentials. |

The GitHub [workflow-list API](https://docs.github.com/en/rest/actions/workflows#list-repository-workflows), retrieved 2026-10-25, supports a first page of up to 100 workflows and returns `total_count` and per-workflow `state`. Use those fields to distinguish positive evidence, complete emptiness, and incomplete coverage. This is not an Actions permissions/settings audit or a diagnosis of why a specific push did not run.

## Options selected

Text-only replacement is cheap but cannot resolve setup uncertainty. A mandatory wizard interrupts configured repositories. Automatic setup scans add startup cost and new failure paths. Select contextual state presentation plus an explicitly requested setup check. Avoid first-run persistence: the same guidance should work for any empty repository.

Use a process-local setup cache rather than changing durable acquisition/dashboard schemas. This avoids migration and mixed-version protocol work; repeated launches may each incur one user-requested call. Different panes may each request a check, but every request remains governed. Cross-pane deduplication for this optional operation is excluded.

## Scope and phase gates

1. [Phase 1: truthful empty and recovery states](2026-10-25-first-run-experience-phases/phase-1.md).
2. [Phase 2: target identity and discoverable help](2026-10-25-first-run-experience-phases/phase-2.md).
3. [Phase 3: optional Actions setup diagnosis](2026-10-25-first-run-experience-phases/phase-3.md).

Each phase is independently useful and accepted sequentially. All touch `index.mjs` and shared rendering fixtures, so there are **no batch-eligible implementation units**. One integration owner owns source, tests, and phase-local docs. Independent read-only review may run separately. Do not push working branches or create PRs.

Out of scope: adding workflows, enabling/dispatching Actions, CI cadence changes, credential changes, new providers, collector protocol/schema migration, fixing an unidentified live staleness incident, a forced tour, telemetry, and releases.

## Shared behavior contract

Introduce a pure `dashboardPresentation` helper in `index.mjs`. Inputs explicitly include tab, snapshot presence, rows, successful-source timestamp/age evidence, freshness state, request state, error/recovery, on-demand policy, security coverage, and selected target. Return semantic state, title, explanation, source-check line, recovery action, and whether to show table chrome. Reuse current status semantics; do not create a second scheduler.

```text
@ dashboardPresentation(input) -> view
pre: null rows mean no snapshot; empty rows alone never prove freshness
do:
  1. validate snapshot, time and error evidence
  2. compute blocking cause before an empty-result claim
  3. compute source-check and recovery lines from evidence
  4. emit bounded contextual content or populated-table metadata
br: cached rows survive failure; successful empty snapshots retain their check time
fail: incomplete or unknown evidence -> disclose uncertainty
```

Resolve conflicts in this order: no-remote setup remains global; an actual error/disconnection/hold remains visible even during refresh; unknown without failure distinguishes queued versus in-flight; known results distinguish overdue versus normal saved/on-demand versus fresh. A running request may add “Updating” but cannot erase the failed or old observation. A known-empty snapshot with a current error uses “Last check found no …” under the failure headline, never an unqualified success. Existing source age and `freshnessDeadline` remain authoritative.

Use absolute local check time (date included when not today) for contextual panels. Avoid a new ticking “just now” timer or rapid repaint. Retain existing minute-granular footer freshness. A future source timestamp or uncertain age is disclosed without fabricating freshness. Do not call a collector receipt time a source check.

### Checkable copy oracle

These are intended assertions for new `test/onboarding.test.mjs` and `test/pty/onboarding.test.mjs`, not tests already executed. Source-check times are injected deterministically.

| ID | Input/evidence | Required output/forbidden claim |
| --- | --- | --- |
| CX-01 | Actions successfully returns `[]`, fresh | “No workflow runs found”; explains automated jobs and matching workflow triggers; no table headings, viewport count, or “all caught up”. |
| CX-02 | Issues/PRs successfully empty | “No open issues” / “No open pull requests”, source check time. |
| CX-03 | No snapshot, in-flight | “Checking Issues…”; no `(0)` or empty-result claim. |
| CX-04 | No snapshot, admission wait | “Waiting to check Issues”, known cause and honest retry/action; no cache claim. |
| CX-05 | No snapshot, failed request | “Could not load Issues”, classified cause and visible remedy; no spinner implying indefinite progress. |
| CX-06 | Cached empty or populated snapshot, failed refresh | “Could not refresh Issues”, original check time, known cause/action; retains prior result. |
| CX-07 | Overdue data, no failed request | “Issues needs an update”; never invent a network failure. |
| CX-08 | Settled on-demand snapshot | “Saved Issues view”, source check time, explain `r`; no promise of continuous polling. |
| CX-09 | Snapshot exists but source timestamp is future/unknown | “Last-check time unavailable”; never “Not checked yet” or “checked just now”. |
| CX-10 | Security empty with partial/disabled/unavailable sources | Retain coverage notes; no global “no alerts” or safe/secure claim; all sources unavailable yields that headline. |
| CX-11 | Failed/waiting state later succeeds | Clear the stale error/cause; render new result with new successful-source time; no reset from cache receipt alone. |
| CX-12 | Unchanged successful empty polls | No new spinner or fast timestamp churn; bounded idle output under existing efficiency oracle. |
| CX-13 | 24/45/80/120 columns and 10/24 rows | Phase 1: context panel fits, quit/refresh and concise remedy remain visible, no phantom width controls, resizing recovers. Phase 2: discoverable help and reachable complete overflow. |
| CX-14 | No remote / authentication / local-state fault | Existing setup or actionable recovery persists; no misleading healthy welcome. |

## Stuck states and recovery

All states refer to users viewing the affected tab; provider-specific cases are explicit. Pair every safety assertion with a transition or disclosure assertion.

| State | Visible disclosure | Exit/recovery and proof |
| --- | --- | --- |
| First request still active | Checking tab; no zero count | Existing timeout becomes failure; successful fixture becomes results (CX-03/05/11). |
| First check blocked by shared admission | Waiting to check; distinguish local pacing from GitHub limit | Ordinary data retries remain scheduler-owned; show known deadline, otherwise honest waiting and `?` details (CX-04/11). |
| No remote / ambiguous target | Existing remote setup or “Repository unresolved”; help shows explicit-target command | Remote setup/restart with explicit target resolves it; existing no-remote PTY plus Phase 2 target tests. |
| Login/access/network failure | Could not load/refresh; actual classified remedy | Known automatic network retry stays automatic; auth action is shown; success clears it (CX-05/06/11). |
| Corrupt/full/unwritable coordination | Cause plus `gh-glance --doctor` and storage remedy | No claim of automatic repair; actionable diagnosis remains visible until recovery (CX-14, existing recovery tests). |
| Saved/overdue data | Original check time and correct saved/overdue label | Activation/`r` follows current policy; successful source observation clears overdue status (CX-07/08/11). |
| Clock uncertainty | Last-check time unavailable | Later valid observation restores time; no false zero age (CX-09/11). |
| Security incomplete | Checked-source scope and unavailable-source notes | Later complete fixture removes limitation; unavailable fixtures never render clearance (CX-10/11). |
| Narrow/short pane or long identity | Short title and help affordance | Paginated wrapped help exposes full target/cause; resize restores content (CX-13, NAV-03). |
| Setup probe cannot be admitted | “Could not check Actions setup”; hold/cause; `s` retry and known deadline | No hidden retry promise; retry after safe grant succeeds (SET-06). |
| Setup probe fails/malformed/incomplete | Setup status separate from run-list result, cause or coverage limit | `s` retry after bounded cooldown, `g` opens Actions; valid next response replaces it (SET-04/05/06). |
| Retryable receipt accounting after a valid setup result | Valid source observation may render; persistent storage/coordination fault keeps its existing remedy visible | Existing terminalization queue retries the original receipt, conservatively retaining the charge; no repeated HTTP request (SET-06). |
| Setup response establishes shared resource hold, including failed hold publication | Setup explains request limit; ordinary tabs show coordination wait without a fabricated run-list fetch error | Existing shared publication/recovery path pauses and later resumes resource traffic; original rows/time remain (SET-06/11). |
| Setup cache old or account changes | Checked timestamp; old entry never crosses identity boundary | `s` refreshes expired entry; account change aborts/discards result and shows check-again prompt (SET-07/08). |
| Collector/SSH setup check unsupported | “Setup checks are available in standalone mode”; `g` Open Actions | No local gh fallback; opening target works or visible opener error gives URL (SET-09/10). |
| Browser opener fails | “Could not open Actions” and target URL in help | Retry `g`; q and normal refresh still work; no poisoning Actions fetch status (SET-10). |
| User leaves/quits during setup work | Current tab remains responsive | Abort on quit/scope change; tab switch retains bounded in-flight check without forcing Actions focus (SET-08/11). |

## Consumer sweep

Searches used on the baseline: `rg -an 'presentRecovery|activeKeyHints|refreshStatus|statusBarLayout|helpLines|workflowCatalogDemand|actionsWorkflowsArgs' index.mjs test scripts README.md`; `rg -an 'OPERATION_COSTS|catalog:actions|doctor:actions-workflows|measuredNestedOperationCost|bodyRows|extraLines|fullHeaderVisible' index.mjs test scripts`; and `rg --files test scripts`. A read-only independent test/fixture sweep supplements this inventory below. Repeat searches after implementation to catch new consumers.

| Shared seam and consumers/writers | Coverage/disposition |
| --- | --- |
| `presentRecovery`: definition `index.mjs:15763`, App call `index.mjs:19632`, test export `index.mjs:20635` | Phase 1: explicit snapshot presence for App; preserve fallback for non-UI callers with missing metadata. |
| Direct recovery consumers `test/recovery.test.mjs:127`, `:165`, `:175`, `:350`; `test/identity.test.mjs:299`; `test/governor.test.mjs:1353` | Phase 1: run all; update only intentional copy assertions; retain future-time uncertainty test. |
| `refreshStatus`: App `index.mjs:19557`, `:19704`, `:19713`; StatusBar `index.mjs:16790`; `test/unit.test.mjs:1595`, `:3713` | Phase 1: preserve semantic kinds and scheduling; new panel takes source facts, not just footer label. Existing status precedence tests remain. |
| `activeKeyHints` / `statusBarLayout`: StatusBar `index.mjs:16789`; `test/runtime-remediation.test.mjs:420`; `test/unit.test.mjs:1722` | Phases 1–3: disable width on tableless states; prioritize Help after Quit/Refresh; add contextual s/g without dropping essentials. |
| `KEY_TABLE`, `keyTableLines`, `helpLines`: `index.mjs:11564`, `:11579`, `:11599`; App `:19921`; `test/runtime-remediation.test.mjs:451` | Phase 2 preserves `helpLines` existing fallback; adds contextual paging, updates key descriptions and small-pane tests. Phase 3 registers s/g. |
| Empty UI, `bodyRows`, `extraLines`, `fullHeaderVisible`, width refs, selection reconciliation: `index.mjs:17079`, `:19732`, `:19826`, `:19982` | Phase 1: one computed layout budget drives rendering and interaction; phase 2 help and phase 3 setup use it. |
| Target resolvers `index.mjs:1273`, `:1282`, `:1292`; topLabel `:19794`; acquisition query `:13670`; `resetVisibleScope` `:18668` | Phase 2 reads resolver outputs without changing their contracts. Phase 3 clears session state on identity/scope reset. Existing identity/acquisition tests unchanged unless adding cases. |
| `actionsWorkflowsArgs` consumers `fetchActions` `index.mjs:1765`, `doctorProbePlan` `:10942`, `test/acquisition.test.mjs:1087`; `workflowCatalogDemand` and `test/poll-policy.test.mjs:211` | Explicitly unchanged: separate setup args/parser avoids changing name-fallback and doctor projection. Phase 3 regression asserts zero automatic setup calls. |
| `OPERATION_COSTS`, `operationCost`, `measuredNestedOperationCost`, `runGh`, `runAdmittedOperation`: `index.mjs:2211`, `:2241`, `:16032`, `:750`, `:16219` | Phase 3 adds one declared operation; existing admission/receipt/transport paths execute unchanged. Test cost and settled/failed/aborted calls. |
| Browser launch `openInBrowser`, `rowBrowserUrl`, `createOpenRequestRegistry`: `index.mjs:6955`, `:6971`, `:6996`; App `:17429` | Phase 3 extracts reusable validated URL launcher; preserve all row-opening behavior and test consumers; new setup errors are separate. |
| Dashboard cache `loadDashboardCache`, `cacheSuccessfulTab`; acquisition snapshots; recovery journals; collector snapshot validator `index.mjs:8698` | No persisted format change. Phase 1 consumes presence/time; Phase 3 setup cache is ephemeral. Existing cache/collector/SSH fixtures remain valid and are regression gates. |

Independent sweep also ran `rg -an 'no runs|no open issues|no open PRs|no alerts|cached age unavailable|waiting for API budget|Actions ·|Refresh.*Quit|Show the keys|Help|INK_SCREEN_READER|NO_COLOR|actions/workflows' test scripts README.md` and `rg -al 'dashboard-cache.json|saveDashboardCache|normalizeDashboardCache|dashboardCacheTarget' test scripts index.mjs`. Its additional consumers/writers are explicitly assigned here:

| Fixture/script consumer | Coverage/disposition |
| --- | --- |
| `test/pty/cache.test.mjs:158`; `test/pty/identity-migration.test.mjs:147`, `:173` | Phase 1 updates exact text assertions **and wait barriers** for changed copy; do not let an obsolete “no alerts” barrier turn into a timeout. |
| `test/pty/status.test.mjs:336`, `:404`, `:777`, `:1051`, `:1095`; `test/pty/runtime-remediation.test.mjs:133`, `:387`, `:413` | Phases 1–2 cover recovery, no-color, reader output and short help. Preserve automatic reader Checking suppression and manual Checking. |
| `test/pty/readme-sample.mjs:1`; README sample and key table at `README.md:25`, `:35`, `:256`, `:309`, `:562` | Phase 2 updates/regenerates applicable terminal samples; Phase 3 updates action hints. Preserve the distinction between automated reader-output verification and untested assistive technology. |
| `test/pty/fixtures/gh:321`, `test/pty/fixtures/gh-state.mjs:116`, `test/pty/fixtures/actions-workflows.json`, `test/pty/fixture-api.test.mjs:215` | Phase 3 distinguishes existing name-list projection from setup envelope; add explicit complete/partial/error scenarios without globally changing existing fixture semantics. |
| `test/fixtures/request-oracle.mjs:236` | Phase 3 covers page-1 route and one-call unit cost with independent transport accounting; preserve ordinary entity/query behavior. |
| `test/pty/adaptive-polling.test.mjs:160`, `:180`, `:208`; `test/pty/conditional-polling.test.mjs:79`, `:160` | Phase 3 preserves automatic request-count/caching contracts and adds explicit-action checks separately. |
| `test/efficiency.test.mjs:120`, `scripts/measure-efficiency.mjs:45` | Phase 3 extends explicit-action workload evidence only if needed; unchanged workloads retain existing thresholds. |
| Dashboard-cache writers: `test/cache.test.mjs`, `test/pty/cache.test.mjs`, `test/pty/status.test.mjs`, `test/pty/runtime-remediation.test.mjs`, `test/pty/mouse.test.mjs`, `test/pty/governor.test.mjs` | Excluded from schema edits because no schema changes are planned; retained as regression fixtures, with copy/barrier changes only where assigned above. |
| `test/pty/shared-acquisition.test.mjs:200`; `test/pty/remote-collector.test.mjs:27`; `test/collector-protocol.test.mjs` | Phase 3 preserves shared query ownership, strict snapshot validation and no local acquisition from connected clients. |

Additional browser sweep: `rg -an 'openInBrowser|rowBrowserUrl|createOpenRequestRegistry|BROWSER_OPENERS' index.mjs test scripts`. Phase 3 covers `test/graphql.test.mjs:133`, `:137`, `:154`; `test/ssh-transport.test.mjs:259`, `:263`; `test/runtime-remediation.test.mjs:385`; `test/governor.test.mjs:1449`, `:1453`; `test/pty/selection.test.mjs:36`; and the fallback scenario in `test/unit.test.mjs:401`. Retain the platform opener fixture scripts `test/pty/fixtures/open` and `test/pty/fixtures/xdg-open`; add setup URL assertions without weakening row URL validation.

Files listed without a single line are whole-file writer inventories, not claims about a specific statement. No durable state writer is authorized to add setup fields.

## Verification and acceptance

Each phase follows failing behavioral tests → implementation → independent review → repairs → codex-simplify → verification. Keep targeted and full checks sequential. Aggregate failures; a later pass does not erase an unexplained failure.

For each phase run `npm run lint`, `node --check index.mjs`, `npm test`, and `npm run test:pty`. Phase 3 also requires `npm run test:efficiency`. Any earlier acquisition/scheduling change triggers that extra gate too. There is no build/typecheck step. No new framework or dependency is planned. Record commands, outcomes, base/current SHA, dirty state and exactly tested candidate in each phase handoff.

Automated acceptance is the CX/NAV/SET matrix and existing regression suites. Manual acceptance is limited to visual/readability judgment: inspect deterministic terminal captures for 45×24 and 80×24, confirm the state, explanation, action hierarchy, then inspect 24×10 recovery and screen-reader output. A human usability study is not a release gate and is not claimed. No manual GitHub setup operation is required. Cross-platform visual validation not performed must be reported as unmeasured.

## Durable handoff

Authorization: planning only. No implementation, tests, commits, pushes, settings changes or publication in this turn. Assessment findings 1–7 are all covered by the three phases; the unidentified live Issues cause remains explicitly outside the diagnostic evidence. The provider restriction is an intentional scope decision, with visible fallback and regression tests, not a silent unsupported path.

Accepted invariants: gh-owned auth, no new poll cadence, accurate source age, preserved quota accounting, no repository health inference from one endpoint, no persistent setup schema, no local acquisition for connected clients. Revalidate worktree identity and preserve unrelated files on resume. Phase 1 entry requires the implementation workflow to be authorized and the current source to match or be reconciled with this baseline. Stop after each phase unless continuation is explicitly authorized.

Planning review: one independent read-only consumer investigation and plan review completed. Four findings were resolved locally: distinguish retryable receipt accounting from terminal failure; allow real shared rate limits to delay traffic without inventing a run-list error; split narrow-help acceptance across Phases 1/2; enumerate fixture writers and text wait barriers. The review also identified future-clock age and connected-provider boundaries, both incorporated. A final independent reread confirmed all four repairs and no remaining blockers within review scope. No required investigator result is missing.

Planning checks: all four plan files passed local-link, trailing-whitespace, unresolved-marker and pseudocode-format checks; tracked diff whitespace check passed. Application tests were not run because only planning documents changed. Remaining product decisions: none; executable evidence belongs to implementation. No implementation behavior is reported as tested or complete.
