# First-run experience implementation notes

## Authorization and identity

The owner authorized all three phases without stopping, local integration into `develop`, and removal of the task worktree after integration. No push or publication is authorized.

Baseline: `4b2a8d3cfdd12b6ac0b7a8a70bcd3bf6349e7aa9`. Implementation branch: `feat/first-run-experience`. Worktree: `/Users/juan/code/gh-glance-first-run`. Runtime: Node `v24.22.1` on macOS. The main checkout's untracked `supabase/` remains outside this worktree. The approved plan and assessment were copied unchanged into the worktree for preservation with the implementation.

One sequential implementation owner works on each phase. The parent provides independent review, owns full sequential gates and integration, and records each phase before starting its successor. Operational logs are outside the disposable worktree at `/tmp/gh-glance-first-run.7n9aUq`.

## Deviations

The plan baseline matches the actual integration checkout. Phase 1 needed optional bounded resize support in `test/pty/capture.mjs` and `test/pty/run.sh`: the plan required a live resize regression, but the existing harness only set initial dimensions. The new option changes terminal size once and leaves ordinary captures unchanged. Final-frame assertions do not claim accurate replay of pre-resize frames at their original dimensions.

## Phase 1 in progress

Behavioral tests were written before runtime changes. The new unit matrix fails because the planned presentation helpers do not exist on the baseline; the new PTY cases exercise the existing UI before its replacement. Acceptance remains pending implementation, independent review, simplify, and complete verification.

### Phase 1 review and targeted evidence

The parent independently reviewed the implementation diff and CX matrix. Resolved findings: moved source refs initially caused a render-time temporal-dead-zone error; populated stale/error views lacked source-check context; stacked notices could displace the short-pane footer; Unicode wrapping used inconsistent metrics; presentation notes shared a mutable array; and populated views unnecessarily wrapped unused panels. Reinspection approved the repaired source. The simplify reuse, quality and efficiency passes retained existing recovery/freshness/viewport logic, unified wrapping metrics, cloned notes and avoided unused wrapping.

A new cached-result transition exposed a valid newly completed source timestamp being compared with an older display-clock sample. Presentation now uses actual render time without a new timer or source timestamp mutation. Ordinary scheduled waiting with a known result is not treated as a blocking hold.

Targeted checks passed: lint, syntax, 47 unit cases, the eight combinations of 24/45/80/120 columns and 10/24 rows, waiting to empty, failed load to rows, cached empty to failure to fresh empty, incomplete to complete Security, table disappearance during width mode and return, no-color/reader output, 24x10 authentication remedy, and live narrow-to-wide resize. The full gates remain pending. Preliminary failures, interrupted checks and two overwritten preliminary log filenames are disclosed in `/tmp/gh-glance-first-run.7n9aUq/phase1-check-history.txt`; those attempts are not passing evidence.

Inspected deterministic final frames at 24x10, 45x24 and 80x24. State, action and check time are visible; wider panes also show Actions meaning and matching-trigger explanation. The 24x10 panel deliberately leaves overflow for Phase 2 help. Native assistive technology, Windows/Linux visuals and human usability remain unmeasured.

Current tested-input fingerprint: `703cd0f9917a0c6c2be2bdcac4535cb8bb425a435a5842c7c1663b1ff2ff458e` (runtime, README, package/lock/config, scripts and tests). Frozen runtime SHA256: `0c2fcb98850e65df86553229443868bc033352fcc660414aa9a3efae8d66124d`. Structured assignment/review handoff: `/tmp/gh-glance-first-run.7n9aUq/phase1-dispatch.json`, structurally validated; full gate completion remains a separate acceptance requirement.

Full Phase 1 lint and syntax gates passed. `npm test` passed all 818 tests in 365.2 seconds on the frozen fingerprint above. `npm run test:pty` is running sequentially; acceptance remains pending that result.

### Phase 1 first complete gate: failed, repairs required

