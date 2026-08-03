# Changelog

All notable changes to this project are documented here.

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Fixed

- **`kill` no longer erases your terminal scrollback.** On `SIGTERM`, `SIGINT`
  and `SIGHUP` the dashboard handed the terminal back to the primary buffer and
  the renderer then repainted onto it — preceded by an erase-scrollback escape,
  so a `kill` threw away the terminal history and left a dead dashboard frame
  behind. Measured at 2,728 bytes on an 80x24 pane. Quitting with `q`, `Esc` or
  `Ctrl+C` was never affected. Found by the new pty harness; present since
  before 0.2.0.

### Added

- **Flags: `--repo`, `--refresh`, `--tab`, `--verbose`.** The tool still takes no
  arguments by default. `--repo owner/name` watches a repository you have not
  cloned, and works from any directory. `--refresh` sets the active-tab interval
  between 2 and 3600 seconds — below two a fetch cannot finish before the next
  tick, so the value would silently stop being real, and it is refused rather
  than accepted. `--tab` picks the starting tab. An unrecognised flag still
  exits 2 rather than being ignored.
- **`--verbose`** writes one line per `gh` invocation to stderr with its duration
  and outcome, for attaching to a bug report. It refuses to start while stderr
  is still a terminal, because the log would otherwise be drawn over the
  dashboard.
- A pty end-to-end harness (`npm run test:pty`). It drives the real binary under
  a pseudo-terminal against a fixture `gh`, and asserts the things unit tests
  structurally cannot reach: that the alternate screen is entered and left
  exactly once, that the cursor is restored, that the final frame is exactly as
  tall as the terminal and never wider, that a narrow pane still draws its
  chrome, that signal exit codes are 143/130/129, and that nothing is left on
  the primary buffer afterwards. It runs in CI as an advisory check.

## [0.2.0] - 2026-08-03

First release. `0.1.0` was never published to any registry and was never
tagged, so this is the first version with an artifact behind it.

The bulk of this entry comes from a pre-launch audit that found 118 issues
across architecture, the `gh` data layer, rendering, performance, release
engineering, security, QA and UX. What follows is what changed as a result.

### Security

- **Sanitize untrusted GitHub text at the data boundary.** Every string the tool
  displays — issue and PR titles, run titles, branch names, advisory summaries —
  is chosen by whoever opens the issue or pull request. Ink strips CSI sequences
  but deliberately preserves OSC, SGR and bare C0 control characters, so OSC 8
  hyperlinks (an attacker-chosen clickable URL with no visual tell), carriage
  returns (which overwrite the row above, and could blank a critical alert),
  bells and newlines all reached the terminal. A single multi-line title could
  evict other rows out of the pane entirely. Control characters are now replaced
  at the point the JSON is parsed. Emoji, ZWJ sequences, CJK, combining marks,
  right-to-left text and the tool's own Nerd Font glyphs are unaffected.
- **Remote values can no longer crash the render.** Severity and status strings
  were used directly as object keys, so a code-scanning alert with a severity of
  `constructor` returned a function where a colour was expected and took the
  whole dashboard down — inside the alternate screen, so the stack trace was
  wiped on the way out. Lookups now ignore inherited keys, and each row is
  wrapped in an error boundary.
- Enabled private vulnerability reporting. `SECURITY.md` told reporters to use
  it while it was switched off, so the documented disclosure path accepted
  nothing.

### Fixed

- **A stalled `gh` no longer wedges a tab forever.** Subprocess calls had no
  timeout, and the in-flight guard was only cleared when the promise settled —
  which a hung child never does. That tab then stopped refreshing for the life
  of the process while the spinner kept insisting it was working. All calls now
  carry a timeout, a kill signal, a 16 MiB output buffer and an abort signal.
- **Errors are readable.** The error formatter checked a property Node never
  sets, so every failure rendered as the entire reconstructed command line —
  roughly 150 characters of JSON field names — against a layout that reserved
  one row for it, overflowing the frame and making the screen flash on every
  redraw. It now shows the first line of stderr, and error and note lines are
  pinned to the single row they are budgeted.
- **A parse failure no longer reports "no runs".** The payload cache was written
  before parsing, so a malformed response was cached, its error was cleared on
  the next tick, and the retry was skipped — leaving the tab confidently empty
  forever. The cache is written only after a successful parse.
