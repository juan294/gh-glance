# Phase 3 validation: sustained freshness and package boundary

Status: Phase 3 local implementation accepted after independent review, simplify,
and five sequential passing gates. Base commit:
`e77be88125d09736307f7a5d300f58f186362ca9`. Work was confined to the
isolated `codex/durable-freshness-20260928` worktree. No push, live install,
provider qualification, or merge occurred.

The staged Phase 3 source, tests, README, and changelog patch, excluding this
self-referential validation document and the generated JSON, has SHA-256
`d45475067580ef7122d5989f6e7220f6daf9132d4ff103f8a18a4cd440503666`.
The extracted-candidate package SHA-256 is
`bd23a891011902014aed4d86e44290c9add13ab9d4115e8238b2049992f06c35`.
The final-shape oracle JSON, regenerated from the `npm test` gate, has SHA-256
`fa0d91a2c9cb2f3d6820f705a13d51903397729077f35327a58a2f99c762f4e7`.
The local commit SHA follows final gates; putting it here would make the
document hash self-referential.

## Implementation and contract

The deterministic request oracle now identifies the resource, access scope,
response headers, issue time, finish time, and independent counter delta for
each HTTP request (`test/fixtures/request-oracle.mjs:378`,
`scripts/sustained-recovery.mjs:275`). The 72-hour exercise calls production
admission, dispatch, settlement, observer, acquisition, and receipt functions.
Its 1/6/10-pane cohorts retain subscriptions and cover duplicate and distinct
repositories, Actions, Issues, Pull Requests, Security, repeated resets, a
short and long sleep, and an identity change (`scripts/sustained-recovery.mjs:20`,
`scripts/sustained-recovery.mjs:211`, `test/sustained-recovery.test.mjs:6`).
One deterministic completion lock fault per cohort retains the same receipt
and retries its write without issuing another HTTP request
(`scripts/sustained-recovery.mjs:351`, `scripts/sustained-recovery.mjs:407`).
The oracle reconciles every request issue/finish and counter delta, every
completed reservation's persisted cost, every unresolved charge, source
publication against a finished response, and source generation order
(`scripts/sustained-recovery.mjs:126`, `test/sustained-recovery.test.mjs:43`).

The virtual interruption leaves the harness PID live and deliberately omits
child-close and terminal evidence. It tests conservative retention and does
not simulate a dead operating-system process. Real SIGKILL evidence is linked
below; this is an explicit cross-test substitution for the phase plan's
integrated process-churn window (`scripts/sustained-recovery.mjs:377`,
`test/governor.test.mjs:4118`, `test/pty/governor.test.mjs:1070`).
Outside the declared sleep, pane subscriptions stay live throughout each
cohort. The sleep fixture explicitly unsubscribes and subscribes again at
resume, so this is not an uninterrupted live subscription across sleep
(`scripts/sustained-recovery.mjs:278`).

The independent source allowance is declared by each cohort. Source age does
not inherit production `nextDueAt`. The report keeps raw gaps and subtracts
only the exact declared sleep interval for awake cadence; each affected query
has a paired raw/eligible gap, and first post-sleep observation remains bound
to 60 seconds (`scripts/sustained-recovery.mjs:466`,
`test/sustained-recovery.test.mjs:29`). The 12-worker 5,000-Core fixture with
1,005 remaining measures observer-adjusted spendable capacity, staggered
grant slots, a measured Core charge, reserve protection, waiting until reset,
and fresh scheduled grants after reset (`test/governor.test.mjs:4041`). Its
earliest scheduled worker is the one settled before reset; later slots remain
reserved and are not represented as HTTP issues. The existing 12-worker
contention test covers shared probe and lane fairness separately
(`test/governor.test.mjs:3891`).

