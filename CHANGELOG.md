# Changelog

All notable changes to this project are documented here.

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- **Full-table columns can be resized with a mouse or keyboard.** Visible header
  grips support left-button dragging, while `w` opens a keyboard width mode for
  one- and five-cell adjustments and selected-column or active-tab resets.
- **Width choices persist automatically per user and per tab.** Only deviations
  from the built-in defaults are stored, so resetting a column or tab cleanly
  returns it to the source-controlled layout.
- **`gh-glance` now widens its own poll interval when the API budget is
  draining.** The rate limit is per token, not per process, so several panes
  spent one budget while each throttled as though it were alone: seven panes
  exhausted a 5,000/hour REST limit in under half an hour (measured 8,500
  calls/hour). Each pane now reads `gh api rate_limit` once a minute -- a probe
  that does not itself count against the limit -- infers how much of the budget
  is its own by comparing its spend against the token's total, and slows down to
  fit, up to a 60-second ceiling. A single pane is unaffected and stays at 5
  seconds. The status bar shows `throttled 18s` whenever the interval has
  widened, and `r` still refreshes immediately.
- **`GH_GLANCE_REFRESH` sets the poll interval for every pane in a shell.** Same
  2-3600 second range as `--refresh`, which still takes precedence.

### Changed

- **Oversized saved widths fit safely in narrower panes.** They are temporarily
  reduced toward the defaults when the stock full table fits, without changing
  the saved preference; widening the pane restores the preferred widths.
- **Terminal mouse reporting is released on every cleanup path.** Clean quit,
  signals, crashes, and the interactive remote-setup handoff disable button and
  SGR reporting before the primary screen is restored.

### Fixed

- **The cost model understated the Actions tab by half.** `gh run list` issues
  two REST requests, not one -- `GET /actions/runs` and
  `GET /actions/workflows` -- so a pane on Actions costs about 1,620 requests an
  hour rather than the 900 `--doctor` reported, and roughly three panes fill an
  hourly budget rather than five. The figure was wrong in `--doctor`, in the
  README's per-tab table, and in ADR 0001's request count. Measured with
  `GH_DEBUG=api`; the projection and the new throttle now read one shared table.

## [0.6.1] - 2026-08-06

### Security

- **The GraphQL repository-resolution check no longer risks catastrophic
  backtracking.** CodeQL flagged `isUnavailable()`'s `.*`-joined pattern as
  worst-case superlinear over the repository name `gh` echoes back verbatim in
  its error text -- attacker-influenced input reaching a vulnerable regex. It
  is now two fixed-substring checks with the same matching behaviour and no
  backtracking risk.

### Added

- **The status bar shows gh-glance's own version**, right-aligned in the
  lower-right corner the way lazygit's footer does. It is dropped on narrow
  terminals rather than left to compete with the `Quit` hint for space.

## [0.6.0] - 2026-08-06

### Added

- **An interactive missing-remote onboarding prompt.** Starting gh-glance in a
  local repository with no remotes now offers to hand off to the user-confirmed
  interactive `gh repo create` flow, while keeping quit and explicit `--repo`
  paths visible. Declining the prompt makes no repository change.
- **Failure-triggered account and repository context.** After an ambiguous
  repository-access failure, gh-glance performs read-only active-account and
  repository checks through `gh`, and `--doctor` now includes a `Repository
  access` probe.

### Fixed

- **Clean no-login failures now explain the delegated authentication path.**
  Previously these were unclassified raw `gh` errors. They now direct the user
  to login or authorization evidence through their own `gh` configuration and
  remain retryable.
- **Inaccessible repository errors now converge on honest wording.** Actions'
  REST 404 and Issues' GraphQL repository-resolution failure described the same
  inaccessible target through unrelated messages. List tabs now say “not found
  or inaccessible” without claiming whether the target is missing or private.

## [0.5.1] - 2026-08-04

### Changed

- **The blank-icons hint waits for a start that is actually stuck.** It shipped
  in 0.5.0 on the loading line unconditionally, so every start put a line naming
  an environment variable in front of everyone for the second or two the first
  fetch takes -- a dim `loading actions…` reads as "working", the same line with
  a remedy attached reads as a warning about a problem you do not have. It now
  appears only once a first fetch has been running 3s, which is past the slow end
  of what `gh run list` costs on the tab you land on (measured: 1.4-3.0s after
  the first frame, against 0.6-1.1s for the other three tabs). An ordinary start
  never shows it; a pane of blank boxes that is genuinely waiting still explains
  itself.

