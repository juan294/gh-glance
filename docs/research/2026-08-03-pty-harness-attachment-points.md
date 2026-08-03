# Research: what a pty end-to-end harness would attach to

> 2026-08-03 | Branch `develop` @ `85784c2` | For issue #37 (QA-S1)
> Four parallel Explore agents: locator, analyzer, pattern-finder, historian.
> Documentarian pass — this describes what exists, not what should change.

## Scope

Issue #37 covers QA-S1 (pty harness) and DO-S1 (verbose diagnostics). This
document covers the harness half: the verification surface as it stands, the
terminal lifecycle in execution order, what ink actually writes, and the
mechanics of capturing it on both the development and CI platforms.

## 1. The verification surface today

Four layers exist, none of which render a frame.

| Layer | Where | What runs |
|---|---|---|
| Pre-commit hook | `.husky/pre-commit:1` | `npm run lint && node --check index.mjs` — no tests |
| Lint job | `.github/workflows/ci.yml:21-32` | `npm run lint`, Node 22 only |
| Test job | `.github/workflows/ci.yml:34-54` | `npm test`, Node 22 and 24, `fail-fast: false` |
| Smoke job | `.github/workflows/ci.yml:56-108` | syntax check, `--version`, `--help`, non-TTY refusal, unknown-arg refusal |

The smoke job's four commands all return from the argv block
(`index.mjs:612-643`) before `render()` at `index.mjs:1626`. `ci.yml:51-53`
records this in a comment: until the Test job existed, "no function body in
index.mjs was executed by any gate."

The unit suite is one file, `test/unit.test.mjs`, 19 tests, discovered by the
shell glob in `package.json:20` (`node --test test/*.test.mjs`). Bare
`node --test` from the repo root finds the same 19. It imports 18 of the 19
names exported at `index.mjs:1631-1650`; `MIN_COMPACT_WIDTH` (`:1647`) is
exported but unused by any test.

Two existing tests already encode pty-derived facts: `test/unit.test.mjs:154-160`
("usableSize() falls back for the sizes pty wrappers actually report") and
`:240-251`, whose comment records "at 52 columns the TITLE column rendered
completely empty while the frame still looked correct."

**No pty harness exists in the repo.** A filesystem sweep for `*harness*`,
`*e2e*`, `*spec*`, `*.sh`, `*.py` outside `node_modules/` returns only
`test/unit.test.mjs`, the two `.claude/hooks/*.sh`, `.husky/_/husky.sh`, and
`.claude/scripts/validate-findings.py`. `docs/research/`, `docs/plans/` and
`docs/decisions/` each contain nothing but a zero-byte `.gitkeep`.

Every pty measurement quoted in the audit was taken by throwaway scripts that
were never committed.

## 2. Startup, in execution order

Module scope in `index.mjs` runs top to bottom:

1. `:23` — `process.env.NODE_ENV ??= "production"`. Must stay first (`:18-22`).
2. `:25-28` — static node: imports. React and ink are **not** imported here.
3. `:38-46` — `detectMainModule()`, two `realpathSync` calls; result in `IS_MAIN`.
4. `:120` — reads `GH_GLANCE_NO_ANIMATION`.
5. `:571` — synchronous `readFileSync` of `package.json` on every run.
6. `:612-643`, gated on `IS_MAIN` — argv, then the TTY guard, then `preflight()`.
   All console writes here use the **unpatched** console, because ink is not
   loaded yet.
7. `:645-646` — dynamic `import("react")` and `import("ink")`. Importing ink
   reads `CI`/`CONTINUOUS_INTEGRATION` (`is-in-ci/index.js:3-5`), `TERM_PROGRAM`,
   `TERM`, `TMUX` (`ansi-escapes/base.js:9-11`), and computes chalk's colour
   level (`ink/build/colorize.js:1-12`).
8. `:708` — reads `GH_GLANCE_ICONS`.
9. `:1614-1627` — `disarmDevBuildLeak()`, `installCrashHandlers()`,
   **`enterAlternateScreen()`**, the `exit` listener, three signal handlers,
   then `render(e(App))`.

The alternate screen is entered by the app one statement before `render()`
(`:1617` vs `:1626`). Ink is not involved: `render()` is called with no options,
so `alternateScreen` defaults to `false` (`ink/build/render.js:19`) and ink's own
`setAlternateScreen` writes nothing (`ink/build/ink.js:699-705`).

### Exit codes