The schema-2 monitor fixes the candidate hash, requested duration, 5-second
sample interval, and host/repository/tab/access/PID cohort before sampling.
It rejects late or dead panes, missing subscriptions, clock reversal, gaps
over 15 seconds, future/regressing source clocks, zero new source success,
early SIGINT, and unrelated quota scopes. It derives deadlines from declared
cadence and active recovery, including a 60-second first/recovery bound
(`scripts/freshness-monitor.mjs:26`, `scripts/freshness-monitor.mjs:144`,
`scripts/freshness-monitor.mjs:231`, `test/freshness-monitor.test.mjs:76`,
`test/freshness-monitor.test.mjs:87`, `test/freshness-monitor.test.mjs:112`).
An external exclusion requires a scoped, append-only captured provider
response with issue/finish times and a 429 or rate-exhausted 403 plus
`Retry-After`; synthetic request-oracle records are rejected by schema 2, and
a local observer/coordination hold fails immediately even if it clears before
the source deadline. An app hold alone never excludes time. The report separates
wall, external, and eligible durations. Its derived `windowClass` is `short`
below 30 minutes, `initial` from 30 minutes to under 24 hours, and `full`
from 24 hours. A short unit run is not F12 completion
(`scripts/freshness-monitor.mjs:87`, `scripts/freshness-monitor.mjs:466`,
`test/freshness-monitor.test.mjs:64`, `test/freshness-monitor.test.mjs:185`).
Schema 1 remains diagnostic only.

The package PTY test packs the current candidate, extracts it, installs
production dependencies from its own package metadata, and runs its CLI from
an empty working directory with explicit fixture `gh`. The valid aged v6
fixture has 511 started receipts, one completed receipt, a fresh 5,000-unit
Core observation, and retained Core 456/GraphQL 162 charge. Three stage
captures require rendered queued, running, and completed Actions values and
strictly increasing source-success timestamps. The unmodified installed
0.15.2 negative uses the same fixture and remains source-stale while still
reading valid v6 evidence (`test/pty/governor.test.mjs:228`,
`test/pty/governor.test.mjs:265`, `test/pty/governor.test.mjs:349`).

## Focused evidence and failed attempts

The first 72-hour run failed after 369.233 seconds because its final
conservation check counted aggregate debt but omitted a still-detailed,
started receipt. The receipt remained charged; the oracle now adds disjoint
aggregate debt and detailed started cost. The next run passed conservation
but failed mixed-cohort cadence because it counted the declared one-hour
sleep as eligible time: raw gap 5,911,746 ms against 5,400,000 ms. The
allowance was not widened. The oracle now reports both raw and awake gaps and
tests an exact paired sleep difference. Logs:
`/tmp/gh-glance-phase3-sustained.log` and
`/tmp/gh-glance-phase3-sustained-final-candidate.log`.

The corrected pre-simplify seeded report passed 2/2 in 375.470 seconds at
`/tmp/gh-glance-phase3-sustained-sampled.log`. The final-shape report was
regenerated by the 700/700 passing `npm test` gate in 375.943 seconds at
`/tmp/gh-glance-phase3-final-test.log`; its generated JSON is
`phase-3-oracle-report.json` (seed `0x20260928`, simulated 72 hours).
It recorded 12,100 admissions, 1,340 interruptions, 408 reset observations,
and exact request/receipt/source reconciliation. Sampled peaks at every
100th operation and the final state were 66,171 ledger bytes, four detailed
receipts, and 128 debt groups. The single/mixed/distinct cohorts first
published in 4.607/22.443/49.451 seconds. The mixed raw maximum source gap
was 5,911,746 ms across its declared one-hour sleep; its maximum awake gap
was 2,902,399 ms against a 5,400,000 ms allowance, and its slowest
post-resume source succeeded in 23.082 seconds. Distinct Core outstanding
charge was 366 units: 365 aggregate debt plus one detailed started receipt;
GraphQL outstanding was 488. Each of the three completion-lock faults
retained its original receipt and retried settlement without another HTTP
request. The virtual run used feasible 5,000/15,000-unit cohort demand;
the separate reserve fixture above supplies oversubscribed evidence.