The first full PTY gate exited 1 after 2188.5 seconds: 175 tests, 163 passed, 11 failed, 1 skipped, none cancelled. Lint/syntax and all 818 unit tests passed. This is a failed gate, not Phase 1 acceptance. Complete output is `phase1-gate-4.log` in the evidence directory; retained terminal bundles are under `/var/folders/h7/qgj9lrs10qg4z_gnxjqbt44h0000gn/T/gh-glance-test-evidence/run-18135`.

Grouped findings under repair:

- P1-F01: capture parser treated a bordered Checking heading as a footer. Retained frames prove correct height, blank guard and one actual footer; parser needs a regression that still detects real duplicate footers.
- P1-F02: two identity-migration assertions imposed cause-before-action ordering. Both exact messages remain present; check them independently without weakening migration/accounting invariants.
- P1-F03: three mouse fixtures sent w before a table existed. Readiness barriers must enter visible width mode before triggering termination/crash or invalid reports; retain exact lifecycle and persistence assertions.
- P1-F04: the cached-empty recovery test counted pre-failure cached paints. Require a later successful source completion and post-failure empty frame, plus unchanged source time through failure and newer source time after success.
- P1-F05: the short populated recovery budget omitted the debounced cause. Restore cause/action/source time within the same bounded budget.
- P1-F06: tableless presentation omitted the existing sanitized source diagnostic. Preserve it alongside classified cause/remedy for visible detail and future contextual help.

The parent reviewed each retained failure group before releasing the frozen candidate for repair. No later pass can erase this attempt; repaired inputs require new verification.

### Phase 1 repair review

P1-F01 through P1-F06 are resolved in the repaired source and strict targeted checks. All 11 original failures passed in sequential repair groups (`phase1-repair-results-1.json`). `status.test.mjs` remains unchanged: restoring the actual cause and sanitized diagnostic satisfied its original assertions. A follow-up one-row populated-notice test failed before repair and passed after prioritizing the required remedy; the existing three-row sustained-cause regression also passed again. The parent independently reread these changes. Simplify retained the bounded layout and existing recovery classification; no acquisition, scheduler, state-schema or dependency changes were introduced.

Repair frozen runtime SHA256: `2f09ca0171c578ccce3558ee984f8ad88f4e0303ffb352376df42c63bc43f215`. New full gates run under the `phase1-r2` evidence prefix. Earlier full unit/PTY evidence is not substituted for these changed inputs.

### Phase 1 second gate: failed and deliberately interrupted

On repaired fingerprint `948cc89066349e50cd06c565c2b1d809706c367da4af4120bcaec98ca7813b29`, lint/syntax passed and the full unit suite passed all 819 tests in 632.0 seconds. The PTY run then failed REFRESH-03: its fixture waited for an Actions request to start, pressed w while still tableless, and sent width arrows as ordinary tab-navigation input. The retained capture reached PR Width mode instead of Actions Width mode.

The parent deliberately stopped the already-failed PTY attempt to repair all equivalent startup-readiness fixtures together. This attempt is failed and incomplete, with process exit 143, not a complete passing terminal gate. `/tmp/gh-glance-first-run.7n9aUq/phase1-r2-interruption.json` records exact task-owned process/group identity and confirms no survivors after TERM. No foreign process was signalled.

P1-F07: use rendered Actions/header readiness, then visible Width readiness, for REFRESH-03 and the keyboard width/reset cases. Compact keyboard/mouse no-op fixtures must first prove populated compact rows, so they cannot pass vacuously during tableless startup. The bounded consumer sweep found no other unguarded width-mode consumers except intentional tableless-no-op tests. These repairs touch test fixtures only; production runtime remains the previously reviewed repair.

P1-F07 is resolved and independently reviewed. The three changed PTY files now wait for visible data and mode entry; four selected tests passed, including explicit populated-compact proofs. Request-count, persisted-preference and lifecycle assertions remain strict. Focused lint and whitespace checks passed. Runtime SHA256 remains `2f09ca0171c578ccce3558ee984f8ad88f4e0303ffb352376df42c63bc43f215`; this repair changed only `test/pty/adaptive-polling.test.mjs`, `test/pty/keys.test.mjs` and `test/pty/mouse.test.mjs`. Full verification resumes under `phase1-r3`.

