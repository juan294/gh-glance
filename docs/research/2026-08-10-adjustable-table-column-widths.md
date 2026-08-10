# Research: adjustable table column widths

> 2026-08-10 | Branch `develop` @ `900dd4255f66d4c1b5d0592adaadeed061f71f2e`
> Four Explore roles: locator, analyzer, pattern-finder, historian.
> Documentarian pass — this describes the current implementation and the
> available interaction surfaces; it does not select an implementation.

## Scope

The supplied screenshot shows the full Actions table and asks whether its
columns can be resized to taste, preferably by dragging with the mouse and with
keyboard control as an acceptable alternative. This document traces the current
layout, the keyboard and pointer surfaces available in the installed stack, the
state and persistence shapes already used by the application, and the existing
verification seams.

The repository already names “Configurable columns / widths” as a contribution
area (`CONTRIBUTING.md:12-17`). No configurable-width behavior exists in the
current application state, CLI, or documented keybindings
(`index.mjs:2462-2497`, `index.mjs:1487-1565`, `README.md:222-241`).

## Summary answer

Both live keyboard resizing and mouse dragging are technically reachable from
the current codebase. Keyboard resizing can use the existing Ink `useInput`
path and PTY input harness (`index.mjs:2666-2712`,
`test/pty/capture.mjs:114-153`). Pointer dragging is not a built-in Ink feature:
the installed Ink export surface has keyboard, stdin, focus, and measurement
APIs but no mouse hook or mouse event type
(`node_modules/ink/build/index.d.ts:20-43`,
`node_modules/ink/build/hooks/use-input.d.ts:1-100`).

There are therefore four observable implementation routes:

| Route | Existing surface it meets | Additional surface |
|---|---|---|
| Keyboard resize mode | The single `useInput` handler and canonical key table | Width-selection state and key-mode routing |
| Direct mouse protocol | Ink's complete CSI input tokenization and element measurement | Mouse reporting lifecycle, SGR event decoding, drag state |
| Ink mouse adapter | Ink Box refs and layout tree | One runtime package providing mouse mode, hit testing, and drag hooks |
| Startup configuration | Existing flags/environment configuration model | Width arguments, environment values, or a config file |

All four routes converge on the same layout seam: runtime widths have to feed
both the header descriptors and the row cells, and the width guard has to see
the resolved descriptors (`index.mjs:1843-1867`, `index.mjs:1988-2029`,
`index.mjs:2217-2238`).

## 1. Current Actions geometry

`Column` is a `Box` with either a numeric `width` or, when `grow` is true,
`flexGrow: 1` and `flexShrink: 1`. Every cell adds a one-column right margin and
its text truncates at the end unless a caller chooses another wrap mode
(`index.mjs:1843-1852`). `HeaderCells` sends the header descriptor props through
that same primitive (`index.mjs:1855-1867`).

The screenshot corresponds to these full Actions descriptors
(`index.mjs:1988-1995`):

| Column | Current width model |
|---|---:|
| status/cursor | 3 |
| title | grows and shrinks |
| workflow | 10 |
| branch | 14 |
| time | 7 |
| updated | 8 |

The row renderer repeats those values rather than reading them from the header:
the icon, workflow, branch, time, and updated widths are restated in
`ActionsRow`, while title is restated as the growing cell
(`index.mjs:2005-2029`). Issues, Pull Requests, and Security use the same
header-plus-row duplication pattern (`index.mjs:2034-2060`,
`index.mjs:2065-2108`, `index.mjs:2118-2159`).

The current behavior makes title the residual column. Fixed cells do not shrink;
title receives whatever remains after their widths, their margins, the panel
borders, and panel padding are accounted for (`index.mjs:1843-1847`,
`index.mjs:3076-3102`). Workflow truncates at the end with the run number placed
first, while branch uses middle truncation (`index.mjs:2023-2028`).

The compact Actions layout retains only the 3-wide status cell, growing title,
and 8-wide updated cell (`index.mjs:1997-2016`). The active tab selects its full
or compact descriptor set at render time, and the row receives only a `compact`
boolean rather than the selected widths (`index.mjs:3053-3066`,
`index.mjs:3151-3169`).

## 2. Width safety and terminal resizing

`minimumWidthFor()` derives the safe table floor from the header descriptors. It
sums every numeric width plus every cell's one-column margin, then adds eight
columns for the frame, horizontal padding, and a four-column minimum for the
growing cell (`index.mjs:2217-2228`). The global full and compact floors are
computed from all tab descriptors (`index.mjs:2235-2238`).

