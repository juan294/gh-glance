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

### Phase 2 PTY execution

- **Plan said:** Run `npm run test:pty` as one serialized Node test command.
- **Found:** An aggregate run placed a literal terminal `^D` in the final guard
  row of the 45-column footer case. The unchanged empty-row assertion passed
  when the complete status module ran in its own Node process.
- **Chose:** Keep the guard-row assertion unchanged and run every PTY module
  sequentially in its own Node process. All 85 cases passed after Phase 2.
- **Why:** The failure is the same local aggregate process-pressure artifact
  recorded in Phase 1. Module isolation verifies the product contract without
  weakening an assertion or increasing a timeout.