## [0.5.0] - 2026-08-04

Findings from a cross-functional audit, filtered hard: everything that would
have added a release gate, a branch-protection rule or more test-harness
machinery was rejected outright. What is left is behaviour you can see.

### Added

- **`?` shows the keys without leaving the dashboard.** Paging, `j`/`k`,
  `Shift+Tab` and the cursor timeout existed only in `--help` and the README --
  and because this is a full-screen app, reading `--help` meant quitting it
  first. Any key closes the overlay. `--help`, the overlay and the status-bar
  hints are now generated from one table, so a binding cannot go missing from one
  of them.
- **The panel names the repository** when it was chosen explicitly through
  `--repo` or `GH_REPO` -- `╭─ Actions · acme/widget ─`. With several panes open,
  or after changing directory, nothing on screen said which repository a pane was
  watching. Dropped before the tab name when the pane is too narrow for both.
- **`--doctor` reports API budget**: REST and GraphQL headroom straight from
  GitHub, plus what this configuration will actually spend per hour. The steady
  cost is not small and was invisible -- roughly 2,200 REST requests an hour at
  the default refresh with the Security tab open, about 44% of a personal token's
  allowance, and `--refresh 2` projects past the limit outright. `gh api
  rate_limit` does not itself count against the limit.
- **Native test coverage is measured and reported.** `npm run test:coverage`
  runs the unit suite under Node's built-in coverage, and a nightly workflow
  publishes the figure to the portfolio endpoint. The delivery script fails
  closed on purpose: every input is required and a parse failure is an error
  rather than a reported zero, so a broken producer cannot quietly claim perfect
  coverage. Not wired into branch protection -- it reports, it does not gate.
- **A first-run hint when icons may be blank.** Without a Nerd Font every status
  icon renders as an empty box, which reads as a broken program rather than a
  missing font, and the fix was documented only in places you had to quit to
  read. Shown for the second the first fetch takes, and only when the Nerd glyphs
  are actually in use.

### Fixed

- **The `stale` indicator no longer fires on a repository that is simply quiet.**
  Freshness was recorded only when the payload *changed*, and the whole point of
  the poll loop is that an unchanged payload short-circuits before that write --
  so on any calm repo the timestamp froze and the status bar accrued a growing
  `stale 2h13m` while every poll was succeeding on schedule. It now records the
  last successful *poll*. The warning fired loudest in the one state that was
  completely healthy, which is the fastest way to teach someone to ignore it.
- **A tab whose fetch keeps failing no longer animates forever.** `setData` only
  runs on success, so a tab that never succeeded stayed in its first-load state
  permanently: the spinner ran at full rate for the life of the process while the
  body rendered "loading actions…" directly above the error explaining that it had
  failed. Measured at 7.8% of a core and 9.8 MB/hr of terminal writes,
  indefinitely, triggered by something as ordinary as closing a laptop lid.
  Motion now means "still working"; the error line means "not working".
- **`Enter` is guarded against key repeat.** Holding it down spawned a
  `gh <kind> view --web` per repeat event -- roughly thirty a second -- each
  opening another browser tab. The `r` key beside it had this guard all along.
- **The status bar adapts to narrow panes.** It was the only band that did not:
  the table swaps to a compact header, the tab bar to short labels, the panel
  edges drop their labels, and the status bar just let ink truncate. Because each
  hint truncates individually the loss was silent -- at 45 columns the bar read
  `Move: | Open:  | Refresh |Quit:…`, dropping the arrows, `Refresh`'s key, and
  most of `Quit`, which is the one hint someone stuck in a full-screen app needs.
  It now falls back to `↑↓ Ent r q`, which keeps every key.
- **`--doctor` no longer prints the value of environment variables it was never
  told about.** It discovers every `GH_*`/`GITHUB_*` variable that is set, and
  printed the value of any whose *name* did not end in `_TOKEN`/`_SECRET`/
  `_PASSWORD`/`_KEY` -- so `GH_APP_PEM` (an entire RSA private key) and
  `GITHUB_OAUTH` were reproduced in full, in the one report that says it is safe
  to paste into a bug report. Printing a value is now opt-in and the list is
  curated; anything discovered reports `set` or `not set`.
