# Phase 3: authoritative GraphQL and explicit request costs

Parent: [complete plan](../2026-09-05-multi-instance-efficiency.md)  
Depends on: 2. Batch eligibility: no.

## Objective and files

Replace opaque quota-consuming porcelain with observable, bounded requests. Change `index.mjs` header/error transport, operation registry, Issues/PR fetchers, observers and active diagnostics (`index.mjs:630`, `:707`, `:1153`, `:1188`, `:1318`, `:3950`, `:4036`). Add `test/graphql.test.mjs` and `test/pty/graphql-budget.test.mjs`; update fixture dispatch, unit, doctor and routing tests. Amend ADR 0003 and ADR 0004 with GraphQL authority and the explicit control exception.

## Changes and pseudocode

Use separate repository connection queries for Issues and PRs, `states: OPEN`, `orderBy: {field: UPDATED_AT, direction: DESC}`, cursor pagination, and only displayed fields. Include repository ID/name, pageInfo, totalCount and rateLimit cost/limit/used/remaining/resetAt. Issues request `labels(first:1)`; PRs retain draft/review decision/head branch. Page size is bounded at 50. During this phase continue collecting at most 150 rows by explicit separately admitted pages; phase 5 makes later pages demand-driven.

```text
performGraphqlPage(operation, variables):
  reserve declared page envelope; acquire HTTP permit
  gh api -i graphql --input -   # fixed query and typed variables on stdin
  parse headers and GraphQL envelope separately
  settle observed cost, or retain envelope when cost evidence is absent
  accept same-epoch counter evidence even on a data error
  publish rows only if required data is complete and valid

observeGraphql():
  claimed bounded query { rateLimit { cost limit used remaining resetAt } }
  never source authority from /rate_limit
```

Queries have versioned declared bounds derived from their connections; use a conservative two-point page bound and one-point observer bound, recorded centrally and tested against query shape. An actual overrun is recorded in full, pauses that operation, and requests authoritative reconciliation; it is not discarded as invalid bookkeeping. No unbounded `gh --paginate`. Extend `runGh` to feed stdin using an argument-array subprocess while preserving timeout, abort, buffer and redaction contracts.

Observer requests are not described as free. Share one resource observer; reuse fresh data headers and skip unnecessary minute probes. Known exhaustion waits until reset plus two seconds. When known remaining cannot pay an observer while preserving reserve, defer until reset. For unknown/bootstrap or post-reset confirmation only, allow one claimed one-point control request, record its charge, and use phase 2's persisted rolling attempt allowance and uncertain-debt rules. It obeys phase 2's shared secondary cooldown/transport primitives. This is an explicit bounded exception, not a data grant. Ordinary known-capacity observer work is admitted normally; only exceptional bootstrap/reset attempts consume the special allowance.

Only claimed resource observers establish a new epoch. Old/mismatched data headers cannot reset capacity; request confirmation. `/rate_limit` may remain an explicitly non-authoritative optional diagnostic, never a source of spendable capacity or reconciliation credit.

Eliminate hidden-cost failure-context/doctor repository porcelain using explicit requests. Read browser URLs from validated rows/repository evidence and use a platform opener through fixed argv; do not invoke `gh view --web` for data already known. Collector clients later open URLs on the client computer. Declared local operations must be proven local; diagnostics with network requirements request admission or report a skip.

## Automated acceptance

- `GQL-01`: advancing actual GraphQL costs plus pinned/sliding `/rate_limit` preserve reserve across a synthetic hour.
- `GQL-02`: HTTP 200 errors, partial data, missing cost, unknown fields and non-JSON preserve rows; usable budget evidence still settles.
- `GQL-03`: every page/observer has its own declared admission and event; page 2 denial does not erase page 1 or imply completeness.
- `GQL-04`: outdated observer/header cannot increase same-epoch capacity; new epoch requires its claimed observer.
- `GQL-05`: cost above bound is fully recorded and blocks the operation; timeout/abort stays conservatively charged.
- `GQL-06`: zero-budget startup makes no data requests, one bounded control path observes reset, no observer storm.
- `GQL-07`: current Issue/PR order and rendered fields match fixtures, Enterprise routing remains correct, slow PRs do not delay Issues publication.
- `GQL-08`: browser opening uses the client-local known URL and no GitHub request; active diagnostics are fully attributable.

Run parent gates sequentially. Any query unsupported by an Enterprise schema yields a scoped capability/error result, not fallback to opaque ungoverned porcelain.

## Manual success criteria

None required for offline implementation acceptance. Actual enterprise installations can use the documented diagnostic path after deployment; no live probe is part of this phase.

## Completion

- [x] Queries, header/cost authority, control observer and diagnostic/open paths implemented.
- [x] GQL scenarios and parent local gates passed.
- [x] Independent compliance/quality review complete; integrated locally; stop.

Two independent reviews ran against the finished worktree: quality (BLOCK, 21
defects) and plan-compliance (APPROVE WITH FIXES, 9 defects, 2 blocking). All
were fixed before integration. Four were user-visible breakage that a green
suite showed no sign of:

- Issues and PRs were broken outright without `--repo` -- the documented default
  mode. `gh issue list` inferred the repository from the working directory;
  GraphQL cannot, and the variables went out as `{owner: "", name: undefined}`.
  Every PTY capture passes `--repo`, so nothing caught it.
- Every repository with more than one page leaked its tab reservation on every
  poll: the settlement summed all page costs, but later pages already settle
  against their own reservation, and an over-settlement is rejected as corrupt --
  discarding the budget observations from the only requests carrying real cost
  evidence. The independent oracle hid it by pricing every GraphQL request at 1.
- `routing.test.mjs`, the only guard that the host travels as `--hostname` and
  never as path text, had been edited into vacuity while this phase moved the
  list tabs onto a new vector.
- The observer's own spend was attributed to external consumers, so the governor
  would progressively throttle the user to make room for its own probing.

One reviewer recommendation was not taken: `GOVERNOR_STATE_VERSION` was bumped
rather than making an unrecognised budget source drop a single resource. The
alternative cannot work -- the code that would need the tolerance is the *older*
binary, which is already written. Only a version gate makes it fail closed.
