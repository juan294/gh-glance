# Phase 3: put every request behind the governor

> Parent: [`../2026-08-18-prevent-api-exhaustion-and-clarify-refresh-status.md`](../2026-08-18-prevent-api-exhaustion-and-clarify-refresh-status.md)
> Depends on: Phases 1 and 2
> Batch eligibility: no

## Objective

Replace the process-local adaptive timer with separate budget-control and data
schedulers. Make startup, automatic checks, background checks, tab switches,
manual refresh, and `--doctor` endpoint probes obtain a safe shared grant before
any quota-consuming `gh` subprocess.

## Source changes

### App state and lifecycle (`index.mjs:4142-4150`, `index.mjs:4595-4613`)

Create one random lease ID per mounted app and refs for:

```text
governor scope and health
current lease/intent IDs
per-tab pending/granted state
per-resource next eligibility, block, and reset
budget-control timeout
data wake timeout
heartbeat timeout
```

Keep the polling effect mount-only and read changing values through refs. Clear
all three timeouts, abort in-flight subprocesses, and release the lease on
unmount. Timers must be one-shot and re-armed from their current decisions;
do not add scheduler values to the effect dependency list.

### Bootstrap

Replace `tick(); rearm()` at `index.mjs:4929-4930` with:

```text
async bootstrap():
    resolve effective host and auth namespace
    register lease with active-tab demand
    await a fresh shared budget or another owner's publication
    if scope/budget is not safe:
        publish pending/paused state and arm control wake only
        return
    wait stable epoch startup phase
    request one active-tab intent
    arm control, heartbeat, and data wakes
```

No data fetch may race the initial probe. Cached rows can render before the
probe, but reconciliation waits for a grant.

### Independent budget-control scheduler (`index.mjs:4839-4927`)

Remove budget probing from `tick()`. Arm a control wake at:

```text
min(snapshot.observedAt + BUDGET_PROBE_MS,
    known resetMs + BUDGET_RESET_GRACE_MS,
    current probe claim expiry)
```

Use the Phase 2 shared claimant protocol. On publication, re-read decisions,
invalidate future grants from an old epoch, and re-arm data wakes. A probe
failure follows the governor's fresh-snapshot TTL; it never resets to the
configured floor.

### Request admission (`index.mjs:4670-4836`)

Add one wrapper before `commit()`:

```text
requestTab(key, kind, {force = false}):
    apply existing local tab/Security quiet gates
    coalesce with existing in-flight or pending intent
    register intent with tabRequestCost(key)
    if decision is future:
        store retryAt and arm one data wake
        return without loading or gh
    if decision is paused/probe/error:
        publish status and arm control/data retry
        return without loading or gh
    atomically revalidate and mark reservation started
    only now clear forced local backoff and call commit(key, run, {force})
    reconcile proven actual cost on success
    keep worst-case cost on rejection, abort, or uncertain termination
```

The start transition must be atomic under the governor lock immediately before
`runGh`. Recheck auth/host scope, live lease, reservation ownership/status,
`notBefore`, epoch, snapshot TTL, probe barrier, resource block, and capacity.
If any check fails, cancel/reschedule without calling `commit()`.

Keep per-tab in-flight guards. Pending and in-flight are separate: a future
grant is not “Fetching,” and an absorbed duplicate creates no second intent.

Security continues to bill actual calls from its source results, but admission
reserves six. A blind result keeps rows/freshness behavior unchanged
(`index.mjs:4757-4767`).

Only a successful, measured result can reduce a worst-case reservation. A
rejected, timed-out, signaled, or aborted Actions/Security subprocess remains
charged at worst case until a later clean probe watermark accounts for it.

When a fetch classifies as rate-limited, publish a shared resource block using
the best reset information from the response or latest budget. Do not enter the
flat synchronized 60-second rate-limit retry. Keep existing ladders for auth,
unavailable, no-remote, and unclassified network errors.

### Poll and background shape (`index.mjs:3689-3693`, `index.mjs:4839-4868`)

Replace `pollTickKeys()` with a pure schedule that returns:

- the active tab on its due tick;
- at most one background tab on a rotating slot;
- no background tab at startup;
- no tab whose resource is held;
- the next useful wake time.

Keep each background tab's average 12-tick observation target when capacity is
healthy, but distribute them through the cycle. When capacity is tight,
background intents yield before active intents and their freshness ages.

### Tab switch and manual refresh

At `index.mjs:4943-4949`, update the lease demand immediately, coalesce obsolete
pending active intents, and request `tab-switch` priority. The new selected tab
can remain Waiting or Paused if its resource is not safe.

At `index.mjs:4570-4577`, manual `r` creates one `manual` intent. It clears
failure context only after a grant starts. If the resource is held, trigger or
join an immediate probe and leave the data call pending. Repeated key presses do
not stack reservations. Persist one manual-probe demand for the budget's current
epoch and baseline `observedAt`; a manual probe that confirms the same hold does
not permit another until a scheduled sample or reset clears the marker.

