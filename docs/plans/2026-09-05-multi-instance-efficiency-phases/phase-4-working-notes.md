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

## Pacing credit (SCHED-01/02)

Writing the acceptance tests against current behaviour first was the right call:
SCHED-02's safety property already held. Uncertain work -- a timeout, abort or
process loss -- already kept its reserved pacing, because settlement only
narrows the charge for a measured outcome. Both SCHED-01 clauses genuinely
failed, and both were the same omission: the lane advances by what a grant
*reserved*, and nothing ever gave the difference back.

- A settlement that cost less than it reserved (a 304 costs nothing) left the
  lane paced out for capacity nobody spent, so the next request waited out a
  slot no one had used.
- `cancelIntent` deleted the reservation and left the lane advanced -- the empty
  slot the acceptance criterion names, literally.

`returnPacingCredit` gives the difference back, floored at the transport gap so
it can never become a burst and capped at one `GOVERNOR_MAX_ATOMIC_COST` so an
idle stretch cannot accumulate into one either. It is an estimate, not an exact
reversal: the rate is recomputed at settlement and can differ from the rate at
grant time. That is safe because pacing decides *when* work may go and never
*whether* -- admission re-checks affordability against the reserve before
anything starts.

The remaining SCHED-01/02 language ("future queue positions become advisory
estimates; only startable work takes a quota reservation") describes the
existing design rather than a change: an intent that cannot be paid for is
paused and stays pending, and only granted work holds a reservation.

## Still outstanding

Phase 4's acceptance criteria are implemented. What has not been done:

- A sustained multi-pane soak specifically for pacing credit. The twelve-pane
  PTY scenarios cover the reserve and the shared permit, and they pass, but none
  of them settles a long run of 304s -- which is exactly the shape that would
  expose a credit return that is too generous.
- ADR 0003 does not yet describe pacing credit; its phase 4 amendment covers the
  observers and the throttle policy only.
