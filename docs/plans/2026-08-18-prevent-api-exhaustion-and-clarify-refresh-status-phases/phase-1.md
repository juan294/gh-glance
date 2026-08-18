# Phase 1: define the hard-reserve and grant policy

> Parent: [`../2026-08-18-prevent-api-exhaustion-and-clarify-refresh-status.md`](../2026-08-18-prevent-api-exhaustion-and-clarify-refresh-status.md)
> Batch eligibility: no

## Objective

Define a replacement for the current interval-only adaptive law as pure,
executable policy for
per-resource reserves, budget epochs, request priorities, safe pacing, and
fail-closed decisions. Do not change the running poll loop in this phase.

At phase completion, tests define exactly when a future governor may grant,
wait, pause, or probe. Existing runtime behavior can still call the old path
until Phase 3 wires the new policy.

## Source changes

### `index.mjs:995-1163`

Keep `REST_PER_FETCH`, `GRAPHQL_PER_FETCH`, `resourcePerTick()`, and cost-table
agreement. Add pure policy helpers beside `adaptiveRefreshMs()` and
`nextBudgetTargets()`. Leave those old runtime functions in place until Phase 3
can replace their callers atomically. The new helpers return discriminated
decisions rather than one clamped number.

Add named constants:

```text
BUDGET_RESERVE_FRACTION = 1 - BUDGET_SAFETY
BUDGET_SNAPSHOT_TTL_MS = 65_000
GOVERNOR_HEARTBEAT_MS = 20_000
GOVERNOR_LEASE_TTL_MS = 90_000
GOVERNOR_PROBE_LEASE_MS = 70_000
GOVERNOR_ACTIVE_PROBE_LEASE_MS = 35_000
BUDGET_RESET_GRACE_MS = 2_000
GOVERNOR_PHASE_WINDOW_MS = 5_000
```

Keep `BUDGET_PROBE_MS = 60_000`. The new safety calculation does not use the
60-second adaptive cap. A safe interval can exceed one minute. Phase 3 removes
the old cap and adapter after every runtime caller uses the governor.

Define normalized resource state and validate every numeric field:

```text
normalizeBudgetResource(raw, observedAt):
    require finite non-negative limit, remaining, used, resetMs, observedAt
    require remaining <= limit and used <= limit
    return normalized value or null

budgetEpoch(resource):
    stable identifier derived from resetMs and limit
```

Define the hard reserve and safe capacity:

```text
resourceReserve(limit):
    return ceil(limit * (1 - BUDGET_SAFETY))

availableForGrant({budget, reservations, nowMs}):
    if budget is absent, malformed, stale, or reset is due:
        return {mode: "probe" or "paused", reason}
    reserve = resourceReserve(budget.limit)
    spendable = budget.remaining - reserve - sum(unaccounted reservations)
    return max(0, spendable)
```

Define a resource decision with no ambiguous number-only result:

```text
ResourceDecision:
    {mode: "open", reserve, spendable, callsPerMs, resetMs, epoch}
    {mode: "waiting", retryAt, reason, resetMs, epoch}
    {mode: "paused", reason, resetMs, epoch}
    {mode: "probe", reason}
```

An open decision requires enough spendable capacity for the proposed
worst-case cost. Compute:

```text
externalFactor = max(1, globalUsedDelta / sharedCompletedDelta)
callsPerMs = spendable / (resetMs - nowMs) / externalFactor
```

Update the factor only when `sharedCompletedDelta >= MIN_SAMPLE_CALLS` and
`globalUsedDelta > 0`. Otherwise retain the prior factor. Preserve it across a
reset. Reject non-finite values and pause; never clamp a large factor downward.
A decision is paused at/below reserve, on a known shared block, or after an
expired window. Unknown or stale state requests a probe but grants no data call.

Define tab resource requirements from the existing tables, with no duplicate
cost constants:

```text
tabRequestCost(tab):
    return {core: REST_PER_FETCH[tab], graphql: GRAPHQL_PER_FETCH[tab]}
```

Extend that registry with explicit auxiliary costs: repository/failure context
is one GraphQL call; opening Actions is two core calls; opening Issues or pull
requests is two GraphQL calls; each individual doctor Security endpoint is one
core call. Mark `rate_limit`, version, auth-status, and local Git inspection as
zero. Add a test that every production `runGh` call site declares one registry
operation, so occasional paths cannot remain invisible to admission.

