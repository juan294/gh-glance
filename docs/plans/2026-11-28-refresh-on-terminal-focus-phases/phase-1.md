# Phase 1 · Focus reporting lifecycle and input safety

Baseline, decisions and stuck states are in the [main plan](../2026-11-28-refresh-on-terminal-focus.md). This phase turns focus reporting on and makes the two focus tokens inert. After this phase, a focus event changes nothing. That is the property phase 2 builds on.

## Changes

1. **Lifecycle.** Extend `createTerminalLifecycle` (`index.mjs:23460-23495`) with `enableFocusReporting`, `disableFocusReporting` and `isFocusReportingEnabled`, following the mouse pattern exactly: idempotent, refused after `restoreScreen`, writing `ESC[?1004h` / `ESC[?1004l`. `restoreScreen` disables focus and mouse reporting before writing `ESC[?25h ESC[?1049l`. Add process-level wrappers beside `index.mjs:23499-23505`.
2. **Mount effect.** In `App`, add an effect beside the mouse effect (`index.mjs:20168-20178`) that enables focus reporting when `interactive` is true and disables it on cleanup. It does not depend on `widthMode`.
3. **Input.** In the `useInput` handler (`index.mjs:20453`), the very first branch consumes `input === "[I"` and `input === "[O"`: it calls `terminalFocusRef.current?.(input === "[I")` and returns. In this phase the ref is unset, so nothing happens. No later branch (CI range draft, Jev query, help, Escape, navigation) can see these tokens.

```
@ useInput(input, key) -> void (first branch only)
pre: Ink removed the leading Escape from an unrecognized CSI token
do:
  1. validate input is exactly "[I" or "[O"
  2. emit terminalFocusRef.current?(focused) (no-op until phase 2)
br: any other input -> existing branches unchanged
risk: an Escape split beyond Ink's pending window still arrives as Escape (same limit as SGR mouse)
```

## Tests (write first, see them fail)

- `test/unit.test.mjs`, beside `:2204`: focus enable/disable are idempotent and write the exact bytes. After `restoreScreen`, enable returns `false`. With both modes on, `restoreScreen` writes `?1004l` and the mouse disables before `?25h?1049l`. The existing mouse assertions keep their byte strings.
- `test/pty/capture.mjs`: add `focus1004Enter`/`focus1004Exit` counts and `focusDisableBeforeAltExit`, mirroring the mouse counters at `:415-440`.
- New `test/pty/terminal-focus.test.mjs`, using fixtures from `test/pty/adaptive-polling.test.mjs`:
  - TF-01: an interactive run writes `?1004h` once after `?1049h`, and `?1004l` before the final `?1049l`, on `q` exit and on `TERM`.
  - TF-02: `printf '\033[I\033[O'` on Actions, on Issues, with Help open (`?`), in width mode (`w`), and while the CI line-range draft is open. The frame, the selection and the open view are unchanged. The draft text does not gain `[`, `I` or `O`. The exit code is 0 and the process did not quit before the scripted `q`. (Reuse the existing entry keystrokes for each view from `test/pty/keys.test.mjs` and `test/pty/ci-details.test.mjs`.)
  - TF-03: a split delivery, `printf '\033'; sleep` shorter than Ink's pending window, then `printf '[I'`, does not quit and changes nothing. Model it on the split SGR report in `test/pty/mouse.test.mjs`. Read the window length from the installed Ink source and record it in the test comment.
  - TF-04: `--doctor` and `--help` output contain no `?1004h`.
  - TF-05: no focus input at all. Request counts equal those of the existing "default on-demand tabs stop after opening" case (`test/pty/adaptive-polling.test.mjs:345`). This is the no-op baseline for terminals without 1004.

## Automated acceptance

The new tests pass, then the full sequence in the main plan: lint, syntax, `npm test`, `npm run test:pty`. `npm run test:efficiency` is not required for this phase (no request behavior changes), but run it if any shared scheduling file is touched. Run the unit suite and `terminal-focus.test.mjs` on Node 22 as well as 24.

## Manual acceptance

None required. Optional: start the checkout in Rex, switch panes and confirm nothing visible happens.

## Completion

- [ ] Lifecycle functions and restore ordering, with unit tests
- [ ] Mount effect and first-branch consumption
- [ ] TF-01 to TF-05 green; full local gates green on the tested commit
- [ ] Independent review and simplify pass recorded in the phase handoff