### Fresh independent review and third gate interruption

A fresh read-only reviewer found two additional Phase 1 contract gaps on runtime `2f09ca0171c578ccce3558ee984f8ad88f4e0303ffb352376df42c63bc43f215`:

- P1-F08 (CX-10): Security blindness is not all-sources-unavailable coverage. It includes any unexpected endpoint failure and excludes intentionally disabled endpoints. All-disabled and partial-failure facts need distinct presentation inputs; the prior helper assertion encoded the wrong equivalence.
- P1-F09 (CX-09): the cached footer still clamps future source age to zero, contradicting the contextual uncertainty line. Suppress or disclose uncertain footer age and test the production footer.

Third-attempt lint/syntax and all 819 unit tests passed (unit duration 344.9 seconds). The parent stopped the candidate's checks after the confirmed review findings, before accepting the terminal gate. This run is interrupted/incomplete, exit 143; `phase1-r3-interruption.json` records verified task-owned groups and no surviving processes. The full gate will run on the repaired candidate after reviewer reinspection. Phases 2 and 3 remain unstarted.

P1-F08 and P1-F09 are resolved and approved by the fresh independent reviewer. Source-note coverage is derived before collapsing display notes; all-disabled, partial-disabled and partial-failed production cases remain distinct, and error/hold precedence remains intact. The real cached footer omits nonfinite/negative age. Both defects reproduced RED in terminal captures, then 9 unit and 4 targeted PTY cases passed GREEN (`phase1-finalfix-*` logs). No persisted schema or acquisition behavior changed. Simplify review retained the direct coverage fact and finite/nonnegative age guard without further changes.

Fresh review runtime SHA256: `8eecd6fcb3171021e4cfa2c00fe809f3b93025ddf8069a1d8ac29899ae5ae483`. No remaining confirmed blocker in that review; complete gates remain required and now run under `phase1-r4`. Recovery after the simulated rollback was not additionally exercised by the new footer regression; existing valid-source recovery coverage remains part of the full suite.

### Phase 1 fourth gate: one fixture race

On fingerprint `3668a938e119338956ab6411f8681040b357f9d6235e61d30ed159f9d44738b7`, lint/syntax and all 819 unit tests passed (309.6 seconds). The complete terminal suite exited 1 after 2098.5 seconds: 181 tests, 179 passed, 1 failed, 1 skipped. The skipped historical-baseline reproduction requires a separately supplied old executable and is not claimed as passing.

P1-F10: the one-row populated authorization-remedy fixture installed a one-shot failure before restart, then sent a timed R. The retained capture shows the conditional startup request failing, its remedy visibly rendered, and the manual unconditional request succeeding before the final assertion. This is a fixture race, not a rendering defect. Evidence: `phase1-r4-gate-4.log` and `/var/folders/h7/qgj9lrs10qg4z_gnxjqbt44h0000gn/T/gh-glance-test-evidence/run-34604/onboarding.test.mjs-65158/capture-018/{fixture-calls.txt,frames.json,terminal.txt}`. An independent bounded fixture sweep found the same race in cached-empty recovery. Both fixtures will hold failure through their required checkpoint; recovery will explicitly release the failure before requesting success. All final-state and source-time assertions remain required. Runtime stays frozen at the fresh-reviewed hash; the test-only repair requires verification before Phase 1 acceptance.

P1-F10 is resolved with independently reviewed test-only changes in `test/pty/onboarding.test.mjs`. The authorization fixture holds failure through the visible remedy assertion; the cached-empty fixture records a quiescent failed checkpoint under the fixture lock, then explicitly releases failure and requests recovery. The original rendering and exact source-time assertions remain, with added completion-outcome assertions. Targeted tests passed 2/2, the complete onboarding file passed 20/20 in 116.29 seconds, and focused lint/syntax/whitespace checks passed (`phase1-race-*` logs). Simplify review found no reusable exported fixture mutation helper and retained the bounded local checkpoint without a shared fixture refactor. Runtime hash is unchanged; repaired test SHA256 is `19fa8cdbc644cb5920c81669f5122fea6d27d4e755968d0834e86b159ddee853`. Full gates now run under `phase1-r5`; acceptance remains pending.

