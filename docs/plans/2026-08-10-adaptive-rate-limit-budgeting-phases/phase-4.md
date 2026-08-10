# Phase 4 — Wire the loop, meter the spend, show the badge

Not batch-eligible (edits `index.mjs`, shared with phases 1-3).

Depends on phases 1 and 3 (the cost table and the control law).

## Why

Phase 3 decided the interval; nothing calls it. This phase supplies the two
inputs (a budget reading and this instance's own spend), applies the result to the
poll timer, and makes the result visible — which the record requires of any
throttle (`docs/agents/pre-launch-report.md:439`).

## Changes

### 1. `index.mjs` — a structured budget read, shared with `--doctor`

`rateBudget` (`index.mjs:1306-1322`) runs the probe but returns preformatted
strings. Split the parse from the formatting so the controller and the report read
one source:

```
+ // The `core` numbers as data. `gh api rate_limit` does not count against the
+ // limit (verified, delta 0), which is what makes it safe to call on a timer.
+ async function readCoreBudget(signal) {
+   try {
+     const raw = await runGh(["api", "rate_limit"], { signal });
+     const core = JSON.parse(raw)?.resources?.core;
+     if (!core || !Number.isFinite(core.remaining)) return null;
+     return { remaining: core.remaining, limit: core.limit, used: core.used,
+              resetMs: core.reset * 1000 };
+   } catch {
+     return null;   // a probe failure must never be louder than the pane's data
+   }
+ }
```

`rateBudget()` keeps its current signature and output for `--doctor`; leave it
alone rather than refactoring it to consume `readCoreBudget` (it formats both
`core` and `graphql`, which the controller does not need).

IMPORTANT: `runGh(["api", "rate_limit"])` must not be counted by the meter below.
Because the meter is fed by fetchers rather than by `runGh`, this happens for
free — but assert it in review.

### 2. `index.mjs` — fetchers report what they actually spent

The meter must not re-derive cost from argv shape; that is a second copy of the
cost model (`index.mjs:974-976` warns about exactly this). Instead each fetcher
reports its own spend, so a source skipped by backoff is not billed.

```
  async function fetchActions(limit, signal) {
    const raw = await runGh(actionsArgs(limit), { signal });
-   return { raw, limit, parse: ... };
+   return { raw, limit, restSpent: REST_PER_FETCH.actions, parse: ... };
  }
```

`fetchIssues` / `fetchPRs`: `restSpent: REST_PER_FETCH.issues` (i.e. 0) — stated
rather than omitted, so the zero is visibly deliberate.

`fetchAlertSource` (`index.mjs:987-1027`): the backoff branch at
`index.mjs:987-993` spawns nothing, so it reports `spent: 0`; both the success and
failure branches spawned one request, so they report `spent: 1` — a failed call
still bills (`docs/agents/pre-launch-report-2026-08-03.md:576`: "every call bills
whether it returns data, `[]`, or 403").

`fetchSecurity` (`index.mjs:1041-1077`) sums them:

```
+   restSpent: results.reduce((n, r) => n + r.spent, 0),
```

### 3. `index.mjs` — the meter

One module-scope counter, in the same spirit as `alertBackoff`
(`index.mjs:956`) — in-memory, per-process, lost on exit:

```
+ // REST calls this process has spent, ever. Only ever compared against itself
+ // between two budget probes, so it needs no windowing and cannot overflow in
+ // any realistic session.
+ let restSpentTotal = 0;
```

Incremented in `commit`'s success and failure paths — the request was made and
billed either way. In `commit` (`index.mjs:2761+`), immediately where the result
lands:

```
+ restSpentTotal += result.restSpent ?? 0;
```

The failure path (`index.mjs:2810`) cannot know what a rejected fetch spent, since
the reject carries no result. Bill the tab's table cost there:

```
+ restSpentTotal += REST_PER_FETCH[key] ?? 0;
```

NOTE a deliberate imprecision: `openItem` (`index.mjs:1112`), `preflight`
(`index.mjs:1129-1150`) and `resolveFailureContext` (`index.mjs:729-734`) are not
metered. They are occasional rather than periodic. Under-reporting our own spend
makes the inferred `share` slightly *larger*, so the loop throttles slightly more
than strictly necessary — the safe direction. Say so in the comment.

### 4. `index.mjs` — probe and apply, inside the existing effect

The poll effect (`index.mjs:2726-2888`) currently creates its interval once
(`index.mjs:2878`). It must now be able to re-arm. The stated property at
`index.mjs:2713-2723` is that the *effect* runs once — no closure, ref or
`AbortController` is recreated — and re-arming the timer from inside the same
effect preserves that. **Amend that comment to say so explicitly**, or a future
reader will read the swap as the bug it prevents.

Inside the effect, replacing `index.mjs:2877-2878`:

```
+ let appliedMs = runtime.refreshMs;
+ let intervalId = null;
+ // 0 rather than `now`, so the first tick probes immediately: a pane started
+ // into an already-drained budget must back off at once rather than spend a
+ // minute at full rate first.
+ let lastProbeAt = 0;
+ let probeInFlight = false;
+ let prevUsed = null;
+ let prevSpent = 0;
+
+ function rearm(ms) {
+   appliedMs = ms;
+   if (intervalId) clearInterval(intervalId);
+   intervalId = setInterval(tick, ms);
+ }
+
+ async function probeBudget(nowMs) {
+   probeInFlight = true;
+   lastProbeAt = nowMs;            // set before awaiting, so ticks cannot stampede
+   try {
+     // `controller` is the effect's own AbortController (index.mjs:2729), so a
+     // probe in flight at unmount is killed with everything else.
+     const budget = await readCoreBudget(controller.signal);
+     if (cancelled || !budget) return;
+     // A window reset makes `used` fall; treat the new value as the delta.
+     const globalUsed = prevUsed === null || budget.used < prevUsed
+       ? budget.used
+       : budget.used - prevUsed;
+     const sample = prevUsed === null
+       ? null                       // first probe: no window to measure over
+       : { globalUsed, myRestCalls: restSpentTotal - prevSpent };
+     prevUsed = budget.used;
+     prevSpent = restSpentTotal;
+
+     const target = adaptiveRefreshMs({
+       budget, sample, floorMs: runtime.refreshMs, nowMs: Date.now(),
+       restPerTick: restPerTick(TABS[activeIndexRef.current].key),
+     });
+     if (adaptiveChangeWorthApplying(appliedMs, target)) {
+       rearm(target);
+       setThrottleMs(target > runtime.refreshMs ? target : null);
+     }
+   } finally {
+     probeInFlight = false;
+   }
+ }
```

and in `tick()`, after the setup-mode guard (`index.mjs:2856`):

```
+ const nowMs = Date.now();
+ if (!probeInFlight && nowMs - lastProbeAt >= BUDGET_PROBE_MS) void probeBudget(nowMs);
```

`tick()` is invoked once synchronously as today, then `rearm(runtime.refreshMs)`
replaces the bare `setInterval`. The cleanup at `index.mjs:2879-2887` clears
`intervalId` instead of `id`.

`setThrottleMs` is a new `useState` beside the others (`index.mjs:2560`-ish),
holding `null` or the widened interval in ms.

The `r` key needs no change: it calls `fetchTab(key, { force: true })`
(`index.mjs:2689-2696`), which bypasses backoff and fetches now regardless of the
interval — so the manual escape hatch the record requires still works.

### 5. `index.mjs` — the badge

`StatusBar` (`index.mjs:2359-2414`) already carries an optional `stale` label
whose slot costs no reserved width when absent (rationale at
`index.mjs:2389-2395`). Add `throttle` next to it, same treatment:

```
+ throttle: throttleMs ? `throttled ${Math.round(throttleMs / 1000)}s` : null,
```

passed at the `StatusBar` invocation (`index.mjs:3207-3214`). Render it in the
same conditional style as `stale`, in the app's dim/notice colour rather than the
error colour — a widened interval is a working state, not a failure.

## Tests

### `test/pty/fixtures/gh` — teach the fixture `rate_limit`

The fixture dispatches on `case "$1" in` (`fixtures/gh:37+`). The `api` branch
needs a `rate_limit` case *before* the alert paths, driven by an env knob so a
capture can choose the budget:

```sh
+ # Budget probe. Remaining is injectable so a capture can drive the adaptive
+ # throttle; the default is a healthy budget, i.e. no adaptation.
+ : "${GH_GLANCE_FIXTURE_RATE_REMAINING:=5000}"
+ case "$2" in
+   rate_limit)
+     reset=$(( $(date +%s) + 3600 ))
+     printf '{"resources":{"core":{"limit":5000,"used":%s,"remaining":%s,"reset":%s},' \
+       "$((5000 - GH_GLANCE_FIXTURE_RATE_REMAINING))" "$GH_GLANCE_FIXTURE_RATE_REMAINING" "$reset"
+     printf '"graphql":{"limit":5000,"used":0,"remaining":5000,"reset":%s}}}\n' "$reset"
+     exit 0 ;;
+ esac
```

### `test/pty/` — a capture that asserts the badge

New file `test/pty/throttle.test.mjs`, following `routing.test.mjs`'s
module-scope-capture idiom (captures cost seconds, so take them once):

```
// A nearly drained budget makes the very first probe -- which fires on the first
// tick -- widen past the floor, so this needs one settle window, not two.
const drained = capture({ cols: 80, rows: 24, settle: 12,
                          env: { GH_GLANCE_FIXTURE_RATE_REMAINING: "40" } });
const healthy = capture({ cols: 80, rows: 24, settle: 12 });

test("a drained budget shows the throttle badge", () => {
  assert.match(drained.screen, /throttled \d+s/);
});

test("a healthy budget shows no badge and does not adapt", () => {
  assert.doesNotMatch(healthy.screen, /throttled/);
});

test("the drained pane still renders its frame and tab bar", () => {
  // Structural only, per capture.mjs:104-105 -- cell contents are never asserted.
  assert.ok(hasPanelFrame(drained));
  assert.ok(hasTabBar(drained));
});

test("the drained pane stops polling at the floor rate", () => {
  // The fixture log is the request record. At settle 12s a 5s floor would issue
  // ~3 run-list calls; a widened interval issues fewer.
  const runs = drained.fixtureCalls.filter((c) => c.startsWith("run list")).length;
  const base = healthy.fixtureCalls.filter((c) => c.startsWith("run list")).length;
  assert.ok(runs < base, `drained ${runs} vs healthy ${base}`);
});
```

`capture()` already returns `fixtureCalls` (`capture.mjs:150-153`), and
`hasPanelFrame`/`hasTabBar` already exist (`capture.mjs:106-108`).

### `test/unit.test.mjs` — meter attribution

```
test("every tab's fetcher reports a spend matching the cost table", () => {
  // Guards the drift this phase's design is built to prevent: the meter and the
  // projection must bill the same numbers.
  for (const key of TAB_KEYS) assert.equal(typeof REST_PER_FETCH[key], "number");
});
```

The richer attribution assertions live in the pty layer above, because the
fetchers need a `gh` to run.

## Verification

### Automated
- `npm run lint`, `node --check index.mjs` clean
- `npm test` passes
- `npm run test:pty` passes including the four new captures
- `node index.mjs --doctor` output unchanged from Phase 1 (doctor exits before the
  loop, so it has no adaptive state to report — which is why no `--doctor` change
  was specified)

### Manual
- Single pane, healthy budget: no badge, 5s cadence unchanged. This is the
  no-regression check and the one that matters most.
- Seven panes across seven repos, 20 minutes: badges appear, `gh api rate_limit`
  shows core settling at or below ~4,000/hour, no rate-limit banner.
- Kill six panes; the survivor's badge clears within ~2 probe cycles (~2 min).
- Press `r` on a throttled pane and confirm it refreshes immediately.

## Out of scope

`BACKGROUND_EVERY` stays 12. No `--doctor` reporting of adaptive state. No
persistence of the learned interval across restarts — the loop re-derives it
within one probe.