- **`--doctor --verbose` produces the log it advertises.** argv was applied to
  runtime state in two places and they had drifted, so the doctor path silently
  dropped `--verbose`, `--refresh` and `--tab`. There is one application site now.
- **The 60s cursor clear no longer costs you your place.** Clearing the selection
  left the scroll offset behind, and the next arrow key seeded from the top of the
  list -- so scrolling to row 80 of 150, reading for a minute and pressing down
  put you back at row 1, with no scroll animation to notice. Movement now seeds
  from what is on screen.
- **`safe()` sanitizes non-string input.** It returned early for anything that
  was not a string, skipping both the control-character strip and the length
  clamp -- the guarantee was being provided by GitHub's schema rather than by the
  function that claims to provide it.
- **The `!` "CI is red" marker stays in the tab bar**, where a label anchors it,
  instead of also being interpolated into the frame's bottom edge as `4 of 4!`.
- **A blind Security tab no longer reports a confident zero.** When all three
  alert endpoints fail -- an expired SAML session, a token without
  `security_events`, an org OAuth restriction -- the tab rendered
  `4:Security (0)`, byte-identical to a genuinely clean repository, on the one
  surface where a false all-clear is the worst available answer. It now reads
  `(?)`. A repository that simply has Advanced Security switched off is a
  different thing and stays quiet, because that is an answer rather than an
  absence of one.
- **A failing tab backs off instead of re-spawning `gh` every tick.** The three
  list tabs had no backoff at all, so a wedged tab launched a subprocess every
  five seconds indefinitely -- 720 an hour against a token already refusing --
  and rate limiting was deliberately excluded from the ladder that did exist,
  which had it backwards: GitHub's secondary limiter keys on sustained rate
  against a limited *token*, so hammering can turn a self-clearing limit into a
  longer block that also hits `git push`. Measured: two `gh run list` calls in
  forty seconds where there were eight. The `r` key bypasses and clears the
  backoff, because a refresh that silently declines to refresh would be worse
  than no key at all.
- **Errors on the Actions, Issues and PR tabs say what to do.** They rendered raw
  `gh` stderr while the Security tab one across had been classifying the same
  failures into remedies all along. An expired token now reads "GitHub
  authorization failed -- try `gh auth login` or `gh auth refresh`". Unclassified
  failures still show their real message: inventing a remedy for something
  nobody recognised would be worse than showing what happened.
- **Bidi override characters are stripped from remote text.** `U+202A`-`U+202E`
  and the isolates measure as zero columns, so they cost no width and survived
  truncation -- one `RLO` in an issue title makes the rest of that cell render
  reversed on any terminal with bidi reordering, which is the same "the row does
  not show its data" failure the control-character strip already prevents.
  Deleted rather than replaced with a space, because they measure zero and a
  space would shift every cell to its right. Genuine RTL, `LRM`, emoji, ZWJ
  sequences and CJK are untouched.
- **`REPO_PATTERN` rejects `owner/..`.** It reached the API path, and `gh`
  forwards the dot segment unnormalized, so GitHub resolved it to a different
  endpoint than the one intended. Names that merely contain or start with a dot
  -- `owner/.github` -- are still valid.
- **Backoff deadlines use a monotonic clock.** They measure elapsed time, and a
  laptop resume or an NTP step could hold an alert source in backoff for an hour
  of apparent time that never passed. Staleness deliberately stays on wall-clock
  time, because a sleep gap is exactly what it exists to report.
- **A crash no longer orphans `gh` children.** The handlers exited without
  unmounting, so the cleanup that aborts in-flight subprocesses never ran. Both
  the crash output and the `--verbose` log are now redacted, like `--doctor`
  already was -- all three are artifacts users are told to attach to bug reports,
  and `gh` error messages quote the URL they failed on.

### Changed

