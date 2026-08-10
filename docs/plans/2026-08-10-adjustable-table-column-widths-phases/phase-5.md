# Phase 5 — Documentation, capture, and full validation

> Files: `README.md`, `CHANGELOG.md`, and `CONTRIBUTING.md` only if test/capture
> guidance needs correction
> Depends on: phases 1-4.
> Not batch-eligible: documentation and the real capture must describe the
> finalized interaction/lifecycle behavior from one verified candidate.

## Objective

Publish the real keyboard, mouse, persistence, compact-layout, storage, and
terminal-selection behavior; regenerate the sample from the implementation;
then run the complete sequential gate and manual terminal matrix.

## README changes

### Keybindings

Add `w` and the width-mode table:

- Tab/Shift+Tab select a column;
- arrows resize by one and Shift+arrows by five;
- `r` resets the selected column and `R` the active tab;
- Enter/Esc/w finishes; q remains quit.

Clarify that normal arrow/Tab/refresh meanings are unchanged outside the mode.

### Mouse resizing

Document:

- left-drag the visible full-header grips;
- no row clicking, hover behavior, or pointer-shape change;
- mouse support requires the same interactive terminal boundary as keys;
- terminal-native text selection may require its mouse-reporting bypass
  modifier, commonly Shift.

### Persistence and location

Document global per-user/per-tab persistence, deviation-only reset semantics,
and exact paths:

```text
$XDG_CONFIG_HOME/gh-glance/preferences.json       when absolute XDG is set
~/Library/Application Support/gh-glance/preferences.json  macOS fallback
~/.config/gh-glance/preferences.json              Linux fallback
```

State that the file is versioned, unknown/corrupt values fall back to defaults,
and a write failure does not stop the live session. Do not invite hand-editing
as the primary workflow; the UI owns it.

### Width/compact limitation

Replace hard-coded wording that implies full thresholds can never vary. Explain:

- compact descriptors remain fixed and non-adjustable;
- narrowed panes preserve full-layout preferences and restore them when widened;
- oversized preferences are temporarily fitted toward defaults when the stock
  full table fits;
- below the safe default/full floor the active tab uses compact, and below the
  compact floor it still shows `too narrow`.

Keep the current default thresholds as defaults, not universal customized
thresholds.

### Real sample capture

The visible header grips and width status change UI covered by
`CONTRIBUTING.md:145-153`. Regenerate the README sample from a real run using
the repository's established capture procedure; do not edit the block by hand.
Capture default widths, then separately describe adjustment rather than baking
personal preferences into the sample.

## CHANGELOG

Under `[Unreleased]`, add user-facing entries:

- **Added:** draggable full-table column grips and keyboard width mode.
- **Added:** automatic per-user/per-tab persistence with reset controls.
- **Fixed/Changed:** saved oversized widths fit safely in narrower panes and
  mouse reporting is restored on every terminal cleanup path.

Do not claim row clicking, compact customization, a resize cursor, Windows
support, or synchronization across machines.

## CONTRIBUTING

The wish-list item “Configurable columns / widths” is now implemented; update
or remove it. Update PTY guidance only if the new mouse sequence/lifecycle
assertions add a reusable rule not already captured by the structural-invariant
section. Preserve the no-build, Node test runner, sequential verification, and
real-capture rules.

## Automated validation

From one exact working-tree candidate, run sequentially:

```bash
npm run lint
npm test
node --check index.mjs
npm run test:pty
node index.mjs --help
git diff --check
```

Then inspect:

```bash
git diff --stat
git diff -- docs/plans docs/research
git status --short
```

The last commands verify planning/research artifacts remain separate from the
implementation diff and no unrelated user work is included. Do not invent a
typecheck. Ubuntu PTY CI must pass for the same candidate after local macOS PTY
validation.

## Manual validation matrix

### Width behavior

- All four tabs: drag every adjustable grip one cell and several cells in both
  directions.
- All four tabs: repeat with keyboard one/five-cell controls.
- Hit every minimum/maximum; movement clamps without overflow, wrapping, or
  repeated full clears.
- Reset selected and active tab independently.

### Persistence

- Save different values on two tabs, quit, restart, and verify both.
- Reset one selected column, restart, and verify other deviations remain.
- Reset a whole tab, restart, and verify only that tab returns to defaults.
- Test corrupt JSON and unwritable storage using a disposable XDG root; the app
  stays live and communicates the save failure.

### Responsive layout

- Resize from preferred full through temporary fitting, compact, too-narrow,
  and back; saved full values return without compact widths changing.
- Verify 80x24, 45x20, and a sub-24-column pane.
- Open help, trigger a fixture error/security note/setup view, and confirm
  hidden/stale grips cannot resize.

### Terminal lifecycle

- Exit with q, Esc outside width mode, Ctrl+C, SIGTERM, and SIGHUP.
- Confirm mouse selection returns, scrollback remains, cursor is visible, exit
  code is correct, and no primary-buffer dashboard tail remains.
- Confirm Shift (or the terminal's configured bypass) selects text while the
  app is running.

### Documentation proof

- Compare `node index.mjs --help`, the `?` overlay, README key table, and live
  status hints; bindings and modal precedence agree.
- Confirm documented paths match the executable path helper on macOS and Linux
  test cases.
- Confirm the README sample is a fresh default-layout capture and contains no
  private repository/account data.

## Completion gate

Phase 5 is complete only when automated gates and the manual matrix are recorded
for one candidate. Planning completion itself does not authorize implementation,
commit, push, PR, merge, release, or publication.
