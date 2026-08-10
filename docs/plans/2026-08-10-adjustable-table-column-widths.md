# Plan: adjustable table column widths

> 2026-08-10 | Branch `develop` @ `900dd425`
> Research: [`docs/research/2026-08-10-adjustable-table-column-widths.md`](../research/2026-08-10-adjustable-table-column-widths.md)

## Goal

Let a user resize the named data columns in every full table with either a
mouse drag or a keyboard-only width mode, then restore those choices on the
next `gh-glance` run.

The change must preserve the current one-file/no-build architecture, compact
layouts, row memoization, width-derived overflow guard, incremental rendering,
and terminal cleanup guarantees. A malformed or unwritable preferences file
must never prevent the dashboard from starting or the current session from
resizing columns.

## Chosen design

| Decision | Choice | Reason |
|---|---|---|
| Pointer input | Direct xterm SGR 1002 + 1006 handling | Ink 7 has no mouse API. The inspected adapter enables noisier all-motion reporting and independently owns stdin/raw-mode cleanup, which overlaps gh-glance's carefully centralized terminal lifecycle. |
| Keyboard input | Modal `w` width mode | Every arrow and Tab already has a normal meaning. A visible mode makes the temporary meanings explicit and leaves existing navigation unchanged outside it. |
| Width ownership | Per tab and per stable column key | The four schemas differ. A shared `UPDATED` setting would unexpectedly couple unrelated tables. |
| Resize semantics | One fixed column resizes against the flexible TITLE/SUMMARY cell | This extends the current fixed-plus-grow layout without converting the flexible cell into a stored numeric width or moving unrelated fixed columns. |
| Adjustable scope | Named fixed-width cells in full layouts only | Status/cursor, Security severity, TITLE/SUMMARY, and every compact descriptor remain locked. Compact mode stays a safety layout rather than a second preference profile. |
| Persistence | Automatic, global per user, per tab | The user confirmed that preferences surviving restarts is essential. Store only deviations from defaults in a small versioned file. |
| Dependency/toolchain posture | No new dependency, module, build step, TypeScript, or test framework | The protocol, geometry, filesystem, and Node test seams already exist in the installed runtime. |

### Alternatives rejected

- **`@ink-tools/ink-mouse`:** compatible by peer versions, but its transitive
  implementation enables modes 1000/1002/1003/1006, changes stdin encoding/raw
  ownership, pauses stdin during teardown, and loses a narrow divider drag when
  hit-testing leaves the registered element. Direct 1002/1006 handling is
  smaller and fits the existing single input router.
- **Flags or environment-only widths:** useful for startup configuration but do
  not satisfy direct manipulation or automatic restart persistence.
- **Adjacent-column exchange:** requires making the flexible title cell numeric
  or maintaining several coupled widths. The current layout already has one
  intentional residual cell.
- **Adjustable compact layouts:** creates a second schema and persistence
  profile for a layout whose purpose is preventing overflow in narrow panes.

## User-visible contract

### Mouse

- Interactive sessions enable xterm button-event reporting (`?1002h`) and SGR
  coordinates (`?1006h`). No all-motion/hover mode is enabled.
- A subtle `│` grip occupies the header's existing one-cell gutter at each
  adjustable boundary. The grip adds no table width.
- Pressing the left button on a grip selects the column and enters width mode.
  Held horizontal movement changes the width by one terminal cell per cell
  crossed. Release ends the drag and commits the preference.
- Wheel, right/middle button, movement without a captured drag, and presses
  outside a live full-layout grip are ignored. Row clicking is out of scope.
- Terminal applications cannot reliably request a browser-style resize cursor.
  The cyan grip and contextual status line are the pointer feedback.
- Mouse reporting means ordinary terminal text selection may require the
  terminal's bypass modifier (commonly Shift); document this limitation.

### Keyboard

| Input | Width-mode behavior |
|---|---|
| `w` | Enter width mode; while active, leave it |
| `Tab` / `Shift+Tab` | Select next / previous adjustable column |
| `Left` / `Right` | Resize selected column by one cell |
| `Shift+Left` / `Shift+Right` | Resize by five cells |
| `r` | Reset the selected column to its default |
| `R` | Reset every width on the active tab |
| `Enter` / `Esc` | Commit and leave width mode |
| `q` / `Ctrl+C` | Quit globally, including from width mode |

Outside width mode, all existing navigation, opening, refresh, help, and quit
bindings retain their current meanings. The mode status replaces the ordinary
hint row with a bounded contextual line such as:

```text
Width: BRANCH 14  Tab select  <- -> resize  r reset  Esc done
```

Use ASCII arrows in this line so its cell width is deterministic.

## Canonical column model

Give every descriptor a stable `key`, and put all layout-affecting facts in the
descriptor read by both header and row:

