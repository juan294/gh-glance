# Plan: pty end-to-end harness (#37) and the SIGTERM buffer fix (#41)

> 2026-08-03 | Branch `develop` @ `c37fff4`
> Research: `docs/research/2026-08-03-pty-harness-attachment-points.md`
> Issues: [#37](https://github.com/juan294/gh-glance/issues/37) (QA-S1),
> [#41](https://github.com/juan294/gh-glance/issues/41)

## Goal

Give CI a way to execute and assert the rendering and terminal-lifecycle code —
the region `pre-launch-report.md:1234` records as "roughly 690 of 824 lines …
never run by any gate", and which the unit suite structurally cannot reach
because every row of data arrives through a `useEffect` poll that
`renderToString` does not observe.

The harness's first job is to catch a real defect: #41, found during research
and reproduced at 1,417 bytes of dashboard written onto the user's primary
buffer after `SIGTERM`, preceded by `\x1b[3J` (erase scrollback).

## Decisions taken

| Decision | Choice | Why |
|---|---|---|
| Capture mechanism | `script(1)` | `node-pty` is a native dependency; `CONTRIBUTING.md:91-93` and `pre-launch-report.md:1237` both forbid expanding the toolchain. Ink's own suite uses `node-pty`, but only as a devDependency excluded from its tarball. |
| Test runner | `node:test` | Already in use (`package.json:20`). No framework, per `AGENTS.md:107-111`. |
| #41 | Fixed in this plan | The harness's headline assertion fails today. `remediate.md:162-167` requires a failing test first; Phase 2 writes it, Phase 3 makes it pass. |
| CI posture | Advisory, not required | #37 records pty capture as "the classic source of flaky CI" and "the only item here that can make CI flaky". Promote to required after a clean streak. |
| Interactive keys | Separate later phase, separate file | Verified feasible, but the only assertions needing timed input. Isolating them means a timing flake cannot red the structural job. |
| Assertion style | Structural invariants only | `pre-launch-report.md:1345`: "gate on structural invariants rather than exact frame content, or a one-character copy change reds the build." |

## Design constraints, all measured

Each of these was established empirically during research or planning. They are
the reason the harness looks the way it does.

1. **`script(1)` is incompatible across platforms.** BSD takes
   `script -q OUT cmd args…`; GNU takes `script -q -e -c "cmd string" OUT`.
   Exit propagation is automatic on BSD and requires `-e` on GNU. Cross-form
   invocation fails outright (`unexpected number of arguments` / `illegal
   option -- c`). Development is darwin, CI is `ubuntu-latest`.
2. **GNU writes a banner into the capture file** even under `-q`
   (`Script started on …`), long enough to be miscounted as an overflowing
   rendered line.
3. **BSD `script` aborts when stdin is a socket** — zero-byte file, rc=1, which
   is indistinguishable from "the app never rendered" unless checked. `</dev/null`
   fixes it.
4. **`CI=true` makes ink non-interactive**, deferring all output to unmount.
   Measured at 60x16: 4,348 bytes and 3 synchronized-update pairs with `CI`
   unset, versus 992 bytes and 0 pairs with `CI=true`. `is-in-ci/index.js:3-5`
   checks both `CI` and `CONTINUOUS_INTEGRATION`, so both must be unset.
   Verified `env -u CI -u CONTINUOUS_INTEGRATION` restores the interactive path
   (4,348 bytes, 3 pairs) even when `CI=true` is exported.
5. **A pty is 0x0 without a controlling terminal** — the CI case. `COLUMNS`/
   `LINES` are ignored because Node reads `TIOCGWINSZ`. Only `stty cols N rows M`
   works, and `stty size` prints rows first.
6. **Successive frames are not newline-separated.** Ink emits an
   erase/cursor-up run and repaints. Measuring the concatenated stream reports
   roughly 3x the true width; the capture must be split at the frame boundary
   first.
7. **`index.mjs` is `grep`-binary** because of the Nerd Font private-use
   codepoints; `grep -a` is required on the source or any capture containing
   them. `GH_GLANCE_ICONS=unicode` avoids the issue in captures entirely.

## Variance to suppress

`docs/research/…§7` enumerates every axis that differs between runs. The harness
pins the controllable ones so that only genuine regressions move:

| Axis | Control |
|---|---|
| Network, rate limits, real repo state | Fixture `gh` on `PATH` — `runGh` calls a bare name (`index.mjs:271`) and merges rather than replaces env (`:275`) |
| Spinner animation | `GH_GLANCE_NO_ANIMATION=1` (`index.mjs:120`) |
| Nerd Font glyphs / binary captures | `GH_GLANCE_ICONS=unicode` (`index.mjs:708`) |
| Ink's non-interactive mode | `env -u CI -u CONTINUOUS_INTEGRATION` |
| Terminal size | `stty cols N rows M` |
| Colour | left at default; assertions strip SGR rather than depending on it |

Deliberately **not** pinned: `formatAge`/`formatDuration` output and the
staleness label. Assertions never read cell contents, only structure.

## What is asserted, and what is not

**Asserted** (structural, stable under copy changes):

- alternate-screen enter/exit balance — exactly one of each
- cursor restored at least once
- final frame is exactly `rows` lines, no line wider than `cols`
- panel frame and tab bar present
- **nothing written to the primary buffer after the restore sequence** (#41)
- process exit code matches the signal (143 / 130 / 129) or 0 for a clean quit
- no full-clear repaint loop (bounded count of `\x1b[2J`)
- the fixture `gh` was actually invoked (guards against a silent capture failure)

**Not asserted**: any cell's text, row counts, ordering, colours, timings, or
byte totals. Those belong to the unit suite or to nothing.

## Phases

All six implemented on `worktree-pty-harness`; commit for each in the last column.

| # | Phase | Files | Depends on | Batch | Commit |
|---|---|---|---|---|---|
| 1 [x] | Capture primitive and fixture `gh` | `test/pty/run.sh`, `test/pty/fixtures/gh`, `test/pty/capture.mjs` | — | | `37d862f` |
| 2 [x] | Structural assertions (the #41 assertion fails here) | `test/pty/e2e.test.mjs` | 1 | | `8235ff1` |
| 3 [x] | Fix #41 | `index.mjs`, `CHANGELOG.md` | 2 | | `a1f4b80` |
| 4 [x] | CI job, advisory | `.github/workflows/ci.yml` | 2, 3 | | `1fa782a` |
| 5 [x] | Interactive key coverage | `test/pty/keys.test.mjs` | 4 | `[batch-eligible]` | `9099fe2` |
| 6 [x] | Document the harness | `CONTRIBUTING.md` | 4 | `[batch-eligible]` | `9099fe2` |

Phases 5 and 6 touch disjoint files and depend only on 1-4, so `/batch` can run
them in parallel. Phases 1-4 are strictly sequential: 2 needs 1's primitive, 3
is the fix for the assertion 2 introduces, and 4 wires up what 2 and 3 produce.

Phase files: `docs/plans/2026-08-03-pty-e2e-harness-phases/phase-N.md`.

## Success criteria

### Automated

- `npm run lint`, `npm test`, `node --check index.mjs` all pass (existing gates).
- `npm run test:pty` passes locally on darwin.
- The same command passes in the CI job on `ubuntu-latest`.
- The primary-buffer assertion fails at the end of Phase 2 and passes at the end
  of Phase 3 — this transition is the plan's proof that the harness works.
- Signal exit codes remain 143 / 130 / 129 (asserted by the harness itself;
  currently only documented in `CHANGELOG.md:71-74`).
- Existing CI checks stay green: `Lint`, `Test (Node 22|24)`,
  `Smoke (Node 22|24)`, `analyze`, `dependency-review`.

### Manual

- Run `gh-glance` in a real terminal with scrollback, `kill -TERM` it, and
  confirm the scrollback survives and no dead frame remains. This is the
  user-visible behaviour #41 describes, and no automated check substitutes for
  seeing it.
- Confirm the harness runs clean three times in a row in CI before considering
  promotion to a required check.

## Known limits, recorded rather than solved

- The fixture `gh` will drift from the real CLI. #37 records: "treat drift as
  the point but expect maintenance." The harness pins the *contract* the app
  depends on, not the CLI's full behaviour.
- The harness never runs against a real repository, so `--search`,
  rate-limiting, and GHAS-availability paths stay uncovered.
- Windows is out of scope, consistent with `README.md:209-211`.
- Phase 5's timing is the only flakiness risk in the plan; it is isolated in its
  own file and its own CI step for exactly that reason.
