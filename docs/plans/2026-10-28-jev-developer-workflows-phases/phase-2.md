# Phase 2 — optional semantic Focus

Parent: [implementation plan](../2026-10-28-jev-developer-workflows.md). Entry: Phase 1 accepted. Outcome: an explicit, optional Jev action finds topic matches beyond local vocabulary while all ordinary work remains usable. This phase owns the one shared adapter used later.

## Changes

Pin runtime dependency `@typesafe-ai/sdk` exactly 0.7.0 in `package.json`/lockfile. Keep `exports`, shipped files, Node >=22 and the no-build contract (`package.json:9`, `:10`, `:52`). Add proposed `evaluateJev`, bounded fetch, response validator, session consent/cache and immutable child-environment filtering inside `index.mjs`. Add CLI settings at `index.mjs:11588`, `:11656`, `:11893`; key capture occurs only in CLI startup. Do not import or instantiate the SDK in help/version, module imports, collector startup, disabled modes or first paint.

Apply the parent's exact endpoint, timeout, retry, response, cache, request-cap, key and consent bounds. Source-bound metadata consent lists the query/title/available labels/PR branch sent to TypeSafe; omit account/repository names, author, URL, identifiers and bodies from payloads. Keep opaque question IDs mapped locally to original rows. Consent is per feature and session; `x` revokes it. No account retention claim appears in UI. Public metadata also requires consent.

Use `focus-v1` with shared state `{query: parsedTopicText}` and one independent Noul per item. First apply Phase 1's exact number/author/branch/date filters in code; semantic candidates are **all** eligible rows, including those without lexical topic matches. Only remaining topic text goes to Jev; a filter-only/empty-topic query uses local results and sends nothing. Each question includes only that item's projected kind/title/available labels/branch. Ask whether it concerns the requested topic, allowing clear synonyms, and reject mere shared generic development terms. True criterion: supplied metadata describes work about the topic; false: a different topic. Titles containing instructions remain evidence text. Do not use a forced Choice across items or a lexical shortlist that drops synonym candidates.

On `J`, freeze those filter-eligible loaded candidates in local ranking order followed by remaining eligible source-order rows, deduplicate by source identity, and evaluate at most 60 uncached items in sequential batches of at most 15 within the single four-second action deadline. `m` explicitly evaluates the next 60 from that manifest. A source/query change requires an explicit new semantic action. Completed valid chunks may publish with exact N/M eligible coverage and eligible/loaded counts; failed/timed-out chunks remain unevaluated. Positive matches rank by probability with original order as tie breaker; uncertain rows and not-yet-evaluated rows remain inspectable, and all ordinary rows remain accessible. No-match wording is allowed only for evaluated negatives and names its denominator; uncertainty is never a negative. Local results remain visible while waiting.

```text
@ evaluateJev(request, identity, signal) -> typed result
pre: explicit user action, supported mode, enabled key and scoped consent
do:
  1. validate input bounds and current identity
  2. lookup exact cache or equal in-flight request
  3. compute bounded batches and reserve each dispatch against session cap
  4. parse bounded responses and validate model, answers and identity
  5. cache normalized current results and emit coverage
br: changed request -> cancel prior work; partial completion -> retain explicit partial coverage
fx: at most one permitted HTTP request at a time; no source writes
fail: transport, deadline or schema error -> unavailable, never negative
```

## Child and diagnostics boundary

Use one proposed `withoutJevCredential(env)` helper at every process launch, including runGh explicit env (`index.mjs:833`, `:838`), auth discovery (`:3014`, `:3462`), sysctl/ps (`:4557`, `:4577`), browser (`:7130`), preflight/git (`:7178`, `:7191`, `:10861`, `:10872`, `:10875`), SSH (`:7267`, `:7314`), GitHub App environment (`:7594`) and interactive repository creation (`:20739`). Do not mutate imported callers' environments. Child fixture prints only whether a dummy key exists. Doctor may show enabled/configured booleans and safe counters, never a key, query, excerpt, URL query or provider body.

Create proposed `test/jev.test.mjs`, `test/jev-child-env.test.mjs`, `test/pty/jev-focus.test.mjs`, `test/pty/fixtures/jev-fetch.mjs`, and `scripts/evaluate-jev.mjs`. PTY transport injection uses a test-only Node preload against the exact endpoint, not a product environment variable allowing arbitrary API origins. Test the real adapter/policy with fake external fetch and fake clock; SDK HTTP serialization itself needs the later live contract probe. Existing PTY environment allowlisting is at `test/pty/capture.mjs:461`.

## Automated acceptance

- Disabled/key-only/no-consent/unsupported-mode/typing/startup/refresh cause zero SDK imports and HTTP calls; permitted `J` makes bounded POSTs; same-request repeats coalesce; changed requests cancel.
- Positive/negative/uncertain boundaries at 0.30/0.70; missing/extra IDs, wrong model/types, NaN, oversized/chunked body, wrong Choice distributions and null usage have exact outcomes. No error is shown as no match.
- Cancel before send, during headers and slow body; whole-action timeout, including later batch; obsolete source/account/query completion cannot publish. Cache TTL, item/byte eviction and all identity partitions work.
- Request cap is charged at dispatch, including later cancellation/errors; cooldown expires but does not dispatch automatically. `x` revocation clears scoped permission/results and cancels work; granting again recovers.
- Every child sees no dummy TypeSafe key, including explicit copied envs; SDK debug/base-url environment variables cannot change configured destination or logging.
- 150 loaded rows can be evaluated through 60/60/30 explicit actions; all-middle/partial runs retain unknown coverage; no extra GitHub request or freshness update occurs.
- Mixed author/number/date/branch filters never admit an ineligible semantic hit, including branch case differences; topic synonyms outside lexical matches are still evaluated; filter-only queries send zero calls and need no cloud consent.
- Run the offline evaluation against frozen Phase 1 labels. Validate the exact package with Node 22 and Node 24. Establish the parent's first-paint/input/cache performance comparisons using identical fixtures.

Sequential gates: lint, syntax, npm test, full PTY; exact-package Node 22/24 checks as described in the parent. No live request belongs in these commands. Manual: inspect consent, uncertainty and coverage text at narrow/wide widths.

## Stuck states and recovery

The parent table is normative. In addition, an SDK import failure leaves local Focus intact and points to reinstall/update; a fixed fixture loader succeeds on retry. If a loaded item exceeds the projection bound, show its truncated-input marker or explicit unevaluated count and retain ordinary access. Model removal shows an update instruction; it never switches to a floating alias. Test each error followed by the corresponding permitted recovery. Missing live evidence is a development qualification status, not a misleading user-facing “no match.”

## Evaluation, ownership and handoff

One integration owner owns runtime, dependency, CLI and transport tests. `[batch-eligible]` evaluation-tool author owns only proposed `scripts/evaluate-jev.mjs` and `test/jev-evaluation.test.mjs`, using the parent corpus/manifest/budget contract; it imports the real adapter only after integration and must not duplicate policy. Tool development can proceed independently, but final checks wait for integration.

The evaluation command defaults offline; live mode requires a reviewed exact payload manifest and explicit call/byte/dollar ceilings. Prepare the <=12-call synthetic/public contract probe before seeking its separate authorization. No private data, key creation or provider setting changes. Record local gate results, pinned package/model, corpus/question hashes and **live contract UNVERIFIED** if no authorized probe ran. Semantic Focus is publicly qualified only after the parent's Focus held-out gate. Phase 3 may proceed after local acceptance without claiming live accuracy. Stop at this phase's acceptance boundary.
