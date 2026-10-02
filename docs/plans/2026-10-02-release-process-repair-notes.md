# Release process repair implementation notes

## Deviations

### Integration baseline moved before implementation

- Plan said: baseline `develop` at `140c77f2bad6863481dfc941725b9567bb08b7c6`, `main` at `e53fb14d5ddd8c4995e8edd744be17f50104ad0b`, npm `latest` 0.16.0.
- Found: on 2026-10-02 implementation started from `develop` `73d23a25bd6f1ecf4a7be74a39b5057addb7356d`. v0.16.1 had been released in between (`main` `5647e41091d370f069ecd5f319747977db060485`, release workflow run 36998649214 success, npm `latest` 0.16.1, gitHead `5647e41`). The four intervening commits change `index.mjs`, `scripts/sustained-recovery.mjs`, three unit test files, the changelog and an ADR; none touches the workflows, policy files or test harness the plan edits.
- Chose: implement against the new baseline. Record v0.16.1 in the current status blocks; the v0.16.0 receipt required by Phase 1 item 6 is still written as planned. No v0.16.1 receipt is fabricated: its release report and delivery receipt do not exist in the repository, so only the read-only registry and workflow facts are cited.
- Why: the plan's findings and design do not depend on which patch release is current.

### Native release skills carry a project preamble

- Plan said: make the two native release adapters thin references (Phase 1 item 2) while keeping managed baselines intact (D1).
- Found: the native `rpi-release` SKILL.md copies are managed files; any reference adds local drift.
- Chose: a four-line override preamble in both copies, pointing to the playbook and replacing the generic `e2e-pro-playbook.md` reference. Diagnostics now report six local-modified managed files (the four pre-existing rule files plus these two). Manifest hashes and baselines are unchanged.
- Why: this is the documented expected-drift path in D1; rewriting the managed skill bodies would create larger drift on every upstream refresh.

### Phase 2: fixture gh call timing is not recorded per call

- Plan said: a failed capture retains "fixture gh call timings" (Phase 2 item 5).
- Found: the fixture `gh` is a POSIX `sh` script (`test/pty/fixtures/gh`); macOS `/bin/sh` has no sub-second clock, so a per-call timestamp means one extra process per fixture call in every PTY test, several of which assert on millisecond-scale pacing.
- Chose: retain the call log itself (order and arguments) plus capture-level start time, duration, timeout, runtime and platform; do not add a per-call clock.
- Why: perturbing the timing-sensitive fixtures to collect timing evidence would weaken the evidence those fixtures produce. Revisit if a future failure needs per-call timing.

### Phase 2: deferred and platform-limited items

- R10 offline canary readiness is implemented in Phase 4, where the plan places the driver and canary preparation (phase-4.md "Local verification").
- CI upload of retained failure evidence (seven-day, failure-only artifacts) is wired in Phase 3's workflows.
- Linux GNU `script(1)` smoke is UNVERIFIED locally (no Linux environment on this host); the Phase 3 candidate workflow runs the smoke on `ubuntu-latest` and `macos-latest`. Native macOS BSD smoke ran locally.

### Phase 2: CI-FIXTURE-02 is the coordination-blip test

- Plan said: the terminal smoke reuses existing "recovery" scenarios and CI-FIXTURE-02 is `status.test.mjs:867` (Paused then Watching).
- Found: line 867 is "a sub-threshold coordination blip stays silent", the Paused -> Watching case. An earlier smoke draft used the storage-pause test at line 720, which never returns to Watching.
- Chose: the smoke runs the blip test. All six CI-FIXTURE regressions remain unchanged in their files.