```text
ColumnDescriptor = {
  key,
  label,
  props: {width? | grow?},
  adjustable: boolean,
  minWidth?: integer,
}

actions full:
  status(3 locked), title(grow locked), workflow(10 min 5),
  branch(14 min 6), time(7 min 5), updated(8 min 6)

issues full:
  status(3 locked), title(grow locked), author(12 min 6),
  label(14 min 6), updated(8 min 6)

prs full:
  status(3 locked), title(grow locked), author(12 min 6),
  branch(14 min 6), review(10 min 7), updated(8 min 6)

security full:
  status(3 locked), severity(4 locked), package(16 min 6),
  summary(grow locked), age(8 min 6)
```

Compact descriptors receive stable keys so rows can share lookup code, but
remain non-adjustable and use their current widths.

Replace row literals with a shared accessor:

```text
propsFor(resolvedColumns, key):
    descriptor = resolvedColumns.find(column.key == key)
    return descriptor.props

HeaderCells(cells = resolvedColumns)
Row(columns = resolvedColumns, compact = boolean)
```

The resolved array must be memoized per active tab/preferences tuple. Passing a
fresh array or props object on every clock tick would defeat the existing
`React.memo` rows (`index.mjs:2164-2172`). Header and row must receive the exact
same resolved descriptor set; no row keeps a private width literal.

## Preference model and safe fitting

The stored document is deliberately small and versioned:

```json
{
  "version": 1,
  "tabs": {
    "actions": { "branch": 18 },
    "issues": { "author": 9 }
  }
}
```

Only integer deviations from current defaults are written. Loading validates
the top-level version, known tab keys, adjustable column keys, safe integer
values, and each column minimum; unknown or invalid entries are ignored. An
unknown document version or malformed JSON yields empty preferences. Defaults
therefore remain source-controlled in the descriptors and automatically apply
to columns introduced in later versions.

Preferred widths and rendered widths are distinct:

```text
preferred = resolveHeader(defaultHeader, savedTabOverrides)

if minimumWidthFor(preferred) <= frameCols:
    effective = preferred
else if minimumWidthFor(defaultHeader) <= frameCols:
    effective = shrink only preferred widths above defaults toward defaults
                until minimumWidthFor(effective) <= frameCols
else:
    compact = true
```

This preserves narrow user choices, prevents an old oversized preference from
forcing compact mode where the stock full table fits, and never mutates the
saved preference merely because the pane was temporarily narrowed. Widening
the pane restores the preferred widths. The growing cell keeps at least the
existing four-cell budget through `minimumWidthFor()`.

For a live adjustment, clamp the proposed fixed width to:

```text
minimum = descriptor.minWidth
available = max(0, frameCols - minimumWidthFor(currentEffectiveHeader))
maximum = currentWidth + available
next = clamp(startWidth + direction * delta, minimum, maximum)
```

This prevents a drag/key press from making the currently visible full table
overflow or immediately switch to compact. A clamped no-op returns the existing
state object so idle redraw suppression remains effective.

## Durable storage

Resolve the preference file without a dependency:

```text
if XDG_CONFIG_HOME is a non-empty absolute path:
    <XDG_CONFIG_HOME>/gh-glance/preferences.json
else if platform == darwin:
    <homedir>/Library/Application Support/gh-glance/preferences.json
else:
    <homedir>/.config/gh-glance/preferences.json
```

Supported production platforms are macOS and Linux; no new Windows claim is
made. The XDG override is checked first on both platforms, which also gives the
test harness a portable isolation seam.

Writes are atomic and nonfatal:

```text
savePreferences(path, preferences):
    payload = serialize only deviations
    mkdir parent recursively with user-only requested mode
    write JSON + newline to unique temp file in same directory
    rename temp file over preferences.json
    on failure: best-effort unlink temp; return {ok:false,error}
```

App state changes immediately. A short trailing debounce coalesces held key or
drag motion; pointer release, leaving width mode, reset, React unmount, and
ordinary quit flush the latest state. Signal exit already unmounts before
restoring the screen, so the cleanup flush participates in that path. A crash
must still restore the terminal even if the preference write fails.

Surface one nonfatal `Widths not saved` indicator in the contextual width
status after a write error. A later successful write clears it. Do not add a
full error row or throw through Ink.

## Mouse protocol and geometry

Ink emits an unrecognized complete CSI token to `useInput` with the leading ESC
removed. Parse mouse input before testing `key.escape`:

```text
parseSgrMouse(input):
    match /^\[<(\d+);(\d+);(\d+)([Mm])$/
    reject malformed, unsafe, zero coordinates, wheel, modifiers, non-left
    x = encodedX - 1
    y = encodedY - 1
    action = final == "m" ? release : code has motion bit ? drag : press
    return {x, y, action}
```

Attach a ref to the live `HeaderCells` Box and use Ink's `measureElement()`.
Never assume a constant y-coordinate: errors, Security notes, help, setup, and
terminal height alter the rendered branch.

Each adjustable fixed column owns the edge that faces the flexible TITLE or
SUMMARY reservoir:

- fixed columns after the grow cell use their leading edge and
  `nextWidth = startWidth - pointerDelta`;
