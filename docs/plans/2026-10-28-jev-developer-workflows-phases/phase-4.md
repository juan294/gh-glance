# Phase 4 — evidence-backed CI observations

Parent: [implementation plan](../2026-10-28-jev-developer-workflows.md). Entry: Phase 3 log transport accepted and Phase 2 adapter available. Outcome: identify reported failure observations and their supporting lines, while preserving the actual run conclusion and exact evidence identity.

## Evidence preparation and question contract

Add proposed `prepareCiSpans`, `buildCiQuestions` and `validateCiObservations` inside `index.mjs`, with pure-policy tests. Bind all output to host/repository/access partition/run/attempt/head SHA/job ID/log digest. Failed-step names are separate facts; a whole-job log cannot establish a step association. Source facts remain visible even if Jev finds no usable observation.

Prepare deterministic excerpts from the retained Phase 3 log: strip ANSI/control sequences, normalize newlines, preserve original line indices, and select the first ten and last hundred nonempty lines plus two-line context around literal error/assertion/timeout/permission/OOM/static-diagnostic markers. Deduplicate in source order, then cap to 40 spans, 512 UTF-8 bytes/span and 8 KiB total, prioritizing marker windows then tail then head. Show all omitted/truncated ranges. A marker is a selection heuristic, never the diagnostic answer. No arbitrary file/body/comment fetching.

Detect known credential formats, authorization/cookie headers, private-key blocks and signed URL query strings before preparing cloud input. Redact matched material locally and flag the excerpt as suspected-secret; that excerpt cannot be sent. A user can select a different, smaller local line range, which is scanned again. Show the exact sanitized payload text and TypeSafe destination before every `J` send; Cancel sends nothing. Redaction does not guarantee secret-free content. Reuse session data-class permission, but never treat it as approval of all future raw logs.

Use `ci-evidence-v1` with six independent Noul observations and six companion Choice questions selecting one existing opaque span ID. All questions see only the approved excerpt and permitted failed-step text. For each category, read the Choice only when its Noul is positive. Fixed true/false criteria:

| Observation | True evidence | Insufficient/false evidence |
| --- | --- | --- |
| assertion_mismatch | Executed test reports expected/actual mismatch or failed assertion | Test starts/passes, generic exit code, quoted example |
| dependency_download | Package/dependency fetch or registry download explicitly fails | Install mentioned; unrelated compile/validation failure |
| permission_denied | Explicit denied permission or authentication/authorization rejection | Speculation about credentials; successful access |
| execution_timeout | Executed operation reports timeout or deadline exceeded | Timeout configuration without a reported timeout |
| memory_exhaustion | Explicit OOM, allocation failure or memory-limit kill | Killed/nonzero process without memory evidence |
| static_check_failure | Lint/type/syntax/compiler reports a concrete code diagnostic | Check starts; only runtime test/download failure |

No “flaky,” “provider outage,” proven root cause, generated command or automatic fix category. Multiple observations may coexist. A positive category without a valid same-excerpt span is invalid/unavailable, not renderable. An all-negative result says “No listed observation found in this excerpt”; all-middle means uncertain. Missing/truncated evidence never means healthy CI. A changed attempt/job/excerpt invalidates old answers before render.

```text
@ analyzeCiExcerpt(evidence, consent, generation) -> observations
pre: qualified log transport; failed or timed-out selected job; explicit reviewed send
do:
  1. validate exact identity and bounded sanitized spans
  2. compute six Noul and six span Choice questions
  3. parse results through the shared strict adapter
  4. validate each positive observation's current evidence span
  5. emit fixed category labels and original line references
br: no positives -> bounded no-observation or uncertain message
fail: suspected secret, stale identity or missing span -> no cloud result
```

## Implementation surface and oracles

Own runtime CI overlay/question helpers plus proposed `test/ci-observations.test.mjs`, `test/pty/ci-observations.test.mjs`, `test/fixtures/jev/ci.json`, and extend the existing proposed evaluation tool to the CI rubric. Reuse Phase 2 transport/cache/error states and Phase 3 local evidence; no second client, new GitHub endpoint, cache format, governor operation or CLI provider flag.

The CI corpus records source-group/split, synthetic/public original lines, approved spans, six observation labels, acceptable supporting span IDs and insufficient-evidence rationale. Include mixed failures, configuration-only timeout, process killed without cause, dependency vs compile failures, multilingual errors, embedded instructions, secrets/signed links and evidence from a different attempt. Exact probabilities are fixture inputs for policy tests, never expected live-model constants.

Required automated assertions: six independent outcomes; Choice cannot force an observation; fabricated/missing/other-attempt span rejection; local line accuracy after ANSI removal/truncation; explicit secret correction/reselection path; preview matches exact sent payload; cancel zero traffic; errors never alter GitHub conclusion; no rerun/action execution; log refresh invalidates results; no raw logs/signed URLs in diagnostics; normal source refresh and keypress responsiveness continue during inference. A head SHA or attempt change must make the old result unreachable, including cached data.

One runtime/integration owner. `[batch-eligible]` corpus author owns only `test/fixtures/jev/ci.json`, independently from the fixed schema/rubric; production owner waits for handoff before editing it. No parallel changes to shared fixture routing or evaluation tool.

## Recovery, acceptance and handoff

Empty log/zero usable spans shows insufficient evidence and GitHub link without a model call. Suspected secret shows the block and smaller-range selection; a clean selected range can reach preview. Model timeout/malformed evidence retains local lines, fixed failure reason and explicit Retry. A changed run points to Actions refresh/reopen. Oversized payload asks for a smaller excerpt; it does not silently resubmit. Tests prove the correction flow for each state as well as refusal.

Sequential automated gates: lint, syntax, npm test, full PTY. Re-run efficiency/transport gates only if this phase changes their inputs; otherwise cite the unchanged accepted Phase 3 identity. Manual: visual line references, preview and source conclusion at narrow/wide widths. Independently review and simplify before acceptance.

Offline mechanics may be complete with **live contract UNVERIFIED**. Authorized live evaluation uses the frozen parent CI corpus criteria and bounded evaluation tool; no live calls are implied by implementation. If per-category precision/evidence criteria fail, keep the local CI lens and mark semantic CI unqualified rather than lowering evidence requirements. Record exact candidate, excerpt/question/corpus hashes, gate results and live status. Stop for Phase 4 acceptance.
