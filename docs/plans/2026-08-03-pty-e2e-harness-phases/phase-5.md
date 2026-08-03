# Phase 5 — Interactive key coverage `[batch-eligible]`

Depends on: Phase 4. Touches only new files, so `/batch` can run this in
parallel with Phase 6.

## Files

- `test/pty/keys.test.mjs` (new)
- `test/pty/run.sh` gains an optional stdin-script argument (additive)

## Why this is a separate file

Every assertion here needs timed input, which is the only flakiness risk in the
plan. Isolating them means the structural job stays trustworthy: a key-timing
flake fails `keys.test.mjs` alone, and `e2e.test.mjs` — which carries the #41
regression guard — is unaffected.

## Feasibility, verified

`script` forwards its own stdin to the pty master, so piping reaches the child
as genuine tty input. Measured at 60x16 with a fixture `gh`:

```
( sleep 3; printf '2'; sleep 2; printf 'q'; sleep 2 ) | script -q OUT /bin/sh -c '…'
```

- full key hints rendered → stdin stayed an interactive tty
- `2` → the Issues tab became active
- `q` → clean exit 0, alternate screen left

This matters because backgrounding the process (`node index.mjs &`, what Phases
1-4 do) detaches stdin and makes `isRawModeSupported` falsy
(`ink/build/components/App.js:121`), so `useInput` is inert
(`index.mjs:1297`) and the status bar shows only `Quit: ^C`
(`index.mjs:1173-1175`). Key coverage therefore requires **not** backgrounding —
the app runs in the foreground and quits itself via `q`.

## Assertions

```
test("keys are advertised only when stdin is interactive")
  foreground run  -> status bar shows the full hints ("Tabs:", "Jump:", "Refresh:")
  backgrounded run -> shows only "Quit: ^C"
  // index.mjs:1169-1175. Asserting both directions is what makes this
  // meaningful; asserting only the first would pass on a broken gate.

test("a digit switches tabs")
  send "2" -> the Issues tab renders as active
  // Bracketed rather than inverse, so it survives NO_COLOR (index.mjs:1126).

test("q quits cleanly and leaves nothing on the primary buffer")
  send "q" -> exit code 0, altEnter === 1, altExit === 1,
              afterRestore.visible === ""
  // The clean-quit counterpart to Phase 2's SIGTERM assertion. Together they
  // are the A/B pair that distinguishes #41: this path was always clean, the
  // signal path was not.
```

`r` (manual refresh) is deliberately **not** asserted: proving it refetched
means reading the fixture log for a call count, which is timing-dependent on the
poll loop and would be the flakiest assertion in the suite for the least signal.

## Timing discipline

- Derive the settle delay from `REFRESH_MS` (`index.mjs:48`) rather than
  hard-coding seconds, so a change to the poll interval does not silently make
  the tests racy.
- Assert on the **final** frame after all input, never on an intermediate one —
  intermediate frames depend on when the poll tick landed relative to the
  keystroke.
- Give the whole file a generous `--test-timeout`; a hang here must fail as a
  timeout with a readable message rather than stalling the job.

## Success criteria

**Automated**

- `npm run test:pty` passes on darwin and on `ubuntu-latest`, both files.
- Ten consecutive local runs with no flake. Record the result; if it flakes,
  the correct response is to delete the offending assertion, not to add retries.

**Manual**

- Read one keys capture end to end and confirm the tab genuinely changed rather
  than the assertion matching something incidental in the frame.