- fixed columns before the grow cell use their trailing edge and
  `nextWidth = startWidth + pointerDelta`.

Hit-test the measured header y and boundary x with a one-cell tolerance. Capture
`{tabKey,columnKey,startX,startWidth,direction}` on press, always derive motion
from that press snapshot, and clear it on release, tab/layout change, compact
transition, help/setup/error replacement, or unmount. SGR release is global, so
a release outside the header still ends the drag.

## Terminal lifecycle

Add idempotent helpers around module-level mouse state:

```text
enableMouseReporting(): write ?1002h + ?1006h once
disableMouseReporting(): write ?1002l + ?1006l once

restoreScreen():
    if already restored: return
    disableMouseReporting()
    show cursor
    leave alternate screen
```

An interactive App effect enables reporting and disables it on cleanup.
`restoreScreen()` remains the final backstop so clean quit, SIGINT/SIGTERM/
SIGHUP, a crash, and the remote-setup handoff all disable both modes before
`?1049l`. Never enable 1003 hover reporting.

## Phases

| # | Phase | Files | Depends on | Batch |
|---|---|---|---|---|
| 1 | Canonical width model and shared rendering | `index.mjs`, `test/unit.test.mjs` | — | Not eligible |
| 2 | Durable per-user preferences | `index.mjs`, `test/unit.test.mjs`, `test/preferences.test.mjs`, `test/pty/capture.mjs` | 1 | Not eligible |
| 3 | Keyboard width mode | `index.mjs`, `test/unit.test.mjs`, `test/pty/keys.test.mjs` | 1, 2 | Not eligible |
| 4 | Mouse drag and terminal lifecycle | `index.mjs`, `test/unit.test.mjs`, `test/pty/capture.mjs`, `test/pty/mouse.test.mjs` | 1-3 | Not eligible |
| 5 | Documentation, capture, and full validation | `README.md`, `CHANGELOG.md`, `CONTRIBUTING.md` if test guidance changes | 1-4 | Not eligible |

Progress:

- [x] Phase 1 — Canonical width model and shared rendering
- [x] Phase 2 — Durable per-user preferences
- [x] Phase 3 — Keyboard width mode
- [x] Phase 4 — Mouse drag and terminal lifecycle
- [x] Phase 5 — Documentation, capture, and full validation

All phases are sequential. They share `index.mjs` and the width contracts, and
each interaction phase consumes the state/persistence behavior established
before it. There is no safe `[batch-eligible]` phase.

Phase files:
`docs/plans/2026-08-10-adjustable-table-column-widths-phases/phase-N.md`.

## Success criteria

### Automated

- Default resolved headers are byte-for-byte equivalent to today's geometry.
- Header and row cells for every tab consume one resolved descriptor set.
- Preferences round-trip atomically, store deviations only, survive a second
  process, and ignore corrupt/unknown/unsafe input without changing defaults.
- Every proposed width clamps at its semantic minimum and current frame budget;
  TITLE/SUMMARY retains at least four cells.
- Oversized saved widths temporarily fit toward defaults when the default full
  table fits, without mutating the saved preference.
- Keyboard and SGR mouse input reach the same reducer; exact transitions are
  unit contracts and PTY tests assert routing, persistence, bounded geometry,
  clean exit, and terminal-mode balance.
- Mouse enable/disable pairs are balanced and both disables precede alternate-
  screen exit on clean, signal, and crash-capable cleanup paths.
- Run sequentially after every phase:

  ```bash
  npm run lint && npm test && node --check index.mjs && npm run test:pty
  ```

- Final documentation phase also runs:

  ```bash
  node index.mjs --help
  git diff --check
  ```

- Existing Ubuntu PTY CI passes in addition to local macOS PTY validation. No
  typecheck or new test framework is introduced.

### Manual

- Drag every adjustable Actions divider wider and narrower in a real terminal;
  the selected grip follows the pointer and no other fixed column moves.
- Repeat through width mode with single-cell, five-cell, selected reset, and
  active-tab reset controls.
- Give two tabs different widths, quit, restart, and confirm both return.
- Narrow into compact mode and widen again; compact remains unchanged and the
  preferred full widths return.
- Start with an intentionally oversized saved preference in an ordinary-width
  pane; the full table remains usable and widening restores the preference.
- Quit with `q`, SIGTERM, and SIGHUP; terminal selection works normally
  afterward, scrollback remains, and no dead frame is left on the primary
  buffer.
- Verify the terminal's mouse-selection bypass modifier documented in README.
- Regenerate the README's real sample capture because the header/status UI
  changes; do not hand-edit the sample.

## Out of scope

- Row clicking, sorting, reordering, hiding, or adding columns.
- More than one saved layout profile, repository-specific preferences, or
  syncing preferences between machines.
- Adjustable status/cursor, Security severity, TITLE/SUMMARY, or compact cells.
- Startup width flags/environment variables and an interactive config editor.
- A mouse-hover mode or browser-style pointer cursor.
- Windows support beyond the project's existing unverified posture.
