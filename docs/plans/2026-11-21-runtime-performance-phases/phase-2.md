# Phase 2 · Terminal work and display cache

Start from the accepted phase 1 commit. One owner updates the app and the related tests. The source and measured baselines are in the [main plan](../2026-11-21-runtime-performance.md).

## Visible animation

At `index.mjs:20071` the spinner consults every Actions row. Move its unconditional timer effect below viewport reconciliation, width calculation and tab-entry selection. Compute one drawn-row slice for the timer and row rendering. It must include the same gates as `index.mjs:23334` (Help, Notifications, too narrow, setup, CI and Attention), and respect the filtered/scrolled data at `index.mjs:23114`. Derive the frame glyph early enough for the tab bar. Keep transition to parked frame zero and effect cleanup unconditional. Check all three consumers: executing row, visible Checking glyph, and the first-load tab suffix in tiers that display it. Keep the current animation policy during loads including ASCII, screen reader, width edit and motion-disabled modes. A hidden running row cannot start a timer by itself. An inactive first-load badge that was parked before this change should continue to park. Elapsed-time and polling use different predicates and keep their present cadence. See `index.mjs:18104`, `index.mjs:18321`, `index.mjs:18624`, `index.mjs:20065`, `index.mjs:22993`, `index.mjs:23095`, `index.mjs:23246`.

## Persistence and references

Keep display-cache version 3, its trailing newline and atomic replacement. Remove only indentation in its serializer. Short-circuit `samePersistedValue` when both inputs are identical, retaining the existing structural comparison for independently decoded JSON. A cache document from an earlier version of the **writer** can be pretty-printed and still be valid v3. The current decoder decides schema compatibility. Preserve per-target/tab three-way merge and width preference behavior. See `index.mjs:13718`, `index.mjs:13745`, `index.mjs:14250`, `index.mjs:14267`, `index.mjs:14300`.

Replace the permanent initial load result with a lazily initialized holder containing the selected startup entry and mutable live/persisted map references. Both references initially point to the same loaded map. Preserve first-paint rows, metadata, selection of the verified access partition and collector source checkpoints. A later successful save advances both references to its merged result. The writer also holds its last scheduled value. Drop it only on success for the latest generation, before reporting the result. Preserve pending newer values and the failed value for retry. This applies to the common writer used by width preferences. See `index.mjs:13781`, `index.mjs:13891`, `index.mjs:13930`, `index.mjs:19480`, `index.mjs:19527`, `index.mjs:21491`, `index.mjs:21963`.

```
@ drain latest write -> persisted generation and current references
pre: one write in flight per writer
do:
  1. lookup the latest generation and value
  2. write it and advance the persisted generation on success
  3. release the scheduled value only when that successful generation is still latest
  4. emit its result and drain any new generation queued by the callback
fail: latest write fails -> retain value and allow a later flush or dispose to retry
```

## Consumer sweep

- `rg -n 'loadedCache|cachedEntry|dashboardCache(Ref|PersistedRef)' index.mjs`. Preserve initial data/meta/Security at `index.mjs:19551`, ages at `index.mjs:19816`, `index.mjs:19824`, `index.mjs:20081`, collector checkpoint at `index.mjs:21491` and stable effect dependency at `index.mjs:22950`. Live consumers at `index.mjs:20694`, `index.mjs:21173` and `index.mjs:21971` need the current merged map. Keep writer disposal at `index.mjs:19545`.
- `rg -n 'samePersistedValue|createCoalescedWriter|createWidthPreferenceWriter' index.mjs test scripts`. Preserve preference merge, UI result and dashboard merge callers at `index.mjs:13732`, `index.mjs:19492`, `index.mjs:13750`, `index.mjs:13764`, `index.mjs:13772`. Both app writers and `test/unit.test.mjs:2363` onward use the same drain. No return-type or warning change.
- `rg -n 'dashboard-cache\.json|dashboardCachePath|saveDashboardCache\(|serializeDashboardCache\(' index.mjs test scripts`. The production writer is `index.mjs:14306`. Cover helper callers in `test/cache.test.mjs:119` and `test/review-1031-freshness.test.mjs:220`. Direct fixture writers at `test/pty/cache.test.mjs:69`, `test/pty/onboarding.test.mjs:293`, and `test/pty/status.test.mjs:308`, `test/pty/status.test.mjs:344`, `test/pty/status.test.mjs:866`, `test/pty/status.test.mjs:1336` deliberately exercise both encodings. The PTY suite covers the other readers and waiters in actions-setup, attention, cache, focus, governor, jev-focus, mouse, notifications, onboarding, runtime-remediation and status. They parse JSON or wait for tokens. Inspect the actual predicates, especially `test/pty/mouse.test.mjs:42` and `test/pty/runtime-remediation.test.mjs:139`. Keep unrelated fixtures and preferences formatting as-is. No matching writer in scripts.

## Automated acceptance and recovery

1. Count the actual 200 ms timer callbacks under a PTY fixture. Confirm positive motion with a visible executing row and zero callbacks over three settled seconds under Help or below the viewport with no other animated consumer. Scroll/resize back or close Help and see motion resume. Exercise Notifications, narrow width, queued/completed rows, visible Checking, loading tab labels, no-animation and screen-reader modes. Verify the same visible elapsed-time updates, GitHub calls and terminal content. Bytes alone cannot detect the hidden work. Use `test/pty/status.test.mjs:527` and `test/pty/review-1031-clock.test.mjs:16`.
2. Read an old indented v3 file, edit one target and read the new compact bytes with the same decoder. Preserve Unicode, truncation, source timestamps, newline, modes, unrelated targets and tabs. An identity-equal entry must skip serialization for the comparison. The final disk write still serializes the complete document. Distinct changed entries still update. Measure byte counts against indented serialization of the identical input. Exercise a peer write between load and save, empty/corrupt/future schema, write failure and subsequent healthy restart. See `test/cache.test.mjs:127`, `test/cache.test.mjs:351`, `test/cache.test.mjs:431`, `test/runtime-remediation.test.mjs:208`.
3. For writer failure, later dispose must retry the exact value. Superseding and reentrant writes must preserve ordering and report the latest applicable result. For mounted memory, inspect retaining paths or use an isolated forced-GC experiment after a successful save and settled drain. Keep the mounted target and live/persisted maps reachable. Show that the superseded startup map and non-selected rows reachable only through its former full-cache roots can be collected. Exercise the actual writer. The earlier 445 KiB estimate excluded its pending-value reference. Avoid GC timing assertions in routine tests. Exercise unmount/quit flush, credential retargeting and SSH reconnect with the original target checkpoint. See `test/unit.test.mjs:2470`, `test/unit.test.mjs:2501`, `test/cache.test.mjs:418`.
4. Run the main plan's sequential lint, syntax, unit, efficiency and PTY commands.

**Manual acceptance.** No visual-only gate. Record timer counts, cache bytes and component heap evidence separately from whole-process RSS.

## Completion

- [x] Park invisible animation, compact display-cache writes and release superseded objects.
- [x] Review, simplify, measure and verify the phase. Measurements and gate results are in 2026-11-21-runtime-performance-notes.md.
