# Phase 2: Notifications view and critical-only inline area

> Plan: [`../2026-11-02-notifications-section.md`](../2026-11-02-notifications-section.md) | Entry: Phase 1 accepted

## Objective

Render the fifth section, route all non-`action` notices into it, and leave the table area clear except for `action` causes.

## Changes (`index.mjs`)

### 1. View state and navigation

- Add `notificationsOpen` state beside `activeIndex` (`index.mjs:18641`). `viewIndex = notificationsOpen ? TABS.length : activeIndex`.
- Key handler (`index.mjs:19746-19754`): `5` opens; `1`–`4` close and `setActiveIndex`; Tab/Right/Shift-Tab/Left move `viewIndex` across five positions. Width mode, features and help keep priority, as they do now (`index.mjs:19586-19620`).
- In the view: Up/Down/PgUp/PgDn scroll a separate `notificationsOffset`; `r` calls the Phase 3 status-check trigger (until Phase 3, `r` keeps its current meaning).
- Opening the view calls `log.markSeen(now)`.
- Help pages (`contextHelpPages`, `index.mjs:16809`) gain a Notifications meaning line and its keys.

### 2. Tab bar

```
@ tabBarEntries({ cols, counts, summary, useShort }) -> Entry[5]
do:
  1. compute four data entries as today (index.mjs:17401-17447)
  2. append { digit 5, name Notifications|Notices, suffix (n) when unread > 0, tone from summary }
  3. compute total width; br if over cols -> fall back to digit-only names for all entries
br: still over cols -> keep digits and suffixes, truncate names
risk: TAB_LABEL_FULL_WIDTH (index.mjs:17393) must be recomputed from the five labels, with hysteresis kept
```

### 3. Event recording in `App()`

- Create one log per pane with `useRef(createNotificationLog(...))`; seed from the journal when the governor scope resolves (standalone only; collector clients start empty).
- After each render, build the snapshot (Phase 1 shape) from `errors`, `acquisitionFailures`, `governorDecisions`, `recoveryCauses`, `lastOkRef`, `securityNotes` and `statusDisconnected`, diff against the previous snapshot in a ref, and apply begin/end to the log.
- Store only `{ unread, tone }` in React state, and update it only when it changes. Routine `info` events must not cause a re-render while the view is closed.

### 4. Critical-only inline area (replaces `index.mjs:19141-19166` assembly)

```
@ criticalInlineLines({ noticeCause, tabError, displayError, cols, capacity }) -> string[]
do:
  1. if noticeCause and noticeLevel(code) == action -> presentRecovery lines (<= 3)
  2. else if tabError fetch verdict level == action -> [displayError]
  3. else -> []
  4. slice to capacity (rows - 9, as today)
```

- `noticeLines` = feature/focus lines (unchanged) + Actions setup lines (unchanged, user-invoked) + `criticalInlineLines`. The `title`/`sourceCheck` prefix and the small-pane variants for `wait`/`overdue` are removed from the table path.
- Delete the `visibleSecurityLines` block (`index.mjs:19160-19161`, `index.mjs:22380-22386`); Security notes now arrive through the snapshot (D6).
- The no-table panel path (`contextualPanelLayout`) and the bottom status bar are unchanged.

### 5. Notifications body

- Replace the table/panel body when `notificationsOpen`: top edge label `Notifications · <target>`; first row is the GitHub status line (Phase 2 shows `GitHub status: not checked yet`); then entries newest first: time, level glyph (reuse the status glyph profile used by `StatusBar`), source label, text, `×N`; `endedAt` entries dim.
- Footer label: `<n> events`, or `Showing the latest 500 events` when truncated.
- Every line `wrap: "truncate-end"`; rows fit `bodyRows`.

### 6. Docs

- `--help` key list, README key table and screenshot caption text, CHANGELOG `Unreleased`: the Notifications section and critical-only inline notices.

## Tests

Update or add (TDD for new behaviour):

1. `test/pty/status.test.mjs`: the existing coordination-notice cases (lines 88, 966-1017) now assert zero rows between the top edge and the header, the badge suffix `(1)`, and the text inside the view after sending `5`.
2. New PTY case: `budget-stale` fixture with Actions rows gives the header directly under the top edge; status bar shows its existing state.
3. New PTY case: `corrupt` storage fixture shows `gh-glance --doctor` inline (≤3 lines) and a red badge.
4. New PTY case: tab bar fits one row with digits `1`–`5` visible at 120, 80, 60 and 40 columns.
5. `test/onboarding.test.mjs`: "not enabled here" is expected in the view, not above the Security table.
6. Unit: `criticalInlineLines` for each level; `tabBarEntries` width tiers.
7. `test/pty/runtime-remediation.test.mjs` `insertedAbove` stays green unchanged.

## Verification

```bash
npm run lint && node --check index.mjs && npm test && npm run test:pty
```

## Acceptance

- [x] Automated checks above pass (Final gate on `82bbb13`: `npm run lint` 0, `node --check index.mjs` 0, `npm test` 1,100/1,100, `npm run test:efficiency` 9/9, `npm run test:pty` 264 pass, 0 fail, 1 skipped (the existing env-gated 0.15.2 baseline reproduction, which needs GH_GLANCE_BASELINE_ENTRY).)
- [ ] Manual (owner): pane with a forced `wait` cause shows no movement of the table; badge yellow; view lists the cause and its clear. The same sequence is automated in `test/pty/notifications.test.mjs`.
- [x] Simplify pass and independent review done; findings resolved (see the notes file).
- [x] Owner authorized continuation through all phases (2026-11-02).

## Handoff (2026-11-02)

- Done: Notifications view, badge, five-position keys, critical-only inline area, Security notes moved, docs. Commits `28f4e28`, fixes in `3c6e4ff` and `82bbb13`.
- Final gate on `82bbb13`: `npm run lint` 0, `node --check index.mjs` 0, `npm test` 1,100/1,100, `npm run test:efficiency` 9/9, `npm run test:pty` 264 pass, 0 fail, 1 skipped (the existing env-gated 0.15.2 baseline reproduction, which needs GH_GLANCE_BASELINE_ENTRY).
- Deviations, review findings and gate findings: [`../2026-11-02-notifications-section-notes.md`](../2026-11-02-notifications-section-notes.md).
- Pending: the two manual owner checks.
