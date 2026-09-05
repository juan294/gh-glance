# Phase 12: sustained acceptance and release readiness

Parent: [complete plan](../2026-09-05-multi-instance-efficiency.md)  
Depends on: 11. Batch eligibility: no.

## Objective and files

Prove all requested enhancements together and produce a locally verified candidate. Add `test/efficiency.test.mjs`, workload fixtures and `scripts/measure-efficiency.mjs`; add `npm run test:efficiency` and `npm run measure:efficiency` to package scripts. Keep tests in `test/`, Node's runner and no build step. Update README, CHANGELOG, CONTRIBUTING, SECURITY, affected ADRs and this plan's completion evidence. Source fixes discovered here must be reviewed and reverified locally before completion.

## Sustained workload and evidence

```text
for topology in [1,2,7,10 panes; duplicate repo; distinct repos; 3+4 clients]:
  initialize independent fixture account with 5000-unit resources / 1h
  run production policy/engine with injected clock for 60 simulated minutes
  script quiet -> running CI -> mixed 200/304 -> external spend -> recovery
  inject primary reset, short secondary hold, producer loss, account switch
  collect server events, engine generations, source-to-display acknowledgments
  assert accounting/freshness/sharing contracts from parent
```

Use the actual engine/governor with injectable clock/transport, not a reimplementation of its policy. Pair the accelerated hour with real process/file-lock/IPC concurrency tests and canonical PTYs so simulation cannot conceal integration failures. The fake SSH transport invokes the real bridge/collector; tests do not require two physical computers. Include a pinned GraphQL probe and independently advancing response counters throughout.

`test:efficiency` is deterministic and asserts the parent targets. `measure:efficiency` records a concise JSON/Markdown comparison to the phase-1 baseline using the same workload and machine/runtime: per-operation HTTP calls, 200/304, proven/uncertain quota, observer cost, duplicate work, p50/p95 freshness, queue delay, subprocess count, wall time and CPU/RSS. Label unmeasurable values explicitly instead of fabricating a percentage. A changed test workload cannot claim comparison to an incompatible baseline.

Validate standalone, local collector, SSH clients, webhook invalidation and App provider combinations. No subscriber/client should acquire local credentials or spend locally in remote mode. Deadline assertions apply only with stated fixture capacity; exhausted workloads must show honest staleness and bounded recovery, not impossible five-second freshness promises.

## Automated acceptance

- `E2E-01`: all identity/GQL/SCHED/POLL/PAGE/REFRESH/SHARE/OBS/COL/SSH/HOOK/APP criteria remain green together.
- `E2E-02`: ten identical views issue one request per due canonical query/page; ten repositories retain fair independent progress; 3+4 clients emit zero client API requests.
- `E2E-03`: full simulated hour and real concurrency preserve primary reserve for admitted data and reconcile bootstrap/control exceptions explicitly.
- `E2E-04`: no duplicate generation, stale completion overwrite, credential leak, false Security all-clear or false freshness on restart/reconnect.
- `E2E-05`: request/charge/latency report shows measured improvement against compatible baseline and meets the parent's fixed correctness/detection targets.
- `E2E-06`: packed installed CLI includes all modes, no test/secrets/config artifacts, and `exports:{}`; ordinary version/help/non-TTY/unknown-argument contracts remain.

Run sequentially on the actual final candidate:

```sh
npm run lint
node --check index.mjs
npm test
npm run test:coverage
npm run test:pty
npm run test:efficiency
npm run measure:efficiency
npm run test:coverage:runtime
git diff --check
```

Also run Node 22/24 unit and CLI smoke locally, including collector/bridge non-TTY modes, and the packed-package tests. Verify supported macOS/Linux PTY and IPC behavior using local environments; do not use hosted CI as the first compatibility check. If a required local runtime/platform is unavailable, record the missing verification and do not call the release candidate fully validated. Inspect all remote workflow triggers after final source changes; no new hosted workflow or deployment is needed for this plan.

Regenerate README sample if visible output changed. Document refresh/R behavior, background off, retained-cache limits, metric meanings, migration restart, optional collector startup/SSH instructions, disconnect semantics, webhook setup and App permission matrix. Remove stale claims that all auth diagnosis is local or no credential retrieval/native network exists. The changelog records improvements and behavior changes; actual version selection/bump belongs to the separately authorized release workflow.

## Manual success criteria and remote boundary

No live quota stress or real App/webhook setup is required to prove the implemented contracts. Optional user-environment smoke can confirm SSH configuration, real webhook forwarding and installed App access only after separate setup/authorization; report it as unperformed until done. Do not disguise fixture evidence as live GitHub performance.

Complete independent compliance and quality review, integrate all finished work locally into `develop`, and record exact commit/runtime/results. Follow `/validate`, `/pre-launch`, `/remediate` as needed, and `/update-docs` before a separately authorized `/release`. Push only the completed integration branch once after all required local gates, respecting the owner's workflow/preview checks. Do not push `main`, create a release PR, publish npm or register remote integrations in this phase.

## Completion

- [ ] All scope and traceability criteria satisfied with local evidence.
- [ ] Canonical gates, Node/platform selection, workload comparison and package checks passed.
- [ ] Documentation and ADR guarantees match measured behavior.
- [ ] Independent review complete; all requested work integrated locally.
- [ ] Validation report records remaining external activation steps without calling them implemented deployments; stop before release.
