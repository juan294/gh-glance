# Phase 2 validation: explicit test selections and reliable evidence

Status: **locally verified after independent review, repair, re-review and simplify.** Test tooling, fixtures, package scripts and documentation only; `index.mjs` and the workflows are unchanged. No push, PR, release, live pane or settings action occurred.

- Worktree `/Users/juan/code/gh-glance-release-repair`, branch `release-process-repair`, on top of the Phase 1 commit `a7d112b`. Tested tree (all Phase 2 files staged): `e2c302287464b34d828f1d317751a487d73f9a33`.

## Items

| Item | Result |
| --- | --- |
| 1 Selector | `scripts/test-select.mjs`: named selections `fast`, `recovery`, `package`, `efficiency`, `pty`, `pty:smoke`; inventory validation (every test file owned, no empty selection, smoke inside full PTY); profile classification (docs/ordinary/broad: unknown, missing base, `index.mjs` and any test file outside a short no-coordination allowlist are broad unless a recorded review says ordinary); `run` keeps going after a failure, exits non-zero if any selection failed, counts executed tests from a TAP report and fails a selection that ran none (or, for smoke, not exactly 7); atomic receipt. |
| 2 Commands | `test:fast`, `test:recovery`, `test:package`, `test:pty:smoke` added; `test:pty` and `test:efficiency` now run through the selector too. `npm test` is unchanged. The cheap sustained-reconciliation cases moved byte-identical to `test/sustained-reconciliation.test.mjs` (fast); the 72-hour oracle is unchanged in recovery. Non-E2E efficiency checks stay in fast via `--test-skip-pattern=E2E-`. |
| 3 Package exercise | `scripts/package-check.mjs`: strict ustar reader (regular files only, checksum, POSIX magic, no prefix, nothing after the end-of-archive block), exact five files, manifest/bin/exports/shebang, installed-file byte equality, direct and per-Node bin runs, non-TTY and unknown-flag exits, blocked imports, dependency tree. `--tarball` never repacks; `--no-pack` makes a missing tarball an error. `test/package-boundary.test.mjs` uses it (and `GH_GLANCE_PACKAGE_TARBALL` / `GH_GLANCE_PACKAGE_REQUIRE_TARBALL`); its old script-shape assertions are replaced by behavior checks. |
| 4 Terminal smoke | 7 named cases: data layer reached, alternate screen balance, SIGTERM 143, tab switch, clean quit, cached secondary age, Paused -> Watching coordination blip. e2e/keys captures are lazy; the smoke selection sets `GH_GLANCE_CAPTURE_REQUIRE_TEST=1`, so any module-scope capture fails loudly. `GH_GLANCE_CAPTURE_ENTRY` runs it against an installed tarball. |
| 5 Failure evidence | `test/pty/evidence.mjs` + `capture.mjs`: each capture stages raw bytes and the fixture call log; on a failed test (or a shared capture in a file with a failing test) a redacted, bounded bundle (terminal, calls, parsed frames, timing/runtime metadata) is kept: 2 MiB per test, 20 MiB per evidence root, default root per test run. Passing captures leave nothing. Verified hook contract: top-level `afterEach` receives `t.passed` on Node 22.22.2 and 24.21.0. Known limit documented (failure inside `t.after`, parent of failed subtest). Per-call fixture timing not added (deviation). |
| 6 Identity fixture | One outer budget per case derived from its timeout (`identityTest`); each child gets the remaining budget minus 2 s and SIGKILL; teardown awaits every child before removing state; `allSiblings` reports the first failure plus siblings. |
| 7 Lint scope | `eslint --max-warnings 0 index.mjs eslint.config.js scripts test`; LINT-01 proves every tracked JS file is covered, LINT-02 proves a scratch file outside the targets is ignored while a planted source error fails. |
| 8 Consumers | CONTRIBUTING (commands, selector, evidence, 15-minute per-file PTY timeout corrected), CLAUDE.md commands, PR template, playbook step 1.3. Coverage and runtime-coverage commands need no change. |

