# Phase 5: budget from response headers

> Parent: [`../2026-08-29-conditional-polling-and-calm-status.md`](../2026-08-29-conditional-polling-and-calm-status.md)
> Depends on: Phase 4 (headers only exist once the REST calls are `gh api -i`)
> Batch eligibility: no

## Objective

Close the control loop. The governor currently cannot see its own spend, because
the only counter it reads is pinned at zero.

## Execution and design gate

Phase 5 does not run in the Phase 1-4 implementation pass. Before Phase 5 source
work, review the protocol below separately.

One bootstrap tradeoff needs explicit acceptance. The verified free
`/rate_limit` source is not authoritative for core. An authoritative endpoint's
first request has no saved validator and can cost one core unit. The recommended
design permits one shared, bounded `/user` bootstrap observation, records that
unit immediately, and then uses conditional requests. This is a named
control-plane exception to the no-unadmitted-call rule and requires a matching
ADR 0003 and CONTRIBUTING update. The alternative is strict fail-closed startup:
a clean scope can make no REST progress until another admitted response supplies
an authoritative core sample. Do not claim that first bootstrap is both free
and authoritative.

## The defect, stated precisely

```text
callsPerMs = spendable / (resetMs - nowMs) / externalFactor      index.mjs:1304
spendable  = max(0, remaining - reserve - charged)               index.mjs:1231
```

`remaining`, `used` and `resetMs` all come from `gh api rate_limit`
(`index.mjs:3210`), which on this account reports `remaining: 5000, used: 0` and
a `reset` of `now + 3600` on every call, while real endpoints report a shared
bucket climbing against a fixed reset. Therefore:

- `spendable` is a constant ~4,000 and `resetMs - nowMs` a constant ~1 hour, so
  the pacing target never tightens as the real budget drains and never relaxes
  after a real reset.
- `globalUsedDelta` is always 0, so `externalSampleIsUsable`
  (`index.mjs:2689-2695`) is never satisfied, so `nextExternalFactor` returns its
  seed `1` forever (`index.mjs:1241-1261`) and never divides pacing.
- The only term that throttles anything is in-flight local `charged`, which
  `publishProbe` retires every minute (`index.mjs:2337-2341`).

## Source changes

### Step 1 --- split the probe by authoritative source

One shared claim/nonce remains the only owner of three core jobs: bootstrap,
exhaustion recovery, and external-burn detection.

```text
core observer:
  authenticated GET /user -i
  persist its ETag in the private governor state
  send If-None-Match once a validator exists
  304 -> authoritative core headers, zero primary units
  first 200 -> authoritative core headers, one recorded bootstrap unit

graphql observer:
  gh api rate_limit
  consume only resources.graphql
  treat it as the currently available probe, not an authoritative counter

forbidden:
  resources.core from gh api rate_limit never writes budgets.core,
  never changes epochs.core, and never participates in core freshness or reset
  ordering
```

At primary exhaustion, a valid 403/429 header sample publishes the block. The
single core observer waits until `resetMs + BUDGET_RESET_GRACE_MS`, then uses its
persisted validator for recovery evidence. During a healthy window it runs at
`BUDGET_PROBE_MS` to detect external burn. GraphQL keeps the existing probe
cadence independently.

### Step 2 --- state and deterministic precedence

Keep the same scope hash and file path so mixed-version processes cannot split
coordination. Rev the stored protocol shape; migrate the exact old shape under
the lock, while old code sees the new shape and fails closed.

```text
budgets[resource].source =
  "response-header" | "core-observer" | "rate-limit-probe"
budgets[resource].factorBaseline = { epoch, used, observedAt }
budgets[resource].knownLocalUsed = nonnegative integer
observers.core = { etag: string|null, outcome, at, nextAt }
```

`rate-limit-probe` is valid only for GraphQL. Only the claimed `core-observer`
or `rate-limit-probe` owner can change its resource epoch. An endpoint response
header is accepted only when its full `(limit, resetMs)` epoch matches the
persisted owner epoch. Within that epoch, greater `used` wins and an exact tie
uses later `receivedAt`; a lower `used` is an out-of-order response and is
ignored. Core `/rate_limit` data is excluded before this comparison, so it
cannot latch ahead of the core observer.

`--doctor` reports the winning source without exposing the scope or validator.

### Step 3 --- settle the response and reservation atomically

Do not add an independent `observeBudget` write. Replace response settlement
with one single-lock mutation:

```text
settleReservationWithBudgetObservations(
  scope, leaseId, reservationId,
  { outcome, actualCosts, observations }, nowMs
)
```

It revalidates the current scope, live lease ownership, and started reservation;
selects one deterministic sample per resource; updates the budget; records
definite local spend; and completes or reconciles the reservation in the same
atomic file replacement. Cost already covered by an accepted absolute counter
is marked accounted so `remaining` and the reservation do not both charge it.
An unobserved or uncertain tail remains conservatively charged.

A response header never clears `blockUntil` and never satisfies `manualProbe`.
Only the claimed observer can do that after reset evidence. A stale or foreign
scope writes nothing and leaves the reservation charged. Invalid or missing
headers use the existing conservative completion semantics without replacing a
valid budget.

