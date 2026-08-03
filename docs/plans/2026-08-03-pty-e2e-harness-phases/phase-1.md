# Phase 1 — Capture primitive and fixture `gh`

Depends on: nothing. Produces the primitive Phase 2 asserts against.

## Files

- `test/pty/run.sh` (new) — cross-platform capture
- `test/pty/fixtures/gh` (new, executable) — deterministic stub
- `test/pty/capture.mjs` (new) — parse a capture into a structured result

## `test/pty/fixtures/gh`

A shell script that answers the four invocation shapes `index.mjs` makes, and
records every call so a test can prove the app actually reached the data layer.

```
#!/bin/sh
# Deterministic stand-in for the gh CLI. index.mjs calls `gh` by bare name
# (index.mjs:271) and merges rather than replaces the environment (:275), so
# putting this earlier on PATH is enough to intercept every call.
echo "$@" >> "${GH_GLANCE_FIXTURE_LOG:-/dev/null}"

case "$1 $2" in
  "--version "*)  echo "gh version 2.97.0 (fixture)" ;;
  "run list")     cat "$FIXTURE_DIR/runs.json" ;;
  "issue list")   cat "$FIXTURE_DIR/issues.json" ;;
  "pr list")      cat "$FIXTURE_DIR/prs.json" ;;
  "api "*)        echo '[]' ;;          # alert endpoints: empty, never an error
  *)              echo '[]' ;;
esac
```

Fixture JSON must satisfy the field sets at `index.mjs:291`, `:334`, `:363` and
survive `safe()` (`index.mjs:160-165`). Include at least one row per tab so the
frame has content, and one row whose title contains a control character, so the
sanitizer is exercised end-to-end rather than only in the unit suite.

`--version` must succeed or `preflight()` (`index.mjs:552-560`) exits 3 before
anything renders.

`git rev-parse --git-dir` is **not** stubbed — the harness runs inside this
repository, so the real check at `index.mjs:562` passes.

## `test/pty/run.sh`

```
usage: run.sh <cols> <rows> <outfile> [signal]

detect platform:
  script --version 2>/dev/null | grep -q util-linux  ->  GNU
  otherwise                                          ->  BSD

inner command (identical on both):
  export PATH=<fixtures dir>:$PATH
  export GH_GLANCE_NO_ANIMATION=1        # remove the 100ms spinner axis
  export GH_GLANCE_ICONS=unicode         # keep captures ASCII, avoid grep-binary
  stty cols <cols> rows <rows>           # a pty is 0x0 without a controlling tty
  env -u CI -u CONTINUOUS_INTEGRATION \  # both, per is-in-ci/index.js:3-5
      node index.mjs & p=$!
  sleep <settle>
  kill -<signal> $p                      # default TERM
  wait $p
  echo "EXITCODE=$?"                     # captured in-band; script's own rc differs

BSD:  script -q "$OUT" /bin/sh -c "$INNER" </dev/null >/dev/null 2>&1
GNU:  script -q -e -c "$INNER" "$OUT"     </dev/null >/dev/null 2>&1
```

`</dev/null` is mandatory on BSD: without it, when stdin is a socket, `script`
aborts with `tcgetattr/ioctl: Operation not supported on socket` and leaves a
zero-byte file with rc=1 — which looks exactly like "the app never rendered".

`-e` is mandatory on GNU and redundant on BSD.

The exit code is echoed **into the capture** rather than taken from `script`,
because the two platforms propagate it differently.

## `test/pty/capture.mjs`

Pure parsing, no assertions. Exports one function so both test files share it.

```
parseCapture(text, { cols }) -> {
  raw,                     // the capture verbatim
  exitCode,                // from the in-band EXITCODE= marker, or null
  altEnter, altExit,       // counts of \x1b[?1049h / \x1b[?1049l
  cursorShows,             // count of \x1b[?25h
  fullClears,              // count of \x1b[2J
  eraseScrollback,         // count of \x1b[3J
  finalFrame: { lines[], widest },   // tail after the LAST frame boundary
  afterRestore: { bytes, visible, hasClear, hasScrollbackErase }, // tail after \x1b[?1049l
  fixtureCalls,            // lines read from the fixture log
}
```

Two details that are easy to get wrong, both learned the hard way:

- **Frame boundary.** Ink repaints without a separating newline, so split on
  `/\x1b\[[0-9]*A|\x1b\[2J|\x1b\[H/g` and measure only the tail. Measuring the
  whole stream reports roughly 3x the real width.
- **GNU banner.** Strip lines matching `/^Script (started|done) on /` before any
  line-width measurement, or the header is counted as an overflowing line.

Width is measured in **codepoints** (`[...line].length`), not UTF-16 units.

## Wiring

Add to `package.json`:

```
"test:pty": "node --test test/pty/*.test.mjs"
```

`npm test` stays `node --test test/*.test.mjs` — the glob does not recurse, so
the pty tests do not join the fast unit run. Keeping them separate is what lets
CI make one advisory and the other required.

`test/` is absent from `files` (`package.json:9-14`), so nothing here ships.

## Success criteria

**Automated**

- `bash test/pty/run.sh 80 24 /tmp/c.txt` produces a non-empty capture on darwin.
- `parseCapture` on it reports `altEnter === 1`, `altExit === 1`,
  `finalFrame.lines.length === 24`, `finalFrame.widest <= 80`.
- The fixture log is non-empty — the app reached the data layer.
- `npm run lint` passes (`eslint.config.js:8` lints `**/*.mjs`, so
  `capture.mjs` is in scope).

**Manual**

- Read the capture for a 45-column run and confirm by eye that the compact
  layout rendered, so later automated width assertions are trusted rather than
  merely green.