With the current descriptors, Actions needs 56 frame columns for its full set.
The application renders one column less than the terminal reports, selects the
compact set per active tab, and replaces all tables with `too narrow` below the
global compact floor (`index.mjs:3027-3033`, `index.mjs:3053-3074`). The
published thresholds are Actions 56, Issues 50, Pull Requests 61, Security 44,
with `too narrow` below 24 (`README.md:409-415`).

Terminal-pane resizing already updates the UI live. `useTerminalSize()` reads
`stdout.rows` and `stdout.columns`, applies the existing 80x30 fallback for
zero/undefined dimensions, subscribes to `stdout`'s `resize` event, and applies
hysteresis to the tab-label breakpoint (`index.mjs:495-503`,
`index.mjs:2419-2457`). The accepted terminal-lifecycle decision keeps this
wrapper because Ink's `useWindowSize` does not supply that fallback
(`docs/decisions/0002-own-the-terminal-lifecycle.md:41-44`,
`docs/decisions/0002-own-the-terminal-lifecycle.md:67-73`).

Runtime changes to a numeric column width would change the table's safe full-set
floor if the resolved descriptor continues to be the input to
`minimumWidthFor()`. The existing unit contract already verifies that a wider
descriptor raises the guard and pins it above the previously measured
52-column silent-title-collapse band (`test/unit.test.mjs:709-720`).

## 3. Keyboard interaction surfaces

The application has one input router. It currently assigns Up/Down and `j`/`k`
to row movement, Page keys to paging, Left/Right and Tab/Shift+Tab to tab
switching, Enter to opening or accepting a prompt, `r` to refresh, `?` to help,
and `q`/Escape to exit (`index.mjs:2666-2705`). The same binding inventory is
the canonical source for `--help` and the in-app help overlay
(`index.mjs:1572-1588`).

A keyboard resize mode can be represented by the interaction-state pattern
already used for row navigation: per-tab React state, a ref that exposes the
current value to the stable `useInput` closure, and functional state updates
(`index.mjs:2491-2497`, `index.mjs:2573-2585`, `index.mjs:2594-2625`). Within
such a mode, one key axis can select a divider and the other can change its
width; outside it, the current row and tab bindings remain the active meanings.
The mode gate is the distinction because every arrow key and Tab already has a
binding (`index.mjs:2666-2712`).

Ink also ships `useFocus` and `useFocusManager`. They make rendered components
focusable, move focus with Tab/Shift+Tab, and expose programmatic focus and an
active ID (`node_modules/ink/build/hooks/use-focus.d.ts:1-29`,
`node_modules/ink/build/hooks/use-focus-manager.d.ts:1-42`). gh-glance does not
currently import those hooks, and its own handler already consumes Tab and
Shift+Tab for tab switching (`index.mjs:1736-1741`, `index.mjs:2697-2704`).

Keyboard input is available only when Ink reports raw-mode support. The app
coerces that flag to `interactive`, activates `useInput` with it, and shows only
the Ctrl+C quit hint when stdin is non-interactive (`index.mjs:2462-2465`,
`index.mjs:2571-2577`, `index.mjs:2706-2712`, `index.mjs:2359-2373`). That is the
same availability boundary a resize key mode would inherit.

## 4. Mouse interaction surfaces

### 4.1 Core Ink does not decode mouse events

The project installs Ink 7.1.1 and React 19.2.8 as its only runtime dependencies
(`package.json:47-50`, `package-lock.json:1253-1291`). Ink's `Box` props contain
layout, border, and accessibility properties, but no click, pointer, or drag
handlers (`node_modules/ink/build/components/Box.d.ts:5-32`,
`node_modules/ink/build/components/Box.d.ts:36-100`). `useInput` builds a
keyboard-only key object and gives the application `(input, key)`
(`node_modules/ink/build/hooks/use-input.js:27-64`,
`node_modules/ink/build/hooks/use-input.js:103-123`).

Ink does preserve complete CSI sequences across split stdin chunks before
dispatch. Its input parser recognizes CSI parameter/intermediate/final bytes,
holds an incomplete escape sequence as pending, and emits the completed
sequence as one event (`node_modules/ink/build/input-parser.js:4-37`,
`node_modules/ink/build/input-parser.js:125-173`). An unrecognized SGR mouse
report therefore reaches `useInput` as string input; Ink does not translate it
into mouse fields (`node_modules/ink/build/parse-keypress.js:366-412`,
`node_modules/ink/build/hooks/use-input.js:39-99`).

### 4.2 Direct xterm-compatible reporting

