# Runtime performance implementation notes

## Phase 1 · Interactive startup

The implementation started from local `develop` at `c61f5ddaddf7ec2fc7a7389053e0828bd462ea93` on the temporary branch `perf/interactive-startup` in `/Users/juan/code/gh-glance`. The controlling specification is 2026-11-21-runtime-performance.md, phase 1. The installed implementation skill had no project overlay.

Explicit standalone and collector-client starts now use the existing host and repository resolvers to decide whether Git discovery can contribute anything. An inferred checkout still reads its remote and gh default, including the existing bootstrap retry after empty discovery. Standalone starts React and Ink after the interactive argument and terminal checks and before local preflight. Import errors are observed immediately and surfaced after successful preflight. The normal-screen diagnostic retains precedence if preflight also fails. See `index.mjs:11566`, `index.mjs:12737`, `index.mjs:12769` and `index.mjs:22896`.

### First-frame decision

The A/B trial used real Node processes and a 120×34 PTY on macOS arm64 with Node 24.22.3, an inferred single-remote checkout, identical installed dependencies, offline gh, and fresh private application state for each launch. One pane ran at a time. Twelve A/B pairs alternated run order. Twelve interleaved baseline/baseline pairs supplied the prespecified noise estimate. Timing starts immediately before process launch and ends at the first terminal bytes containing the Actions tab or the known fresh fixture title. Neither time measures physical terminal painting.

| Endpoint | Baseline median | Candidate median | Median paired change | Median absolute difference, baseline/baseline |
| --- | ---: | ---: | ---: | ---: |
| First frame | 282.00 ms | 247.63 ms | 26.37 ms earlier | 25.14 ms |
| First fresh row | 2,867.26 ms | 3,763.29 ms | 652.39 ms later | 618.09 ms |

The candidate reached its first frame sooner in 11 of 12 pairs and its first fresh row sooner in 4 of 12. The first-frame gain cleared the selected threshold by 1.23 ms. Retain import overlap on that evidence. Independent lease slots introduce seconds of first-row variability, so the fresh-row measurement does not isolate an effect of this change. The 48 processes each made three fixture API calls, including one Actions read, and exited successfully with the alternate screen restored.

| Trial | Baseline / candidate first frame (ms) | Baseline / candidate first fresh row (ms) |
| ---: | ---: | ---: |
| 1 | 281.3 / 268.5 | 2,720.8 / 4,136.9 |
| 2 | 288.5 / 288.2 | 4,022.0 / 3,694.9 |
| 3 | 273.4 / 250.5 | 2,730.5 / 4,378.9 |
| 4 | 336.5 / 353.7 | 2,855.2 / 3,338.0 |
| 5 | 289.6 / 240.2 | 2,822.2 / 3,831.7 |
| 6 | 301.0 / 264.3 | 4,030.3 / 2,597.5 |
| 7 | 278.3 / 248.6 | 4,341.4 / 4,958.3 |
| 8 | 266.5 / 233.6 | 2,892.4 / 2,699.0 |
| 9 | 255.4 / 241.8 | 1,983.3 / 2,671.2 |
| 10 | 298.6 / 233.6 | 4,061.3 / 3,509.7 |
| 11 | 268.7 / 246.7 | 2,730.8 / 6,337.1 |
| 12 | 282.6 / 234.0 | 2,879.3 / 4,177.6 |

### Regression and review evidence

- The initial real-PTY regression against the baseline failed three cases. A flag in a one-remote checkout launched three Git discovery children. A valid GH_REPO outside a checkout launched two. For the inferred target, the import hook first saw React and Ink after checkout validation and discovery had completed. All four initial focused tests then passed on the candidate. The final regressions are at `test/pty/startup.test.mjs:32` and `test/pty/startup.test.mjs:59`.
- An independent read-only reviewer assessed the source, error precedence, target selection, import lifecycle and failure cases. The reviewer found the probe would ignore an alternate installed entry. The repair canonicalizes the entry selected by the PTY harness and honors its empty-path fallback. The conflicting checkout remote and actual emitted Actions request are now checked together. The failed-import test exercises both a real preflight failure after the rejection and the import alone. The reviewer approved the repaired source.
- The simplify pass checked resolver reuse, control flow and avoidable startup work. The same discovery helper serves all three interactive call sites. The existing doctor inventory is separate. The fixture resolves its entry once, and the test names distinguish flag, environment and inferred selection. No new dependency or production instrumentation was needed.

### Additional entry-point checks

The candidate executable had SHA-256 `c18b8f6a75d6696a74747eb07937120554b85f6200b1fe11e2da66f239acb141`. A separate 4/4 run loaded a copy through the harness's alternate-entry mechanism. The offline supplementary checks observed the following.

- Help, version, doctor, foreground serve and stdio hello/welcome exited 0 with zero direct React/Ink imports. Importing the module as a library loaded each dependency once and exposed its existing callable exports. Non-TTY and invalid arguments preserved their distinct diagnostics and early exits.
- Malformed GH_REPO outside a checkout kept its prior target error on the connected path. Standalone still mounted and performed the two inferred remote reads without an early checkout rejection. A genuine missing-gh error exited 3 before alternate-screen entry. Restoring the fixture and relaunching produced rows with zero Git children.
- During a 3.8-second credential lookup the first frame appeared 998 ms after the lookup started. A live fixture row appeared after the credential returned. Local and SSH test transports emitted the actual subscription for `ghe.example.test/acme/widget` from GH_REPO with zero Git and gh children.
- The benchmark and supplementary checks ran one pane at a time in temporary private roots. The benchmark owner removed its scratch, and the supplementary owner verified its socket/children were closed before removing its root. The SSH transport and GitHub responses were fixtures.

### Local verification and next phase

| Check on the final candidate | Outcome |
| --- | --- |
| Separate-copy startup PTY regressions | 4 passed |
| ESLint and Node syntax | Both exited 0 |
| Full unit suite | 1,130 passed, zero failures |
| Efficiency suite | 9 passed, zero failures |
| Full PTY suite | 270 passed, zero failures, one optional test skipped |
| Whitespace check | Passed |

The skipped PTY case specifically requires an installed historical 0.15.2 executable via GH_GLANCE_BASELINE_ENTRY. The rest of the 35-file suite ran on the candidate. The final source SHA-256 is recorded above. The accompanying startup tests had SHA-256 `01abd4e14500f35f9086b3863cb2dc05c516c77d243ef3c23c4df30aac6a0bf9` (PTY tests) and `286ebaf5beb4e604add198efc3c728355ecc2274810538d155b89580cb2336c0` (import hook). The local phase commit preserves these exact inputs. Resume from the locally integrated phase commit, check branch and worktree state, and begin phase 2 (terminal work and display cache) after owner acceptance.

## Deviations

The trial used cold application state for all timing pairs, one of the two allowed phase 1 designs. It reports time to fresh rows separately from first paint. The research used a 100×24 terminal, while the phase trial held both builds at 120×34. Compare builds within this trial. The slower first-row result and the small margin above the first-frame noise threshold are retained in the handoff.
