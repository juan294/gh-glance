# Phase 7: freshness and cost diagnostics

Parent: [complete plan](../2026-09-05-multi-instance-efficiency.md)  
Depends on: 6. Batch eligibility: no.

## Objective and files

Make the user's experience explainable with measured acquisition state. Change `index.mjs` logging/doctor/snapshot/UI status (`index.mjs:601`, `:4122`, `:6886`, `:8834`). Extend `test/doctor.test.mjs`, status/runtime tests, and `test/pty/status.test.mjs`; add metric assertions to shared-acquisition tests. Update README, CONTRIBUTING and SECURITY descriptions.

## Changes and pseudocode

Add a local metrics snapshot to the engine/ledger: HTTP requests, REST 200/304, actual core/GraphQL units, conservative outstanding units, observer calls, cache hits, joined followers, queue wait, hold reason, active query/subscriber counts and epoch. Distinguish known actual values from estimates. Do not log payloads, tokens, credential digests, App keys, SSH configuration contents or signed webhook bodies.

```text
diagnostic = {
  source: standalone | local collector | SSH collector,
  lastSuccessAt, lastChangedAt, nextDueAt,
  hold: primary | secondary | observer | coordination | disconnected,
  observedRequests, provenPrimaryCost, uncertainCost, coalescedConsumers
}

--doctor:
  inspect local/connected engine evidence; start zero GitHub API requests
--doctor --probe:
  run bounded declared, admitted capability requests; report deferred/skipped work
```

Preserve current curated environment/redaction behavior. The default doctor command still reports local executable/configuration problems and returns its established diagnostic exit behavior; add explicit probe selection rather than implicitly fetching every tab. Connected doctor uses protocol metrics later, not local GitHub credentials.

UI status remains concise: waiting for a scheduled safe check, paused by a limit, using shared data, or disconnected. Do not expose reservation IDs or stack traces. Keep last successful observation, last change, next planned poll and current hold separate internally and in detailed doctor output. A cache receipt never updates lastSuccess. A slower selected policy is not itself an API error, but known rows older than their source policy/hold deadline retain a truthful age.

Use existing fixed status allocation and minute-granular age display. No per-second redraw solely for telemetry; metric counters update outside React's hot path. Generate README sample from the deterministic PTY capture when visible status/hints change. Replace old `gh run list` transport claims and misleading fixed GraphQL charge projections.

## Automated acceptance

- `OBS-01`: all displayed request/charge/cache/observer counts reconcile exactly to the oracle for a mixed 200/304/GraphQL/failure sequence.
- `OBS-02`: default doctor invokes no API commands; explicit probes receive a grant or a clear skip and obey cooldowns.
- `OBS-03`: observer failure, primary hold, secondary hold, shared wait, and cache-only state remain distinguishable in structured diagnostics.
- `OBS-04`: read/reconnect does not freshen rows; successful unchanged observation advances lastSuccess without changing lastChanged.
- `OBS-05`: narrow/wide, no-color and screen-reader fixtures preserve frame height, one status line, fixed hints and terminal cleanup; unchanged data does not add redraws.
- `OBS-06`: injected credential-like values are redacted in diagnostic, verbose and crash paths; no raw response bodies are emitted.

Run all parent gates sequentially and regenerate the sample rather than editing its rows by hand. This phase is the standalone milestone; it does not trigger a release or push.

## Manual success criteria

None required for correctness. Optional visual inspection may refine copy, but does not substitute for PTY assertions.

## Completion

- [ ] Metrics and explicit diagnostic modes implemented and documented.
- [ ] OBS scenarios and parent local gates passed.
- [ ] Independent compliance/quality review complete; integrated locally; stop.
