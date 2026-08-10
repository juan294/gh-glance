# Phase 1 — Correct the cost model and make it the single source of truth

Not batch-eligible (edits `index.mjs`, shared with phases 2-4).

## Why

`projectedHourlyCost` encodes `restCalls = { actions: 1, ... }`
(`index.mjs:1332`). Measured 2026-08-10 with `GH_DEBUG=api`, `gh run list`
issues **two** REST requests:

```
> GET /repos/juan294/gh-glance/actions/runs
> GET /repos/juan294/gh-glance/actions/workflows
```

Phases 3-4 control on this model. If it is wrong they compute the wrong interval,
so it is corrected first and pinned by tests before anything reads it.

The per-fetch numbers currently live as two object literals inside
`projectedHourlyCost`. Phase 4 needs the same numbers to meter actual spend.
Copying them would be the exact drift this file warns about at
`index.mjs:974-976` ("two copies of this would diverge the first time one of them
was fixed"), so they are lifted to module scope as one table.

## Changes

### `index.mjs` — lift and correct the tables

Near the other request-volume constants, after `BACKGROUND_EVERY`
(`index.mjs:110`):

```
+ // What one fetch of each tab costs, per budget. The single source of truth:
+ // `projectedHourlyCost` derives the hourly figure from it and the spend meter
+ // (phase 4) bills against it, so a corrected number cannot reach one and miss
+ // the other.
+ //
+ // actions is 2, not 1: measured 2026-08-10 with `GH_DEBUG=api`, `gh run list`
+ // issues GET /actions/runs *and* GET /actions/workflows. The 1 that stood here
+ // understated the default tab -- the tab every pane starts on, since
+ // initialTabIndex defaults to 0 -- by half.
+ //
+ // issues and prs are 0 REST because SORT_RECENT's --search routes both through
+ // GraphQL entirely (2 POSTs each, confirmed by the same measurement).
+ const REST_PER_FETCH = { actions: 2, issues: 0, prs: 0, security: ALERT_SOURCES.length };
+ const GRAPHQL_PER_FETCH = { actions: 0, issues: 2, prs: 2, security: 0 };
```

NOTE: `ALERT_SOURCES` is declared at `index.mjs:899`, *after* line 110. Place
these two constants immediately after `ALERT_SOURCES` (i.e. after
`index.mjs:947`) rather than in the constants block, and leave a pointer comment
at the `BACKGROUND_EVERY` site. Do not inline `3` to avoid the ordering problem —
`projectedHourlyCost` already derives from `ALERT_SOURCES.length`
(`index.mjs:1332`) and that property must survive.

### `index.mjs` — `projectedHourlyCost` reads the table

```
  function projectedHourlyCost(activeKey) {
    const perHour = 3_600_000 / runtime.refreshMs;
-   const restCalls = { actions: 1, issues: 0, prs: 0, security: ALERT_SOURCES.length };
-   const graphqlCalls = { actions: 0, issues: 2, prs: 2, security: 0 };
    let rest = 0;
    let graphql = 0;
    for (const key of TAB_KEYS) {
      const ticks = key === activeKey ? perHour : perHour / BACKGROUND_EVERY;
-     rest += ticks * restCalls[key];
-     graphql += ticks * graphqlCalls[key];
+     rest += ticks * REST_PER_FETCH[key];
+     graphql += ticks * GRAPHQL_PER_FETCH[key];
    }
    return { rest: Math.round(rest), graphql: Math.round(graphql) };
  }
```

Keep the comment at `index.mjs:1324-1329` (the "derived from the same constants
the poll loop uses" rationale) and extend it to name the new tables.

### `index.mjs` — export block (`index.mjs:3381-3436`)

```
+ REST_PER_FETCH,
+ GRAPHQL_PER_FETCH,
+ projectedHourlyCost,
```

`projectedHourlyCost` is currently unexported, so its output cannot be asserted
except by spawning `--doctor`. Export it so Phase 3's control law and the tests
below can call it directly.

## Tests — `test/unit.test.mjs`

Follow the existing table-and-invariant idiom (`unit.test.mjs:798-812`).

```
test("the per-fetch cost tables cover every tab and nothing else", () => {
  assert.deepEqual(Object.keys(REST_PER_FETCH).sort(), [...TAB_KEYS].sort());
  assert.deepEqual(Object.keys(GRAPHQL_PER_FETCH).sort(), [...TAB_KEYS].sort());
});

test("an actions fetch costs two REST calls", () => {
  // Measured 2026-08-10: gh run list issues /actions/runs and
  // /actions/workflows. Pinned because phases 3-4 budget against it.
  assert.equal(REST_PER_FETCH.actions, 2);
});

test("issues and prs cost no REST and two GraphQL, because --search routes them", () => {
  for (const key of ["issues", "prs"]) {
    assert.equal(REST_PER_FETCH[key], 0, key);
    assert.equal(GRAPHQL_PER_FETCH[key], 2, key);
  }
});

test("security costs one REST per alert source", () => {
  assert.equal(REST_PER_FETCH.security, ALERT_SOURCES.length);
});

test("projected hourly cost, per active tab, at the default refresh", () => {
  // runtime.refreshMs is REFRESH_MS on an imported module (the argv block is
  // gated on IS_MAIN), so these are the default-refresh figures.
  assert.deepEqual(projectedHourlyCost("actions"),  { rest: 1620, graphql: 240 });
  assert.deepEqual(projectedHourlyCost("issues"),   { rest: 300,  graphql: 1560 });
  assert.deepEqual(projectedHourlyCost("prs"),      { rest: 300,  graphql: 1560 });
  assert.deepEqual(projectedHourlyCost("security"), { rest: 2280, graphql: 240 });
});
```

`ALERT_SOURCES` must be exported for the third test, or that assertion should use
the literal `3` with a comment. Prefer exporting — it keeps the derivation.

## Verification

### Automated
- `npm run lint` clean
- `node --check index.mjs` clean
- `npm test` passes, including the five new tests
- `node index.mjs --doctor | grep "this config spends"` reports
  `~1620 REST + ~240 GraphQL per hour (refresh 5s, "actions" active)`
- `node index.mjs --tab security --doctor | grep "this config spends"` reports
  `~2280 REST`

### Manual
None.

## Out of scope

Do not touch `README.md` in this phase — Phase 5 regenerates its table from
these numbers. Do not add the spend meter; that is Phase 4.
