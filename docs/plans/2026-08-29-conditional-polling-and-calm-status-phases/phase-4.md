# Phase 4: conditional requests

> Parent: [`../2026-08-29-conditional-polling-and-calm-status.md`](../2026-08-29-conditional-polling-and-calm-status.md)
> Depends on: Phase 3 (the `unusable-output` verdict; a 304 body is precisely
> the shape that verdict exists to absorb if the status line is ever missed)
> Batch eligibility: no

## Objective

Make an unchanged answer free. Actions moves from `gh run list` to two `gh api`
calls so it can carry a header at all; Actions and Security then send
`If-None-Match` and treat a 304 as the existing unchanged-payload outcome.

## Source changes

### Step 1 --- the fixture first, before any production argv changes

`test/pty/fixtures/gh` dispatches on `$2` for the `api` case
(`test/pty/fixtures/gh:152-178`). Inserting `-i` or `-H` shifts every positional
match and silently breaks the whole PTY suite.

```text
fixture gh:
  parse flags position-agnostically; select on the first non-flag argument
  add an ETag/304 mode:
      if If-None-Match matches the fixture's current entity tag for that path:
          print the 304 status line + headers, print nothing else, exit 1
      else:
          print 200 status line + headers (incl. Etag), blank line, body

test/pty/fixtures/gh-state.mjs:
  cost(): a 304 charges 0; a 200 charges as today (line 181)
  the rate_limit case (lines 375-387) is untouched in this phase
```

This step lands and the suite passes green **before** `index.mjs` changes.

### Step 2 --- one seam for a `gh api` response

`runGh` returns only `stdout` (`index.mjs:619`), and with `-i` the headers
arrive prepended to the body in that same string.

```text
add beside runGh, not inside it -- runGh stays the single subprocess seam:

  parseGhApiResponse(stdout):
      split on the first blank line
      status  = integer from the "HTTP/x.y NNN" first line
      headers = lowercased name -> value
      body    = remainder            # already --jq projected

  ghApi(args, { operation, signal, etag }):
      argv = ["api", "-i", path, ...hostArgs, "--jq", projection]
             + (etag ? ["-H", `If-None-Match: ${etag}`] : [])
      try   -> parse stdout                       # 200
      catch -> parse err.stdout if it has a status line, else rethrow
      return { status, etag: headers.etag, rateLimit: pickRateLimit(headers), body }
```

> **The status line is the branch. The exit code is never read alone.**
> Verified: a 304 and a 404 both exit 1. On a 304 `gh`'s own `--jq` additionally
> writes `unexpected end of JSON input` where the body would be --- returning
> that to the caller is how this change would otherwise reproduce the exact
> sentence Phase 3 just removed.

`pickRateLimit` is defined here but not consumed until Phase 5.

### Step 3 --- Actions onto `gh api`

Traced with `GH_DEBUG=api`, `gh run list` is exactly two GETs, both ETag-capable:

```text
GET /repos/{owner}/{repo}/actions/runs?exclude_pull_requests=true&per_page=N
GET /repos/{owner}/{repo}/actions/workflows?page=1&per_page=100
```

```text
actionsArgs(limit) becomes two argv builders, both named so --doctor keeps
reporting the exact vectors sent (index.mjs:718-721):

  actionsRunsArgs(limit)       --jq '[.workflow_runs[] | {
                                   databaseId: .id, displayTitle: .display_title,
                                   number: .run_number, headBranch: .head_branch,
                                   status, conclusion,
                                   startedAt: .run_started_at,
                                   updatedAt: .updated_at,
                                   workflowId: .workflow_id }]'
  actionsWorkflowsArgs()       --jq '[.workflows[] | {id, name}]'

fetchActions:
  raw = runsBody + "\0" + workflowsBody       # same joined-raw idiom as
                                              # fetchSecurity (index.mjs:2872)
  parse() joins on workflowId -> workflowName

  # verified against the live API: this reproduces gh run list --json's field
  # set exactly, at comparable latency
```

The aggregate reservation and subprocess declarations are separate, matching
Security's complete pattern:

```text
REST_PER_FETCH.actions = 2                         # unchanged
tab:actions              { core: 2, graphql: 0 }  # upfront reservation
tab:actions-runs         { core: 1, graphql: 0 }  # exact runGh boundary
tab:actions-workflows    { core: 1, graphql: 0 }  # exact runGh boundary

doctor:actions-runs      { core: 1, graphql: 0 }
doctor:actions-workflows { core: 1, graphql: 0 }
```

`completeReservation` reduces the two-unit worst-case reservation as the two
one-unit subprocesses settle. Reusing a two-unit aggregate operation at both
`runGh` boundaries would reserve four units and violate `OPERATION_COSTS` as the
single exact-vector authority.

