# Phase 5 working notes

Written while implementing Phase 5. Kept because the next session needs to know
what was decided and why, not just what the diff says. Delete this file when
Phase 5 lands.

Base: develop @ 44c43d7 (phase 4 released as 0.13.3; unit 381/381, PTY 115/115).

## Writing the acceptance tests first was worth it again

Every POLL/PAGE/REFRESH scenario was written against current behaviour before
any production change, and all of them failed -- 12 unit cases at import (the
policy did not exist yet) and all 8 PTY cases against the real binary. Nothing
already passed, which is itself the finding: the old scheduler had one fixed
active floor, one four-floor background slot, and a Security-only unchanged
rule, and none of those is expressible as the cadence table.

Two production bugs came out of the exercise that no acceptance criterion names,
and both would have shipped:

**Every separately admitted operation was refused, always.** The workflow
catalog and every list page past the first go through `runAdmittedOperation`,
which took the governor's answer as final. But a second request inside one tab
fetch always asks a moment after the tab's *own* grant advanced the lane, so the
answer is always `notBefore` a fraction of a second away -- a schedule, not a
refusal. Under PTY the catalog was requested zero times on a repository whose
runs carry no names, and the WORKFLOW column silently rendered empty. This also
means Phase 3's later-page walk has never actually paged when a governor was
present; the unit tests drove `admit` through a seam that always said yes.
`runAdmittedOperation` now takes a bounded `waitMs` (`GOVERNOR_ADMISSION_WAIT_MS`,
2s) and waits for the slot the governor already named, then re-runs
`startReservation`, which revalidates the budget. A gap past the bound still
declines. A slot the call decides not to take is now cancelled rather than left
`scheduled` against the budget.

**A queued manual refresh was replayed as `R` whatever was pressed.** The
handoff for a keypress arriving during in-flight work hardcoded `force: true`.
With `r` and `R` split, that made `r` drop validators whenever it happened to
land while an automatic poll was running -- reproducible as an intermittent PTY
failure, roughly one run in three. The queue now carries the intention.

`runAdmittedOperation` also gained a `now` seam. Without it the wait was
measured on `Date.now()` while the sandbox drove the governor on its own clock,
and the test was a coin flip; the codebase already uses this seam everywhere
else that reads time.

## The upgrade hazard the cost change created

`REST_PER_FETCH.actions` went from 2 to 1, because the workflow catalog is now a
conditional fallback with its own reservation. An intent must declare *exactly*
what its tab costs (`normalizeGovernorIntent`), so the moment a still-running
old pane holds a pending Actions intent, the new build reads its whole ledger as
`corrupt` -- the same class of failure the Phase 4 notes describe, and the same
file the restart boundary must be able to read.

Reproduced against the real ledger on this machine before fixing it.
`GOVERNOR_STATE_VERSION` is 6, version 5 joins `LEGACY_GOVERNOR_VERSIONS`, and
`dropSupersededTabCosts` drops intents priced by a superseded table. Dropping is
the only safe option: re-pricing an Actions intent down to 1 would under-reserve
for a pane that will still make two calls, and an intent that is still in the
file has not been granted -- `scheduleGovernorState` deletes each one as it
creates its reservation -- so dropping it forgives no debt and releases nothing.
The pane re-registers at the current price on its next wake.

## The 45-reservations observation

Checked against the live ledger while implementing: 13 reservations against 4
leases, completed entries 3-99s old and retiring normally. The 45 was a peak,
not a leak.

The mechanism is worth writing down because Phase 5 changes its inputs.
Completed reservations retire in `publishProbe`, and only when
`factorBaseline.observedAt` has advanced past `completedAt` for every resource
they charge. The baseline advances only on a *reconciled* sample -- five local
units against a positive global delta -- so on a repository answering 304s the
baseline can sit still for a long time. Two things bound it: a zero-cost
completed reservation is retired immediately (it satisfies the
`reservationCost === 0` disjunct), and every epoch change resets the baseline to
the observation time, which retires everything older. So the standing set is
roughly one epoch's worth of reservations that actually spent.

Phase 5 cuts the number that spend (one call per Actions fetch instead of two,
and 304s at a slower cadence), so the standing set should shrink rather than
grow. It is still worth a real measurement before Phase 6, whose retention work
owns the 512 cap: the failure mode at the cap is `normalizeGovernorState`
returning null, which reads as a corrupt ledger rather than as pressure.

## The cost literal was written down in three disguises

Re-pricing the Actions tab from 2 core units to 1 broke nine PTY assertions that
had the old number baked in, in three different disguises: a lane interval
computed as `2 / callsPerMs`, an expected call count of `12 panes x 2`, and --
the subtle one -- reservation *searches* written as `costs.core >= 2` or
`=== 2`. That last form was not a magic number at all while it lasted: two core
units uniquely identified an Actions tab reservation, because every control
operation costs one. At one unit it names the identity bootstrap and the budget
observer too, so three tests were silently waiting on, or asserting about, the
wrong request. `identity-switch` waited its full 60s deadline for a charge that
is *meant* to stay uncertain across an account switch.

