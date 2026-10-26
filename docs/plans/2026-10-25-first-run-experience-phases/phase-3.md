# Phase 3 — Optional Actions setup diagnosis

Parent: [first-run experience plan](../2026-10-25-first-run-experience.md). Requires Phases 1 and 2 accepted.

## Scope and user interaction

On the Actions tab, `s` requests a read-only setup observation and `g` opens the selected repository's Actions page. Show both in the contextual empty screen/help; populated Actions may expose them in help without changing row Enter. Help explicitly says “Close help with ?, then press s/g”: s/g while help is open only dismiss it, consistent with Phase 2; they do not fall through. Quit/Refresh/Help retain priority in cramped footers. Setup state has its own result/error and never changes Actions rows, counts or source-success timestamps. It does not reschedule ordinary polls except when a genuine shared quota/transport hold requires all affected traffic to wait. r/R continue to refresh tab data and do not trigger setup probes.

Standalone only: `runtime.connect === null`. On collector/SSH clients, s shows “Setup checks are available in standalone mode. Press g to open Actions.” No local gh call, collector protocol change, or remote command is added. g works only with a valid selected host/repository and never enables, edits, or dispatches workflows. Unknown target gets the visible explicit-target remedy.

Own `index.mjs`, new `test/actions-setup.test.mjs`, onboarding PTY/unit tests, request/operation-cost/identity fixtures and tests, browser opener tests, efficiency cases, and README. The workflow-name fallback and doctor API projection remain unchanged.

## Observation contract

Add separate `actionsSetupArgs` and strict `parseActionsSetup` helpers, preserving `{total_count, workflows: [{id, name, state}]}` from one GET to `repos/{owner}/{repo}/actions/workflows?per_page=100&page=1`. No auto-pagination, settings lookup, YAML fetch, or trigger analysis. Validate a nonnegative safe total, bounded array, unique valid IDs, safe names and string states. Contradictory counts, missing fields or empty transport output are unusable, not empty success. Unknown state values are preserved as unknown; do not classify them as disabled.

Complete observation requires a valid body and `total_count === workflows.length` (and no next-page evidence if response metadata supplies it). `total_count === 0 && workflows.length === 0` proves only that no workflows were listed. If a page is incomplete, say “Workflows found; setup check incomplete” and report only the observed portion. Show “All listed workflows are disabled” only when coverage is complete, nonempty and every state is a recognized disabled state; otherwise report observed disabled entries without global conclusions. States `disabled_manually` and `disabled_inactivity` are recognized; unfamiliar non-active states remain “other state”. Never infer Actions is disabled repository-wide from HTTP 403/404 or zero workflows.

Session cache: at most the current target/access partition, successful observations retained for 5 minutes. Key by provider, host, resolved repository and current access key; capture a generation token for completion fencing. Success and partial valid observation get an original checked-at timestamp. Repeated s within TTL reuses it and says it is the saved setup check; disclose when s will check again. No force-bypass key is added. An expired result remains explicitly dated until s starts a new observation. Errors do not replace the last successful observation; their visible error is separate. Failure/retry cooldown is at least 30 seconds and at least any known shared hold deadline; show “Press s to retry” plus known earliest retry. Clock rollback expires session success conservatively and never invents an age.

## Request and lifecycle design

Add `setup:actions-workflows` with `{core: 1, graphql: 0}` to `OPERATION_COSTS` (`index.mjs:2211`). Use `runAdmittedOperation` with manual priority and the existing `GOVERNOR_ADMISSION_WAIT_MS` bound (`index.mjs:2260`, `:16219`), `ghApi` and current transport/receipt accounting. Bind the captured host/repository/access to the request context. Missing scope is a disclosed unavailable setup check, not permission to bypass admission. Ordinary control-plane work continues to establish/recover scope.

Preserve `runAdmittedOperation`'s return contract. A retryable receipt write (`busy`/`unwritable`) is not a failed source observation: the helper may return success while `queueTerminalization` (`index.mjs:6097`) retains conservative charge and retries the captured receipt. Allow a valid setup result into the session cache in this case. Keep any persistent storage/coordination fault's existing visible remedy; do not describe it as a failed GitHub check. Only a returned admission/request/identity or terminal blocked/compacted error prevents publishing a new setup success. No new receipt poller, helper return fields or duplicate HTTP request is allowed. This distinction governs every mention of settlement failure below.

Integrate the handler with the polling effect's scope lifecycle through a ref, like existing manual tab requests. Use a dedicated one-operation in-flight record and AbortController, separate from tab-data in-flight flags. Repeated keypresses do not queue another setup request. Retire/abort on identity change, lost scope, remote setup, effect cleanup or quit; settle against the captured original scope and discard late results. Do not release a scope still needed by the setup operation without the normal receipt lifecycle. A tab switch does not cancel or focus-steal; completion is shown on return. A bounded failure is disclosed and retries only on s; do not claim automatic setup retry.

Classified 429/secondary-limit responses must participate in the existing shared transport/limit publication behavior. Reuse `handleRateLimitBlocks`/pending publication (`index.mjs:18636`, `:18603`) with the existing `actions` tab key, because this is an Actions-originated operation; do not invent a setup tab key. Keep its source error in setup state rather than `errors.actions`. Resource-wide coordination/governor status and poll admission are allowed to change, including a fail-closed publication pause. The UI must explain the shared hold, not claim that the run-list fetch failed. Existing rows and their source timestamps remain intact. Once hold publication/recovery succeeds, ordinary polling resumes under the existing scheduler; retrying setup itself still requires s. Test the publication-fails→recovers sequence with concurrent data traffic.

