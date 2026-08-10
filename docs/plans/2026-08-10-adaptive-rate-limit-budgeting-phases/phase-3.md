# Phase 3 — The control law as a pure, exported function

Not batch-eligible (edits `index.mjs`, shared with phases 1, 2, 4).

## Why

The interval decision is the only genuinely novel logic in this plan, and the
only part that can be got subtly wrong in a way tests would not notice later.
Landing it as a pure function with no timers, no React and no subprocesses means
the behaviour rubric below *is* the specification, and Phase 4 becomes plumbing.

This is the file's established shape for anything worth pinning: pure functions
exported "for unit tests… nothing here is part of the public API"
(`index.mjs:3378-3380`).

## Changes

### `index.mjs` — constants

Place with the other budget constants, after `REST_PER_FETCH`/`GRAPHQL_PER_FETCH`
from phase 1:

```
+ // Ceiling on adaptive widening. Required by
+ // docs/agents/pre-launch-report-2026-08-03.md:675 ("an adaptive interval needs
+ // a ceiling"). A minute is where the pane stops being live in any useful sense;
+ // past it the honest answer is fewer panes, not a slower one.
+ const MAX_ADAPTIVE_REFRESH_MS = 60_000;
+
+ // Target this fraction of what the token can afford, not all of it. The margin
+ // is for the user's own `gh` and `git` commands, which are the whole reason the
+ // pane yields at all (see RATE_LIMIT_RETRY_MS).
+ const BUDGET_SAFETY = 0.8;
+
+ // How often to re-read the budget. `gh api rate_limit` does not count against
+ // the limit (verified, delta 0 -- see rateBudget) but it is still a subprocess,
+ // so once a minute rather than once a tick: the quantity it measures moves on
+ // the scale of minutes.
+ const BUDGET_PROBE_MS = 60_000;
+
+ // Below this many of our own REST calls in a probe window, the share inference
+ // is noise -- one call against a global delta of one reads as "we are the only
+ // consumer" whether or not that is true. Under the threshold the loop declines
+ // to adapt rather than guessing.
+ const MIN_SAMPLE_CALLS = 5;
+
+ // Only move the applied interval when the target differs by more than this
+ // factor either way, so a budget wobbling around a boundary cannot make the
+ // poll rate flap. Same reasoning as TAB_LABEL_HYSTERESIS.
+ const ADAPTIVE_HYSTERESIS = 1.25;
```

### `index.mjs` — the law

```
+ // How wide the active-tab interval has to be for this instance to fit its share
+ // of the token's remaining budget.
+ //
+ // The share is *inferred*, not configured: this instance knows exactly how many
+ // REST calls it has spent since the last probe, and `rate_limit` reports how
+ // many the token spent in total over the same window. The ratio is how many
+ // equivalent consumers are on this token -- other panes, a `gh pr checks
+ // --watch`, an agent shelling out to `gh`. That is why no IPC and no on-disk
+ // registry is needed: the token's own counter is the shared channel, and it
+ // already aggregates everything.
+ //
+ // Deliberately one-directional: the returned value is never below `floorMs`, so
+ // --refresh and GH_GLANCE_REFRESH stay a floor the loop widens from and cannot
+ // tighten past. A single instance on a fresh window computes a required interval
+ // below the floor and therefore stays at exactly the configured refresh, which
+ // is what keeps this from changing ordinary single-pane behaviour.
+ function adaptiveRefreshMs({ budget, sample, restPerTick, floorMs, nowMs }) {
+   if (!budget || !Number.isFinite(budget.remaining) || restPerTick <= 0) return floorMs;
+   if (budget.remaining <= 0) return Math.max(floorMs, MAX_ADAPTIVE_REFRESH_MS);
+
+   const secondsToReset = Math.max(1, (budget.resetMs - nowMs) / 1000);
+   const affordable = (budget.remaining / secondsToReset) * BUDGET_SAFETY;
+   if (affordable <= 0) return Math.max(floorMs, MAX_ADAPTIVE_REFRESH_MS);
+
+   const share =
+     sample && sample.myRestCalls >= MIN_SAMPLE_CALLS && sample.globalUsed > 0
+       ? Math.max(1, sample.globalUsed / sample.myRestCalls)
+       : 1;
+
+   const mine = affordable / share;
+   const requiredMs = (restPerTick / mine) * 1000;
+   return Math.min(Math.max(floorMs, requiredMs), Math.max(floorMs, MAX_ADAPTIVE_REFRESH_MS));
+ }
+
+ // Whether a newly computed target is different enough to act on.
+ function adaptiveChangeWorthApplying(appliedMs, targetMs) {
+   if (appliedMs <= 0) return true;
+   const ratio = targetMs / appliedMs;
+   return ratio >= ADAPTIVE_HYSTERESIS || ratio <= 1 / ADAPTIVE_HYSTERESIS;
+ }
+
+ // REST cost of one tick in this configuration: the active tab every tick, the
+ // other three amortised over BACKGROUND_EVERY. Same table and same shape as
+ // projectedHourlyCost, so the controller and the report cannot disagree.
+ function restPerTick(activeKey) {
+   let cost = REST_PER_FETCH[activeKey] ?? 0;
+   for (const key of TAB_KEYS) {
+     if (key !== activeKey) cost += (REST_PER_FETCH[key] ?? 0) / BACKGROUND_EVERY;
+   }
+   return cost;
+ }
```

`MAX_ADAPTIVE_REFRESH_MS` is wrapped in `Math.max(floorMs, …)` everywhere so a
user who sets `--refresh 120` — above the cap — is never silently sped up.

### `index.mjs` — export block

```
+ adaptiveRefreshMs,
+ adaptiveChangeWorthApplying,
+ restPerTick,
+ MAX_ADAPTIVE_REFRESH_MS,
+ BUDGET_SAFETY,
+ MIN_SAMPLE_CALLS,
+ ADAPTIVE_HYSTERESIS,
```

## Tests — `test/unit.test.mjs`

The table below is the specification. Each row is an assertion; expected
intervals are derived, not guessed — with `restPerTick("actions") = 2 + 3/12 =
2.25` and a fresh window (`remaining 5000`, `resetMs = now + 3_600_000`),
`affordable = 5000/3600*0.8 = 1.111` calls/sec.

```
const FRESH = { remaining: 5000, limit: 5000, resetMs: 3_600_000 };
const at = (over) => ({ budget: { ...FRESH, ...over?.budget }, nowMs: 0,
                        restPerTick: 2.25, floorMs: 5000, ...over });
