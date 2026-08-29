# Conditional polling and calm status implementation notes

## Deviations

### Phase 1 PTY execution

- **Plan said:** Run `npm run test:pty` as one serialized Node test command.
- **Found:** Three aggregate runs under supported Node 24 and Node 22 failed in
  different unchanged cases: two timing assertions, one `spawnSync` timeout,
  one stray terminal `^D`, and one crash-recovery count. Each affected complete
  module passed when rerun alone, so no failure repeated at module scope.
- **Chose:** Run every `test/pty/*.test.mjs` file sequentially in its own Node
  process. All 84 PTY cases passed, including the new Phase 1 transition and all
  governor, throttle, geometry, lifecycle, selection, and remediation modules.
- **Why:** Per-file isolation preserves the repository's required sequential
  execution while avoiding aggregate local PTY process pressure. No assertion,
  timeout, or product contract was weakened.

### Phase 2 PTY execution

- **Plan said:** Run `npm run test:pty` as one serialized Node test command.
- **Found:** An aggregate run placed a literal terminal `^D` in the final guard
  row of the 45-column footer case. The unchanged empty-row assertion passed
  when the complete status module ran in its own Node process.
- **Chose:** Keep the guard-row assertion unchanged and run every PTY module
  sequentially in its own Node process. All 85 cases passed after Phase 2.
- **Why:** The failure is the same local aggregate process-pressure artifact
  recorded in Phase 1. Module isolation verifies the product contract without
  weakening an assertion or increasing a timeout.

### Phase 3 Security unusable-output path

- **Plan said:** Route unusable subprocess JSON through the shared poll-result
  transition and retry it on the next tick.
- **Found:** Security parses each endpoint inside `fetchAlertSource`, before the
  shared transition, and its separate unchanged-data cadence gate can suppress
  the next otherwise admitted scheduler tick.
- **Chose:** Tag JSON syntax failures at the app-owned parse seam, propagate an
  unusable Security sentinel without replacing any source rows, and clear only
  `securityNextPollAt` when that transition settles.
- **Why:** This gives list and Security tabs the same silent, next-tick recovery
  contract while preserving their different fetch structures and all last-good
  data and freshness state.

### Phase 3 PTY execution

- **Plan said:** Run `npm run test:pty` as one serialized Node test command.
- **Found:** After seven isolated modules passed in sequence, an unchanged
  top-level remediation capture reached the harness `spawnSync` timeout. The
  complete remediation module had passed immediately before the full sequence.
- **Chose:** Keep every assertion and timeout unchanged, retain the complete
  remediation pass, and finish the remaining isolated modules separately. All
  87 PTY cases have a passing module run for the Phase 3 candidate.
- **Why:** This is the same aggregate local PTY process-pressure behavior from
  Phases 1 and 2, not a repeated product failure in an isolated module.

### Phase 4 PTY EOF replay

- **Plan said:** Keep the exact guard-row and frame-height assertions while the
  conditional-request PTYs extend the serialized suite.
- **Found:** In the longer full run, BSD `script` echoed its synthetic EOF as
  the exact sequence `^D\b\b`. Terminal replay treated those driver bytes as an
  application row. The same suite pressure also exposed one pre-existing
  remediation wait that polled buffered capture output without enabling live
  flushing. After that harness correction, the aggregate command still reached
  the unchanged `spawnSync` timeout in the same top-level remediation capture;
  the complete module passed in isolation.
- **Chose:** Remove only `^D\b\b` from terminal replay. Keep raw capture intact,
  preserve ordinary printable `^D`, keep both geometry assertions exact, and
  enable the harness's existing live-flush mode for the output-driven wait. Run
  every PTY module sequentially in its own Node process; all 94 cases passed.
- **Why:** The replay now models the application screen instead of the PTY
  driver's EOF echo. A capture regression distinguishes the two sequences, and
  module isolation verifies the full product contract without weaker
  assertions or longer timeouts. The aggregate-only failure matches the local
  PTY process-pressure behavior recorded in Phases 1 through 3.

