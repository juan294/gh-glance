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

## Landed since

SCHED-03/04/05/06/08 are implemented, tested and green on all three gates.
Highlights that are not obvious from the diff:

- The throttle ladder's cap binds only a locally chosen delay. A server-supplied
  `Retry-After` is honoured exactly however long it is, and holds merge by
  maximum so a shorter concurrent error cannot erode a longer one.
- A permission-only 403 is explicitly not a throttle. It previously could hold
  the shared transport, which paused every pane over one unreadable repository.
- The estimator could raise its factor and had no reliable way to lower it:
  publishProbe closed the sampling window on every publication, including
  samples too small to reconcile, so local accumulation was thrown away before
  it could reach the five-unit minimum. Only a reconciled sample closes the
  window now. Nothing is written in the other branch on purpose -- keeping the
  baseline is what lets the completed reservations behind it count again, and
  folding them into the local total as well counts the same spend twice.
- A new epoch no longer inherits the previous window's ratio.
- GOVERNOR_STATE_VERSION is 5. Version 4 was never released, so phase 4 ships
  one combined 3 -> 5 break. LEGACY_GOVERNOR_VERSIONS now spans two adaptations:
  v4 needs only the fairness field defaulted, v3/v2 need the observer shape
  rewritten first.

## Still outstanding

Only SCHED-01 and SCHED-02's pacing credit remains, and it is the largest single
piece of the phase:

- Future queue positions become advisory estimates; only startable work takes a
  quota reservation.
- Track primary pacing credit/debt from actual and uncertain costs, refilled
  from conservative spendable capacity over the remaining window.
- Cap accumulated credit at the largest permitted atomic operation, so idle time
  cannot become a burst.
- Settlement returns unused primary credit, capped, and retains HTTP pacing.
- A zero-cost settlement (a 304) advances the next primary-limited request
  subject only to the HTTP gap, and cancelled work leaves no empty slot.

Much of what SCHED-01/02 *assert* already holds -- the reserve, the shared
permit, and retention of uncertain cost are phase 2/3 work with PTY coverage
("twelve real workers share one probe", "twelve mixed active panes pace core and
GraphQL without consuming either reserve"). What does not exist is the credit
mechanism itself. Write the SCHED-01/02 acceptance tests first against current
behaviour to find out which parts already pass; that tells you how much of this
is new code rather than a new name for existing code.

One trap, learned the hard way in SCHED-08: intents are planned as they are
registered, so an intent that can be granted is granted immediately and never
queues. A test that expects work to sit in a queue will pass for the wrong
reason. The way to make an intent genuinely pending is to have it paused -- an
exhausted budget will do it -- because a paused intent stays in `state.intents`
for the next pass to reconsider.