Every one of them now derives from `tabRequestCost("actions").core`, and the
searches that needed a real discriminator got one: the newest started
reservation in `identity-switch` (nothing new starts in an abandoned scope), and
"granted at or after this reset's publication" in `throttle`. Neither can be
re-broken by a price change.

The subtlest of the nine was not an assertion at all. `status`'s manual-refresh
fixture sizes its budget so that one Actions reservation is paced about ten
seconds out, which is the window the test observes a *held* lane in. The lane
gap is `cost / callsPerMs`, so halving the cost halved the window -- the run
reported a largest lead of 1120ms against the 1500ms it needs, and only under
full-suite load, because standalone the polling loop caught the shorter window.
The spendable capacity is now derived from the cost too, which keeps the ten
seconds the fixture was written around.

## The broken conditional pair was reachable, just not the way it reads

`REFRESH-02`'s "a 304 with no valid associated entity" sounds defensive, and the
obvious reading -- a validator with no stored payload -- is unreachable:
`cachedEntity` refuses to send an ETag it has no body for. The reachable shape
is an entity stored with an *empty* body. It is a string, so the validator is
sent; the server answers 304; the payload parses to nothing; and the validator
is only ever refreshed by a 200, so the tab re-asks the same unanswerable
question at every poll for the life of the process. `conditionalRecoveryPlan`
treats present-but-empty as no entity, `fetchConditionalEntity` drops that
validator immediately (not through the staged publication, which only runs on a
usable transition), and the poll reports unusable, which keeps the last-good
rows. One recovery, and the next admitted check is unconditional.

## Flaky PTY tests

`identity-switch` was searching for the Actions reservation by
`costs.core >= 2`, so the cost change would have made it spin its full 60s
internal deadline and then assert on nothing. It now searches `>= 1`, and its
fixture runs carry `workflowName`, so the pane makes exactly one core call per
Actions fetch and no catalog call can match the search. That also removes the
second delayed "actions" call the fixture delay would otherwise have applied to.

The 55s-against-60s observation from Phase 4 is unaddressed as a *bound*: the
deadline is still 60s and the run still spends most of it waiting for the
delayed request to settle. Nothing here made it worse, and the reservation
search now succeeds sooner, but it remains the most timing-fragile file.

## Deliberate behaviour changes

- `r` sends validators; `R` is the resynchronization. The old PTY expectation
  that `r` drops `If-None-Match` was changed on purpose and the corresponding
  explicit-`R` regression kept in the same file. `R` is now also the only key
  that clears a negative capability backoff, which is why the Security
  auth-backoff PTY test presses `R`.
- `securityPollDelay` is deleted rather than kept alongside `pollPolicyInterval`.
  Two policies that can disagree is what produced the original asymmetry, where
  Security slowed after one unchanged poll and no other tab ever slowed at all.
- The doctor line is `projected demand` and prints a range. "this config spends"
  was a single number that read as a measurement; the governor section below it
  is where actual charges live.
- `KEY_HINTS` -- the status bar's short subset -- deliberately does not gain
  `R`. It is the one line that appears in every frame, and widening it would
  change the README sample and every status assertion for a key that `?` and
  `--help` both list. The README sample is therefore unchanged and was not
  regenerated: no column, limit or status-bar element moved, and regenerating
  would only churn its relative dates.
- `helpLines` picks bindings by name instead of by index into `KEY_TABLE`.
  Adding `R` shifted every position after it and silently pushed Quit out of the
  four-row overlay, which is exactly the failure an index list invites.

## One plan sentence read narrowly, on purpose

"Commit the first page without waiting on another tab or page." The tab half was
already true. The page half is satisfied where it matters -- the first fetch of
a tab asks for one page, so nothing about first paint waits on a second -- but a
*demanded* extra page still commits together with a re-fetched first page rather
than streaming in beside it. Nothing is lost by that: the demand only ever
arrives when page one is already on screen, so the pane never blanks. Publishing
each page incrementally would mean an additional commit path through
`pollResultTransition` and the cache writer for a latency the user cannot
observe, so it was not built.

## The third bug, found by the coverage that was nearly left out

Demand paging was going to ship with unit coverage only -- the checked-in
GraphQL fixture holds three issues, so there is no second page to scroll into,
and `test/pagination.test.mjs` exercises the walk, the merge and the coalescing
through seams. Writing the PTY case anyway (`GH_GLANCE_FIXTURE_GRAPHQL_ROWS`
already existed for exactly this) found that it could never have worked in the
real app: the Issues and Pull requests entries in `TABS` destructure
`{ signal, governor, previousRaw }` and drop everything else, so the demanded
page count was computed, stored, and thrown away one call short of the fetcher.
Every scroll re-fetched page one.

The lesson is the Phase 4 note again, one level up: seams that always say yes
prove the code below them, never the wiring above. Both bugs this phase found
in that class -- this one and the always-refused admission -- were invisible to
every unit test and obvious on the first real run.

## Still outstanding

- Extra pages are released when the 60s idle clear drops the cursor. Switching
  tabs deliberately does *not* release them, because the selection survives the
  switch and shrinking the list under it would lose the row.
- A sustained multi-pane soak for the reservation retirement described above.
  The 512 cap belongs to Phase 6's retention work; what is missing is a
  measurement of the standing set under the new, much lower spend rate.
