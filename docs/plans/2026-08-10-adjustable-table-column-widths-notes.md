# Implementation notes -- `2026-08-10-adjustable-table-column-widths.md`

## Deviations

### Phase 5 -- interactive setup uses a readiness handshake

- **Plan said:** Phase 5 changes documentation only, then runs the complete
  local validation suite.
- **Found:** The new keyboard and mouse PTY files both exercise the interactive
  repository-setup handoff with timed foreground input. Node runs test files in
  parallel by default, so a fixed-delay producer can outrun the handoff and the
  child receives EOF without its confirmation. Serialization reduced the
  contention but still reproduced the EOF race once. Failed runs nevertheless
  spawned exactly one canonical-TTY `gh repo create` process with balanced
  terminal modes.
- **Chose:** Added an opt-in ready marker to the fixture `gh`, made the retained
  Phase 4 handoff producer wait for that marker and one 200 ms scheduling margin
  before sending confirmation,
  removed the keyboard-only duplicate acceptance capture, and replaced the
  production `unmount` plus `setImmediate` approximation with Ink's supported
  one-way `suspendTerminal()` handle followed by one immediate turn before
  unmounting, explicitly releasing the parent's stdin listeners, and spawning
  `gh`. The suspension is intentionally never resumed after the permanent
  handoff. The default parallel test runner remains unchanged.
- **Why:** The marker proves the canonical child reached its prompt boundary
  without retries or suite-wide serialization. `suspendTerminal()` releases
  raw-mode/parser state, the immediate turn lets the current input dispatch
  return, and the explicit parent stream cleanup prevents future reads from
  competing with the inherited child fd. Keeping the test producer open after
  confirmation proves the parent exits without waiting for stdin EOF.
  The Phase 4 assertion subsumes the earlier keyboard-only duplicate and
  additionally proves mouse-mode cleanup.

## Phase 5 validation record

### Automated local gate

- `npm run lint`, `npm test`, `node --check index.mjs`, `npm run test:pty`,
  `node index.mjs --help`, and `git diff --check` passed sequentially on the
  final working-tree candidate.
- Unit and real-filesystem tests: 139 passed. Parallel PTY tests: 37 passed.
- The fixture-backed README frame is 13 lines, at most 76 cells wide, and has
  SHA-256 `5744e5bacba2cfc2ef5554bc4d809e92bf86db5c19714c7d8277962c9c129ba9`
  without its trailing newline. Its privacy denylist is clean.

### Manual fixture-terminal matrix

- All 13 adjustable grips across Actions, Issues, Pull Requests, and Security
  completed one- and three-cell mouse drags in both directions. The same 13
  columns completed one- and five-cell keyboard moves, repeated minimum/maximum
  pressure, selected reset, and active-tab reset. Captures exited zero, stayed
  within 80x24 geometry, and ended with no saved deviations.
- Two tabs persisted distinct values (`actions.workflow = 11` and
  `issues.author = 17`) across processes. Selected reset preserved the other
  tab, and active-tab reset then removed the remaining deviation.
- Oversized saved widths rendered fitted full at 80x24, compact at 45x20, and
  `too narrow` at 23x16; the saved file remained byte-identical throughout.
- Stale mouse coordinates in help, shifted error, shifted Security-note, and
  setup views made no preference change. Corrupt JSON started normally. A
  file-as-config-root save failure kept the app live and showed
  `Widths not saved`.
- q, Esc, interactive Ctrl+C, SIGTERM, SIGINT, SIGHUP, crash, and remote child
  handoff all restored balanced mouse modes and the cursor with no dashboard
  tail on the primary buffer; exit codes matched their contracts.
- Direct GUI Shift-drag selection could not be exercised because Computer Use
  blocks terminal applications. The installed Ghostty configuration has no
  `mouse-shift-capture` override, and its local vendor documentation states that
  the default `false` keeps Shift for extending terminal selection. This is
  configuration evidence, not a direct gesture result.

### External gate

- Ubuntu GNU `script(1)` CI is pending because this implementation remains
  local and unpushed; no GitHub operation was authorized for this run.
