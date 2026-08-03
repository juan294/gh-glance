# Phase 2 — Structural assertions

Depends on: Phase 1. **Ends deliberately red** — the primary-buffer assertion
captures #41 and cannot pass until Phase 3.

## Files

- `test/pty/e2e.test.mjs` (new)

## Shape

`node:test`, matching the conventions in `test/unit.test.mjs`: lowercase prose
test names that state a behaviour, comments inside the body recording the
observed failure that motivated the assertion, and a third `assert` argument
explaining the consequence rather than restating the check.

Captures are expensive (~4s settle each), so take each one **once** in a
`before`-style module-level setup and assert against it repeatedly, rather than
re-capturing per assertion.

```
const wide    = await capture({ cols: 80, rows: 24 });   // full column set
const narrow  = await capture({ cols: 45, rows: 20 });   // compact set, below MIN_TABLE_WIDTH
const sigterm = await capture({ cols: 60, rows: 16, signal: "TERM" });
```

## Assertions

### Terminal lifecycle

```
test("the alternate screen is entered exactly once and left exactly once")
  altEnter === 1 && altExit === 1
  // An unbalanced pair strands the user's terminal in the alt buffer.

test("the cursor is restored before exit")
  cursorShows >= 1
  // index.mjs:1595 writes ?25h because an explicit process.exit() skips ink's
  // own unmount restore (index.mjs:1588-1590).

test("signal exit codes are 143 / 130 / 129")
  // Documented in CHANGELOG.md:71-74 but asserted nowhere until now.
```

### Frame geometry

```
test("the final frame is exactly as tall as the terminal")
  finalFrame.lines.length === rows
  // Output.get() pre-allocates exactly `height` rows (ink/build/output.js:71-85),
  // so anything else means the layout overflowed.

test("no rendered line exceeds the terminal width")
  finalFrame.widest <= cols
  // Measured before the fix: 45x20 rendered 48 columns wide.

test("the panel frame and tab bar are drawn")
  // Chrome presence only -- never cell contents.

test("a narrow pane drops columns instead of overflowing")
  narrow.finalFrame.widest <= 45 && chrome still present
  // MIN_TABLE_WIDTH is 61 (index.mjs:1099), so 45 exercises the compact set.

test("the frame does not repaint by full-clear in steady state")
  fullClears <= 2
  // Two are the alt-screen enter itself. More means the overflow-repaint path.
```

### The #41 assertion — expected to fail in this phase

```
test("nothing is written to the primary buffer after the alternate screen is left")
  // Measured today: 1,417 bytes of dashboard land on the primary buffer after
  // restore, preceded by \x1b[3J, which erases the user's scrollback. The app's
  // exit listener restores the primary buffer first (index.mjs:1618), and ink's
  // unmount then repaints there, taking the
  // `isUnmounting && previousOutputHeight >= viewportRows` branch of
  // shouldClearTerminalForFrame (ink/build/ink.js:89-112).
  //
  // This is the assertion the release-time pty check did not make: it checked
  // enter/exit balance, cursor restore and max width, all of which still pass.
  sigterm.afterRestore.hasScrollbackErase === false
  sigterm.afterRestore.hasClear === false
  sigterm.afterRestore.visible === ""
```

### Capture integrity

```
test("the fixture gh was actually invoked")
  fixtureCalls.length > 0
  // Guards the silent failure modes: a zero-byte BSD capture when stdin is a
  // socket, and a preflight exit(3) before anything renders.
```

## Success criteria

**Automated**

- `npm run test:pty` runs, and every test passes **except** the primary-buffer
  one, which fails with the measured byte count in its message.
- `npm test` (the unit suite) is unaffected and still green.
- `npm run lint` passes.

**Manual**

- Read the failure output of the primary-buffer test and confirm it names the
  actual bytes rather than only asserting a boolean — the message is what a
  future contributor will read when it regresses.

## Note for `/implement`

Ending a phase red is intentional here and is the project's own TDD rule
(`.claude/commands/remediate.md:162-167`: "Write a failing test FIRST that
captures the finding"). Do **not** weaken the assertion to make the phase green
(`remediate.md:386-387`: "Never weaken a test. If a test fails after merge, fix
the source code, not the test"). Phase 3 is the fix.