Define priorities in one ordered table:

```text
manual = diagnostic > tab-switch > active > background
```

Define deterministic queue ordering and lane pacing:

```text
scheduleIntents({intents, leases, budgets, reservations, lanes, nowMs}):
    prune invalid and expired unstarted intents
    group by priority
    round-robin equal priorities after each resource cursor
    for each intent:
        require every non-zero resource to be open
        notBefore = max(nowMs, resource laneNextAt, epoch phase)
        if notBefore >= resource resetMs:
            wait until reset + grace without a current-epoch reservation
        reserve worst-case cost only if it remains above reserve
        advance each resource lane by cost / callsPerMs
    return grants, updated lanes, updated cursors, denied decisions
```

For a request that needs two resources in the future, use the latest resource
slot and advance both lanes from that common `notBefore`. Current tabs use one
resource, but the helper must not encode that accident.

Do not expire a `started` reservation based only on its timestamp. A later
probe will reconcile it. An expired lease may release an unstarted scheduled
reservation because no subprocess began.

Keep `inferShare()` and `nextProbeWindow()` only if they remain useful for
measuring non-governor token spend. Rename fields from `myCalls` to shared
completed/reserved calls so the scope is not described as process-local. A
small sample holds the last external factor. A reset starts a new sample but
does not lower the factor to one.

### Test-only exports at `index.mjs:5614-5740`

Export the new constants and pure helpers through the existing test seam. Do
not create a production module or build step.

## Tests

### `test/unit.test.mjs:2059-2304`

Preserve tests for cost tables and projected cost agreement. Add the new policy
tests in this phase. Mark the old adaptive tests that pin these unsafe behaviors
for removal with their runtime functions in Phase 3:

- exhausted budget returns 60 seconds;
- widening is capped at 60 seconds;
- missing budget returns the configured floor.

Add table-driven tests:

1. A 5,000 limit produces a 1,000 reserve.
2. `remaining` at 1,000, below 1,000, and zero produces no grant.
3. A request whose worst-case cost crosses the reserve is denied.
4. A safe interval of 59 seconds, 60 seconds, 61 seconds, and 10 minutes stays
   mathematically safe; none is clamped faster.
5. An expired budget never uses `max(1, secondsToReset)` to reopen.
6. Missing, malformed, future-skewed, and stale samples grant nothing.
7. A known rate block pauses until its reset.
8. Core and GraphQL decisions are independent.
9. Security always reserves six REST calls.
10. Manual has priority but cannot cross the reserve.
11. Equal-priority leases rotate fairly and deterministically.
12. Background intents yield to active intents.
13. Started reservations remain charged after their lease expires.
14. Unstarted reservations can be reclaimed after lease expiry.
15. Reset changes the epoch and produces a new deterministic phase.
16. Lower remaining, longer time to reset, larger request cost, or larger
    external factor never produces an earlier slot.
17. A small external-spend sample retains the prior factor.
18. Fresh-window cases for 1, 3, 7, 12, and 20 identical leases keep the
    aggregate lane inside the 4,000-call spendable budget.
19. A lane slot at or after reset creates no old-epoch reservation and waits for
    a fresh post-reset decision.

Add a deterministic closed-loop simulation with a fake clock. Run a full
budget window for both resources with:

- leases joining and leaving;
- Actions-, Issues-, pull-request-, and Security-active mixes;
- background demand;
- an external consumer burst;
- a rate-window reset.

Assert after every step that gh-glance reservations do not consume the hard
reserve and that all continuously live active leases eventually receive a
grant while capacity exists.

### `test/runtime-remediation.test.mjs:172-223`

Replace interval-target assertions with per-tab resource-decision assertions.
Keep the existing loading visibility tests unchanged in this phase; Phase 4
will replace their footer contract.

## Automated success criteria

- All new pure policy tests pass.
- The new tests reject exhausted and missing-budget grants. The old adapter
  tests remain only until Phase 3 removes the old runtime path.
- Cost tables remain the single source of truth.
- No live fetch path has changed yet.
- Run sequentially:

  ```bash
  npm run lint
  npm test
  node --check index.mjs
  git diff --check
  ```

## Manual success criteria

None. This phase creates a pure policy contract and does not change runtime
behavior.

## Stop condition

Stop after the pure reserve, decision, queue, and simulation tests are green.
Do not add persistence or route live requests through the policy in this phase.