| Code | Trigger | Line |
|---|---|---|
| 0 | `--help` / `-h` | `index.mjs:617` |
| 0 | `--version` / `-v` | `index.mjs:621` |
| 2 | any unrecognised argv | `index.mjs:625` |
| 1 | `!process.stdout.isTTY` | `index.mjs:635` |
| 3 | `preflight()` returned a problem | `index.mjs:641` |
| 1 | `uncaughtException` / `unhandledRejection` | `index.mjs:1608` |
| 130 | SIGINT | `index.mjs:1622` |
| 143 | SIGTERM | `index.mjs:1623` |
| 129 | SIGHUP | `index.mjs:1624` |

CI currently asserts two of these: exit 1 plus the substring `not a terminal`
(`ci.yml:85-98`), and exit 2 for an unknown argument (`ci.yml:99-107`).

## 3. What ink writes, and when

`render()` at `index.mjs:1626` passes no options, so `incrementalRendering`
defaults to `false` (`render.js:17`) and `logUpdate.create` selects
**`createStandard`** (`log-update.js:246-251`), not the per-line differ. The
incremental renderer is unreachable in this app.

A steady-state repaint is (`ink.js:223-232`, `log-update.js:20-57`):

```
\x1b[?2026h                      begin synchronized update
(\x1b[2K\x1b[1A) x (rows-1)      erase each previous line, cursor up
\x1b[2K \x1b[G                   erase last line, column 1
<frame>                          SGR-styled text, lines joined with \n, no trailing newline
\x1b[?2026l                      end synchronized update
```

On the first frame only, `\x1b[?25l` (hide cursor) is written to **stdout**
first (`log-update.js:21-24`).

**Successive frames are not newline-separated.** They are separated by the
erase/cursor-up run above. Any per-line measurement over a raw capture must
first split on that boundary — measuring the concatenated stream reports roughly
3x the true width. This is recorded in the header comment of the corrected
parser in the scratchpad, written after an earlier version of the harness
produced false failures at every width.

**A byte-identical frame writes zero bytes** — not even the synchronized-update
wrapper, because `ink.js:224-231` checks `willRender` first, and
`log-update.js:30-32` returns early when the string matches the previous one.
This is the property the app's redraw suppression depends on.

**Throttle**: `maxFps` defaults to 30 (`render.js:16`), giving
`renderThrottleMs = 34` (`ink.js:196-198`).

**Full-clear condition** (`shouldClearTerminalForFrame`, `ink.js:89-112`), on
non-Windows, is true when any of:

- the previous frame overflowed the viewport, or
- the next frame overflows **and** a previous frame existed, or
- the previous frame filled the viewport and the next does not, or
- **`isUnmounting && previousOutputHeight >= viewportRows`**.

The clear it writes is `\x1b[2J\x1b[3J\x1b[H` (`ansi-escapes/base.js:118-124`) —
erase screen, **erase scrollback**, cursor home.

Because this app's root Box is `height: rows` (`index.mjs:1507`), the frame
always exactly fills the viewport, so the fourth condition holds on **every**
unmount.

A second clear path exists: `Ink.resized` (`ink.js:279-291`) calls `log.clear()`
and blanks `lastOutput` whenever terminal **width decreases**, then re-renders
synchronously against still-stale React state.

## 4. Frame geometry

`Output.get()` pre-allocates exactly `height` rows of `width` cells
(`ink/build/output.js:71-85`), drops writes outside that range (`:139-144`), then
right-trims each row and joins with `\n` (`:193-199`). So `outputHeight === rows`
and the frame is exactly `rows` lines.

`isFullscreen = isTty && outputHeight >= viewportRows` (`ink.js:754`); when true
no trailing newline is appended (`:755`).

The app's own reserved-line arithmetic is `index.mjs:1239-1243`:

```
extraLines = (errors[tab] ? 1 : 0) + (tab === "security" ? securityNotes.length : 0)
bodyRows   = Math.max(1, rows - 7 - extraLines)
```

The 7 is enumerated at `:1240-1242`: two panel edges, two for the column header
(text row plus its bottom rule, `:741-754`), one tab bar, one status line, one
safety margin. The error line and each note are held to one row each by
`wrap: "truncate-end"` (`:1525`, `:1528`).

