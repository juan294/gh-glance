# Phase 12 validation report

Date: 2026-09-15  
Tested implementation commit: `3463c3ee37154058508ed06a72a3b43ac08d404a`  
Result: locally validated candidate; no remote activation, push, release, or deployment performed.

## Acceptance result

All Phase 12 automated criteria passed against independent offline fixtures and the production governor, acquisition engine, collector, SSH bridge, webhook ingress, and GitHub App provider paths. The final independent compliance review found no P0 or P1 issue. Three post-implementation simplification passes removed duplicate helpers, separated the sustained E2E workload from ordinary unit and coverage commands, bounded test waits, and retained the full three-run determinism proof.

The final measurement artifacts are [phase-12-efficiency.json](phase-12-efficiency.json) and [phase-12-efficiency.md](phase-12-efficiency.md). The sustained-hour report records 1,619 HTTP requests, 896 data requests, 385 core units, 350 GraphQL units, 723 observer calls, and 699 combined observer charged units. It records zero duplicate producers per generation, zero remote-client GitHub requests, a refused one-unit request at the 1,000-unit core reserve boundary, and successful standalone, collector, SSH, webhook, and App combinations. Source-to-display latency was 3,110 ms p50 and 4,720 ms p95; shared follower delivery was 100 ms p50 and 464 ms p95. The compatible startup slice reduced Actions requests by 50%. The unlike Phase 1 and sustained-hour workloads are explicitly labeled incompatible, so no fabricated full-workload percentage is claimed.

## Final local gates

The canonical commands ran sequentially with macOS arm64 Node `v24.19.0`:

- `npm run lint`: passed with zero warnings.
- `node --check index.mjs`: passed.
- `npm test`: 567 passed, 0 failed, in 20.55 seconds.
- `npm run test:coverage`: 567 passed, 0 failed; 78.64% line, 81.71% branch, and 90.50% function coverage.
- `npm run test:pty`: 135 passed, 0 failed, in 1,449.34 seconds.
- `npm run test:efficiency`: 4 passed, 0 failed, in 69.86 seconds; all three normalized sustained runs were identical.
- `npm run measure:efficiency`: passed and wrote the checked-in JSON and Markdown artifacts.
- `npm run test:coverage:runtime`: 135 passed, 0 failed, in 1,454.99 seconds; 1,167 of 1,407 functions (82.94%) were observed across 260 V8 reports.
- `git diff --check`: passed.

The runtime-coverage pass initially exposed an implicit 100 ms overlap assumption in the two-pane identity-migration PTY test. The fixture now keeps the first Actions generation open explicitly and gives instrumented panes bounded synchronization time. The focused case passed twice under V8 coverage and then passed in both full PTY gates. A later full PTY pass exposed a second fixture race where three leases existed before any holder necessarily owned a future paced lane. That setup now requires a holder-owned lane with at least five seconds remaining; the focused case passed five consecutive runs and then passed in both full PTY gates. Production timeouts and assertions were not weakened.

## Runtime, package, and platform coverage

- macOS arm64 Node `v22.22.2`: 567 unit/package tests passed. The packed-package test installed the tarball and exercised version, help, non-TTY exit 1, unknown-argument exit 2, foreground collector, stdio bridge, local collector client, SSH doctor, and closed package exports.
- macOS arm64 Node `v24.19.0`: the same 567 unit/package tests and CLI/package smoke passed.
- Linux arm64 Node `v22.23.2` in `node:22-bookworm`: 93 serialized collector/protocol/SSH/App/webhook IPC tests passed; 7 targeted collector, remote-collector, and shared-acquisition PTY tests passed.
- Linux arm64 Node `v24.18.0` in `node:24`: the same 93 serialized IPC tests passed.

The first Linux IPC invocation ran independent files concurrently and produced two latency timeouts. The required serialized rerun passed 93/93 on both Linux runtimes, matching the repository's canonical timing policy.

## Workflow and external boundary

Remote workflow triggers were inspected after the final source changes. CI runs on pushes and pull requests to `main` and `develop` with Node 22/24 unit and smoke jobs. CodeQL uses the same branches plus a schedule. Coverage runs on `develop`, schedule, and manual dispatch. Dependency review runs on pull requests to both branches. Release publishing runs only for a published GitHub release. Sutura runs after CI completion. No workflow file changed in this phase and no hosted run was started.

The following remain optional user activation steps and are not claimed as deployed or live-tested:

- configure a real SSH alias and collector host;
- configure an HTTPS reverse proxy and webhook secret;
- create/install a GitHub App and provide its installation ID and private-key path;
- run an optional real-account quota smoke;
- push `develop`, open a release pull request, publish npm, or create a release.

