# Phase 3 — Prove restart recovery end to end and document it

Not batch-eligible. Depends on the Phase 2 cache contract.

## Changes

### `test/pty/`

- Use one caller-owned `configHome` for two sequential processes.
- First process: fixture data succeeds and produces a cache entry.
- Second process: the fixture returns `HTTP 403: API rate limit exceeded` for
  every data endpoint from startup.
- Assert the second final frame contains the rate-limit banner, a stale label,
  and a non-empty Actions table/count while preserving width, height, alternate
  buffer, and teardown invariants.
- Add the negative pair: restart with a different repository target and assert
  no cached row/count crosses the target boundary.
- Keep rate-limit failure injection separate from `api rate_limit` when the
  scenario needs a readable budget probe; the fixture selector controls this
  explicitly.

### `CHANGELOG.md`

- Record that status updates keep a terminal guard row and no longer accumulate
  old footer copies.
- Record that last-known-good rows survive restart and remain visibly stale
  under a live rate-limit banner.
- State the private on-disk cache location/permissions at the level users need;
  do not expose implementation-only schema details.

## Verification

- `npm run lint`
- `node --check index.mjs`
- `npm test`
- Run each explicit `test/pty/*.test.mjs` sequentially.
- Inspect `git diff --check` and the final scoped diff.