### Doctor admission (`index.mjs:1728-1808`)

Run the free budget probe before quota-consuming endpoint diagnostics. Register
an ephemeral diagnostic lease and reserve explicit measured worst-case costs:

```text
Repository access: 1 GraphQL
Actions: 2 core
Issues: 2 GraphQL
Pull requests: 2 GraphQL
Each individual Security endpoint probe: 1 core
```

Keep `gh --version`, `gh auth status`, Git remote inspection, and
`gh api rate_limit` outside data grants because they do not consume these rate
resources. Give endpoint diagnostics the same safe priority as manual work, but
do not make `--doctor` wait through a long future slot: print
`SKIPPED (budget paused; reset ...)` or `SKIPPED (next safe slot ...)` for a
probe that is not immediately grantable. Release the ephemeral lease on every
exit. This makes doctor useful at zero without letting diagnosis worsen it.

### Auxiliary API operations (`index.mjs:760-765`, `index.mjs:1410-1415`)

Route repository failure-context resolution and open-item `gh ... view --web`
through the same manual-priority grant protocol with their Phase 1 costs. Keep
auth status local/free. If repository context cannot obtain an immediate grant,
use the existing safe fallback context. If open-item cannot obtain a grant,
show an actionable active-tab error without launching `gh` or stacking key
repeats.

### Spend accounting (`index.mjs:1202-1212`)

Replace process-local `spentTotal` as the primary controller input with shared
reservation/completion accounting. Keep only local diagnostics that are useful
for tests or doctor output. Measure external spend from shared completed costs
against token-wide `used` deltas.

Delete the old `adaptiveRefreshMs()`, `nextBudgetTargets()`, 60-second cap, and
their compatibility tests now that no runtime caller depends on them. Keep any
small-sample/external-factor helpers that the shared governor still uses, with
their fields renamed to shared-scope terms.

## Tests

### Unit/runtime tests

- Replace tick-zero all-tab expectations at
  `test/runtime-remediation.test.mjs:233-267` with active-first and distributed
  background cases.
- Test every request kind through one admission seam.
- Test that an in-flight or pending duplicate makes no new intent.
- Test that a grant failure performs zero data calls.
- Test manual coalescing, safe priority, and delayed backoff clearing.
- Test independent control/data wake calculations and cleanup.
- Test host/auth migration before the next grant.
- Test rejected, timed-out, signaled, and aborted requests retain worst-case
  reservations until a clean probe.
- Test a planned grant rejected at start for stale epoch, expired lease, changed
  scope, stale snapshot, active probe barrier, and a new resource block.
- Test `--doctor` reserves each endpoint cost and skips unsafe endpoints while
  still reporting budget/governor health.
- Test every production `runGh` quota consumer has a declared operation and
  unsafe open-item/failure-context calls are skipped.

### Extend `test/pty/fixtures/gh`

Replace the per-process static budget fixture with an optional shared fixture
state protected by its own test lock. Support:

- core and GraphQL limit/used/remaining/reset sequences;
- atomic cost debit for each fixture command;
- reset sequences with offsets from the real test clock;
- request delay and failure injection;
- call timestamps, process identity, and maximum observed concurrency;
- completed-only Actions rows so workflow animation does not mask footer tests.

The production code never reads this fixture state.

### `test/pty/throttle.test.mjs:18-65`

Replace “drained means fewer calls” with strict cases:

1. At core remaining zero, the first shared probe occurs before any data command
   and Actions/Security command count stays zero.
2. Pressing `r` at zero may cause one coalesced probe but no data command.
   A burst before and after that probe still creates only one probe demand for
   the unchanged held sample.
3. Core held with GraphQL open permits Issues and pull-request calls.
4. A reset sequence requires one fresh probe and resumes one phased active
   request at a time.
5. Twelve panes do not retry a shared rate-limit block every minute.

## Automated success criteria

- Every data and doctor endpoint subprocess has a successful reservation-start
  record immediately before it.
- Startup and reset cannot issue all four tab fetches per pane.
- Core and GraphQL remain independently usable.
- Manual refresh gives priority without crossing the reserve.
- Existing last-good cache, unchanged-payload, local backoff, and abort cleanup
  tests remain green.
- Run sequentially:

  ```bash
  npm run lint
  npm test
  node --check index.mjs
  npm run test:pty
  git diff --check
  ```

## Manual success criteria

Run two panes against the fixture: one on Actions with core held and one on
Issues with GraphQL open. Confirm Actions makes no data call, Issues continues,
and a manual Actions refresh does not bypass the hold.

## Stop condition

Stop once all live fetch paths are governed and scheduler tests pass. Do not
change footer copy or documentation in this phase.
