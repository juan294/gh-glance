# Phase 1: independent request oracle and regression scenarios

Parent: [complete plan](../2026-09-05-multi-instance-efficiency.md)  
Depends on: none. Batch eligibility: no; later phases depend on these contracts.

## Objective and files

Make server truth independent from production cost declarations and observations. Existing fixture GraphQL counters advance accurately even though the historical real probe did not (`test/pty/fixtures/gh-state.mjs:491`). Extend `test/pty/fixtures/gh-state.mjs`, fixture `gh`, `test/pty/fixture-api.test.mjs`, `test/fixtures/governor-worker.mjs`; add `test/fixtures/request-oracle.mjs`, `test/request-oracle.test.mjs`, and versioned workload JSON fixtures. Do not change application behavior yet.

## Changes and pseudocode

```text
oracle.state = {
  accounts: actual core/graphql counters, epochs, secondary cooldown,
  credentials: synthetic credential -> principal + permissions,
  entities: (host, repo, query variant) -> versions and payloads,
  publishedProbes: accurate | pinned | sliding | missing,
  scriptedEvents: change | throttle | externalSpend | reset | delay | disconnect,
  events: request identity, before/after truth, response status/cost, times
}

handle(request):
  validate synthetic credential and requested permission
  identify operation from actual argv/query, not production OPERATION_COSTS
  compute fixture-defined charge and secondary request count
  apply scripted changes and return independently chosen response evidence
  atomically append the event under the fixture's own lock
```

Use stable operation names, explicit query shapes and bounded fixture response sizes. Unknown paths/GraphQL operations fail loudly. Keep fixture state/locks separate from governor and cache; no import of production reserve or charge calculation inside the oracle. Test assertions may compare observed results to the planned reserve, but the server must not obtain permission from the mechanism it tests.

Provide injected time for hour-long simulation and real process timestamps/readiness handshakes for concurrency/PTYs. Create separate fixture roots for client configuration and one synthetic account ledger for a two-machine scenario. No test may discover or inherit real tokens; whitelist fixture environment inputs.

Capture current request-count and latency baseline using only existing production behavior; distinguish baseline observations from future targets. Add scenarios for 1/2/7/10 panes, duplicate/distinct repositories, 3+4 clients, repeated CI changes, pinned GraphQL probes, retry headers, partial GraphQL errors, credential switches, and 150-row pagination. Scenarios are data contracts; production regression assertions are enabled in their owning phases, so this foundation phase finishes green rather than checking in expected failures.

## Automated acceptance

- `ORACLE-01`: pinned/sliding GraphQL probe stays unchanged while actual charged GraphQL events advance.
- `ORACLE-02`: authenticated 304 records one HTTP request and zero primary core charge; 200 records one core charge; observer requests are distinguishable.
- `ORACLE-03`: concurrent processes cannot lose a counter/event update; independent config roots consume the same fixture account.
- `ORACLE-04`: seconds/date `Retry-After`, HTTP 200 GraphQL errors, mismatched epochs, absent cost and unexpected cost have deterministic responses.
- `ORACLE-05`: per-repository versions and permissions isolate responses; unknown query/credential fails rather than defaulting to a valid empty result.
- Existing fixture, governor and terminal tests still pass.

Run the parent's complete sequential local gate, including canonical PTY and coverage; record Node 22/24 evidence. Baseline measurements must state fixture workload, commit and runtime.

## Manual success criteria

None. No live API or real multi-machine test is needed for this foundation.

## Completion

- [x] Independent oracle and scenario contracts reviewed.
- [x] Baseline captured locally without real account calls.
- [x] Automated criteria and parent local gates passed.
- [x] Independent compliance and quality review complete; integrated locally; stop at phase gate.

## Local verification evidence

Verified on 2026-09-05 with production source unchanged from `b819f42`:

- Independent compliance review approved after query-shape, identity, probe partition and target-routing fixes; separate quality review approved.
- `npm run lint`, `node --check index.mjs`, and `git diff --check`: passed.
- `npm test`: 311 passed on Node 24.19.0 and Node 22.23.2.
- `npm run test:coverage`: 311 passed; index.mjs line 68.59%, branch 83.77%, function 89.37%.
- Canonical `npm run test:pty`: 96 passed, zero failed, about 14.4 minutes on macOS arm64 / Node 24.19.0.
- Both runtimes passed version/help, unknown-argument exit 2, non-TTY exit 1, and missing-gh/outside-repository preflight exit 3 checks.
- [Baseline measurements](phase-1-baseline.json) record the same startup workload for 1/2/7/10 duplicate panes and ten distinct repositories, with request counts/latency, primary charges, subprocess counts and sampled owned-process-tree CPU/RSS. Sampling limitations and unavailable source-to-display/queue metrics are explicit. No real account calls were used.

The user authorized continuation through all phases; no remote push or release is part of this phase.
