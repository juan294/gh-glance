# Changelog

All notable changes to this project are documented here.

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Fixed

- **The row cursor clears itself after 60s without movement.** Once you pressed
  a movement key the selection marker stayed on screen until you quit, so a pane
  left in the corner of a screen sat there marked at something you had stopped
  caring about an hour ago. Any movement key rearms the timer; expiry clears the
  cursor on every tab, not just the visible one.
- **The `Move` hint in the status bar reads `↑↓` rather than `jk`.** The hints
  are otherwise strictly width-1 ASCII, because East-Asian-Ambiguous glyphs
  measure as two columns in ink's width model and overflowed an 80-column
  terminal once before. The arrow pair is a deliberate exception: the pty suite
  asserts the rendered frame stays inside the terminal width, so a font that
  renders them double-width fails there loudly instead of shifting columns
  silently.

## [0.4.0] - 2026-08-04

Correctness on GitHub Enterprise and Enterprise Managed Users tenants, and a
diagnostic command built to settle what a bug report cannot describe. The two
enterprise entries below are the same failure: the dashboard stating something
confident and wrong, which is precisely what its error classifier exists to
prevent. The rest of the release is a run of layout and interaction fixes.

### Fixed

- **A lapsed enterprise SAML session was reported as "not enabled for this
  repository", and latched for up to an hour.** EMU tenants expire the SAML
  session periodically; while lapsed the API answers 403, which the classifier
  could not tell apart from "this feature is switched off". So the Security tab
  went blank under a false explanation, and the escalating backoff
  (60s -> 300s -> 1800s -> 3600s) kept it that way long after the user had
  re-authorized in the browser. Auth failures -- SAML, SSO, a credential not
  authorized for the org, a missing token scope -- now surface `gh`'s real
  message and take a short fixed 30s retry instead of the escalating ladder, so
  recovery is bounded at about half a minute. A 403 with no auth markers still
  produces the existing note and ladder.
- **On a non-default host the three security-alert endpoints were queried
  against `github.com`.** `gh api` has no `--repo`, so a host-qualified target
  routed the four list-driven tabs to the enterprise host while the alert calls
  went to `github.com`, 404ed, and -- via the defect above -- rendered as "not
  enabled". The Security tab could therefore report that a feature was off for a
  repository whose alerts it had never asked for. The host now travels as
  `--hostname`, and both halves of the dashboard talk to the same server. The
  fixture-log assertions in `test/pty/routing.test.mjs` are the guard against it
  recurring.
- **`Enter` on an Actions row opened the wrong run, or none at all.** Every
  openable row passed its display `number` to `gh <kind> view`, which is right
  for an issue or a pull request and wrong for a workflow run: runs are
  addressed by `databaseId`, a different and global ID space, so a run's number
  is almost never a valid one and the browser got a 404. Runs now open by
  `databaseId`; issues and pull requests are unchanged.
- **The panel's right border could be clipped at the terminal edge.** One
  trailing column is now reserved for it, so the frame closes on terminals that
  treat the final cell as the wrap boundary.
- **The stale indicator reserved its column even when there was nothing to
  say.** An idle dashboard now gives that width back to the table instead of
  holding it empty against a label that only appears after 30 seconds without a
  successful refresh.
- **The spinner jittered against the status icons beside it.** The classic
  "dots" braille set lights only one or two of a cell's eight dot positions per
  frame, and in different corners each frame, so next to the solid circle glyphs
  used for completed runs it visibly wandered rather than holding a centre. The
  replacement lights six or seven dots per frame, reading as a filled blob of
  the same visual weight, and stays width-1.

### Changed

- **The tab bar moved to the top of the pane**, above the table rather than
  below it, with a divider separating the two. Below the table it was being
  missed entirely; the status and key hints stay at the bottom.
- **The rate-limit figures in the README were wrong and are now stated per
  tab.** The documented "roughly 500 requests an hour, about 10% of the limit"
  did not follow from the constants it described. A visible Actions, Issues or
  Pull Requests tab costs about 1,000 an hour (20% of the 5,000/hour
  authenticated limit); the Security tab, being three endpoints rather than one,
  costs about 2,300 (47%). Both figures fall when an endpoint backs off because
  the feature is not enabled, and `--refresh` scales the whole number.

### Added

- **`--repo` accepts `[host/]owner/name`**, the same form `gh --repo` itself
  accepts, so a GitHub Enterprise or EMU data-residency tenant can be watched
  from outside a clone: `gh-glance --repo tenant.ghe.com/acme/widget`. A host
  must contain a dot, which is what keeps `owner/name/extra` a rejected typo
  rather than a silent request to a host named `owner`. The host is validated
  separately from the `owner/name` slug and is never interpolated into a request
  path.