The initial packed diagnostic failed while the aged v6 fixture used a reset
two seconds earlier than the fixture observer. A temporary bounded trace
showed the mismatch; using the fixture's exact reset identity retained the
valid 511-started/one-completed ledger. A lockfile-copy install also failed
before this fix, so dependency drift was not the cause. Trace hooks were
removed. The final packed candidate passed 1/1 in 13.290 seconds
(`/tmp/gh-glance-phase3-packed-final.log`); unmodified 0.15.2 stayed stale
1/1 in 15.497 seconds (`/tmp/gh-glance-phase3-baseline-final.log`). Its installed
source SHA-256 was
`a05d47418387e9ce30eec2e9c8cf5310f240ccb7bcbe523bfb7d392350a68f5a`.
The package test uses `npm install --prefer-offline` from the extracted
package's own metadata, with no copied checkout lock or dependency symlink.

One monitor-focused run failed 25/26 because the one-second CLI test's timer
reached its deadline after `sample()` had recorded a slightly shorter
monotonic elapsed duration. The CLI now stops only after a sample itself
covers the requested duration (`scripts/freshness-monitor.mjs:530`). Five
full monitor-file repeats passed 26/26 each
(`/tmp/gh-glance-phase3-monitor-fixed-{1..5}.log`).
After independent review required raw captured responses and immediate local
hold failure, the focused monitor file passed 27/27 in 1.340 seconds
(`/tmp/gh-glance-phase3-monitor-review-repair.log`).
The real governor SIGKILL companion passed 1/1 in 0.543 seconds
(`/tmp/gh-glance-phase3-real-crash.log`), and the PTY survivor/recovery case
passed 1/1 in 119.707 seconds
(`/tmp/gh-glance-phase3-real-crash-pty.log`). The new oversubscribed 12-worker
case passed 1/1 in 1.972 seconds
(`/tmp/gh-glance-phase3-oversubscribed.log`).

## F01–F11 disposition

| Contract | Local evidence | Disposition |
| --- | --- | --- |
| F01 | Extracted-package PTY and unmodified 0.15.2 negative above, bound to the package hash above | Local package case and full PTY regression pass; live installation remains Phase 4 work |
| F02–F07 | Accepted Phase 1 ledger, migration, dispatch, observer, acquisition, and terminalization evidence in `phase-1-validation.md` | Retained by passing Phase 3 regression gates |
| F08 | Accepted Phase 2 cause/action, read-only doctor, and terminal modes in `phase-2-validation.md` | Retained by passing Phase 3 regression gates |
| F09 | 72-hour per-request and quota reconciliation, real SIGKILL companion, storage-write retry, bounded state checks | Local virtual acceptance; actual death is linked companion evidence, not a virtual claim |
| F10 | Independent cohort cadence, paired sleep exclusion, <=60s first/resume checks, oversubscribed 5,000-Core reserve fixture | Local acceptance; provider/live freshness remains unmeasured |
| F11 | Schema-2 cohort/hash/duration/clock/gap/failure tests and exact provider-response exclusion | Monitor method passes local tests; a real uninterrupted 24-hour window remains unmeasured |

The virtual report's ledger byte/receipt/debt-group peaks are sampled every
100 operations and at the final state. They are **sampled peaks**, not proven
global maxima. The hard 2 MiB write boundary and 512-receipt/128-group
schema bounds are verified independently in Phase 1, including the
maximum-cardinality preservation test (`test/governor.test.mjs:3567`).
Unknown owner/child charge is not refunded by the virtual reset counter.
Actual GitHub, EMU, monitor interruption over a full window, and real source
transitions remain **unmeasured** until Phase 4.

## Final sequential gates

These gates ran in order against the unchanged Phase 3 executable and test
inputs identified by the staged patch hash above. The generated oracle JSON
was refreshed by the `npm test` gate; only evidence documents changed after
the gates.