Width thresholds are derived, not hard-coded: `minimumWidthFor()` at
`index.mjs:1088-1092`, `MIN_TABLE_WIDTH` = 61 and `MIN_COMPACT_WIDTH` = 24 at
`:1099` and `:1102`, both exported. Tab-bar label hysteresis is
`TAB_LABEL_FULL_WIDTH = 78` ± 4 (`:1108-1109`, `:1455-1459`).

Note a recorded discrepancy: QA-H6's title in
`docs/agents/pre-launch-report.md:1241` says the layout collapses "below about 57
columns", while `CHANGELOG.md:75-79` and `README.md:200-202` say "about 61". The
derived constant is 61; the finding's title predates the constant.

## 5. Shutdown paths

Shared machinery: `restoreScreen()` (`index.mjs:1591-1596`) writes
`\x1b[?25h\x1b[?1049l` to stdout, once, latched by `screenRestored` (`:1591`).
It is registered on `exit` at `:1618`. signal-exit patches `process.emit` and
runs the app's `exit` listeners **before** ink's `unmount`
(`signal-exit/index.js:185-201`).

| Path | Sequence | Exit code |
|---|---|---|
| `q` / `Esc` | ink `handleExit` → raw mode off → unmount → final frame painted **inside** the alt screen → `exit` → `restoreScreen` discards it | 0 |
| `Ctrl+C`, raw mode | `\x03` arrives as data; ink's `exitOnCtrlC` (`App.js:148-159`) → same as above. `index.mjs:1276` never sees it | 0 |
| `Ctrl+C`, no raw mode | tty raises a real SIGINT → next row | 130 |
| SIGINT / SIGTERM / SIGHUP | app handler → `process.exit` → `exit` event → **`restoreScreen` first**, then ink's unmount repaints **onto the primary buffer** | 130 / 143 / 129 |
| `uncaughtException`, `unhandledRejection` | `restoreScreen()` → two `console.error` (still ink-patched, so routed via `ink.js:462-489`) → `process.exit(1)` | 1 |
| ink error boundary | `ErrorOverview` rendered into the alt screen, `unmount(error)`; the exit promise is rejected but pre-caught (`ink.js:271-277`) and **no exit code is set** | 0 |
| `RowBoundary` catch | `index.mjs:791-815` renders `! this row could not be rendered`; process continues | n/a |

### Measured: what lands on the primary buffer after SIGTERM

Captured under a real pty at 60x16 with a stubbed `gh`, splitting the capture at
the `\x1b[?1049l` restore sequence and inspecting only what follows:

| | v0.2.0 (`85784c2`) | pre-audit baseline (`3f909ad`) |
|---|---|---|
| bytes after leaving the alt screen | 1,417 | 1,576 |
| contains `\x1b[2J` (erase screen) | yes | yes |
| contains `\x1b[3J` (**erase scrollback**) | yes | yes |
| dashboard frame present on primary | yes | yes |

The behaviour is identical before and after the v0.2.0 release, so it is
pre-existing rather than introduced by it. It follows from the ordering in the
table above combined with the unmount branch of `shouldClearTerminalForFrame`
(§3): `restoreScreen` returns the terminal to the primary buffer, and ink then
performs its final repaint there.

The release-time pty check did not detect this because it asserted only
alternate-screen enter/exit **balance** (1/1), cursor restoration, and maximum
line width — never the content of the primary buffer after restore.

The `q`, `Esc` and raw-mode `Ctrl+C` paths do not exhibit it: there
`restoreScreen` runs after ink's final paint, so the frame is written into the
alternate screen and discarded with it.

## 6. Raw mode

`isRawModeSupported` is literally `stdin.isTTY` (`ink/build/components/App.js:121`).
Node leaves that `undefined` — not `false` — on a non-TTY stdin, which is why
`index.mjs:1273` coerces with `Boolean` before passing `isActive` to `useInput`
(`:1297`); the reason is recorded at `:1293-1296`.

Consequences a harness inherits:

- With stdin not a tty, `useInput` is inert, so `q`, `r`, arrows and digits do
  nothing, and the status bar shows only `Quit: ^C` (`index.mjs:1169-1175`).
- Backgrounding the process under `script` (`node index.mjs &`) detaches stdin,
  which produces exactly that non-interactive state.
- Driving the key handlers therefore requires stdin to remain an interactive
  tty, which rules out piping keystrokes in.

## 7. What varies between runs

Everything in this list is a potential source of flakiness in a content
assertion:

- **Time** — `now` advances on the poll tick when a run is in progress or a
  minute has elapsed (`index.mjs:1396-1398`), feeding `formatAge` /
  `formatDuration` in the TIME, UPDATED and AGE columns.