### Phase 5 executable contract location

- **Plan said:** The external-burn guarantee was in
  `test/pty/throttle.test.mjs:391`.
- **Found:** The executable case is `a real reset resumes all panes, while
  atomic external burn limits the next epoch` in
  `test/pty/governor.test.mjs`. The cited throttle line was diagnostic data in
  another case.
- **Chose:** Name the governor case directly and keep its predicate and
  assertions unchanged.
- **Why:** A stable test name identifies the intended owner contract and avoids
  a false claim about which suite proves external-burn detection.

### Phase 5 split-source claim

- **Plan said:** Core and GraphQL have independent source authority and due
  clocks under one shared claim and nonce.
- **Found:** A core reset must also advance the free GraphQL sample in the same
  transition to preserve one coherent reset publication, while an ordinary
  GraphQL minute observation must not wake exhausted core early.
- **Chose:** Claims contain only due resources. Core reset also makes GraphQL
  due under that nonce; GraphQL-only cadence does not make core due.
- **Why:** Each observer keeps its owner and exhaustion deadline without
  splitting reset accounting or changing the protected reset contract.

### Phase 5 Actions fixture ordering

- **Plan said:** Keep the reset/external-burn governor test unchanged while
  Actions continues to issue its two endpoint calls in parallel.
- **Found:** Separate fixture child processes can record the workflows start
  before the runs start even though production launches runs first. The test's
  existing readiness predicate can then inspect a half-recorded final batch.
- **Chose:** In the stateful fixture only, a workflows child waits for the same
  dashboard process's runs start. Production keeps parallel requests, and the
  protected predicate and assertions remain unchanged.
- **Why:** The fixture now records the declared Actions batch order
  deterministically without weakening the product contract or serializing the
  real requests.

### Phase 5 held manual-probe observation

- **Plan said:** A forced refresh must not wake an exhausted core observer
  before reset, while its coalesced manual probe demand still runs once.
- **Found:** The older throttle PTY waited for the held core budget's
  `observedAt` to advance. Under the approved split-source contract, that field
  correctly stays fixed while the free GraphQL source publishes the manual
  observation.
- **Chose:** Observe the GraphQL publication in that test while retaining the
  exact two-probe count, exhausted-core state, and zero REST data-call checks.
- **Why:** The assertion now proves the permitted free probe without requiring
  the known-exhausted core observer to spend or wake early.

### Phase 5 verification

- `node --check index.mjs`, `npm run lint`, and all 290 unit tests passed.
- All 94 PTY cases passed in isolated module processes. One conditional-request
  case hit the previously recorded sequence-only process-pressure timeout and
  then passed unchanged when its complete module ran in a fresh process.
- The protected exhaustion and reset/external-burn governor cases passed with
  their predicates and assertions unchanged.

### Phase 5 live mixed-epoch correction

- **Plan said:** Any endpoint response header with a non-rewound reset could
  advance the stored core epoch.
- **Found:** GitHub returned different core reset epochs from different REST
  endpoints at the same time. A later endpoint epoch could replace the `/user`
  observer epoch, after which authoritative samples for the real shared window
  were rejected as rewinds.
- **Chose:** Only the claimed observer can establish or move an epoch. Response
  settlement accepts only `response-header` samples whose full
  `(limit, resetMs)` epoch matches that owner epoch, then applies monotonic
  counter ordering inside it.
- **Why:** The owner remains authoritative while useful endpoint counters still
  close the loop. In the accepted hour, 1,125 endpoint headers matched the
  owner epoch and 1,722 endpoint-specific headers were safely ignored.

## Phase 6 measurement and tuning

### Window and method

- Four real panes ran continuously from 2026-08-29 22:02:17 to 23:02:17 CEST.
  A 2-second private governor sampler recorded 1,782 samples; its maximum gap
  was 3 seconds, and every sample contained four live leases.
