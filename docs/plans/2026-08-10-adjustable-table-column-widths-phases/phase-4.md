# Phase 4 — Mouse drag and terminal lifecycle

> Files: `index.mjs`, `test/unit.test.mjs`, `test/pty/capture.mjs`,
> `test/pty/mouse.test.mjs`
> Depends on: phases 1-3. Blocks: phase 5.
> Not batch-eligible: it shares the width state/UI and extends terminal cleanup
> that final validation must exercise as one candidate.

## Objective

Make the visible header grips draggable with the left mouse button through
direct SGR reports, while proving mouse reporting is disabled on every terminal
exit path before the alternate screen is released.

## Changes

### 1. Direct SGR parser

Add and export `parseSgrMouse(input)` near other pure input helpers. Ink removes
the leading ESC before `useInput`; accept the exact remaining form:

```text
^[<code;x;y[Mm]$
```

Validation:

- decimal code/x/y only; safe integers; x/y at least 1 before converting to
  zero-based coordinates;
- reject wheel (`code & 64`), modifier variants, right/middle buttons, and
  unsupported codes;
- final `m` means release; motion bit means drag; otherwise left press;
- return `null` for malformed/unsupported input.

Decode mouse before `key.escape` in the existing input router. A CSI report must
never accidentally trigger the quit branch.

### 2. Measured handle geometry

Import Ink's `measureElement` with the existing dynamic import and attach a ref
to `HeaderCells`' root Box.

Add pure helpers:

```text
dividerHandles({header, metrics}):
    return adjustable boundaries with x, y range, key, direction

hitDivider(handles, point, tolerance = 1):
    require point.y inside measured header
    choose nearest boundary within tolerance, deterministic on ties
```

The edge facing TITLE/SUMMARY is trailing for a fixed descriptor before grow
and leading for one after grow. Include each descriptor's current width and
one-cell gutter exactly once. Compact/non-adjustable descriptors yield no
handles.

### 3. Drag state and routing

Keep drag state in a ref because held motion can be frequent:

```text
on left press:
    require interactive, full visible header, measured hit
    enter width mode and select handle key
    dragRef = {tabKey,key,startX,startWidth,direction}

on drag:
    require matching live tab/full layout and active drag
    delta = event.x - startX
    proposed = startWidth + direction * delta
    call phase-3 preference reducer through phase-1 clamp

on release:
    dragRef = null
    flush preference writer
```

Always calculate from the press snapshot, not cumulative moves. A global
release clears drag even outside the header. Also clear drag on tab change,
compact transition, help/setup/error branch, and unmount.

Mouse press enters the existing width mode so the selected grip and contextual
keys remain available after release. Clicking elsewhere does not select rows or
leave the mode.

### 4. Idempotent terminal mouse lifecycle (`index.mjs:3218-3275`)

Add module state and helpers:

```text
enableMouseReporting():
    if enabled: return
    stdout.write(ESC[?1002h ESC[?1006h)
    enabled = true

disableMouseReporting():
    if not enabled: return
    stdout.write(ESC[?1002l ESC[?1006l)
    enabled = false

restoreScreen():
    if restored: return
    disableMouseReporting()
    restored = true
    stdout.write(showCursor + altExit)
```

An interactive App effect enables once and disables on cleanup. Keep the
restore backstop for q, remote setup, SIGINT/SIGTERM/SIGHUP, uncaught exception,
unhandled rejection, and ordinary process exit. Disable must precede `?1049l`.
Never emit 1000 or 1003.

### 5. Capture parser lifecycle evidence (`test/pty/capture.mjs`)

Extend escape stripping so SGR mouse reports do not count as visible frame
content. Count the four mode sequences and record their positions:

```text
mouse1002Enter, mouse1002Exit, mouse1006Enter, mouse1006Exit
mouseDisableBeforeAltExit
afterRestore.mouseReportingEnabled == false
```

Keep existing alternate-screen, cursor, clear, width, and primary-buffer
assertions. A parser change must not weaken those contracts.

### 6. Real mouse PTY test (`test/pty/mouse.test.mjs`)

Use the existing 80x24 Actions fixture and a caller-owned temporary XDG config
home. Derive the stable test grip coordinates from the pure geometry helper's
default header/known frame origin, and pin the live coordinate conversion with
one PTY run.

Send separate timed writes using POSIX `printf`:

```text
ESC[<0;x;yM        left press
ESC[<32;x+N;yM     held move
ESC[<0;x+N;ym      release
q
```

Add one case that splits a CSI report across two writes to pin Ink's pending
token parser. Assertions:

- expected width deviation appears in the isolated preferences file;
- frame height/width remain bounded and `fullClears <= 2`;
- exit is zero and primary-buffer tail is empty;
- 1002/1006 enable and disable counts each balance exactly once;
- both disables precede alternate-screen exit;
- compact/outside-grip/wheel/non-left input produces no preference change.

Unit tests own exact cell changes; PTY proves real protocol routing and cleanup.
Avoid modifying `test/pty/run.sh` unless the existing foreground mode cannot
deliver the required bytes.

## Unit tests (`test/unit.test.mjs`)

- parse press, held move, and release with 1-to-0 coordinate conversion;
- reject malformed, zero, unsafe, wheel, modifier, right/middle, and unrelated
  keyboard input;
- arbitrary header x/y metrics produce correct boundary positions on both
  sides of the grow cell;
- one-cell tolerance and nearest-boundary tie behavior are deterministic;
- shifted header y still hits correctly; compact/no-header yields none;
- move without press, press outside, tab/layout invalidation, and release
  cancellation are no-ops;
- drag width comes from press snapshot and applies direction correctly;
- lifecycle helpers are idempotent and sequence disable before alternate exit
  through injected write capture.

## Automated success criteria

Run sequentially:

```bash
npm run lint && npm test && node --check index.mjs && npm run test:pty
```

- Run PTY locally on macOS and require the existing Ubuntu PTY CI to prove both
  BSD and GNU `script(1)` paths.
- No adapter/runtime dependency appears in package files.
- Existing signal exit codes, scrollback, and no-dead-frame assertions remain
  green.

## Manual success criteria

- Drag each grip left/right, leave the header before release, then release; the
  captured column stops resizing and no drag remains stuck.
- Drag columns before and after the flexible cell and confirm the boundary
  follows the pointer in the correct direction.
- Exercise help, an error line, Security notes, compact mode, and tab switches;
  stale coordinates never resize another column.
- Quit normally and via SIGTERM/SIGHUP; shell text selection works afterward,
  scrollback remains, and no dashboard frame is left behind.
- Confirm the terminal's Shift (or configured) bypass still permits native text
  selection while gh-glance is running.
