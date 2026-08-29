# Conditional polling and calm status implementation notes

## Deviations

### Phase 1 PTY execution

- **Plan said:** Run `npm run test:pty` as one serialized Node test command.
- **Found:** Three aggregate runs under supported Node 24 and Node 22 failed in
  different unchanged cases: two timing assertions, one `spawnSync` timeout,
  one stray terminal `^D`, and one crash-recovery count. Each affected complete
  module passed when rerun alone, so no failure repeated at module scope.
- **Chose:** Run every `test/pty/*.test.mjs` file sequentially in its own Node
  process. All 84 PTY cases passed, including the new Phase 1 transition and all
  governor, throttle, geometry, lifecycle, selection, and remediation modules.
- **Why:** Per-file isolation preserves the repository's required sequential
  execution while avoiding aggregate local PTY process pressure. No assertion,
  timeout, or product contract was weakened.