Main-checkout revalidation during the fifth gate: `develop` remains at baseline with no tracked edits. A new unrelated untracked `docs/research/2026-10-25-gitcrawl-cache-ideas-assessment.md` is present alongside the original unrelated `supabase/`; preserve both during final integration and cleanup.

### Phase 1 accepted locally

Fifth complete gate: all required commands exited 0 on unchanged fingerprint `7138212d644d5c22f527679a8a43406e4193a484aee8b99d5ec829d41654b482`. Lint passed in 2.5 seconds; syntax passed; all 819 unit tests passed in 290.3 seconds; PTY passed in 2102.7 seconds with 180 passed, 0 failed and 1 explicit historical-baseline skip. Receipt: `/tmp/gh-glance-first-run.7n9aUq/phase1-r5-gates.json`. The earlier failures and interrupted runs remain recorded above. Runtime SHA256 remains `8eecd6fcb3171021e4cfa2c00fe809f3b93025ddf8069a1d8ac29899ae5ae483`. Independent source review and test-repair review are complete; simplify made no further changes. Native assistive technology, Windows/Linux visuals and human usability remain unmeasured.

Phase 1 is accepted under the owner's all-phases continuation. Next: Phase 2 target identity and discoverable paginated help, with separate TDD, independent review, simplify and full local gates. Phase 3 remains unstarted. No remote publication occurred.

## Phase 2 in progress

Entry commit: `16177519031f026a54d87af93e5c943b7fa92a9b` on `feat/first-run-experience`; Phase 1 is accepted and its curated plan, assessment and evidence notes are committed. `/root/phase2` owns the sequential implementation of selected-target display and contextual paginated help in runtime, tests and README. The parent owns independent review, simplify, full gates and commits. No acquisition or scheduling change is authorized by this phase. Scope and acceptance are NAV-01 through NAV-07 plus the existing CX matrix. Targeted checks precede the separate complete sequential gates; no implementation acceptance is claimed yet.

Phase 2 TDD and interim review: four new unit regressions failed on missing helpers/Help reservation (`phase2-unit-red-1.log`), then passed. Initial inferred-target PTY failure also had an empty-host fixture issue; it is not sufficient evidence for healthy acquisition until the corrected fixture passes. Corrected HTTPS/SSH target and modal-consumption checks passed 3/3. Parent review found P2-F01: help inherited the width-truncated diagnostic. A complete-page traversal reproduced the missing full diagnostic (`phase2-diagnostic-red-3.log`); earlier red-1 (generated driver syntax) and red-2 (wrong fixture selector) are invalid harness attempts, preserved separately. P2-F02: compact first-page fallback invented refresh for arbitrary manual remedies; its unit regression failed before repair. Both source repairs are implemented, with full targeted and independent final review still pending. The implementer reported one quick unit RED overlapping the end of a PTY attempt; this departed from sequential-check instructions, and subsequent checks are sequential. No full-gate evidence is claimed from that overlap.

### Phase 2 review and final targeted evidence

Correction to the interim diagnostic note: `phase2-diagnostic-red-3.log` used input beyond the existing `shortErr` 120-character retention limit, so it also does not prove the intended help-only truncation. `phase2-diagnostic-red-4.log` uses retained text below that limit and completes traversal before failing the full-text assertion against the old help path; the restored full diagnostic path then passes. The existing error-retention contract is unchanged.