- **The spinner runs at 200ms rather than 100ms.** It is the single largest CPU
  term in the app, because every frame makes ink rebuild and diff the whole
  output string: measured 7.8% of a core at 100ms against 3.9% at 200ms, on a
  0.33% idle floor. The motion is load-bearing -- it is the only thing separating
  an executing run from a queued one -- so it is slowed, never stopped.
- **Only an executing Actions row receives the spinner frame.** It went to every
  visible row, so a prop changing several times a second defeated row
  memoisation for all of them: 7,960 row renders over 20 seconds against 238.
- **The panel names the repository** when it was chosen explicitly via `--repo`
  or `GH_REPO` -- `╭─ Actions · acme/widget ─`. With several panes open, or after
  changing directory, nothing on screen said which repository a pane was watching.
  It is dropped before the tab name when the pane is too narrow for both.
- **Column density is decided per tab.** One global breakpoint meant the widest
  tab decided for the narrowest: Pull requests needs 61 columns and Security only
  44, so Security dropped two columns a full 17 columns before it had to. Only
  one tab is on screen at a time, so there is nothing to be inconsistent with.
- **Below 24 columns the pane says "too narrow"** instead of rendering a table
  that cannot fit. Under that width even the compact columns overflow, which
  hard-wraps every row and drives ink into repainting the whole screen each
  frame -- reachable just by dragging a sidebar narrow. Widening recovers
  immediately.
- **The Security tab collapses its not-enabled notes into one line.** Each
  unavailable alert source took a full row above the column header, so any
  repository without Advanced Security permanently spent two rows -- about a
  tenth of a twenty-row pane -- restating a fact that will never change, on the
  tab meant to make real alerts stand out. Failures that are not "not enabled"
  keep their own lines, because those are actionable and transient.
- **Alert ordering is pinned rather than left to each endpoint's default.**
  Severity ranking runs over one page, so the page boundary decides what can be
  ranked at all -- a critical alert sitting past it was never fetched, and the
  pane showed "100+" with a screen of moderates. Newest-first at least makes the
  cut deterministic.
- **`-v` is no longer an alias for `--version`.** This CLI also has `--verbose`,
  so `gh-glance -v 2>log` -- what you type when you want the log -- printed a
  version string and exited 0. The argv surface exists to make typos fail loudly,
  and this was the one flag that failed quietly. `--version` is unaffected.

### Documentation

- **Corrected a claim this project made about itself in 0.4.0 and repeated in the
  0.4.1 release notes.** The status bar's `↑↓` glyphs were described as "a
  deliberate, tested exception" whose double-width rendering "fails loudly" under
  `npm run test:pty`. No such assertion exists or could: each hint truncates
  individually, so the failure mode is silent text loss rather than overflow, and
  at 80 columns the panel border is 79 cells against a 54-cell status bar, so the
  bar never sets the maximum a width check would measure. The glyphs are fine;
  the guarantee was not real, and a comment asserting coverage that does not
  exist is worse than an acknowledged gap.
- The README no longer claims every run state has a distinct glyph under
  `NO_COLOR`. Timed-out, action-required and running share one, as do skipped,
  neutral, stale and queued. The tab bar's `!` marker is what actually answers
  "is CI red" without colour, and it does.
- `eslint.config.js` no longer describes an inline `exhaustive-deps` suppression
  that has never existed; the rule is now an error, which it can be precisely
  because there is nothing to suppress.

## [0.4.1] - 2026-08-04

Two fixes to the interactive surface: a selection marker that outlived its
usefulness, and a key hint that named the wrong keys.

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

[0.6.1]: https://github.com/juan294/gh-glance/releases/tag/v0.6.1
[0.6.0]: https://github.com/juan294/gh-glance/releases/tag/v0.6.0
[0.5.1]: https://github.com/juan294/gh-glance/releases/tag/v0.5.1
[0.5.0]: https://github.com/juan294/gh-glance/releases/tag/v0.5.0
[0.4.1]: https://github.com/juan294/gh-glance/releases/tag/v0.4.1
[0.4.0]: https://github.com/juan294/gh-glance/releases/tag/v0.4.0
[0.3.1]: https://github.com/juan294/gh-glance/releases/tag/v0.3.1
[0.3.0]: https://github.com/juan294/gh-glance/releases/tag/v0.3.0
[0.2.0]: https://github.com/juan294/gh-glance/releases/tag/v0.2.0