const sample = (mine, global) => ({ myRestCalls: mine, globalUsed: global });

test("a single instance stays at the configured floor", () => {
  // required = 2.25 / 1.111 = 2.03s, below the 5s floor
  assert.equal(adaptiveRefreshMs(at({ sample: sample(100, 100) })), 5000);
});

test("three panes sit just above the floor", () => {
  const ms = adaptiveRefreshMs(at({ sample: sample(100, 300) }));
  assertClose(ms, 6075, 200);            // 2.25 / (1.111/3) * 1000
});

test("seven panes widen to about 13 seconds", () => {
  assertClose(adaptiveRefreshMs(at({ sample: sample(100, 700) })), 14175, 500);
});

test("ten panes widen to about 20 seconds", () => {
  assertClose(adaptiveRefreshMs(at({ sample: sample(100, 1000) })), 20250, 500);
});

test("the aggregate of N adapted panes lands near the safety target", () => {
  // The property that matters, asserted directly rather than inferred from the
  // intervals: N panes each polling at the computed interval spend at most
  // BUDGET_SAFETY of the hourly limit.
  for (const n of [1, 3, 7, 10, 20]) {
    const ms = adaptiveRefreshMs(at({ sample: sample(100, 100 * n) }));
    const aggregate = n * (3_600_000 / ms) * 2.25;
    assert.ok(aggregate <= 5000 * BUDGET_SAFETY + 1, `n=${n} spent ${aggregate}`);
  }
});

test("an exhausted budget goes straight to the cap", () => {
  assert.equal(adaptiveRefreshMs(at({ budget: { remaining: 0 }, sample: sample(100, 700) })),
               MAX_ADAPTIVE_REFRESH_MS);
});

test("widening is capped", () => {
  assert.equal(adaptiveRefreshMs(at({ budget: { remaining: 10 }, sample: sample(100, 9000) })),
               MAX_ADAPTIVE_REFRESH_MS);
});

test("too small a sample declines to infer a share", () => {
  const ms = adaptiveRefreshMs(at({ sample: sample(MIN_SAMPLE_CALLS - 1, 5000) }));
  assert.equal(ms, 5000);                // floor, not a wild extrapolation
});

test("a missing or unreadable budget returns the floor unchanged", () => {
  for (const budget of [null, undefined, { remaining: NaN }]) {
    assert.equal(adaptiveRefreshMs({ ...at(), budget, sample: sample(100, 700) }), 5000);
  }
});

test("the configured floor is never tightened, even above the cap", () => {
  const ms = adaptiveRefreshMs({ ...at({ sample: sample(100, 100) }), floorMs: 120_000 });
  assert.equal(ms, 120_000);
});

test("hysteresis suppresses small moves and admits large ones", () => {
  assert.equal(adaptiveChangeWorthApplying(10_000, 11_000), false);   // +10%
  assert.equal(adaptiveChangeWorthApplying(10_000, 9_500), false);    // -5%
  assert.equal(adaptiveChangeWorthApplying(10_000, 13_000), true);    // +30%
  assert.equal(adaptiveChangeWorthApplying(10_000, 7_000), true);     // -30%
  assert.equal(adaptiveChangeWorthApplying(0, 5_000), true);          // first apply
});

test("restPerTick amortises the background tabs", () => {
  assert.equal(restPerTick("actions"), 2 + 3 / BACKGROUND_EVERY);
  assert.equal(restPerTick("security"), 3 + 2 / BACKGROUND_EVERY);
  assert.equal(restPerTick("issues"), (2 + 3) / BACKGROUND_EVERY);
});

test("restPerTick and projectedHourlyCost agree", () => {
  // Two derivations of the same quantity; if they drift, one of them is wrong.
  for (const key of TAB_KEYS) {
    const perHour = restPerTick(key) * (3_600_000 / REFRESH_MS);
    assertClose(perHour, projectedHourlyCost(key).rest, 1);
  }
});
```

`assertClose(actual, expected, tolerance)` is a local helper; add it beside the
tests. `REFRESH_MS` and `BACKGROUND_EVERY` must be exported for the last two
tests — `REFRESH_MS` is currently unexported, which is also what forces
`test/pty/keys.test.mjs:24-28` and `test/pty/selection.test.mjs:12-13` to
hard-code `5` independently (recorded at
`docs/agents/pre-launch-report.md:1808-1814`). Exporting it here lets those two
files derive it in a later cleanup; do not change them in this phase.

## Verification

### Automated
- `npm run lint`, `node --check index.mjs` clean
- `npm test` passes including all thirteen new tests
- No behaviour change is observable yet: `node index.mjs --doctor` output is
  byte-identical to Phase 1's

### Manual
None — nothing is wired.

## Out of scope

No timers, no `rate_limit` probing, no React, no status bar. Phase 4.