Resolved findings: P2-F01 full sanitized diagnostic now reaches help without the dashboard-width truncation; P2-F02 compact first-page copy no longer invents refresh for unrelated manual remedies; P2-F03 complete validated identifiers, including a greater-than-600-character test slug, wrap in bounded chunks without the remote-field 300-character clamp; P2-F04 exact duplicated meaning/explanation text is omitted while distinct state explanations remain; P2-F05 generated terminal-driver errors are now asserted at every caller so a late driver failure cannot pass silently. A test lint error was repaired without changing the negative control-character assertion. The legacy short-help check's `/Quit/` assertion failed on the intentional lowercase `q/Esc/^C quit` page control; its generic assertion now ignores case and the exact exit-control assertion remains.

The independent reviewer approved runtime SHA256 `7f69512f51313573e05cfd2f81ed0373a50973a53b4dd97b0b767282d79f264b` after reinspection. Parent simplify passes: reuse preserves existing target resolvers, wrapping and static help; quality removes duplicate text and strengthens driver outcome checks; efficiency constructs full help context only when open, with no new timer, subprocess or acquisition path. No further source change was needed after reinspection.

Final targeted receipt `/tmp/gh-glance-first-run.7n9aUq/phase2-final-targeted-2.json` records passing focused lint, syntax, 36 unit tests, 2 exact consumer unit tests, all 10 help PTY tests, regenerated README sample, 45-column capture and whitespace checks. Earlier `phase2-final-targeted-1.json` remains failed: lint failed and the legacy PTY consumer file had 11 passed/1 copy mismatch. All 20 onboarding PTY cases passed before the final duplicate-text cleanup; complete final-candidate regression gates remain required.

Parent visual inspection: final 80x24 and 45x24 captures show target, host, source time, action and page controls; the 24x10 long-target fixture preserves the doctor remedy and quit/navigation on every page and reconstructs the complete target. NAV-07's new tests exercise source-state combinations, not new live account-switch or collector-reconnect paths; the unchanged identity/collector regression suites remain part of full verification. Native assistive technology, Windows/Linux visuals and human usability remain unmeasured. Phase 3 remains unstarted.

Phase 2 final implementation handoff received. README SHA256 `9daf02994439d256609508029e0971d07e0ab52a1e6fc83c8cf871825b2d8dfc`; source remains the approved runtime above. Final immutable visual copies: `phase2-final-24x10-help-pages-2.json`, `phase2-final-80x24-help-2.txt`, and `phase2-final-capture45-2.log` in the evidence directory. Convenience capture filenames were refreshed during iteration; these final copies preserve the reviewed outcome. Structured handoff `phase2-dispatch.json` validates against tested-input fingerprint `8ae37264e0da450f61f2995f5caa4bdc5882263b51fc171b41d3f874a0c17334`. The complete Phase 2 gates now run on that unchanged candidate; lint and syntax have passed, with unit/terminal completion pending.

### Phase 2 accepted locally

Complete gates passed on unchanged fingerprint `8ae37264e0da450f61f2995f5caa4bdc5882263b51fc171b41d3f874a0c17334`: lint/syntax exit 0, all 825 unit tests passed in 234.9 seconds, and PTY passed in 2180.0 seconds with 190 passed, 0 failed and 1 explicit historical-baseline skip. Receipt: `/tmp/gh-glance-first-run.7n9aUq/phase2-gates.json`. Independent review and simplify are complete. Next is the approved Phase 3 setup observation and browser action. The owner reiterated a cross-project requirement to avoid overengineering and redundant broad verification; reuse unchanged evidence and verify narrow repairs proportionately while preserving required final gates. No publication is authorized.

## Phase 3

Entry commit: `55ba4f9210826c00e28e938e405e46090b52b9e7`. The same worktree and branch contain the optional standalone Actions setup check, separate session cache/error, governed one-page request, validated browser action, connected-mode fallback and README/key documentation. No dependency, durable schema, collector protocol or CI routing change was made.

