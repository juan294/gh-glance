# Phase 1: crash-safe shared lock protocol

Depends on: research. Stops after local verification and review.

## Deliverable

Extract the raw lock acquisition/recovery loop already used by the governor into one private helper in `index.mjs`. Keep governor scope/registry preflight in `withGovernorLock`; call the shared helper from `withAcquisitionStore` around its existing load/operation/write transaction. Remove the acquisition-specific three-attempt lock loop and dead-owner `.dead-${nonce}` rename path. Do not change acquisition file schema or erase persisted snapshots. [Current governor protocol](../../../index.mjs:4138), [current acquisition loop](../../../index.mjs:12952)

```text
withFileLock(path, operation, owner, wallClock):
  if recovery marker belongs to live/unknown owner: return busy
  claim path with exclusive create; clean up this inode on write failure
  if acquired: recheck recovery marker and own record; run operation; nonce-fenced release
  if young unreadable or live/unknown owner: bounded wait, then busy
  if aged unreadable or confirmed dead owner:
    create unique recovery marker; recheck before and after quarantine rename
    discard only the same abandoned record; retry

withAcquisitionStore(path, operation):
  withFileLock(path + ".lock", () => load -> operation -> atomic write)
```

Use the existing 10-second wall-clock orphan bound; injected acquisition time is for query semantics only. Keep file permissions 0700/0600 and the lock off the network path. A failed lock release must use the nonce-fenced fallback already present for governor locks. [Orphan clock](../../../index.mjs:4119), [release](../../../index.mjs:4169), [store transaction](../../../index.mjs:12979)

## Tests first

In `test/acquisition.test.mjs`, reproduce the research's aged empty-lock `busy` result as a failing test, then cover an aged partial record; young empty/partial records; owner-record write failure; live and unknown PID protection; dead PID recovery; stalled creator and two recoverers racing a successor; stale/live recovery markers; and preservation of existing acquisition metadata after recovery. Use governor lock tests at `test/governor.test.mjs:2582-2625` as the executable protocol reference. [Research repro](../../research/2026-09-23-live-staleness-evidence.md:30)

In `test/pty/shared-acquisition.test.mjs`, run separate processes against one temporary root. Inject an abandoned empty lock, assert recovery after the ten-second age bound with a wall-clock deadline, one producer per generation, follower delivery, and successful subsequent refresh/publication. Assert two critical sections never overlap during a recovery race. Retain the existing twelve-pane test. [Process fixture](../../../test/pty/shared-acquisition.test.mjs:48)

## Automated success

- The previously failing aged empty-lock test turns green; the lock and metadata remain intact while a valid live or indeterminate owner holds them.
- No failed exclusive create/write leaves an orphaned lock; a successor is never removed by a concurrent recoverer.
- Existing governor lock behavior, acquisition persistence, and process sharing remain green.
- Run the plan's sequential local verification gate.

## Manual success and limits

Review the race trace and file permissions in the isolated fixture. Do not touch the current user's 0.15.1 lock during this phase; a new lock protocol cannot claim safe mixed-version recovery with those processes still running. [Legacy path](../../../index.mjs:12952)
