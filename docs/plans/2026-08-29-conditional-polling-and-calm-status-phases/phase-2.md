# Phase 2: rebuild the status bar's state region

> Parent: [`../2026-08-29-conditional-polling-and-calm-status.md`](../2026-08-29-conditional-polling-and-calm-status.md)
> Depends on: Phase 1
> Batch eligibility: no

## Objective

Make the bar keep its own promise: *"Reserved so the hints never shift when the
active tab changes state"* (`index.mjs:5892`). Stop calling the healthy steady
state `Waiting`, stop rendering a wall clock as a grant, and stop firing an
amber staleness warning because the throttle is working.

## Source changes

### 1. The state region absorbs detail and stale

Today `statusBarLayout` allocates in the order status cell, mandatory hints,
detail, stale, optional hints, version (`index.mjs:5995-6042`), and `StatusBar`
renders in that same order (`index.mjs:6219-6237`) --- which places the two
changing strings between `Quit: q` and `Move: ↑↓`.

The detail still outranks optional hints, but the state reservation cannot be
derived from the strings present in one render. That would move every hint when
`next 2m` becomes `next 12m`.

```text
derive one fixed wide-state cap from reachable content:

  REFRESH_STATUS_WIDTH = 12
  longest bounded warning = "stale 99h59m" = 12 cells
    # formatDuration receives at most 359_999_000 ms at index.mjs:7875
  separator = 1 cell
  WIDE_STATE_WIDTH = 12 + 1 + 12 = 25 cells

  stateWidth = drawableCols >= 44 ? min(drawableCols, WIDE_STATE_WIDTH)
                                  : min(drawableCols, REFRESH_STATUS_WIDTH)

  # StatusBar receives one fewer drawable column than the terminal width. At a
  # 45-column terminal, 25 state cells plus the existing full mandatory Refresh
  # and Quit hints fit in 44 drawable cells. Below 45 terminal columns, the
  # existing narrow contract wins: reserve only the 12-cell label and omit
  # detail/stale.

  # Detail is capped to the remaining 12-cell payload. Relative minute text is
  # bounded at `99m+`; a later `sharing N` detail must use the same cap. If a
  # stale warning and detail compete, stale wins and detail is omitted. The
  # warning is user-significant; the next grant remains available to the
  # scheduler and does not justify widening or moving the hints.

StatusBar renders:

  Box{ width: layout.stateWidth, flexShrink: 0 }
    Text{ statusColor, dimColor: tone==="inert" }  `${glyph} ${label}`
    Text{ dimColor }                               layout.detail
    Text{ color: ATTENTION }                       layout.stale
  ...mandatoryHints
  ...optionalHints
  Box{ flexGrow: 1 }
  Text{ dimColor }                                 layout.version
```

The glyph stays the first character of the line and the label stays adjacent to
it: `test/pty/capture.mjs:43`'s `STATUS_LINE` regex (`/^\S (?:Setup|Checking|
Paused|Failed|Limited|Watching)(?:\s|$)/`) is the foundation of every
status assertion in the PTY suite, and `test/pty/status.test.mjs:155, 194-197,
250-254` read `[...line][0]` as the animation glyph.

Moving the detail adjacent to the label **satisfies** the two order-sensitive
assertions rather than breaking them --- `test/pty/status.test.mjs:187`
(`/^· Watching.*next \d+m/`) and `test/pty/cache.test.mjs:124`
(`/‖ Paused.*reset \d\d:\d\d/`) both use `.*`, which currently spans the hints
and afterwards spans nothing.

### 2. `Watching` for scheduler holds; retire `Waiting`

`refreshStatus` (`index.mjs:5956`) maps every governor mode in
`waiting | pending | probe` to `Waiting`. With more than one pane that is the
normal condition, so the dashboard spends most of its life reporting that it is
blocked while it is merely between polls.

```text
in refreshStatus:

  paused or actionable resource/coordination hold -> "Paused"
  waiting | pending | probe                       -> "Watching"

There is no separate reachable `Waiting` state. Remove it from
`REFRESH_STATUS_GLYPHS`, the `STATUS_LINE` alternation, README, CHANGELOG, and
all semantic assertions. Do not keep a dead label in the vocabulary.
```

`Watching` already carries the ordinary scheduled-hold meaning as the
fallthrough at `index.mjs:5964`; `Paused` remains the actionable state.

### 3. A coarse relative grant detail

```text
add, beside statusTime (index.mjs:5967):

  statusInterval(at, nowMs):
      if not finite(at): return null
      remaining = at - nowMs
      if remaining < 60_000: return "<1m"
      minutes = ceil(remaining / 60_000)
      return minutes > 99 ? "99m+" : `${minutes}m`

