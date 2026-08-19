# 1. Keep the `gh` CLI data layer; do not collapse it into GraphQL

Date: 2026-08-03
Status: Accepted
Closes: [#34](https://github.com/juan294/gh-glance/issues/34) (PE-S1)

## Context

The pre-launch audit filed PE-S1: *"Seven separate `gh` processes per full
refresh where one GraphQL query would do."* A full tick spawns six processes
costing five REST and two GraphQL requests, each paying its own binary load
(~40 MB RSS measured), git-remote resolution, TLS handshake, and JSON
serialisation through a pipe.

The finding set its own acceptance bar rather than assuming the win, and that
bar is what this decision is measured against:

> Do not adopt unless the combined query is measurably faster than the
> **slowest** current call (1.13 s for Actions), not merely faster than their
> sum.

The reason for that bar: `commit()` lets each tab paint the moment its own data
lands. An earlier `Promise.allSettled` barrier made the three fast tabs
invisible behind the slow Actions fetch, and a commit removed it deliberately. A
single combined query reinstates exactly that barrier.

## Decision

**No-go.** The `gh` CLI stays the data layer. Actions, Issues, PRs and the three
alert endpoints keep their own invocations.

## Why

### The premise does not hold: workflow runs are unreachable from GraphQL

The finding's headline — collapse Actions + Issues + PRs into one query — is not
possible.

- `WorkflowRun` exists as a GraphQL type, with `databaseId`, `displayTitle`,
  `event`, `runNumber`, `createdAt`, `updatedAt`, `workflow` and `checkSuite`.
- `Workflow` exposes a `runs` connection, and `WorkflowRunConnection` exists.
- But **`Repository` has no `workflows` field**, and the `Query` root has no
  workflow entry point.

So workflow runs are only reachable from a `Workflow` node you already hold —
which means enumerating workflows over REST first. Getting "recent runs for this
repository" in one GraphQL round trip cannot be expressed.

The most that could be combined is Issues + PRs. That is two of the six calls,
not six.

### The remaining combination is not measurably faster

Measured twice against `cli/cli` (989 open issues, 55 open PRs):

| Call | run 1 | run 2 |
|---|---|---|
| `gh run list --limit 20` (2 REST) | 3,254 ms | 3,796 ms |
| `gh issue list --limit 150` (GraphQL) | 2,383 ms | 4,223 ms |
| `gh pr list --limit 150` (GraphQL) | 4,341 ms | 3,149 ms |
| **combined issues+PRs GraphQL** | **2,616 ms** | **3,850 ms** |

Run-to-run variance is up to 1,840 ms — larger than any difference between the
two designs. The combined query is not measurably faster than the slowest call
it would replace; it is not measurably anything. The bar is not met.

### The costs are real and permanent

- **Schema drift becomes ours.** Field selection moves out of `gh`'s maintained
  `--json` flags and into a hand-written query in this codebase. BE-M7 already
  records ~25 hard-coded field names as a maintenance surface; this would add
  one that `gh` currently absorbs entirely.
- **GraphQL bills separately.** Confirmed at the time of measurement: `core`
  4,993/5,000 and `graphql` 4,154/5,000 are independent budgets. "Fewer
  requests" does not mean "cheaper" — it moves spend between two pools.
- **The barrier returns for the two tabs it merges.** Issues and PRs would stop
  painting independently. On the measured numbers that is sometimes better and
  sometimes worse, which is another way of saying it is not an improvement.

### The problem it was meant to solve is already solved

PE-S1 was filed as the architectural version of the rate-limit finding (PE-B1),
which measured 1,980-2,520 REST calls per hour — 40-50% of an hourly budget.
That was addressed in v0.2.0 by raising `BACKGROUND_EVERY` from 4 to 12, cutting
steady-state usage to roughly 500 calls per hour. A full tick now happens once a
minute rather than every 20 seconds, so the saving on offer here is about one
request per minute.

## Consequences

- Six `gh` invocations per full tick remain. That is accepted, and the reasons
  are now recorded rather than rediscovered.
- The independent per-tab `commit()` at `index.mjs:7026-7226` stays load-bearing.
  Anything that reintroduces a barrier across tabs must clear the same bar this
  decision failed.
- The last-known-good dashboard cache is downstream of this layer. It hydrates
  previously parsed rows and persists only successful, non-blind observations;
  it introduces no network client and does not bypass `gh` for fresh data.
- If GitHub later exposes workflow runs from `Repository` in GraphQL, the
  premise changes and this decision is worth revisiting — the measurement
  method above is reusable.
- `--jq` projection (PE-M2, shipped in v0.2.0) already captured the payload-size
  half of the original concern, cutting the security fetch roughly 48x without
  touching the transport.

## Correction (2026-08-10)

Two figures above are wrong and are corrected here rather than edited in place,
because the decision they support still stands.

- A full tick costs **six** REST requests, not five: `gh run list` issues
  `GET /actions/runs` *and* `GET /actions/workflows` (measured with
  `GH_DEBUG=api`, 2026-08-10). The GraphQL count of two is correct.
- "Roughly 500 calls per hour" was never reached. It was PE-B1's *target*, not a
  measurement, and it was already corrected twice in the README (`a89c816`,
  `934d8a0`) from a cost model that itself understated Actions by half. The real
  steady state at the default refresh is ~1,620 REST/hour with Actions visible.

Neither changes the conclusion. The saving on offer from collapsing the data
layer is still about one request per minute, and `core`/`graphql` are still
independent budgets.

See `docs/research/2026-08-10-api-request-cost-and-rate-limit-exhaustion.md`.

## Correction (2026-08-11)

The pre-launch remediation changed the bounded shape and accounting again
without changing this decision.

- A normal full tick still starts six independent `gh` commands: Actions,
  Issues, Pull Requests, and one newest-page request for each Security source.
  That baseline spends five REST requests and four GraphQL points under the
  current `gh` behavior.
- When a newest Security page reaches 100 open alerts, bounded priority lanes
  add one Dependabot request and two code-scanning requests. The worst case is
  therefore nine `gh` commands and eight REST requests for a full tick. Small
  repositories do not pay for those lanes.
- The safe hourly projections at a five-second floor are now up to 1,800 REST
  with Actions visible, 480 REST and 1,560 GraphQL with Issues or Pull Requests
  visible, and 4,440 REST with Security visible. The ordinary non-full Security
  case remains about 2,280 REST/hour.
- The adaptive controller now meters and constrains REST and GraphQL
  independently, then applies the safer interval. Moving more list work into a
  combined GraphQL query would consume the budget that now already constrains
  Issues and Pull Requests; it would not make the work free.

Priority lanes preserve independent source completion and bounded top-N
visibility. They do not introduce a new network client or a cross-tab barrier,
so the accepted decision remains unchanged.
