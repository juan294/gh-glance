# Plan: adaptive rate-limit budgeting for concurrent instances

> 2026-08-10 | Branch `develop` @ `900dd42` (v0.6.1)
> Research: `docs/research/2026-08-10-api-request-cost-and-rate-limit-exhaustion.md`

## Problem

Seven concurrent panes exhausted the token's 5,000/hour REST budget in under
30 minutes (measured ~8,500 calls/hour). Every throttle in the app is
per-process; the rate limit is per-token. Cost scales linearly in instance count
and nothing in the app is aware that a second instance exists.

The cost model also understates the default tab by 2x: `gh run list` issues two
REST requests (`/actions/runs` and `/actions/workflows`), measured 2026-08-10
via `GH_DEBUG=api`, while `index.mjs:1332` encodes `1`. Corrected, one pane on
Actions costs **1,620 REST/hour**, so **only 3 panes fit the budget** at the
default 5s refresh.

## Approach

Two independent levers, one corrective pass:

1. **`GH_GLANCE_REFRESH`** -- a persistent floor the user can set once per shell
   instead of retyping `--refresh` per pane.
2. **A closed-loop adaptive throttle** -- each instance probes
   `gh api rate_limit`, infers how many consumers share the token by comparing
   its own spend against the global counter, and widens its own interval to fit
   its share. No IPC, no disk state, no configured instance count.
3. **Correct the cost model and every document that quotes it.**

### Why no cross-process coordination

The app has never written to disk (two `fs` reads at module load, nothing else --
research §6). None is needed: `gh api rate_limit` already reports the
*aggregate* consumption of every consumer, because the budget is per-token. The
shared token **is** the coordination channel. The probe is free (documented, and
measured at delta 0 -- `index.mjs:1302-1305`).

### The control law

```
secondsToReset = max(1, (budget.resetMs - now) / 1000)
affordable     = (budget.remaining / secondsToReset) * BUDGET_SAFETY   // calls/sec, whole token
share          = max(1, sample.globalUsed / sample.myRestCalls)        // inferred consumers
mine           = affordable / share                                    // calls/sec, this instance
required       = (restPerTick(activeTab) / mine) * 1000                // ms
applied        = clamp(max(floorMs, required), floorMs, MAX_ADAPTIVE_REFRESH_MS)
```

`floorMs` is the configured refresh (`runtime.refreshMs`). The loop may only
widen from it, never tighten past it -- so `--refresh` and `GH_GLANCE_REFRESH`
remain a hard floor.

Verified limit behaviour (this is the rubric Phase 3 tests encode):

With `restPerTick("actions") = 2 + 3/12 = 2.25` (the active tab every tick plus
the three background tabs amortised over `BACKGROUND_EVERY`) and a fresh window,
`affordable = 5000/3600 * 0.8 = 1.111` calls/sec:

| Situation | `share` | applied interval | aggregate REST/hr |
|---|---|---|---|
| 1 pane, fresh window | 1 | **5s** (floor; required 2.0s) | 1,620 |
| 3 panes on Actions | 3 | 6.1s | 4,000 |
| 7 panes on Actions | 7 | 14.2s | 4,000 |
| 10 panes on Actions | 10 | 20.3s | 4,000 |
| 20 panes on Actions | 20 | 40.5s | 4,000 |
| budget exhausted | any | 60s (cap) | -- |
| own sample too small | -- | floor (no inference) | -- |

The aggregate column is the invariant worth noticing: for every N, the panes
together converge on `BUDGET_SAFETY x 5,000 = 4,000` REST/hour, leaving 1,000 for
the user's own commands. Phase 3 asserts that property directly rather than
inferring it from the intervals.

The single-instance case is unchanged at 5s, which is the property that keeps
this from being a behaviour regression for ordinary use.

`share` counts *any* consumer, not just gh-glance. When a `gh pr checks --watch`
or a CI-monitor agent is spending on the same token, `share` rises and the pane
yields proportionally. That is deliberate and matches the reasoning already
recorded at `index.mjs:144-151`: a background pane must not degrade `git push`.