- **Staleness** — `stale <duration>` appears once data is older than 30s
  (`index.mjs:111`, `:1486-1491`).
- **Animation** — a 10-frame braille spinner at 100ms (`:113-114`, `:1440`),
  active only while `anyFirstLoad || hasRunningVisible` (`:1431`).
  `GH_GLANCE_NO_ANIMATION` (`:120`) removes this axis entirely.
- **Network** — row counts, the `+` truncation marker, ordering, titles, error
  strings, security notes, and per-source backoff windows of 60s to 1h
  (`:104`, `:450-465`).
- **Load state** — `firstLoad` changes the tab-bar suffix (`:1120`) and the
  empty-body message (`:1544-1553`); `failed` turns a tab label red (`:1139`).
- **Cadence** — background tabs refresh every 12th tick (`:79`, `:1389`); the
  tab you switch to refetches immediately (`:1418-1420`).
- **Geometry** — `rows`/`cols` drive `bodyRows`, the run limit sent to `gh`
  (`:1249`), compact mode below 61 columns, and short tab labels below 78.
- **Environment** — `GH_GLANCE_ICONS` swaps the whole glyph table (`:708`);
  `NO_COLOR`/`FORCE_COLOR` change every SGR byte; `INK_SCREEN_READER` switches
  ink to a different render path entirely (`ink.js:186-187`, `:371-414`); `CI`
  makes ink non-interactive so **nothing is written until unmount**
  (`ink.js:191`, `:362-370`).

That last one is load-bearing for CI: ink checks `is-in-ci`, and GitHub Actions
sets `CI=true`.

## 8. Capture mechanics: `script(1)`

The two platforms are incompatible in argument order, command form, and exit
propagation. Development is darwin; CI is `ubuntu-latest` (`ci.yml:23`, `:37`,
`:62`).

| | BSD / macOS | GNU / util-linux 2.39.3 |
|---|---|---|
| Invocation | `script -q OUT cmd args…` | `script -q -e -c "cmd string" OUT` |
| Outfile position | first positional | last positional |
| Command form | argv vector | one shell string via `-c` |
| Exit propagation | automatic; `-e` accepted but redundant | **requires `-e`** |
| `-q` and the banner | fully suppressed | `Script started on …` / `Script done on …` **still written into the file** |
| Flush flag | `-F` (otherwise 30s interval) | `-f` / `--flush` |

Measured cross-form failures: BSD order on GNU gives
`script: unexpected number of arguments` (rc=1); GNU `-c` on BSD gives
`script: illegal option -- c` (rc=1).

Two further observed facts:

- **BSD `script` aborts when stdin is a socket** — `tcgetattr/ioctl: Operation
  not supported on socket`, producing a **zero-byte file with rc=1**. Adding
  `< /dev/null` fixes it. A parser that only greps the capture reports this as
  "the app never rendered."
- **The GNU banner lines live inside the capture file.** A 78-character
  `Script started on …` header would be counted as an overflowing rendered line
  by a naive width check.

## 9. Forcing terminal size

`stty cols N rows M` inside the pty works on both platforms. Verified:

```
$ script -q OUT /bin/sh -c 'stty cols 45 rows 20; stty size; node -e "…"'
20 45
{"isTTY":true,"columns":45,"rows":20}
```

Note `stty size` prints **rows first**, the reverse of the argument order.

`COLUMNS` / `LINES` environment variables do **not** work — Node reads the size
via `TIOCGWINSZ` on the fd and ignores them entirely; the same command with env
vars instead of `stty` reports `{"columns":0,"rows":0}`.

**The default pty size is 0x0 on both platforms** when there is no controlling
terminal, which is the agent and CI case. That is precisely the input
`usableSize()` handles (`index.mjs:244-246`) and that `test/unit.test.mjs:155`
pins, falling back to 30x80 (`index.mjs:242-243`).

## 10. Stubbing `gh`

The seam is a single call site: `runGh()` at `index.mjs:270-279`, commented at
`:250-252` as "One seam for every `gh` call." It invokes
`execFileAsync("gh", args, …)` with a **bare name**, so PATH resolution applies,
and merges rather than replaces the environment (`:275`), so an injected PATH
survives. `preflight()` also shells out, to `gh --version` (`:554`) and
`git rev-parse --git-dir` (`:562`).

