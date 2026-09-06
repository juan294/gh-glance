# Phase 4 working notes

Written while implementing Phase 4. Kept because the next session needs to know
what was decided and why, not just what the diff says. Delete this file when
Phase 4 lands.

Base: develop @ 0cc944b (phases 1-3 pushed).
Schema half: landed in 7212bba, b8196e7 and 6f08824. Green on all three gates
(unit 364/364, PTY 112/112, lint).

## What landed

Observer state was split across two shapes for no reason -- `observers.core` for
one resource and a differently shaped `probeOutcome` for the other, with a
single `probeClaim` serializing both. The schema is now symmetric:

```
observers:   { core: {etag, outcome, at, nextAt}, graphql: {...} }
probeClaims: { core: claim|null, graphql: claim|null }
```

`probeOutcome` is deleted; `claim` drops `resources` because the key is now the
resource. GOVERNOR_STATE_VERSION 3 -> 4. Versions 3 and 2 stay readable as
evidence, which the restart boundary depends on.

## The three regressions, and what they cost to find

None of these were in the failing-test list 7212bba wrote down. That list
described tests encoding the old protocol; these were defects in the new one.

**Legacy files became unreadable.** `LEGACY_GOVERNOR_VERSIONS` listed 4, 3 and 2,
but `acceptVersion` only varied the version *number* against the current key
set -- and v4 changed the shape. Every file a v2 or v3 pane actually wrote was
rejected as `legacy-corrupt`, which is precisely the file the restart boundary
must read to see an older pane holding a live lease. Fixed by
`readLegacyGovernorState` + `adaptPreSplitGovernorShape`: a version number does
not identify a document, a shape does.

**One failed observer silenced the healthy one.** `governorWakeTimes` suppressed
the observed-cadence candidate for every resource whenever
`observers.graphql.outcome` was "failed" -- correct when `probeOutcome` was the
single outcome, wrong once each resource has its own. Now per resource.

**The core-reset coupling broke in both directions.** A core reset opens a new
shared accounting epoch, so GraphQL is due with it. The single claim enforced
that implicitly by evaluating both resources under one nonce. Split apart, it
stopped happening at all when core refreshed first (the publication moves core's
reset an hour out before GraphQL's claim is evaluated), and happened far too
much when GraphQL refreshed first (the same term keeps *every* pane qualifying
until core publishes -- twelve panes turned one due observation into four).
Both are now one predicate stated in each place it is decided: GraphQL is due at
a core reset only until it has observed since that reset.

## The lesson for phases 5-12

The reset coupling was invisible to 364 unit tests and only failed under PTY.
7212bba called the schema work "sound" on unit tests alone; it was not. Every
remaining Phase 4 item -- the throttle ladder, recovery election, pacing credit
-- is coordination *ordering*, which is the class of bug unit tests do not see.
Run `npm run test:pty` before believing any of it, and expect the first run to
tell you something. Reproducing a suspected ordering bug at unit level against
the real exported functions took seconds and beat waiting ~10 minutes per PTY
run to guess again; do that first, then confirm under PTY.

Also: `refreshSharedBudget` now refreshes GraphQL before core deliberately.
Core's publication is what reopens data admission, so refreshing it last keeps
the cycle's remaining control work from sitting between the reopened lane and
the data waiting for it. A pane that merely published the reset was otherwise
holding the shared permit for one more observer and taking the single data slot
ahead of a manual refresh holding the earlier reservation.

## Still outstanding

Nothing below is started.

### Throttle classification and ladder (SCHED-04/05/06)
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

Phase 2 already has the primitives: `transportCooldownDeadline`,
`applyTransportCooldown`, `SECONDARY_LIMIT_PATTERN`, and a flat 60s for
429/secondary. The ladder replaces that flat value and needs persisted attempt
state. `state.hosts[host]` can gain a `throttle` field the way `waiters` did --
see the optional-key pattern in `normalizeIdentityRegistry` -- so no registry
version bump is required.

### Estimator (SCHED-03)
- Keep sampling baseline + definite local accumulation until >= 5 local units.
- Two 4-unit local-only samples must take factor 7 -> 1.
- Authoritative new epoch resets factor and sample to 1 (reserve semantics unchanged).
- Quiet recovery: 5 min of valid unchanged counters, zero local cost, no
  uncertain work. Failed samples and external-only spend do NOT establish it.

### Pacing credit (SCHED-01/02/08)
- Future queue positions advisory; only startable work reserves.
- Credit refills from conservative spendable capacity over the remaining window.
- Cap accumulated credit at the largest permitted atomic operation (no idle bursts).
- Settlement returns unused primary credit (capped), retains HTTP pacing.
- At most 3 consecutive manual grants before an eligible active turn (SCHED-08).

Note on SCHED-08: the shared HTTP permit is strict FIFO on arrival
(`acquireIdentityHttpPermit`). Priority is enforced at grant time, not at the
permit, so a pane that queued milliseconds earlier keeps the single data slot
regardless of a higher-priority reservation behind it. That did not need fixing
for the reset case once the call ordering was restored, but it is the mechanism
SCHED-08 will have to address directly.

### New tests and docs
`test/scheduling-policy.test.mjs`, `test/pty/secondary-limit.test.mjs`, and the
ADR 0003 amendment (per-resource observers and v4, the throttle ladder, pacing
credit). ADR 0003's "Protocol and recovery" section still describes one shared
claim and `rate_limit` as the GraphQL probe.