### Invariant this plan knowingly breaks

The record states four times that the active tab's interval must never be
throttled (issue #20; `docs/agents/pre-launch-report-2026-08-03.md:409`, `:579`;
`docs/agents/pre-launch-report.md:594`). That guidance was written for one or two
instances -- `docs/agents/pre-launch-report-2026-08-03.md:580` says so
explicitly, "leaving headroom for a second instance".

It cannot solve N>=4: the active tab is 1,440 of the 1,620 REST calls/hour
(89%), so widening `BACKGROUND_EVERY` to infinity still leaves 7 panes at
10,080/hour and even 4 panes at 5,760/hour. The invariant is retained in spirit --
liveness is only degraded while the budget is measurably draining, and the
alternative is the current outcome, where the pane shows a rate-limit banner and
refreshes not at all. Approved 2026-08-10.

`BACKGROUND_EVERY` is left at 12 and is not touched by this plan.

## Phases

| # | Phase | Batch | Done |
|---|---|---|---|
| 1 | Correct the cost model and make it the single source of truth | no | [x] |
| 2 | `GH_GLANCE_REFRESH` environment variable | no | [x] |
| 3 | The control law as a pure, exported function | no | [x] |
| 4 | Wire the loop, meter the spend, show the badge | no | [x] |
| 5 | Correct README, ADR 0001, and CHANGELOG | no | [x] |

**No phase is `[batch-eligible]`.** Batch execution requires zero file overlap.
Phases 1-4 all edit `index.mjs` -- unavoidable, since the app is deliberately one
file (`CLAUDE.md`, `CONTRIBUTING.md`) -- and Phase 5 consumes Phase 1's corrected
numbers. `/batch` would conflict on every phase. Run them in order.

Phase files: `docs/plans/2026-08-10-adaptive-rate-limit-budgeting-phases/phase-N.md`

## Success criteria

### Automated

- `npm run lint` clean.
- `node --check index.mjs` clean.
- `npm test` -- includes new unit tests from phases 1, 2, 3.
- `npm run test:pty` -- includes the new throttle-visibility capture from phase 4.
- `node index.mjs --doctor` reports `~1620 REST` for `refresh 5s, "actions"
  active` (phase 1), and the README table matches it exactly (phase 5).
- `GH_GLANCE_REFRESH=30 node index.mjs --doctor` reports `refresh 30s` and
  `~270 REST` (phase 2).

### Manual

- Run 7 panes across 7 repositories for 20 minutes. Expect: each pane's badge
  shows a widened interval, `gh api rate_limit` shows core consumption settling
  near or below 4,000/hour, and no pane displays the rate-limit banner.
- Run a single pane and confirm it stays at 5s with no badge -- the
  no-regression check.
- Kill 6 of the 7 panes and confirm the survivor's interval returns toward 5s
  within ~2 probe cycles.

## Risks

- **Re-arming `setInterval`.** The poll effect is documented as creating its
  interval exactly once (`index.mjs:2713-2723`). Phase 4 re-arms the timer from
  *inside* the same effect, so the effect itself still never re-runs and no
  closure, ref or `AbortController` is recreated. The comment must be amended to
  say this explicitly.
- **Share inference noise** when this instance has spent very few calls. Guarded
  by `MIN_SAMPLE_CALLS`; below it the loop returns the floor and does not adapt.
- **Oscillation.** Guarded by `ADAPTIVE_HYSTERESIS` -- the applied interval only
  moves when the target differs by more than 25% in either direction. Precedent:
  `TAB_LABEL_HYSTERESIS` (`index.mjs:2245`, applied `index.mjs:2441-2443`).
- **A second cost-model copy.** The counter must not re-derive per-call cost from
  argv shape; that is the two-copies drift the file warns about repeatedly
  (`index.mjs:974-976`, `index.mjs:389-395`). Phase 1 puts the per-fetch cost in
  one exported table that both `projectedHourlyCost` and the meter read.