No stub exists in the repo. A working end-to-end demonstration was built during
this research: a fake `gh` on PATH, under a pty, at 45x20, driving the real
`index.mjs` — six invocations recorded in the fake binary's call log, capture
5,438 bytes, final frame exactly 20 lines x 45 columns, no stray process.

## 11. `renderToString` — what it can and cannot reach

Ink ships `renderToString` (`ink/build/render-to-string.js`, default export line
115; re-exported from the package root at `build/index.d.ts:4`). Signature:

```ts
(node: ReactNode, options?: {columns?: number}) => string
```

Its own doc comment (`render-to-string.d.ts:11-21`) records that it does not
write to stdout, sets up no terminal listeners, is intended for testing, and
that **`useEffect` callbacks run but their state updates do not affect the
returned output** — only `useLayoutEffect` updates are reflected.

This app is polling-driven: every row of data arrives through the `useEffect`
poll loop (`index.mjs:1312-1412`). `renderToString` therefore reaches the
initial empty frame only. Observing a populated frame requires the pty route.

Ink ships no other test utility — `files` is `["build"]`, and its own suite uses
AVA plus `node-pty`, both devDependencies excluded from the tarball.

## 12. Prior art in the scratchpad

Not committed, but the working parsers from this session's release exist and
record two lessons:

- `pty-smoke.sh` — BSD-form capture with `sleep`/`kill -TERM` bounds, plus an
  embedded parser reading the file as `latin1`. It does **not** redirect stdin
  from `/dev/null`, which is the BSD socket failure above.
- `pty-check.mjs` — the corrected parser. Its header records why: successive
  frames are not newline-separated, so the capture must be split at the frame
  boundary (`/\x1b\[[0-9]*A|\x1b\[2J|\x1b\[H/g`) and only the tail measured. It
  also asserts `clears > 4` as an overflow-repaint signal, noting "two full
  clears are the alt-screen enter itself."
- `frame*.mjs` — a different strategy entirely: a fake `Writable` with
  `isTTY = true` and fixed `rows`/`columns` handed to `render()` as the `stdout`
  option, counting bytes in-process. No pty, identical on both platforms, but it
  replicates the layout rather than running `index.mjs`.

## 13. Recorded constraints

From the project's own documents, attributed:

- No test framework and no build step — `CONTRIBUTING.md:47-50`, `:91-93`;
  `pre-launch-report.md:1237` ("Do not let 'add tests' become 'add a test
  framework'"); `AGENTS.md:107-111`.
- Keep the main-module guard intact — `CONTRIBUTING.md:48-50`.
- Gate on structural invariants, not exact frame content, "or a one-character
  copy change reds the build" — `pre-launch-report.md:1345`, issue #37.
- `script` syntax differs between darwin and ubuntu, "so the harness needs both
  or it will only ever run in one place" — issue #37.
- Nothing may write to stdout that is not a frame; verbose output must go to
  stderr — `pre-launch-report.md:917`, issue #37.
- The harness "should land on top of a stable unit suite, not instead of one",
  and is "the only item that can make CI flaky" — `pre-launch-report.md:1345`,
  `remediation-report.md:127`.
- The three app invariants a change must not break — `CONTRIBUTING.md:54-62`:
  the mount-only poll effect, the raw-payload bail-out, and sanitizing at the
  parse boundary.

Issue #37 is also the only place the original harness command line survives
verbatim:

```
script -q out.txt sh -c "stty cols N rows M; node index.mjs & p=$!; sleep 4; kill -TERM $p; wait $p"
```

## 14. Open questions for the planning phase

1. **The SIGTERM primary-buffer write (§5) is unaddressed and pre-existing.**
   Whether the harness asserts against current behaviour or the behaviour
   changes first is a sequencing decision, not a research finding.
2. **`CI=true` makes ink non-interactive**, deferring all output to unmount
   (`ink.js:191`, `:362-370`). Whether the harness runs with `CI` unset, and
   what that means for fidelity to the real CI environment, is unresolved.
3. **Driving keys requires an interactive stdin**, which backgrounding under
   `script` removes (§6). Whether the harness covers the interactive layer at
   all, or only the render and lifecycle layers, is open.
4. **Fixture drift.** A stubbed `gh` diverges from the real CLI over time;
   issue #37 records "treat drift as the point but expect maintenance."
5. The GNU banner and the BSD zero-byte-on-socket failure (§8) are both
   silent-ish failure modes that a parser would need to distinguish from a
   genuine render failure.
