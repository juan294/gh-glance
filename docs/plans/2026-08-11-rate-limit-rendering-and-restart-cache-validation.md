# Validation — rate-limit rendering and restart cache

Validated against
[`2026-08-11-rate-limit-rendering-and-restart-cache.md`](./2026-08-11-rate-limit-rendering-and-restart-cache.md)
on 2026-08-11.

## Result

All three phases are complete. The implementation fixes both reported user
outcomes and has no open review finding.

| Phase | Status | Evidence |
|---|---|---|
| 1. Terminal guard row | Pass | The frame renders one row below the physical viewport. Terminal replay proves the guard row stays blank and no synchronized update ever shows more than one status line. |
| 2. Last-known-good cache | Pass | A versioned, target-scoped cache hydrates rows and freshness before polling. Reads and atomic writes are nonfatal, POSIX permissions are `0700`/`0600`, blind Security results preserve known alerts, and the cache is bounded to five targets and 60 rows per tab. |
| 3. Restart recovery | Pass | Four real-process PTY captures prove healthy cache creation, stale and throttled same-target recovery under live 403 responses, blind Security preservation, and different-target isolation. Width, guarded height, alternate-screen balance, and clean teardown remain intact. |

## Automated verification

- `npm run lint`: pass, zero warnings.
- `node --check index.mjs`: pass.
- `npm test`: pass, 168 of 168 tests.
- Every explicit `test/pty/*.test.mjs` file, run sequentially: pass, 50 of 50
  tests across eight files.
- `git diff --check`: pass.

## Review findings

The required reuse, quality, efficiency, and plan-compliance reviews are clean.
The review passes led to these corrections before final validation:

- PTY parsing now replays the live alternate-screen state and retains the
  maximum status-line count, so a transient duplicate cannot be hidden by a
  later clean repaint.
- Cache decoding rejects invalid tab metadata independently and enforces private
  permissions even when the config directory already exists.
- Identical payloads do not schedule writes, and the bounded cache keeps a
  synthetic maximum synchronous save near 11 ms in the local benchmark.
- Blind Security polls preserve live and cached alerts without advancing
  freshness. Their raw comparison is invalidated so an identical healthy
  response commits and clears `Security (?)` after recovery.

The Phase 1 PTY-parser deviation is intentional and documented in
[`2026-08-11-rate-limit-rendering-and-restart-cache-notes.md`](./2026-08-11-rate-limit-rendering-and-restart-cache-notes.md).
It restores executable geometry coverage that byte slicing lost after the frame
moved below full height.

## Manual testing

None required. The terminal behavior, process restart, cache isolation,
rate-limit failure, readable budget probe, adaptive throttle, and teardown paths
all run through real PTY process boundaries in the automated suite.

## Recommendation

The branch is ready for local integration into `develop`. Push and release are
separate authorization gates.