At the terminal protocol layer, xterm button-event mode 1002 sends movement while
a button is held and SGR mode 1006 encodes the button plus terminal-cell
coordinates in a semicolon-separated CSI report. These are xterm extensions,
not part of core Ink ([xterm Mouse Tracking specification](https://invisible-island.net/xterm/ctlseqs/ctlseqs.html)).
The application currently emits only alternate-screen enter/clear/home on
startup and cursor-show/alternate-screen-exit on cleanup; it has no mouse-mode
enable, disable, or parser (`index.mjs:3218-3237`).

The installed Ink geometry APIs cover the other half of hit testing.
`measureElement()` returns a Box's live-layout x, y, width, and height after
layout, and its own documentation explicitly discusses converting those values
before comparing them with mouse-event viewport coordinates
(`node_modules/ink/build/measure-element.d.ts:1-29`). `useBoxMetrics()` provides
parent-relative width, height, left, and top that update with layout
(`node_modules/ink/build/hooks/use-box-metrics.d.ts:1-38`). Neither is currently
imported by gh-glance (`index.mjs:1736-1741`).

The header's vertical position is not a permanent constant: the help overlay,
an active tab error, Security notes, and missing-remote setup replace or add
rows before the normal header branch (`index.mjs:2527-2536`,
`index.mjs:3115-3152`). Coordinate-aware dragging can therefore use the live Box
measurement surface instead of assuming the header is always on one terminal
row (`node_modules/ink/build/measure-element.d.ts:20-28`).

### 4.3 Mouse adapter package

A registry scan on 2026-08-10 found `@ink-tools/ink-mouse` 2.1.0. Its published
surface advertises a `MouseProvider`, press/release/move hooks, `useOnDrag`, Box
hit testing, and SGR/legacy mouse events
([package source and peer metadata](https://raw.githubusercontent.com/neiromaster/ink-tools/main/packages/ink-mouse/package.json),
[package README](https://github.com/neiromaster/ink-tools/tree/main/packages/ink-mouse)).
Its package metadata declares Ink `>=6`, React `>=17`, and Node `>=20`, which
includes the versions declared by gh-glance (`package.json:44-50`). This route
adds a runtime dependency to the current two-package runtime surface
(`package.json:47-50`).

The adapter and the direct-protocol route expose the same application-level
event: press on a measured divider, movement with the button held, and release.
They differ at the terminal boundary—one delegates mouse mode, parsing, and hit
testing to a package; the other uses Ink's existing CSI string and measurement
surfaces directly (`node_modules/ink/build/input-parser.js:125-173`,
`node_modules/ink/build/measure-element.d.ts:20-29`).

## 5. Width-state models exposed by the current layout

The present layout supports three distinct meanings for a drag or key adjustment:

1. **Residual-title sizing.** Change one numeric fixed column; the growing title
   automatically gains or loses the corresponding space because it is the only
   flexible cell (`index.mjs:1843-1847`, `index.mjs:1988-1995`).
2. **Adjacent-divider sizing.** Give space to the cell on one side of a divider
   and remove it from the cell on the other. This requires both cells to have
   resolved numeric values; title is currently represented as `grow`, not a
   number (`index.mjs:1988-1995`).
3. **Independent preferred widths.** Store preferred numeric widths and let the
   existing full/compact guard choose which descriptor set fits the current
   terminal (`index.mjs:2217-2238`, `index.mjs:3053-3074`).

The current descriptors also expose three scope choices. Widths can be per tab,
shared only for semantically matching columns such as UPDATED, or one global
layout profile. The tab registry currently owns separate header arrays and row
components, and the existing selection/scroll state is keyed per tab
(`index.mjs:2174-2215`, `index.mjs:2491-2497`).

Compact-mode behavior is a separate state dimension. Each tab owns a distinct
compact descriptor with fewer columns, and compact Actions repeats a separate
row branch (`index.mjs:1997-2016`, `index.mjs:2034-2046`,
`index.mjs:2065-2078`, `index.mjs:2118-2132`). A preferred full-layout width can
remain stored while the narrow pane temporarily renders compact, or compact and
full descriptors can carry independent preferences; neither persistence model
exists today (`index.mjs:2462-2497`).

## 6. Session and persistence surfaces

Session-only widths match the current selection and offset lifecycle: React
state exists for the process and is initialized fresh on startup
(`index.mjs:2462-2497`). A startup-only configuration matches the current CLI
and environment model: the parser recognizes a closed set of flags and the
README documents configuration through flags and environment variables
(`index.mjs:1487-1565`, `README.md:259-288`).

Durable “to taste” preferences would introduce a different storage path. The
application imports `readFileSync` only, uses it to read `package.json` for the
version, and imports no filesystem write API (`index.mjs:25-28`,
`index.mjs:1570`). The current npm package ships `index.mjs` and documentation,
with no default config file (`package.json:6-14`).

## 7. Existing verification seams

The unit suite already has the pure width contract: wider fixed descriptors must
raise `minimumWidthFor()`, and the global floor must stay outside the measured
failure band (`test/unit.test.mjs:709-720`). Dynamic resolved descriptors and
per-column minimums can be exercised at that same pure boundary.

The PTY harness accepts terminal columns, rows, and an arbitrary timed stdin
script, and foreground mode keeps stdin interactive
(`test/pty/capture.mjs:114-153`, `test/pty/run.sh:11-16`,
`test/pty/run.sh:64-102`). Existing keyboard tests send literal bytes and assert
the final frame after settling; selection tests deliberately separate key writes
because a combined write is one Ink input event (`test/pty/keys.test.mjs:24-39`,
`test/pty/selection.test.mjs:19-29`).

The structural PTY suite already covers the two relevant layouts—80-column full
and 45-column compact—and asserts frame height, maximum line width, retained
chrome, and bounded full-screen clears (`test/pty/e2e.test.mjs:22-25`,
`test/pty/e2e.test.mjs:125-176`). The project's stated assertion rule is
structure rather than cell text (`CONTRIBUTING.md:51-69`).

Because the harness can send arbitrary stdin bytes, it can deliver an SGR mouse
press/move/release sequence just as it currently delivers keyboard bytes
(`test/pty/capture.mjs:114-145`, `test/pty/run.sh:83-102`). Its capture already
counts alternate-screen and cursor lifecycle escapes and isolates content left
after restoration, which is the existing terminal-cleanup surface
(`test/pty/capture.mjs:77-109`).

## 8. Option comparison

| Option | Input availability | Geometry source | Persistence shape | Existing automated seam |
|---|---|---|---|---|
| Keyboard resize mode | Any interactive raw-mode stdin | Active descriptor/boundary state | Session, flag/env, or new file path | Existing timed-key PTY harness |
| Direct mouse drag | xterm-compatible mouse reporting | `measureElement` / resolved widths | Same width state as keyboard | Arbitrary-byte PTY input plus lifecycle capture |
| Mouse adapter | Package-supported terminal reporting | Adapter Box refs/hit testing | Same width state as keyboard | Package unit surface plus app PTY harness |
| Startup-only widths | No live input required | Parsed numeric preferences | Flag/env or new file path | Argument/unit tests and structural PTY runs |
| Mouse and keyboard together | Pointer where available, raw-mode keys as the other input path | One resolved-width model | One shared preference model | Both PTY input forms against the same geometry assertions |

## 9. Historical context

The fixed-plus-growing model dates to the initial commit, `28863cc` (`feat:
initial commit of gh-glance`), which also added the invitation for configurable
widths that remains in `CONTRIBUTING.md:12-17`. Commit `6d42728` (`fix: harden
the data boundary, failure paths and layout before launch`) introduced derived
minimum widths and compact descriptors after the narrow-pane failure recorded in
the changelog (`CHANGELOG.md:520-524`).

Commit `7ae8530` (`refactor: registry-driven fetchers, named colours, extracted
size hook (#36)`) extracted the current terminal-size listener and recorded the
accepted lifecycle decision (`docs/decisions/0002-own-the-terminal-lifecycle.md:21-27`,
`docs/decisions/0002-own-the-terminal-lifecycle.md:41-44`). Commits `8235ff1`
and `9099fe2` added the structural PTY and timed-key layers now available for
width interaction coverage (`CONTRIBUTING.md:51-69`).

Later interaction and density work retained the same geometry. Commit `ee31bfd`
added row selection while keeping its marker inside the existing 3-wide icon
cell (`test/pty/selection.test.mjs:82-89`); commit `fec2801` made the compact
threshold per-tab and added the sub-24-column guard (`CHANGELOG.md:209-217`);
commit `ba6db4d` reserved the trailing terminal cell still used by `frameCols`
(`index.mjs:3027-3033`).

A column change also has a documentation artifact: the README sample is a real
capture and the contribution guide requires regenerating it when a column,
limit, or status bar changes (`CONTRIBUTING.md:145-153`).

## 10. Decisions left for planning

1. Are widths session-only, or should they survive process restarts?
2. Are preferences per tab, shared by semantic column name, or one whole-table
   profile?
3. Does moving a divider resize the fixed column against the residual title, or
   preserve the combined width of the two adjacent columns?
4. Are the status/cursor cell and compact layouts adjustable, or only the named
   full-layout data columns?
5. Which keyboard mode owns arrows while resizing, given their existing row and
   tab meanings?
6. Does pointer input use the existing CSI/measurement surfaces directly or a
   runtime mouse adapter?
7. What per-column minimums preserve meaningful labels and values while keeping
   `minimumWidthFor()` derived from the resolved descriptors?
