# Phase 5 validation: multi-pane freshness

Date: 2026-09-23
Base: `develop` at `f3f604eaf0c568e98a510c6241ffc4a992aa0e18`
Candidate `index.mjs` SHA-256: `ece5a2cdc51df18815ec46362a04c83e606ac665d37253e4d59e3884413c61b5`

## Simulated hour

The mixed workload ran eight subscriptions over seven canonical queries across
two repositories and all four tabs. It included duplicate panes, active and
background transitions, 200 and 304 source responses, external spend, a
secondary limit, reset, and injected core and GraphQL observer failures. The
eligible overdue limit was 15,000 ms per query. It excluded a 60-second
observer interval only after the fixture injected the failure and the persisted
governor reported failure and recovery for that resource. Every affected query
had a validated source success within 100 ms after recovery. Each reported
source success was correlated with its matching oracle operation and a
published acquisition generation.

| Canonical query | First source success | Worst eligible overdue |
| --- | ---: | ---: |
| `acme/widget` Actions | 4,685 ms | 4,685 ms |
| `acme/widget` Issues | 4,381 ms | 10,250 ms |
| `acme/widget` PRs | 6,485 ms | 6,485 ms |
| `acme/widget` Security | 6,235 ms | 6,235 ms |
| `acme/other` Actions | 11,102 ms | 11,102 ms |
| `acme/other` Issues | 7,984 ms | 7,984 ms |
| `acme/other` Security | 10,752 ms | 10,752 ms |

The background `acme/widget` PRs, `acme/other` Issues, and `acme/other`
Security queries made 42, 42, and 12 validated observations respectively.
There were no duplicate current-generation producers; the maximum was one.
The run ended with 4,971 core and 4,208 GraphQL units remaining, above each
resource's reserve. The final efficiency suite passed 9/9 tests.

## Fault matrix

The simulated hour is the cadence oracle. The following focused fixtures
exercise faults that require separate processes or an isolated fake clock;
they are not represented as if they happened in the same hour.

| Fault | Verification |
| --- | --- |
| Empty/partial aged acquisition lock and competing recoverers | `test/acquisition.test.mjs`; `test/pty/shared-acquisition.test.mjs` |
| Suspended/dead owner and 180-second unstarted claim | `test/acquisition.test.mjs`; `test/pty/shared-acquisition.test.mjs` |
| Failed GraphQL observer with healthy core background work | `test/pty/governor.test.mjs` |
| Failed core observer with healthy GraphQL background work | `test/pty/governor.test.mjs` (focused run passed in 123.5 s) |
| Secondary hold, reset, reserve, and collector coalescing | `test/pty/governor.test.mjs`; `test/collector.test.mjs` |
| Six real panes with an orphan lock, duplicate and distinct targets, and source ages | `test/pty/governor.test.mjs` (focused 145.28 s run passed) |
| Repository alias learned after live slug subscriptions | `test/acquisition.test.mjs` and a permanent six-pane 30 s PTY test: one Actions record, five subscribers, one request per validated generation |

## Sequential candidate gate

The final sequential run passed `npm run lint`, `node --check index.mjs`,
`npm test` (630/630), `npm run test:efficiency` (9/9),
`npm run test:pty` (144/144 in 1,909.1 seconds), and `git diff --check`.
The integration commit ID is recorded by Git after this report is committed.

## Packed artifact and activation

`npm pack --json --ignore-scripts` produced a five-file tarball containing
`index.mjs`, README, CHANGELOG, LICENSE, and package metadata. The extracted
entrypoint and verified source have the same SHA-256:
`ece5a2cdc51df18815ec46362a04c83e606ac665d37253e4d59e3884413c61b5`.
The extracted CLI passed `--version`, `--help`, and isolated `--doctor` smoke
checks. It rejected non-TTY dashboard use with the expected diagnostic.
This is a candidate pack at the unchanged 0.15.1 version; release preparation
requires an explicitly selected hotfix version and a new pack check.

The local report and tests do not prove the globally installed package or
current project panes are fresh. Post-release activation requires a separate
30-minute live readback and a 24-hour monitor window with an independent pane
manifest, explicit holds, and redacted source-success samples.
