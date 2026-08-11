# Plan: stable rate-limit rendering and restart cache

> 2026-08-11 | Branch `develop` @ `9f5c09a`
> Research: `docs/research/2026-08-11-rate-limit-rendering-and-restart-state.md`

## Problem

During a sustained GitHub rate-limit window, the changing status line can leave
old copies at the bottom of a terminal while the dashboard scrolls upward. If
the user exits and starts again during that window, all prior rows have been
lost with the process and every new fetch fails, so the default Actions view is
an error banner, headers, and an empty body.

## Selected design

### A terminal guard row, not a renderer rollback

Keep Ink's incremental renderer and its lower terminal traffic. Render the app
one row shorter than the live viewport. Ink then treats the frame as
non-fullscreen and terminates it on the unused physical bottom row. The status
bar is never written on the terminal's scroll edge, so repeated status changes
cannot turn into scroll events that accumulate prior copies.

This follows the existing horizontal safety-column precedent. Disabling
incremental rendering would also avoid the specific diff path, but it would
restore whole-frame writes for every spinner, elapsed-time, and polling update.
Patching `node_modules/ink` would make correctness depend on an unowned install
artifact.

### A private, target-scoped last-known-good cache

Persist only successfully parsed dashboard state in a versioned
`dashboard-cache.json` beside `preferences.json`. Use the same private directory
and atomic `0600` file replacement contract as width preferences.

Cache entries are keyed by the explicit repository target when one exists. For
the normal inferred-repository mode, use the current working directory together
with the active host environment. This prevents one repository's rows from
appearing in another pane without adding a startup API call that cannot succeed
during the failure this cache handles.

Each target entry contains per-tab rows, metadata, last-success timestamps, and
the Security tab's notes/blind marker. App hydrates those values before its
first fetch. Live success replaces the corresponding cached tab. Failure never
replaces or clears a last-known-good entry. Cached timestamps feed the existing
`stale` label, and a live rate-limit error remains visible above the cached rows.

Cache reads and writes are advisory. A missing, corrupt, unknown-version, or
unwritable cache must not block startup, fetching, rendering, or clean exit.
Remote titles and security findings can be private, so directory/file modes are
part of the contract, not an implementation detail.

## Phases

| # | Phase | Batch | Done |
|---|---|---|---|
| 1 | Give incremental rendering a physical guard row | no | [ ] |
| 2 | Add the versioned last-known-good cache | no | [ ] |
| 3 | Prove restart recovery end to end and document the behavior | no | [ ] |

No phase is `[batch-eligible]`. Phases 1 and 2 both edit `index.mjs`; Phase 3
depends on the cache format and runtime behavior from Phase 2.

Phase files:
`docs/plans/2026-08-11-rate-limit-rendering-and-restart-cache-phases/phase-N.md`

## Success criteria

### Automated

- `npm run lint` passes.
- `node --check index.mjs` passes.
- `npm test` passes, including cache validation, target isolation, atomic
  replacement, and private-permission tests.
- Every explicit `test/pty/*.test.mjs` passes.
- PTY geometry proves the rendered app always leaves one physical row outside
  the incremental frame at supported heights.
- A two-process PTY test first saves healthy Actions data, then starts with the
  same config root while every GitHub data call is rate-limited. The second
  process shows the rate-limit banner, a stale indicator, and cached Actions
  rows in one frame.
- A different repository target does not hydrate the first target's rows.
- Corrupt or unwritable cache state leaves the live process usable and does not
  change successful in-memory data.

### Manual

No manual-only criterion is required. The original terminal failure is covered
by the stronger layout invariant that no dynamic content occupies the physical
bottom row, and restart behavior is covered through two real processes under a
PTY.

## Risks

- **Private repository data at rest.** The cache can contain issue titles,
  branches, authors, and security findings. It therefore inherits the existing
  `0700` directory and `0600` atomic file contract.
- **Wrong-target hydration.** Explicit repo/host and inferred working-directory
  identities remain separate and are tested. Cache lookup never falls back to a
  different entry.
- **Corrupt cached item shape.** Decode accepts only the current version,
  recognized tab keys, arrays, finite timestamps, and record metadata. Invalid
  tabs are ignored independently so one bad entry cannot blank the others.
- **Write churn.** Writes are coalesced and only scheduled after a parsed
  successful payload changes the cached state. Identical polls retain the
  current redraw and disk-write short circuit.

