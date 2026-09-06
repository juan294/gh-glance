# Phase 4 working notes

Written while implementing the schema half of Phase 4 (commit `wip: split
observer claims per resource`). Kept because the next session needs to know
what was decided and why, not just what the diff says. Delete this file when
Phase 4 lands.


Base: develop @ 0cc944b (phases 1-3 pushed, CI watching).

## The asymmetry to remove
Today observer state is split across two shapes for no reason:
- `state.observers.core = { etag, outcome, at, nextAt }`  (core only; exactKeys(raw.observers, ["core"]))
- `state.probeOutcome  = { status, at, nextAt }`          (de facto the GraphQL one)
- `state.probeClaim` is ONE claim serializing both resources (`claim.resources`).

Phase 4 requires independent claims, readiness and outcomes per resource, and an
*atomic* validator/migration replacement (not a runtime-field tweak).

## Target schema (GOVERNOR_STATE_VERSION 3 -> 4)
```
observers: {
  core:    { etag, outcome, at, nextAt },
  graphql: { etag, outcome, at, nextAt },
}
probeClaims: { core: claim|null, graphql: claim|null }
```
`probeOutcome` is deleted. `claim` keeps { ownerLeaseId, nonce, leaseUntil,
nextAt, claimAt, startedReservationIds } but drops `resources` (the key is now
the resource). LEGACY_GOVERNOR_VERSIONS gains 3, so a still-running phase-3 pane
is readable as legacy evidence.

Touch points: emptyGovernorState (~3046), normalizeGovernorState (~3226-3244),
migrateGovernorState (~3290), claimProbe (3714), publishProbe (3852),
failProbeClaim, renewProbeClaim, refreshSharedBudget (~4189), governorWakeTimes
(7491), deferredBackground (3606), doctor report, and every test constructing
probeClaim/probeOutcome.

## SCHED-07 property
A failed/slow GraphQL observer must not invalidate fresh core authority, and the
core lane must start as soon as the shared HTTP permit frees -- not wait for the
GraphQL observer's retry or publication. That falls out of separate claims plus
the existing permit; the test must prove the *ordering*, not just the outcome.

## Throttle classification (SCHED-04/05/06)
`classifyThrottle({ status, headers, graphqlErrors, stderr })`:
- Retry-After seconds or HTTP-date -> shared cooldown at that deadline (never shortened).
- else confirmed secondary/abuse or generic 429 -> ladder 60/120/240/480/900s
  by attempt count; the 900 cap applies only to the locally chosen delay, never
  to a server-supplied deadline.
- Permission-only 403 (no rate-limit headers, no secondary marker) -> NOT a throttle.
- Primary exhaustion -> holds only that resource until its reset.
- 5 consecutive failures -> paused until manual retry or a reset-triggered
  recovery opportunity, still respecting the deadline.
- Cooldowns merge by maximum and survive primary epoch changes.

## Estimator (SCHED-03)
- Keep sampling baseline + definite local accumulation until >= 5 local units.
- Two 4-unit local-only samples must take factor 7 -> 1.
- Authoritative new epoch resets factor and sample to 1 (reserve semantics unchanged).
- Quiet recovery: 5 min of valid unchanged counters, zero local cost, no
  uncertain work. Failed samples and external-only spend do NOT establish it.

## Pacing credit (SCHED-01/02/08)
- Future queue positions advisory; only startable work reserves.
- Credit refills from conservative spendable capacity over the remaining window.
- Cap accumulated credit at the largest permitted atomic operation (no idle bursts).
- Settlement returns unused primary credit (capped), retains HTTP pacing.
- At most 3 consecutive manual grants before an eligible active turn (SCHED-08).

## New tests
`test/scheduling-policy.test.mjs`, `test/pty/secondary-limit.test.mjs`.
Update ADR 0003 guarantees to match.
