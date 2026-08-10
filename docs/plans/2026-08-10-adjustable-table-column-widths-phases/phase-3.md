# Phase 3 — Keyboard width mode

> Files: `index.mjs`, `test/unit.test.mjs`, `test/pty/keys.test.mjs`
> Depends on: phases 1 and 2. Blocks: phases 4 and 5.
> Not batch-eligible: phase 4 reuses its mode, selection, reducer, and status UI.

## Objective

Expose every adjustable full-layout column through a discoverable keyboard
mode, using the canonical width reducer and durable preference writer.

## Changes

### 1. Canonical keys (`index.mjs:1572-1588`)

Add a `w` binding to `KEY_TABLE`, so `--help` and the `?` overlay both document
width mode from the existing single source. Update the quit description to make
the modal Esc behavior honest without crowding the resting `KEY_HINTS`.

Do not add `w` to the already dense ordinary status bar. Width mode replaces
that bar contextually.

### 2. Width interaction state

Add per-App state/ref:

```text
widthMode = false
selectedWidthKeyByTab = {}
widthSaveError = null

resizeRef.current = {
  active, tabKey, selectedKey, effectiveHeader, frameCols, compact,
  fullHeaderVisible
}
```

Entering selects the tab's last-used adjustable key or first adjustable key.
Switching tabs by digit is disabled while the mode owns input; the user leaves
the mode first. If compact/help/setup/too-narrow/error state replaces the full
header, `w` is a no-op and no adjustable grip is selected.

### 3. Pure mode reducer

Use one reducer-like helper for keyboard and phase-4 pointer calls:

```text
updateWidthPreference({overrides, tab, key, nextWidth}):
    validate adjustable key and clamp through phase-1 model
    if nextWidth == default: delete deviation and empty tab object
    if no semantic change: return same overrides
    else return copied normalized overrides

resetWidthPreference(overrides, tabKey, key)
resetTabWidthPreferences(overrides, tabKey)
```

Each actual change updates state/ref and schedules phase 2's writer. Reset
flushes immediately.

### 4. Input precedence (`index.mjs:2666-2712`)

Mouse parsing is added in phase 4, but reserve its future first position. Route
keys in this order:

```text
if q or Ctrl+C path: flush, quit
else if widthMode:
    w / Enter / Esc -> flush and leave
    Tab / Shift+Tab -> cycle adjustable keys
    Left / Right -> delta -1 / +1
    Shift+Left / Shift+Right -> delta -5 / +5
    r -> reset selected + flush
    R -> reset active tab + flush
    otherwise consume/no-op
else:
    existing help, navigation, open, refresh, digits, and tab routing
```

Unlike ordinary mode, Esc leaves width mode. `q` remains unconditional quit.
Do not let a width key fall through and switch tabs, rows, open an item, or
refresh data.

### 5. Header selection and status

Give `HeaderCells` the selected adjustable key. Render a one-cell `│` grip in
the existing header gutter for adjustable columns, cyan/bold for the selected
key and dim border color otherwise. Locked/compact gutters preserve current
total geometry.

Add a width-mode branch to `StatusBar` with bounded ASCII content:

```text
Width: <LABEL> <N>  Tab select  <- -> resize  r reset  Esc done
```

At narrower widths progressively drop prose while retaining selected label,
width, arrows, reset, and done. Append/replace with `Widths not saved` after a
phase-2 write failure. Unit-test the hint selection helper rather than exact PTY
copy.

## Tests

### `test/unit.test.mjs`

- entering each tab selects its first adjustable key and remembers last used
  during the session;
- Tab and Shift+Tab wrap only over the chosen adjustable inventory;
- one/five-cell deltas call the same clamp and preference normalization;
- selected and tab reset remove only intended deviations;
- locked/compact/missing keys are no-ops preserving object identity;
- status variants fit their declared column budgets and contain ASCII-only
  control glyphs;
- grip rendering preserves descriptor width plus one existing gutter cell.

### `test/pty/keys.test.mjs`

Use separate timed writes, never a combined key string:

1. Create one caller-owned temporary XDG config home.
2. Start at 80 columns; send `w`, Right, Enter, `q`.
3. Assert exit 0, bounded frame, clean alternate-screen teardown, and a version
   1 file containing the expected first-column deviation.
4. Start a second process against the same config home; send `w`, Left, Enter,
   `q`.
5. Assert the deviation is removed. This distinguishes loading the first run
   from merely writing a fresh default-minus-one value.
6. Add a 45-column compact capture where `w` plus arrows writes no preference.

Exact width math belongs to unit tests; PTY owns real input routing,
persistence across processes, and terminal structure.

## Automated success criteria

Run sequentially:

```bash
npm run lint && npm test && node --check index.mjs && npm run test:pty
```

- Existing digit/tab/row/open/refresh/help behavior passes unchanged outside
  width mode.
- Width-mode PTY writes are separate and deterministic on BSD/GNU `script(1)`.
- No content-cell copy becomes a PTY assertion.

## Manual success criteria

- On each tab, enter with `w`, cycle every adjustable grip in both directions,
  resize by one and five, reset one, reset the tab, and leave with Enter/Esc/w.
- Confirm ordinary arrow, Tab, Enter, `r`, and Esc meanings return after exit.
- Quit with `q` while still in width mode; restart and confirm the last width was
  flushed.
- Force an unwritable test preference path and confirm the contextual warning
  appears while resizing without blocking the session.