- **Security failures are no longer misreported as configuration.** Any failure
  on the code-scanning or secret-scanning endpoints — expired token, rate limit,
  network — was reported as "not enabled". Only a genuine 403/404 says that now;
  everything else surfaces as itself, and unavailable sources back off instead
  of being re-asked on every refresh.
- **Counts stopped lying.** Issues, pull requests and alerts are all capped by
  the fetch, but only the Actions tab said so. Every tab now marks a truncated
  count, and a tab whose fetches are failing is marked in the tab bar rather
  than showing a frozen number at full confidence.
- **Rows are sorted by what matters.** Security alerts were ordered by which
  endpoint answered first, which put secret-scanning alerts — always critical —
  last, below the fold. They now sort by severity. Issues and pull requests were
  returned oldest-created-first while the age column showed the update time, so
  the column could not be read and truncation dropped recently-active items;
  both now sort by update time.
- **A crash is visible.** Uncaught errors were drawn into the alternate screen
  and then erased by the exit handler, so the tool vanished with exit code 0.
  Crashes now restore the screen first, print a stack trace, and exit non-zero.
  Interrupts exit 130/143 instead of 0.
- **Narrow panes work.** Below about 61 columns the fixed columns overflowed the
  frame, rows wrapped and the screen repainted in full every frame; in the band
  just above that the frame looked correct while the title column silently
  rendered empty. Narrow panes now drop columns instead, keeping the frame, tab
  bar and status line on screen.
- Missing or malformed timestamps rendered as `NaNd ago`; they now render as a
  dash.
- `GH_FORCE_TTY`, which many people export in their shell profile, made `gh`
  emit coloured JSON that could not be parsed, breaking all four tabs at once.
  The environment passed to `gh` is now neutralized for display variables only.
- A missing `gh` or a directory that is not a repository produced four copies of
  a raw subprocess error inside the alternate screen, which was then erased on
  exit. Both are now caught before the dashboard starts, with an actionable
  message and a non-zero exit.

### Added

- `q` and `Esc` quit; `r` refreshes the current tab immediately.
- `GH_GLANCE_ICONS=unicode` swaps the Nerd Font Octicons for plain ASCII, so the
  tool is usable without a Nerd Font. The previous advice was to edit the source
  — which would not survive an update once installed as a package.
- `GH_GLANCE_NO_ANIMATION=1` freezes the spinner, for a pane that sits in
  peripheral vision for hours.
- A severity column on the Security tab. Severity had been carried by the shield
  icon's colour alone, which made critical and high indistinguishable and
  erased the distinction entirely under `NO_COLOR` or for a colour-blind reader.
- A staleness marker once the visible tab's data is old enough to mislead.
- Screen-reader labels on the status icons, which otherwise announce as nothing.
- A unit test suite on Node's built-in runner — no framework, no build step.
  Before this, no function in the file was executed by any check.
- `release.yml`, which publishes with provenance from a verified tag.

### Changed

- **Node 22 is now the minimum.** Ink and two of its dependencies already
  required it while the package claimed 20.19, so installs on the advertised
  floor emitted engine warnings. Node 20 reached end of life on 2026-04-30.
- Background tabs refresh every 60 seconds rather than every 20. Steady-state
  polling had been consuming 40-50% of an hourly GitHub API rate limit for a
  single pane; the visible tab is unchanged at 5 seconds.
- The spinner animates on first load and while a run is executing, rather than
  on every fetch. The previous behaviour kept a 10 fps redraw loop alive
  permanently, costing roughly 44 MB of terminal writes per idle hour.
- `--version` and `--help` no longer load the rendering stack: 0.27s and 94 MB
  down to 0.04s and 49 MB.
- Secondary text uses the terminal's own dim attribute rather than a fixed
  colour chosen for dark themes, so it is readable on light backgrounds too.
- The age column is labelled `UPDATED`, which is what it has always shown.
- CI runs the test suite, no longer stops the matrix at the first failure,
  asserts exit codes rather than just non-zero, and pins every action to a
  commit SHA.

### Removed

- The `main` field from `package.json`. It advertised the file as importable,
  but importing it took over the terminal or exited the host process.

[0.2.0]: https://github.com/juan294/gh-glance/releases/tag/v0.2.0
