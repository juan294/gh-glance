# Phase 1 — Canonical width model and shared rendering

> Files: `index.mjs`, `test/unit.test.mjs`
> Depends on: nothing. Blocks: phases 2-5.
> Not batch-eligible: every later phase consumes and extends this model.

## Objective

Make column geometry a single executable model shared by headers, rows,
minimum-width guards, and future interactions. Default output must remain
geometrically identical in this phase.

## Changes

### 1. Add stable descriptor metadata (`index.mjs:1988-2159`)

Add `key`, `adjustable`, and `minWidth` to full descriptors. Add `key` to compact
descriptors but leave them non-adjustable.

Use the plan's exact scope/minima:

- Actions: workflow 5, branch 6, time 5, updated 6.
- Issues: author 6, label 6, updated 6.
- Pull requests: author 6, branch 6, review 7, updated 6.
- Security: package 6, age 6.
- Lock status/cursor, TITLE/SUMMARY grow cells, Security severity, and all
  compact descriptors.

Stable keys are lowercase identifiers independent of labels. Do not use labels
as persistence keys.

### 2. Add pure width helpers

Export helpers through the existing test-only export seam:

```text
columnProps(columns, key):
    find exact key
    return descriptor.props

resolveHeader(base, overrides = {}):
    map base descriptors
    for adjustable numeric descriptor with valid override:
        copy descriptor and props with width = max(minWidth, override)
    otherwise retain descriptor identity where possible

fitHeaderToFrame(preferred, defaults, frameCols):
    if preferred fits: return preferred
    if defaults do not fit: return null
    shrink only values above their defaults, deterministically in descriptor
    order, until the derived minimum fits
    do not mutate preferred/defaults/overrides

adjustWidth({header, key, delta, frameCols}):
    clamp at minWidth and available frame budget
    return unchanged header/state for a clamped no-op
```

`minimumWidthFor()` remains the only table-floor formula. Do not introduce a
second sum or hard-coded threshold. Preserve its four-cell grow budget.

### 3. Make rows consume resolved columns

Change every row signature to accept `columns`:

```text
ActionsRow({..., columns})
IssueRow({..., columns})
PRRow({..., columns})
SecurityRow({..., columns})
```

Replace numeric width/grow literals with `columnProps(columns, key)`. Both the
compact and full branches receive the descriptor set selected by App. Content,
color, wrapping, cursor, and ordering remain unchanged.

### 4. Preserve memoization

Create a memoized resolved full header per tab/default-overrides tuple, and use
the registry's stable compact array directly. Pass the same selected array to
`HeaderCells`, `minimumWidthFor()`, and every visible row.

Do not reconstruct descriptor arrays or nested props on each `now` tick. A
fresh columns prop would make every `React.memo` row render on every clock
update (`index.mjs:2164-2172`).

### 5. Establish effective/full/compact selection

At this phase overrides are empty, so behavior is unchanged, but route through
the future-safe algorithm:

```text
preferredHeader = resolveHeader(tab.header, {})
effectiveHeader = fitHeaderToFrame(preferredHeader, tab.header, frameCols)
compact = effectiveHeader == null
header = compact ? tab.compactHeader : effectiveHeader
```

`tooNarrow` continues to use the existing compact floor. Keep
`MIN_TABLE_WIDTH` and `MIN_COMPACT_WIDTH` exported and derived from default
registry descriptors.

## Tests (`test/unit.test.mjs`)

Add failing-first contracts:

- every full/compact descriptor has a unique stable key within its tab;
- the adjustable-key inventory equals the chosen scope exactly;
- resolving empty overrides preserves every current width/grow value;
- valid overrides affect only the named adjustable descriptor;
- locked, unknown, fractional, non-finite, and below-minimum values do not
  escape the helper contract;
- helpers never mutate registry arrays, descriptors, props, or overrides;
- every full and compact row key resolves from its matching descriptor set;
- `minimumWidthFor(resolveHeader(...))` increases with a wider fixed column;
- adjustment clamps at the semantic minimum and frame maximum while preserving
  four grow cells;
- a clamped no-op preserves object identity;
- fitting returns preferred when it fits, temporarily shrinks only above-
  default preferences when defaults fit, and returns `null` when the default
  full header does not fit.

Retain the existing measured `MIN_TABLE_WIDTH > 52` assertion and all PTY
geometry tests unchanged.

## Automated success criteria

Run sequentially:

```bash
npm run lint && npm test && node --check index.mjs && npm run test:pty
```

- Default wide and compact captures have the same frame bounds as before.
- Unit tests prove one source of width truth for header, rows, and guard.
- No dependency or build/tooling file changes.

## Manual success criteria

- Open all four tabs at 80 columns and compare column order/widths with the
  research capture; this phase must have no visible width change.
- Shrink through each tab's current compact breakpoint and confirm the existing
  compact sets still appear without wrapping.
