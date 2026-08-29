# Phase 6: re-tune what phases 4-5 made loose

> Parent: [`../2026-08-29-conditional-polling-and-calm-status.md`](../2026-08-29-conditional-polling-and-calm-status.md)
> Depends on: Phase 5
> Batch eligibility: no

## Objective

Phases 4 and 5 change the facts the earlier tuning was derived from. This phase
re-derives it from measurement rather than assuming the old constants still fit.
It is deliberately last and deliberately small: nothing here is required for the
UX or the cost win.

## Execution gate

Phase 6 is removed from the 2026-08-29 implementation run. It requires a
separate session after Phase 5 review and completion. That session must first
add temporary measurement instrumentation, then run four panes for one full
real reset window, present the evidence, and wait for approval before changing
probe cadence, TTL, external-factor decay, pane-count copy, or the 5-second
default. Temporary instrumentation is not permission to tune constants in the
same unattended pass.

## Source changes

### 1. Re-measure before changing any constant

```text
measure, with 4 panes over one full reset window, per resource:
  observed units/hour attributable to gh-glance
  share of Actions/Security polls answered 304
  time spent in each status kind
  count of budget-stale / budget-unknown transitions
```

Nothing below is applied unless the measurement supports it. Record the numbers
in a companion `-notes.md`, as the 2026-08-10 and 2026-08-18 plans did.

### 2. Probe cadence and snapshot TTL

`BUDGET_SNAPSHOT_TTL_MS` is 65s and `BUDGET_PROBE_MS` is 60s
(`index.mjs:1114, 1127`) --- a 5s grace, and the only reason a once-a-minute
probe keeps admission open. With headers arriving on every call, a fresh
observation now exists between probes for `core`, and the probe's remaining jobs
(bootstrap, exhaustion recovery, external-burn detection, GraphQL) have
different natural periods from each other.

```text
candidate: keep BUDGET_PROBE_MS for graphql and for burn detection, and let the
core TTL be satisfied by header observations, so a core-only pane stops needing
a probe purely to stay admitted

precondition: the four probe jobs above must each still have an owner. Do not
              relax the TTL for a resource that has no header source.
```

### 3. The external factor's one-way ratchet

`Math.max(1, measured)` (`index.mjs:1259`) means the factor can rise and never
fall. Unreachable before Phase 5, live afterwards. If the measurement shows it
climbing and staying high while gh-glance is the only consumer, add a decay
toward 1 across epochs. If it converges on its own, change nothing and record
that.

### 4. Surface the pane count

The governor knows its live lease count. Phase 2 gave the status region a stable
home for a changing string, so an unexplained wait can explain itself.

```text
when a hold is caused by sharing rather than by scarcity:
    detail becomes  "sharing 5"   instead of   "next 2m"
```

### 5. Re-examine whether the 5s default is honest

Not whether it should be larger. Before Phase 4 the default promised a live feed
the budget could not fund. After Phase 4 an unchanged answer is free, so the
question is whether 5s now delivers what it claims for a repo that *is* changing.
Keep it if the measurement says yes; the point is that the answer is now
evidence rather than inheritance.

## Success criteria

### Automated

- No constant changes without a companion `-notes.md` entry recording the
  measurement that motivated it.
- If a decay is added: a unit case asserts the factor returns to ~1 across N
  epochs with no external spend, and does not decay while external spend
  continues.
- If the pane-count detail is added: a unit case asserts it is chosen only for a
  sharing hold, and a PTY capture asserts the hint group's start column is still
  invariant with it present.
- `test/pty/governor.test.mjs` and `test/pty/throttle.test.mjs` pass unmodified.
- Sequential verification passes.

### Manual

- Four panes for a full hour across one real reset. REST and GraphQL both stay
  outside their 20% reserves; no synchronized reset burst; the footer never
  looks inert.
- Confirm a pane that is waiting purely because of sharing says so.

## Out of scope

Any change to the admission guarantee or the hard reserve. Removing the probe.
Release-pipeline or CI changes.