statusDetailVariants (index.mjs:5974) returns, widest first:
      [`${detailKind} ${interval}`, interval]
```

**Minute granularity is load-bearing, not cosmetic.** `index.mjs:158-162`
documents that `now` advances only on minute boundaries when nothing is in
progress, which is what keeps an idle frame byte-identical. `formatDuration`
(`index.mjs:281`) returns `1m47s` below an hour and must not be used here.

Updates required: `test/pty/status.test.mjs:84, 187, 455` and
`test/pty/cache.test.mjs:124` match `\d\d:\d\d`.

### 4. Stale measured against the granted cadence

`freshnessDeadline` (`index.mjs:6055`) uses
`lastOk + max(STALE_AFTER_MS, refreshMs * 6)`, i.e. 30s at the default. The
governor deliberately spaces polls further than that whenever panes share the
budget, so the amber badge fires *because* the throttle is working --- and it
renders in `ATTENTION`, the same weight as a real failure.

```text
freshnessDeadline takes the cadence the governor actually granted:

  grantedMs   = the interval between this pane's two most recent admitted
                request starts, when known; keep it per tab and do not derive it
                from lastOk or error age
  baseline    = max(STALE_AFTER_MS, (grantedMs ?? refreshMs) * 6)
  baseDeadline = lastOk + baseline

  # the existing valid-waiting-grant extension (index.mjs:6068-6074) is kept
  # unchanged: it already extends the deadline through a current-epoch grant
```

Data is stale when it is old relative to what the app itself promised. The
existing `/stale 2m/` assertions in `test/pty/status.test.mjs:455` and
`test/pty/cache.test.mjs:121` set `lastOk` to 120s ago explicitly and must keep
passing --- which they do as long as the granted cadence in those fixtures keeps
the deadline under 120s.

## Behaviour to match

- `test/unit.test.mjs:1380-1437` (`"refresh status pins active-tab precedence,
  copy, motion, and details"`) is the rubric for branch precedence. It
  `deepEqual`s whole status objects, so it is the executable spec for the new
  `Watching` / `Paused` split and must be extended, not replaced.
- `test/unit.test.mjs:1456-1528` is the rubric for allocation. It asserts the
  layout object across cols `[80, 60, 45, 24, 23]` and must gain `stateWidth`
  and a case proving the hint group's start column is identical across a
  detail-present and detail-absent decision at the same width.

## Success criteria

### Automated

- A new unit case asserts: for a fixed `cols`, `statusBarLayout` returns the
  same `mandatoryHints[0]` start offset for a decision with a detail, a decision
  with a detail and a stale label, and a decision with neither.
- A new unit case asserts `statusInterval` is minute-granular for every input
  in one minute, i.e. it returns at most two distinct values across 60 samples.
- `test/unit.test.mjs:1380-1437` maps ordinary scheduler holds to `Watching` and
  actionable holds to `Paused`; no reachable state returns `Waiting`.
- `REFRESH_STATUS_GLYPHS`, `test/pty/capture.mjs:43`, README, CHANGELOG, and the
  screen-reader assertions contain no `Waiting` status contract.
- A new PTY capture asserts the status line matches `/^· Watching next \d+m/`
  and that `hasFullKeyHints` still holds at 80 columns.
- All `STATUS_LINE`-anchored assertions pass; the four `\d\d:\d\d` assertions
  are updated to the relative form.
- `node test/pty/readme-sample.mjs` regenerated into `README.md`.
- Sequential verification passes (lint; test; `node --check`; test:pty; `git diff --check`).

### Manual

- Run four panes. Confirm `Refresh: r` starts at the same column in every pane
  and never moves as the detail cycles.
- Confirm a quiet pane reads `Watching` with a next-check interval, and that an
  actionable hold reads `Paused`.
- Run one pane with `NO_COLOR=1` and `GH_GLANCE_NO_ANIMATION=1` and confirm the
  words alone still distinguish the states.

## Out of scope

Notice wording (Phase 3); the pane-count detail (Phase 6).

## Completion

- [x] The wide state region uses the derived 25-cell cap at terminal widths of
  45 or more and preserves the existing 12-cell narrow collapse below 45.
- [x] Ordinary scheduler holds render `Watching`; actionable holds render
  `Paused`; the `Waiting` status contract is retired.
- [x] Relative grant details are minute-granular and capped, stale warnings win
  the bounded payload, and admitted per-tab cadence controls freshness.
- [x] Lint, 270 unit/runtime tests, syntax, all 85 isolated sequential PTY cases,
  and diff checks pass. The aggregate PTY harness deviation is recorded in the
  implementation notes without weakening an assertion or timeout.
