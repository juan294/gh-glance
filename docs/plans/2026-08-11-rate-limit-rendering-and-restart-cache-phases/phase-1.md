# Phase 1 — Give incremental rendering a physical guard row

Not batch-eligible. Edits the shared runtime and PTY geometry tests.

## Changes

### `index.mjs`

- Derive the root viewport height from the smaller of React's terminal-size
  state and the synchronous live `stdout.rows` read.
- Reserve one physical row below the Ink root, with a minimum one-row frame for
  degenerate terminal reports.
- Keep `frameCols = cols - 1`; the new vertical guard is its row analogue.
- Update the layout comment so it states that the root must stay below the
  physical viewport while incremental rendering is enabled.
- Keep the current body-row count unless executable geometry shows it no longer
  fits; the existing body formula already includes a one-line safety margin.

Pseudocode:

```text
liveRows = min(stateRows, usableSize(stdout.rows, stateRows))
frameRows = max(1, liveRows - 1)
render root with height=frameRows
```

### `test/pty/e2e.test.mjs` and shared PTY assertions

- Change supported-size geometry assertions from `frame lines == terminal rows`
  to `frame lines == terminal rows - 1`.
- Retain width, clear-count, alternate-buffer, and teardown assertions.
- Add an explicit assertion/message that the unused bottom row is the terminal
  scroll guard, so a future full-height refactor fails for the behavior it would
  reintroduce.

## Verification

- `npm run lint`
- `node --check index.mjs`
- `npm test`
- `node --test --test-timeout=120000 test/pty/e2e.test.mjs`
- `node --test --test-timeout=120000 test/pty/keys.test.mjs`