- **`--doctor`**, a reporting command that prints versions, authenticated hosts,
  how the repository target resolved, the relevant environment, and one probe
  per endpoint -- with the exact argv sent and how any error was classified.
  It exits 0 and reports rather than failing when `gh` is missing or the working
  directory is not a repository, and it works through a pipe. Tokens are never
  printed: token-valued variables are reported as present or absent, anything
  token-shaped in captured text is replaced, URL credentials are stripped, and
  no response bodies are included -- so the report is safe to attach to a bug
  report.

## [0.3.1] - 2026-08-04

First release published by CI rather than from a laptop, and the first carrying
an [npm provenance
attestation](https://docs.npmjs.com/generating-provenance-statements) linking
the tarball to the workflow run and commit that built it.

### Fixed

- **The install instructions on the npm page told you to clone the
  repository.** `README.md` ships inside the tarball, and the copy published
  with `0.3.0` still said "Not yet published to npm -- clone + `npm link` is
  the current install path". It was written before there was a package and was
  false the moment one existed. `npm install -g gh-glance` is now the first
  thing the page shows.

### Added

- **Publishing is automatic and credential-free.** Publishing a GitHub release
  builds and publishes from the tagged commit via OIDC trusted publishing.
  There is no `NPM_TOKEN` in the repository and there will not be one: npm
  revoked all classic tokens in December 2025, removed account and package
  management from bypass-2FA granular tokens in August 2026, and removes their
  direct-publish ability in January 2027.
- The release workflow now installs the packed tarball globally and runs the
  binary before publishing, so a dropped `files` entry or a broken bin shebang
  fails the release rather than the next person's install. It also refuses a
  tag that is not reachable from `main` or that does not point at the commit
  being built, and skips a version that is already on the registry rather than
  hard-failing on `E403`.

## [0.3.0] - 2026-08-03

The dashboard stops being read-only: you can now move through the table and open
what you are looking at. The rest of the release is the audit backlog `0.2.0`
deferred — a configuration surface, structural refactors, and the first tests
that drive the real binary under a terminal.

### Added

- **Row selection, scrolling, and opening items in a browser.** `↑`/`↓` or
  `j`/`k` move a cursor, `PgUp`/`PgDn` move a page, and `Enter` opens the
  selected run, issue or pull request. The cursor tracks the item rather than
  the row position, so it stays put as new rows arrive above it rather than
  drifting every few seconds. The marker is a plain `>` sharing the existing
  icon column, so it survives `NO_COLOR` and costs no width.
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

### Changed

- **Terminal traffic roughly halved.** The renderer now updates only the lines
  that changed instead of rewriting the whole viewport: measured 13,918 bytes
  down to 6,799 on a settled 80x24 pane.
- Rows are memoised and the spinner frame is no longer handed to the three tabs
  that ignore it, so a running workflow animates one glyph instead of
  reconciling every row ten times a second.
- The Actions tab count carries a `!` when the newest run failed, so "is CI red"
  is answerable from any tab rather than only from that one.
- The status bar's key hints are plain ASCII. The arrows, return symbol and
  box-drawing separator it used are East-Asian-Ambiguous, which the renderer
  measures as two columns each — enough to overflow an 80-column terminal once
  selection added a hint.
- The four fetchers are driven by one registry rather than four near-identical
  functions, colours are named rather than repeated as literals, and the
  terminal-size hook is extracted. No behaviour changed.
- Installing from a git URL or a local directory no longer writes git hooks.
- `develop` is now PR-only, admin-enforced, with eight required checks. Its
  previous protection required an approving review that a solo maintainer could
  not give, so every commit had been landing as a direct push and the required
  checks gated nothing.

### Fixed

- **`kill` no longer erases your terminal scrollback.** On `SIGTERM`, `SIGINT`
  and `SIGHUP` the dashboard handed the terminal back to the primary buffer and
  the renderer then repainted onto it — preceded by an erase-scrollback escape,
  so a `kill` threw away the terminal history and left a dead dashboard frame
  behind. Measured at 2,728 bytes on an 80x24 pane. Quitting with `q`, `Esc` or
  `Ctrl+C` was never affected. Found by the new pty harness; present since
  before 0.2.0.

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

[Unreleased]: https://github.com/juan294/gh-glance/compare/v0.4.0...HEAD
[0.4.0]: https://github.com/juan294/gh-glance/releases/tag/v0.4.0
[0.3.1]: https://github.com/juan294/gh-glance/releases/tag/v0.3.1
[0.3.0]: https://github.com/juan294/gh-glance/releases/tag/v0.3.0
[0.2.0]: https://github.com/juan294/gh-glance/releases/tag/v0.2.0