- The window crossed the real core reset at 22:36:53 CEST. The next owner
  sample established the new epoch. Only one REST response completed in second
  3 after reset, three in second 4, none in seconds 5 through 13, and two in
  second 14, so there was no synchronized reset burst.
- Temporary JSONL instrumentation accepted only operation names, status kinds,
  response codes, declared costs, numeric rate fields, and source labels. It
  excluded targets, paths, IDs, titles, bodies, tokens, and error text, and was
  removed before the final candidate.

### Measured cost and conditional results

- Actions made 528 runs and 528 workflows requests. Security made 1,791 alert
  requests. All 2,847 data REST responses were `304`; 59 conditional `/user`
  observer responses were also `304`. The measured panes used 0 attributable
  core units in the window.
- Issues and pull requests completed 760 and 789 successful two-unit GraphQL
  operations. Their declared attributable load was 3,098 units.
- Core remaining never fell below 2,775 of 5,000. GraphQL reported 5,000 of
  5,000 throughout. Both stayed above the 1,000-unit hard reserve.

### Status and freshness

- Actions spent 286.200 seconds Checking, 3,308.543 seconds Watching, and
  0.318 seconds Paused. Issues spent 391.199 seconds Checking, 3,148.992
  seconds Watching, 54.275 seconds Paused, and 1.955 seconds Failed. Pull
  requests spent 268.680 seconds Checking, 3,304.131 seconds Watching, 22.405
  seconds Paused, and 2.961 seconds Failed. Security spent 208.448 seconds
  Checking, 1,943.178 seconds Watching, and 1,448.275 seconds Failed because an
  alert source was unavailable. No pane stayed inert.
- Core observation age peaked at 60.813 seconds and had no 65-second stale
  transition. GraphQL age peaked at 122.591 seconds and crossed the old
  65-second TTL in two episodes when one minute sample could not advance its
  sliding epoch.

### Decisions

- Keep `BUDGET_PROBE_MS = 60_000` and the core
  `BUDGET_SNAPSHOT_TTL_MS = 65_000`. Core headers maintained freshness between
  owner probes, and the probe still owns bootstrap, exhaustion recovery,
  external-burn detection, and GraphQL observation.
- Set the GraphQL TTL to `2 * 60_000 + 5_000 = 125_000` ms. The derivation is
  two probe periods plus the existing 5-second grace. It covers the measured
  122.591-second worst case, produces zero stale episodes for this window, and
  still fails closed after two consecutive unusable observations.
- Do not add factor decay. The valid-window factor peaked at 7.58, returned to
  1 within 305 seconds, and ended at 1.21 while other existing local consumers
  continued to use the account. Two earlier controlled burns of about 500
  units also tightened pacing within one probe and then converged naturally.
- Add transient `sharing N` copy for a wait caused only by a lane owned by
  another live lease. Four-pane PTY evidence shows `Watching sharing 4` and the
  same hint start column as settled Watching. Stored reservations retain their
  exact v2 shape.
- Keep the five-second default. Every measured REST data response was a free
  `304`, but no `200` change occurred in the accepted hour. The observation
  therefore does not justify changing the floor or claiming a measured
  changed-repository latency.

### Phase 6 final verification

- `node --check index.mjs`, `npm run lint`, all 295 unit and real-filesystem
  tests, `node index.mjs --help`, and `git diff --check` passed on the final
  candidate.
- All 95 PTY cases passed in isolated module processes. The protected
  exhausted-core and reset/external-burn cases passed with their predicates and
  assertions unchanged.
- The simplify review removed hot-path budget clones and scheduler allocations,
  centralized sharing validation, reduced the new four-pane PTY from a fixed
  15-second hold to a readiness handshake, rejected wrong-source core probe
  publication, and revalidates transient sharing evidence against current live
  leases. No measurement-only code or test remains.