## Six regressions (unchanged)

CI-FIXTURE-01 `identity-transport.test.mjs:277`, -03 `webhooks.test.mjs:721/798` and -05 `pty/adaptive-polling.test.mjs:100` have no diff. -02 `pty/status.test.mjs:867` has no diff and is now also in the smoke. -04 (`identity-process.test.mjs`, "independent processes share three HTTP slots") changed only its harness wrapper; its `allSettled`/`finally` body and assertions are identical. -06 (`pty/keys.test.mjs` `keyed` capture) is wrapped in `lazyCapture` with an identical body and assertions.

## Test-first and mutation evidence

- Red before green: `test-select`, `package-check`, `lint-scope` failed on missing modules / old lint script; FIXTURE-G05 failed against the old fixture (the 30 s child ran the full 20 s case timeout).
- Evidence tests, drafted with the helper, were mutation-checked: always-discard, no-redaction, no shared retention and no shared marking were each caught. A later re-check found EVIDENCE-01's redaction assertion passed only because an over-broad key pattern scrubbed `PATH`; it now asserts the secret shown on screen and fails under the no-redaction mutation.
- Reviewer exploit tarballs (data after one zero block; PAX size override) pass the old reader and fail the new one.

## Review and simplify

- Independent review: CHANGES REQUIRED with two majors (tar reader could be fooled into installing a hidden sixth file; selector could skip a changed terminal/coordination test) and twelve minors. All fixed except per-call fixture timing (deviation, accepted). Re-review: APPROVE with three suggestions (anchored `PAT` redaction key, `--installed` mode test, exact ustar magic/no prefix); the first and third were applied, the `--installed` delivery mode is tested in Phase 3 where it is used.
- Simplify (four angles): single-pass tarball inspection; install/check split so PKG-05 reuses one install (about 4 s to 1.7 s); per-Node probes in parallel; help text reused; shared `rechecksum` and manifest/files fixture options; one `withEvidence` path for both capture helpers; frames and redaction only on retention; cached evidence-root size; planted captures for policy-only evidence cases (about 6.4 s saved); ordinary-test allowlist instead of a coordination deny-list; smoke guard enforced at the capture layer; `node:util` `parseArgs`; `identityTest` wrapper. Skipped: reusing `index.mjs` `redact` in evidence (would load the 20k-line app into every PTY process), sharing `allSiblings` with governor/status tests and a common `writeAtomic` (outside this diff, low value).

## Checks (sequential, exits retained)

| Check | Result |
| --- | --- |
| `npm run lint` | 0 |
| `node --check index.mjs` | 0 |
| `npm test` | 0; 761 passed, 0 failed, 269 s |
| `npm run test:efficiency` | 0; 9 passed, 125 s |
| `npm run test:pty` | 0; 160 tests, 159 passed, 1 known optional baseline skip, 0 failed, 2,027 s |
| `npm run test:coverage` | 0; 761 passed; `index.mjs` lines 79.02%, branches 83.49%, functions 91.95% (selection changed: new test files; v0.16.0 recorded 79.01 / 83.48 / 91.95), 665 s |
| Selection measurements (earlier inputs, same selections) | fast 756 tests in 24.3 s (load average about 36); package 6.1 s; pty:smoke 7 cases in 65 s from source and 66 s against an installed packed tarball; a bogus `GH_GLANCE_CAPTURE_ENTRY` fails |

All on Node 24.21.0, macOS (BSD `script`). Earlier runs of the same gate on pre-review inputs (lint, check, 758 unit, 9 efficiency passed; an interrupted PTY run with 83 passed, 0 failed, 11 cancelled by the stop) are superseded by the table above. Linux GNU smoke is UNVERIFIED locally; Phase 3's candidate workflow runs it.

## Handoff

Next entry: Phase 3 from this commit. Production workflows are still the old ones.
