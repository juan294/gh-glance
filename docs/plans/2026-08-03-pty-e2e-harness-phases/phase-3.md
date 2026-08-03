# Phase 3 — Fix #41

Depends on: Phase 2. Turns its failing assertion green.

## Files

- `index.mjs` — the signal-handler block at `:1614-1627`
- `CHANGELOG.md` — an Unreleased entry

## The defect

`restoreScreen` is registered on `exit` (`index.mjs:1618`). signal-exit runs the
app's own `exit` listeners **before** its own emitter
(`signal-exit/index.js:185-201`), so on any external signal the order is:

1. `restoreScreen()` → `\x1b[?25h\x1b[?1049l` → back on the **primary** buffer
2. ink's `unmount` → final repaint, **onto the primary buffer**

Because the root Box is `height: rows` (`index.mjs:1507`) the frame always
exactly fills the viewport, so that repaint takes the
`isUnmounting && previousOutputHeight >= viewportRows` branch of
`shouldClearTerminalForFrame` (`ink/build/ink.js:89-112`) and is preceded by
`\x1b[2J\x1b[3J\x1b[H` — where `\x1b[3J` erases scrollback.

`q` / `Esc` / raw-mode `Ctrl+C` are unaffected: there ink's `handleExit`
(`ink/build/components/App.js:141-147`) unmounts first and `restoreScreen` runs
afterwards, so the final paint lands inside the alternate screen and is
discarded with it.

## Change

Capture the render instance and unmount ink **before** restoring, so the signal
path matches the clean-quit ordering.

```
- process.on("SIGINT",  () => process.exit(130));
- process.on("SIGTERM", () => process.exit(143));
- process.on("SIGHUP",  () => process.exit(129));
-
- render(e(App));
+ const app = render(e(App));
+
+ // signal-exit runs our `exit` listener before ink's unmount, so restoring the
+ // primary buffer there means ink's final repaint -- which always takes the
+ // full-clear branch, because the frame exactly fills the viewport -- lands on
+ // the primary buffer and erases the user's scrollback with \x1b[3J.
+ // Unmounting first puts that repaint inside the alternate screen, where
+ // restoreScreen then discards it. This is the same ordering the q/Esc path
+ // already gets through ink's own handleExit.
+ const bySignal = (code) => () => {
+   try {
+     app.unmount();
+   } catch {
+     // Teardown is best effort; restoreScreen below and the `exit` listener
+     // both still run, so the terminal is restored either way.
+   }
+   restoreScreen();
+   process.exit(code);
+ };
+ process.on("SIGINT",  bySignal(130));
+ process.on("SIGTERM", bySignal(143));
+ process.on("SIGHUP",  bySignal(129));
```

`unmount()`'s final `calculateLayout()` + `onRender()` are synchronous
(`ink/build/ink.js:511-514`), so the repaint completes before `restoreScreen()`
runs. `process.exit(code)` immediately after preserves the immediate-exit
guarantee — the process does not wait for the event loop to drain, which
`AR-L3` in `pre-launch-report.md:1129-1139` records as the reason not to switch
to an awaited unmount: a hung `gh` would otherwise turn Ctrl+C into an apparent
hang.

## Measured, in a spike of exactly this change

| | before | after |
|---|---|---|
| bytes on primary after restore | 1,417 | **6** |
| contains `\x1b[2J` | yes | **no** |
| contains `\x1b[3J` (erase scrollback) | yes | **no** |
| dashboard frame on primary | yes | **no** |
| SIGTERM / SIGINT / SIGHUP exit codes | 143 / 130 / 129 | **143 / 130 / 129** |

## Invariants this must not break

- `restoreScreen` stays idempotent and stays registered on `exit`
  (`index.mjs:1591-1596`, `:1618`) — it is the **only** cover for the
  uncaught-exception path.
- The crash handlers keep restoring **before** writing
  (`index.mjs:1603-1612`), so a stack trace still lands on the primary buffer
  where it can be read. Do not reorder them to match the signal path.
- Exit codes stay 130 / 143 / 129 — documented in `CHANGELOG.md:71-74` and now
  asserted by Phase 2.
- `--help` / `--version` keep exiting 0 and the non-TTY guard keeps exiting 1;
  both are asserted by the smoke job (`ci.yml:85-98`).
- `app.unmount()` is wrapped because ink's teardown writes are only guarded
  internally (`ink/build/ink.js:717-723`) and the app's own `restoreScreen`
  write is not (`index.mjs:1595`); a throw must not skip the restore.

## Success criteria

**Automated**

- The Phase 2 primary-buffer test passes. Every other pty test still passes.
- `npm test`, `npm run lint`, `node --check index.mjs` all pass.
- Exit codes verified 143 / 130 / 129 by the harness.

**Manual**

- In a real terminal with visible scrollback: run `gh-glance`, `kill -TERM` it
  from another pane, and confirm the scrollback survives and no dead dashboard
  frame is left behind. The automated check reads bytes; this is the behaviour
  a user actually experiences.
- Confirm a crash still prints a readable stack trace, by temporarily forcing a
  throw. The crash path shares `restoreScreen` with this change.
