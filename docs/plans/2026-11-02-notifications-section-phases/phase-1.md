# Phase 1: Notification core (pure functions, no UI change)

> Plan: [`../2026-11-02-notifications-section.md`](../2026-11-02-notifications-section.md) | Baseline `develop` @ `7686e40`

## Objective

Add the pure building blocks that Phases 2 and 3 render and feed. No rendered output changes in this phase.

## Changes (all in `index.mjs`, near the recovery presentation code at `index.mjs:16480-16680`)

### 1. `noticeLevel`

```
@ noticeLevel({ code?, verdict? }) -> "action" | "problem" | "wait" | "info"
pre: code is a RECOVERY_COPY key or null; verdict is a fetch verdict or null
do:
  1. lookup code in frozen NOTICE_LEVELS table (plan Design: Notice levels)
  2. lookup verdict: auth-problem/unavailable/no-remote -> action; other -> problem; rate-limited -> wait
br: unknown code -> "wait" (same fallback rule as recoveryCause -> coordination)
risk: a new RECOVERY_COPY key without a level; the exhaustiveness test catches it
```

### 2. Notification log store

```
@ createNotificationLog({ max = 500, now }) -> { record, end, list, markSeen, summary, size }
pre: entries hold sanitized display text only (no payloads, tokens or raw argv)
do:
  1. record(event): coalesce with newest entry of same key if no non-info entry of that source came after (count++, lastAt)
  2. otherwise append { id, key, level, source, code, text, action, firstAt, lastAt, count, endedAt:null }
  3. end(key, at): set endedAt on open entry; append info "cleared" entry for non-info levels
  4. trim oldest beyond max; set truncated flag
  5. summary(): unread = non-info entries with firstAt > seenAt; tone = red if unread action/problem, yellow if unread wait, else none
fx: in-memory only
```

### 3. Snapshot diff

```
@ diffNotificationSnapshots(previous, current, nowMs) -> { begin: Event[], end: key[], pending }
ctx: snapshot = { tabs: {key: { lastOk, error, failure, paused }}, recovery: {core, graphql}, securityNotes, disconnected }
do:
  1. compute condition keys per source from current (cause code, verdict, note text)
  2. keep pending conditions until seen for >= COORDINATION_NOTICE_AFTER_MS (800 ms)
  3. emit begin for conditions newly stable; end for stable conditions now absent
  4. emit info "refreshed <Label>" when tabs[key].lastOk advanced
br: condition seen and gone within 800 ms -> no event
risk: per-render cost; inputs are small fixed-size objects
```

Text uses existing copy: `RECOVERY_COPY` summary/action through `recoveryCause()` (`index.mjs:16553-16577`), `formatTabError()` for fetch errors (`index.mjs:570-584`), Security note strings as stored (`index.mjs:18951-18971`).

### 4. Journal seed

```
@ seedNotificationsFromJournal(log, scope) -> void
ctx: readRecoveryTransitions(scope) (index.mjs:16902)
do:
  1. read journal; br on status
  2. record each non-clear entry as source "earlier session", its level from noticeLevel, firstAt/lastAt from the entry
  3. record clear entries as end markers
br: status healthy|missing -> seed (missing seeds nothing); corrupt|unavailable -> one info entry naming gh-glance --doctor
fx: none on disk (read-only)
```

## Tests (TDD: write first, see them fail)

New file `test/notifications.test.mjs` using `node:test`:

1. Every key of `RECOVERY_COPY` has exactly one level; the `action` set equals the plan's 22 codes; `wait` has 34. (Requires exporting `RECOVERY_COPY` and `noticeLevel` through the existing test export mechanism; follow how `test/recovery.test.mjs` imports `presentRecovery`.)
2. Coalescing: 12 `refreshed Actions` events give one entry with `count === 12`; an intervening `wait` for Actions starts a new entry.
3. Bound: 501 distinct events leave 500 entries and `truncated === true`.
4. Unread and tone: wait-only gives yellow; adding a problem gives red; `markSeen(now)` gives none.
5. Debounce: a condition present for 799 ms yields no event; for 800 ms yields begin, then end when gone.
6. Journal seed for `healthy`, `missing`, `corrupt`, `unavailable` (fixture journal files in a temp dir, same pattern as `test/recovery.test.mjs`).
7. Sanitization: event text containing control characters is stored through `safe()` with no ESC bytes.

## Verification

```bash
npm run lint && node --check index.mjs && npm test
```

## Acceptance

- [x] All tests above pass; `npm test` passes in full (1,080 tests, 0 failures).
- [x] No change to rendered frames (no PTY test changes needed in this phase).
- [x] Simplify pass done; review findings resolved (see the notes file).
- [x] Owner authorized continuation through all phases (2026-11-02).

## Handoff (2026-11-02)

- Done: noticeLevel, notification log, snapshot diff and journal seed in `index.mjs`; `test/notifications.test.mjs` (21 tests).
- Checks on the Phase 1 candidate: `npm run lint` 0, `node --check index.mjs` 0, `npm test` 0 (1,080 pass).
- Deviations and finding dispositions: [`../2026-11-02-notifications-section-notes.md`](../2026-11-02-notifications-section-notes.md).
- Next: Phase 2 wires these into `App()`.