### Step 4 --- external-factor attribution keeps the probe watermark

Do not infer external spend from arbitrary response arrival order. Atomic
settlement increments `knownLocalUsed` only for definite local cost. The claimed
core observer retains the existing drain and `claimAt` watermark, compares its
authoritative counter with `factorBaseline.used`, calls unchanged
`nextExternalFactor(global delta, known local delta)`, advances the baseline,
and clears only the accounted accumulator. Crash or ordering uncertainty remains
charged.

The three owner contracts stay executable:

1. **Bootstrap and exhaustion recovery.**
   `twelve exhausted core panes share one visible hold and make no REST data
   calls` passes with its assertions unmodified.
2. **External-burn detection.**
   `a real reset resumes all panes, while atomic external burn limits the next
   epoch` in `test/pty/governor.test.mjs` passes with its assertions unmodified.
3. **GraphQL bootstrap and freshness recovery.**
   The `rate_limit` probe remains its protocol owner, but later validation
   proved that its counter can stay fixed while real GraphQL use advances. It
   does not provide authoritative external-spend evidence.

The fixture changes source behavior, not these assertions: `/user` reads the
same atomic fixture core counter, a matching conditional response costs zero,
an exhausted 403 costs zero, and the first 200 costs one. Fixture
`rate_limit.core` is deliberately pinned/wrong so the suite proves it cannot
overwrite the core observer.

## Behaviour to match

- `a real reset resumes all panes, while atomic external burn limits the next
  epoch` in `test/pty/governor.test.mjs` is the executable guarantee that
  external burn is still caught. Its assertions must pass **unmodified**; if
  they need editing, the design has regressed.
- `test/governor.test.mjs:1392` (`"clean probe samples persist the shared
  external-spend factor"`) remains the executable law for the claimed observer
  and its `claimAt` watermark.

## Success criteria

### Automated

- Unit: source validation proves `/rate_limit` can update GraphQL but cannot
  update core, even when its reset is later.
- Unit: settlement rejects a different endpoint epoch, future observation,
  foreign scope, wrong lease, claimed-source label, and out-of-order same-epoch
  response; it accepts same-epoch monotonic samples deterministically.
- Unit: response settlement never clears `blockUntil` and never resolves
  `manualProbe`.
- Governor worker test: response settlement from 12 real processes against one
  state file is atomic, loses no definite local costs, and never double-charges
  an accepted absolute counter plus its reservation.
- Unit: core observer publication retains the existing claim watermark and
  external-factor law; arbitrary response order never updates the factor.
- PTY: with the fixture's counter moving, `budgets.core.used` tracks the fixture
  between probes rather than only at probe boundaries.
- PTY: the named exhausted-core and reset/external-burn governor cases pass
  with their assertions unmodified. If either assertion needs editing, stop:
  the redesign has regressed.
- Sequential verification passes.

### Manual

- Run four panes for 20 minutes with `GH_DEBUG=api` on one of them. Confirm the
  governor's stored `remaining` tracks the real `x-ratelimit-remaining` within
  one refresh interval, rather than sitting at 5000.
- Spend ~500 units out of band with a `gh` loop; confirm panes tighten within one
  probe interval and that the reserve is preserved.
- Confirm `--doctor` reports the header-derived budget and says which source it
  came from.

## Out of scope

GraphQL conditional requests. Removing the probe. Re-tuning cadences --- Phase 6.

## Completion

- [x] The v2 stored protocol migrates the exact v1 shape in place without
  changing the scope hash or `rate-governor-v1` path. Read-only and mutating
  migration paths persist v2 atomically before releasing the lock.
- [x] One shared claim owns the conditional core observer and the GraphQL-only
  `rate_limit` source. Core exhaustion waits through reset plus grace, while
  GraphQL-only observation remains independent.
- [x] Response observations and reservations settle in one lock mutation with
  deterministic ordering, exact local-cost attribution, conservative residual
  charging, and no response-driven block or manual-probe clearing.
- [x] Doctor uses claimed observations, reports the winning source, and does
  not expose a validator or scope identifier.
- [x] Source authority, migration, rewound and out-of-order samples, future and
  foreign observations, worker concurrency, 200/304/403 fixture costs, and
  slow-source claim renewal have direct automated coverage.
- [x] The protected bootstrap, exhaustion, reset/external-burn, factor,
  crash-recovery, and block contracts pass without weaker assertions.
- [x] Four live panes tracked authoritative core headers within one refresh,
  tightened within one probe after two controlled burns of about 500 units,
  and preserved the reserve. Doctor reported the winning `response-header`
  source after matching endpoint evidence. The Phase 6 notes contain the
  measured window and the mixed-epoch defect found before it.
- [x] Validation later proved the free GraphQL `rate_limit` counter can stay
  fixed while real GraphQL headers advance. GraphQL probe freshness remains
  fail-closed, but its admission counter is open-loop and no GraphQL reserve
  guarantee is claimed. The follow-up needs its own response-header design.