| Gate | Result | Evidence |
| --- | --- | --- |
| `npm run lint` | Pass | `/tmp/gh-glance-phase3-final-lint.log` |
| `node --check index.mjs` | Pass | `/tmp/gh-glance-phase3-final-syntax.log` |
| `npm test` | 700 passed, 0 failed; 375.943 seconds | `/tmp/gh-glance-phase3-final-test.log` |
| `npm run test:efficiency` | 9 passed, 0 failed; 94.371 seconds | `/tmp/gh-glance-phase3-final-efficiency.log` |
| `npm run test:pty` | 147 passed, 0 failed, 1 opt-in skip; 1,779.905 seconds | `/tmp/gh-glance-phase3-final-pty.log` |

The skipped PTY case reruns the unmodified installed 0.15.2 executable only
when `GH_GLANCE_BASELINE_ENTRY` is set. Its separate same-fixture negative
passed 1/1 at `/tmp/gh-glance-phase3-baseline-final.log`; the extracted
candidate case passed again inside the full PTY gate. The sustained
coordination notice in that gate rendered cause and action 1,474 ms after
visible `Paused`, within its 2,000 ms bound. Earlier diagnostic gate failures
and their repairs are recorded above; later passes do not erase them.

## Independent review and simplify

The independent reviewer accepted the F01/F09–F11 contract after checking
the package boundary and baseline staleness, raw-provider exclusion and local
hold failure, 72-hour charge/source reconciliation, sampled-peak labeling,
and the explicit real-process companion boundary. `git diff --cached --check`
was clean. The dedicated `codex-simplify` pass used three local lenses.
For reuse and efficiency, it indexed oracle requests by reservation once
instead of scanning every issue for each of 12,100 reservations. For quality,
it renamed virtual `crash` fields to `unterminalized` so the generated JSON
cannot imply that a real process died, and it rejects duplicate request IDs
that could otherwise mask a charge. The focused negative reconciliation test
and 110-operation mini cohort passed after this change. This cleanup changes
the sustained script/test and generated report shape, so the pre-simplify
72-hour log remains diagnostic; the final `npm test` gate regenerated the
accepted JSON. No unrelated refactor was applied.

## Phase 4 activation manifest field inventory

The live schema-2 manifest is fixed before each window. Two separately
completed reports are required: an initial 1,800,000 ms window and a full
86,400,000 ms window, both sampled every 5,000 ms. The test candidate's
package SHA-256 is local evidence only; the live manifest must hash the exact
installed candidate executable under observation. The following fields have
no live values in Phase 3 and require read-only discovery from the selected
environment before activation:

| Field | Required live derivation |
| --- | --- |
| `schema` | Constant `2` |
| `candidateHash` | SHA-256 of the installed candidate executable for that window |
| `requestedDurationMs` | `1800000` for the initial run; `86400000` for the full run |
| `sampleIntervalMs` | Constant `5000` |
| `panes[].id`, `panes[].pid`, `panes[].startedAt` | Every launched pane's declared identity, live PID, and subscription start time before first sample |
| `panes[].repository`, `panes[].repositoryId`, `panes[].tab` | Exact expected repository and Actions/Issues/PRs/Security selection |
| `panes[].host`, `panes[].accessKey` | Exact effective host and private access fingerprint from the chosen auth scope |
| `panes[].cadenceMs` | Declared expected source cadence before measurement, independent of runtime `nextDueAt` |
| `--store`, `--quota`, `--report` | Cached acquisition path, registry-matched quota path, and a new private report path |
| `--external-evidence` | Optional append-only, scoped captured provider-response trace; no inferred outage labels |

Phase 4 must reject any missing/ambiguous identity, path, or cohort member,
and must retain the full JSONL for each window. Neither this local report nor
the schema-1 diagnostic mode proves live F12 acceptance.