```text
@ requestActionsSetup(target, scope, cache) -> setupState
pre: explicit s intent; standalone provider; validated target and current access
do:
  1. validate generation, cooldown and single-flight guard
  2. lookup fresh session observation
  3. compute admitted one-request operation when cache is expired
  4. parse response with coverage evidence and settle receipt
  5. cache observation only for the unchanged access generation
br: unsupported or denied -> emit cause and visible retry/navigation action
fail: request or settlement fails -> retain dated prior observation and disclose failure
```

For g, extract a reusable URL-launch helper from `openInBrowser` (`index.mjs:6971`) while retaining row URL validation/behavior. Build the Actions URL only from validated effective host and repository; launch via the existing platform opener using argv, timeout, abort, output capture and `createOpenRequestRegistry` deduplication. Show browser errors in setup context with the URL reachable in help; never set tab fetch errors for a browser failure. No API call is needed to open this page.

## Automated acceptance

| ID | Oracle |
| --- | --- |
| SET-01 | No s press means zero setup API calls; empty normal runs still do not request the workflow-name catalog. r/R never start setup. |
| SET-02 | Successful complete zero-workflow response produces “No workflows found”; Issues/PRs remain independent; no workflow creation guidance is presented as required dashboard setup. |
| SET-03 | Active, all-known-disabled, mixed and unknown states yield evidence-bounded copy; no guessed push-trigger explanation. |
| SET-04 | 100-of-101 response is incomplete and cannot claim all disabled or no workflows; inconsistent total, duplicate IDs, missing total and malformed body are unusable. |
| SET-05 | 403/404/auth/network/timeout failures do not become no-workflow evidence; dated prior success remains qualified; later valid response clears error. |
| SET-06 | Denied admission and shared rate limit disclose cause/retry, start no unadmitted subprocess, and preserve data; safe later s succeeds. Terminal blocked/compacted settlement failure is disclosed and not cached. Retryable busy/unwritable receipt→settled retains the valid source result, settles the original scope, and makes no second HTTP request; persistent storage trouble retains a visible remedy. Failed shared-hold publication pauses data safely, discloses coordination status and resumes after recovery. |
| SET-07 | Repeated s, success TTL, partial TTL, error cooldown and clock rollback respect request bounds; no trailing request from key repeat. |
| SET-08 | Account/host/target change, unknown identity, quit and late completion cannot publish old setup evidence; original receipt accounting remains intact and children abort. |
| SET-09 | Local/SSH connected modes call neither local gh nor a new bridge operation; unsupported explanation and g fallback are visible. |
| SET-10 | g constructs correct public/enterprise URL, opens once, rejects invalid target, shows opener failure and can retry; existing row navigation tests still pass. |
| SET-11 | Setup check does not change run count, run-list freshness, run-list fetch error or active tab; ordinary deadlines are unchanged except genuine shared holds/publication barriers. Hold recovery resumes normal data traffic without setup fabricating a run-list result; successful setup retry clears only setup error. |
| SET-12 | Request logs show at most one workflow page per uncached s, one declared core operation, no setup calls after quiet idle; concurrent normal requests retain admission/hold invariants. |

Write failing tests first. Use published GitHub response schema as a checkable external contract fixture and keep its source URL/date with the test; validate parser edge cases without making live account calls. A private/EMU runtime check not executed is unmeasured, not silently passed. Use fake gh at the external boundary and real governor/acquisition/input lifecycle in PTY tests. Extend `test/pty/fixtures/gh:321`, `test/pty/fixtures/gh-state.mjs:116`, `test/pty/fixture-api.test.mjs:215`, and `test/fixtures/request-oracle.mjs:236` as needed so old jq name lists and new setup envelopes are independently represented and accounted for; do not manufacture success by treating every workflow route as a complete catalog.

Required sequential gates: lint, syntax, full unit suite, full PTY suite, `npm run test:efficiency`. Existing workload limits must remain unchanged for sessions that do not request setup; add a separate explicit-action cost assertion instead of loosening those limits.

## Manual acceptance

Inspect empty Actions, successful setup, denied setup and connected-mode captures in 45×24 and 24×10. Confirm that “what happened” and “what next” remain visible, and the source-check timestamp is not confused with the separate setup-check time. Browser navigation is verified with the fixture opener; a real browser launch is optional visual validation, not a required remote action.

## Stuck states, work units and gate

Parent SET recovery rows are binding: every failed/disabled path has either an observable retry transition or visible actionable disclosure, including unsupported provider and browser failure. One sequential implementation unit due to shared App/admission/input/fixture ownership. Independent review must check request accounting, identity fencing, limits and browser error separation; simplify and verify after repairs. Record all outcomes and exact candidate, then stop for acceptance. Publication remains separately authorized.

## Completion

- [x] SET-01 through SET-12 implemented and reviewed.
- [x] Simplify and required local gates completed; the sole terminal failure was repaired and its four affected regressions passed.
- [x] Final evidence, limitations and retained failure history recorded in [implementation notes](../2026-10-25-first-run-experience-notes.md).

Accepted under the owner's all-phases continuation; local integration and task-worktree cleanup are authorized. No publication is authorized.
