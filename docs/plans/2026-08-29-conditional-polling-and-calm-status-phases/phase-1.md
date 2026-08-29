# Phase 1: stop the crash and unpin the frame height

> Parent: [`../2026-08-29-conditional-polling-and-calm-status.md`](../2026-08-29-conditional-polling-and-calm-status.md)
> Depends on: nothing
> Batch eligibility: no (single-file project; every phase overlaps `index.mjs`)

## Objective

Two independent defects that both make the terminal misbehave rather than
misinform. Neither changes copy, request behaviour, or state.

## Source changes

### 1. Hoist `persistenceWaitCell` above its first use

**Observed**, once, on clean `develop` @ `43993a0`:

```text
ReferenceError: Cannot access 'persistenceWaitCell' before initialization
    at waitForLock      (index.mjs:2049)
    at withGovernorLock (index.mjs:2093)
    at mutateGovernor   (index.mjs:2101)
    at releaseLease     (index.mjs:2533)
    at runDoctor        (index.mjs:3421)
```

Root cause, confirmed by reading: the cell is `const`-declared at
`index.mjs:4775` and used at `index.mjs:2049`. Module evaluation is suspended
before line 4775 by the top-level `await import("react")` at `index.mjs:3852`,
and the `if (IS_MAIN)` block opens at `index.mjs:3762` --- so `runDoctor`
(`index.mjs:3817`) runs entirely inside the cell's temporal dead zone.

`waitForLock` is only reached when the lock is contended, which is why it is
intermittent (it did not recur in six further runs on this machine). Worse than
a crash on its own: the `ReferenceError` is thrown *outside* the `try` at
`index.mjs:2081`, which wraps only `openSync`/`writeFileSync`. It therefore
escapes `withGovernorLock` entirely instead of returning the intended
`{ok: false, reason: "busy"}` --- the fail-closed contract is bypassed, not just
reported badly.

```text
move  const persistenceWaitCell = new Int32Array(new SharedArrayBuffer(4))
from  index.mjs:4775
to    above withGovernorLock's first use (before index.mjs:2030)

keep  the existing use at index.mjs:4797 (withPersistenceLock) pointing at the
      same single cell -- there must remain exactly one
```

### 2. Reserve the notice line unconditionally

`extraLines` (`index.mjs:6445-6448`) counts three conditional rows and
`bodyRows = rows - 8 - extraLines` (`index.mjs:6452`). When a notice appears,
`bodyRows` drops by one on the same frame the row list is still the previous
length; the frame overflows `rows`, the terminal scrolls, and the previous rows
strand above a freshly drawn header. That is the doubled `TITLE / WORKFLOW`
header in the reported screenshot. The code already names this failure mode at
`index.mjs:6444`: *"getting this wrong by one row is what makes ink repaint the
whole frame."*

```text
extraLines becomes a constant reservation for the notice row:

  NOTICE_ROWS = 1                      # always reserved, blank when silent
  extraLines = NOTICE_ROWS
             + (tab.key === "security" && !remoteSetup ? securityLines.length : 0)

render tree (index.mjs:8078-8092) collapses the two conditional Text nodes
into one always-present node:

  noticeLine =
      coordinationError ? coordinationNotice(...)
    : displayError      ? displayError
    :                     ""            # a blank row, not an absent row

  e(Text, { color: noticeTone, wrap: "truncate-end" }, noticeLine)
```

Consequences to carry deliberately:

- A pane shows one fewer data row at all times. That is the trade named in the
  parent plan: one row costs less than a full-screen repaint, and it makes the
  whole class of off-by-one height bugs unreachable.
- The coordination notice and the tab error can no longer occupy two rows at
  once. Precedence is coordination first --- a coordination pause means the tab
  error is downstream of it and stale.
- `securityLines` keeps its variable-height reservation. It is bounded, already
  collapsed above one line by `index.mjs:6436-6442`, and only appears on one
  tab; folding it in as well would cost two permanent rows on every tab.

## Behaviour to match

Executable, not prose:

- `test/pty/e2e.test.mjs:170` (`"the frame does not repaint by full clear in
  steady state"`, asserts `fullClears <= 2`) must hold **while a notice appears
  and disappears mid-capture**. Today that transition is untested; Phase 1 adds
  a capture that toggles a coordination notice and asserts the same bound.
- Every existing frame-geometry assertion --- `finalFrame.lines.length === rows - 1`
  in `test/pty/e2e.test.mjs:131`, `keys.test.mjs:63`, `mouse.test.mjs:121`,
  `selection.test.mjs:88`, `cache.test.mjs:101` --- must pass unmodified.

## Success criteria

### Automated

- A new unit test asserts `waitForLock` is reachable without a `ReferenceError`
  by invoking `withGovernorLock` against a pre-existing live lock file, in a
  context that mirrors the doctor path's module timing.
- A new PTY test toggles a coordination notice mid-capture and asserts
  `fullClears <= 2`, `maxStatusLines === 1`, and `finalFrame.lines.length === rows - 1`.
- All existing geometry assertions pass unmodified.
- Sequential verification passes:

  ```bash
  npm run lint; npm test; node --check index.mjs; npm run test:pty; git diff --check
  ```

### Manual

- With four panes running, `node index.mjs --doctor` completes 20 consecutive
  times with exit 0. (The crash needs lock contention, so an idle machine does
  not exercise it.)
- Watch a pane through a real coordination blip and confirm the table does not
  jump and no header is duplicated.

## Out of scope

Notice *wording* (Phase 3) and the status bar (Phase 2).

## Completion

- [x] The governor lock wait cell is initialized before every main-path use.
- [x] The notice row is permanently reserved and uses coordination-first
  precedence.
- [x] The doctor contention and notice appearance/disappearance regressions pass.
- [x] Lint, 268 unit/runtime tests, syntax, all 84 serialized PTY cases, and
  `git diff --check` pass. See the companion notes for the local PTY runner
  deviation.