The implementation author was `/root/phase2`; the parent independently reviewed accounting/lifecycle, and `/root/phase1_final_review` reviewed parsing, presentation, input and browser behavior. Resolved findings: P3-F01 preserve the root abort handle using a combined setup signal; P3-F02 retain nested admission/reset deadlines and known holds even when publication fails; P3-F03 preserve storage/source remedies; P3-F04 reject contradictory zero workflows plus next-page metadata; P3-F05 clear browser retry presentation after success; P3-F06 show connected-mode guidance at 24x10 without inventing a connection failure; P3-F07 remove duplicate recovery notices; P3-F08 register s/g in CLI help. Reinspection approved runtime SHA256 `dc5d493dd9e40bf2c207be63a2284740d62d79b7bdb3d8a1c8a42feb2f0ecc90`. Parent simplify retained existing admission, receipt, hold and opener helpers, removed duplicated notices and confirmed no automatic setup timer or extra idle request.

Initial parser tests failed on missing exports. Preserved intermediate failures were an overstrict sanitizer assertion, invalid fixture/receipt selectors, generated-test syntax, a clipped readiness selector and a lint-only control-character regex. These were repaired with focused checks; no broad suite was restarted for them. Evidence prefixes: `phase3-unit-red-1`, `phase3-unit-fixture-final-1`, `phase3-governor-1`, `phase3-lifecycle-2`, `phase3-presentation-final-1`, and `phase3-lint-final-1` under the existing evidence directory. The shared-hold recovery case passed in `phase3-lifecycle-1` despite unrelated selector failures in that attempt.

SET-01 through SET-12 are covered by strict parser/cache tests, real governor/receipt tests, real input/identity/lifecycle PTYs, independent one-request cost accounting and source review. Dedicated setup PTYs exercise 403, blocked/retryable settlement, account change and quit; other failure classes, compacted/unwritable settlement and unknown identity also rely on unchanged shared mechanisms and their existing regressions. No additional dedicated setup PTY is claimed for those variants. Final captures at 24x10 and 45x24 preserve state/action hierarchy, the doctor remedy, connected fallback and separate run/setup timestamps; overflow remains reachable in help. Captures are in `phase3-final-captures`. Native assistive technology, non-macOS visuals, private/EMU runtime and human usability remain unmeasured.

### Phase 3 accepted locally

Full gates completed once on fingerprint `c5a6502e1cec05f956c20b39fa91162e783d464236d6e9fe281099a4061507e9`: lint/syntax passed, all 831 unit tests passed (297.4 seconds), all 9 efficiency tests passed (99.0 seconds), and the full PTY run finished with 203 passed, 1 failed and 1 historical-baseline skip (2247.4 seconds). The full PTY result remains recorded as failed in `phase3-gates.json`.

P3-F09 was the sole failure: at one-row capacity a sustained recovery summary displaced the already-prioritized authorization remedy. Independent review confirmed a one-line correction at `index.mjs:17486`: prefix existing `tableNotices` rather than unprioritized `recoveryLines`. The existing Set still removes duplicates. No requests, accounting, timers, parser, cache, fixture or test code changed. Reconstructing the prior line reproduces the full-gate runtime hash exactly. The final runtime is `e1131e1aabefc9f199f5f9da16c550ee7f1411a17f0d5c9b5648776a3a55f19c`; final fingerprint is `2a6bc264fd18d67b8bf06e8b419ad42d72ee510af05c61e605c1cbc715ab8f45`.

The reviewer approved that correction and bounded the invalidated display coverage to the one-row authorization remedy, sustained coordination-notice appearance/clearance, setup-error isolation with populated rows, and shared-hold publication/recovery. All four exact regressions passed on the repaired candidate in 40.6 seconds; lint, syntax and whitespace checks also passed (`phase3-notice-repair.json`). Unaffected passing evidence is retained; the entire broad suite was not repeated after this isolated display repair, following the owner's instruction to avoid redundant verification. One historical executable-dependent skip remains explicit. All confirmed findings are resolved and all three authorized phases are accepted locally. No push or publication occurred.

Integration target is local `develop`; task originals are preserved before fast-forward integration and worktree removal. Unrelated main-checkout research and `supabase/` files remain outside the change.