Known call sites to update: `doctorProbePlan`'s `"Actions (run list)"` label
(`index.mjs:3300-3310`, asserted at `test/doctor.test.mjs:205`), and ~12 test
assertions keyed on `run list` / `argv[0] === "run"` in
`test/pty/{e2e,cache,status,governor,runtime-remediation}.test.mjs`.

### Step 4 --- ETag store and the 304 outcome

```text
entityRef: per (tab, path) -> { etag, body }, in memory alongside rawRef
           (index.mjs:6478)

An ETag is only ever held together with the exact projected body it validates;
dropping one drops the other. Mixed 200/304 batches rebuild their joined raw
payload from the new bodies plus the cached bodies. A forced refresh (`r`) sends
no `If-None-Match`.

Stage entity changes inside the fetch result and publish them only after
`pollResultTransition` accepts the observation. A malformed 200 must not poison
the entity store and make the next 304 suppress its retry. An identical valid
200 may rotate its ETag, so the successful `unchanged` branch still publishes
the staged entity update even though it skips parse and React state work.

in the poll handler:
  all requests for a tab returned 304
      -> synthesise the unchanged outcome: pass previousRaw through as raw so
         pollResultTransition (index.mjs:5729) returns { kind: "unchanged" }
         on its own first line, unmodified

  any request returned 200
      -> rebuild raw from the new bodies; the byte comparison still decides
         whether it is "changed", so an identical 200 remains free of a parse
```

The 304 path therefore inherits, with no new state: `lastOkRef` advanced,
backoff cleared, error cleared, `parse()` skipped, `setState` skipped, React
bail-out preserved, and the 60s freshness checkpoint
(`shouldCheckpointFreshness`, `index.mjs:5375`).

### Step 5 --- Security

The three alert endpoints are already `gh api` (`alertArgs`,
`index.mjs:2705-2707`), so this is only the `-i` / `If-None-Match` addition and
routing through `ghApi`. A cached primary body must remain available after a
304 because its alert count decides whether the priority lanes run. Note the
measured detail that all three returned the
same ETag when all three bodies were `[]`: **an entity tag is a body hash, not a
resource identity.** The store must be keyed by path.

## Behaviour to match

- **The property worth locking down:** a quiet repository produces zero
  rate-limit spend across several refresh cycles. `test/pty/fixtures/gh-state.mjs`
  already models the counter server-side, so this is assertable end to end.
- `test/runtime-remediation.test.mjs:213-232` (`pollResultTransition` unchanged
  never calls `parse()`) is the existing rubric the 304 path must satisfy
  unchanged.

## Success criteria

### Automated

- Unit: `parseGhApiResponse` over recorded prefixes for 200, 304, 404 and a
  malformed response returns the right status and never throws.
- Unit: a 304 with `--jq` in the body position does **not** produce a tab error.
- Unit: the Actions runs/workflows join yields the previous field set for a
  recorded fixture pair, including a run whose workflow is absent from the list.
- Unit: every Actions subprocess declares a one-unit operation while one
  two-unit tab reservation still covers the batch.
- Unit: a malformed 200 cannot publish a staged ETag/body pair; an identical
  valid 200 can rotate and publish its ETag without parsing or setting React
  state.
- PTY: a quiet repo over >=3 refresh cycles ends with the fixture's core counter
  unchanged after the first fetch, and the frame still renders rows.
- PTY: a changed run list produces a 200 and the new row appears.
- PTY: `r` on a 304-ing tab sends no `If-None-Match` and spends.
- `test/doctor.test.mjs:205` and the ~12 `run list` assertions updated.
- Sequential verification passes.

### Manual

- Run one pane against a quiet repo for 10 minutes with `GH_DEBUG=api`; confirm
  the great majority of Actions responses are 304 and `x-ratelimit-used` barely
  moves.
- Push a commit and confirm the new run appears within one refresh interval.
- Confirm `--doctor` reports the new Actions vectors.

## Out of scope

Feeding the captured `rateLimit` into the governor --- that is Phase 5. Issues
and PRs (GraphQL, no ETag).

## Completion

- [x] The fixture gate passed 2/2 before production argv changed; API path and
  header parsing is position-independent, 200 responses spend, 304 responses
  are free, and the `rate_limit` probe is unchanged.
- [x] Actions uses two exact one-unit API operations under its two-unit tab
  reservation, with matching doctor operations and field-compatible joining.
- [x] Actions and Security stage path-keyed ETag/body pairs, publish them only
  after accepted observations, reuse cached 304 bodies, and omit validators on
  forced refresh.
- [x] Quiet, changed, forced, malformed, identical-200 rotation, and Security
  cached-primary behavior have direct automated coverage. Phase 5 response
  observations remain unconsumed.
- [x] Lint, 279 unit/runtime tests, syntax, all 94 PTY cases in isolated
  sequential module runs, and diff checks pass. The aggregate-only PTY timeout
  and exact EOF replay deviation are recorded without weakening assertions or
  increasing timeouts.
