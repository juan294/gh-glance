# Plan: Notifications section and critical-only inline notices

> 2026-11-02 | Repository `juan294/gh-glance` | Branch `develop` @ `7686e40d2b2298785b53c7681fefeebe9e444574`
> Research: [`docs/research/2026-11-02-inline-status-notices-and-notification-center.md`](../research/2026-11-02-inline-status-notices-and-notification-center.md)
> Phases: [`2026-11-02-notifications-section-phases/`](2026-11-02-notifications-section-phases/)

## Goal

Status notices stop pushing the table down. Lines above a table appear only when the user must act or a serious problem blocks the dashboard. Everything else goes to a new fifth section, `5:Notifications`, which keeps a history the user can open when they suspect a problem. A new source reports GitHub platform status from `githubstatus.com`.

## Owner decisions (2026-11-02)

| ID | Decision |
|---|---|
| D1 | Only absolutely critical notices stay inline: they need user action or signal a serious problem that waiting does not fix. Self-resolving waits and informational lines are not critical. |
| D2 | Notifications holds the history of events (what happened, when, refreshed, retried, wrong). |
| D3 | GitHub service status from `githubstatus.com` is a new notification source. It never goes inline. |
| D4 | History is in memory per pane, seeded at start from the existing shared recovery journal. No new persisted file. |
| D5 | Long self-resolving problems never escalate inline. The fifth tab label shows an unread count and colour; the status bar keeps its one-row state. |
| D6 | Security "not enabled" and source-unavailable lines move from above the Security table to Notifications. |
| D7 | Labels: `Notifications` (full), `Notices` (short), with an unread suffix such as `(3)`. |

## Design

### Notice levels

One pure function, `noticeLevel(code)`, maps every cause to a level. Exhaustiveness over `RECOVERY_COPY` is enforced by a unit test (every key has exactly one level).

| Level | Inline | Badge | Codes |
|---|---|---|---|
| `action` | yes | red | `unwritable`, `corrupt`, `capacity`, `accounting-overflow`, `reservations-invalid`, `external-factor-invalid`, `pacing-invalid`, `budget-resource`, `legacy-unresolved`, `legacy-corrupt`, `restart-required`, `throttle-paused`, `credential-unavailable`, `identity-unavailable`, `disconnected`, `app-auth`, `auth-problem`, `unavailable`, `backup-conflict`, `version-mismatch`, `unsafe-permissions`, `disk-full` (22); fetch verdicts `auth-problem`, `unavailable`, `no-remote` |
| `problem` | no | red | fetch verdict `other` (a failed refresh with raw text); GitHub status incident or component outage affecting a tracked component |
| `wait` | no | yellow | `busy`, `stale`, `identity-busy`, `transport-busy`, `debt-journal-full`, `migration-hold`, `identity-backoff`, `identity-capacity`, `budget-unknown`, `budget-stale`, `budget-future`, `probe-failed`, `block-unpublished`, `budget-reset`, `reset`, `priority`, `rate-limit`, `rate-limited`, `local-reserve`, `reserve`, `blocked`, `secondary`, `secondary-rate-limit`, `abuse-limit`, `network-outage`, `security-incomplete`, `receipt-retry`, `interrupted-request`, `request-queue`, `acquisition-busy`, `clock-recovery`, `source-incomplete`, `unknown-scope`, `coordination` (34); fetch verdict `rate-limited`; Security source failure notes |
| `info` | no | none | refreshed, cause cleared, Security "not enabled", status feed unavailable, earlier-session history |

Classification notes, from repository evidence:
- `coordination` is the fallback copy for unmapped reasons, including external quota drain (`index.mjs:16557-16558`; owner memory "Local coordination unavailable is fallback copy"), so it is `wait`. The real storage failures have their own `action` codes.
- `unknown-scope` is the startup "Confirming your GitHub login" state (`index.mjs:16473`). A real missing login surfaces as `credential-unavailable` or `identity-unavailable` (`action`).
- `migration-hold` and `debt-journal-full` say "retry automatically" in their own copy (`index.mjs:16510`, `index.mjs:16503`).

### Inline area after the change

When a table is visible, the rows above the header are at most the `presentRecovery()` lines of an `action` cause (≤3, `index.mjs:16635-16675`) or the formatted error of an `action` fetch verdict (1 line). The `Waiting to update <Label>` title, `Checked HH:MM`, `cached …` and all `wait`/`problem`/`info` text no longer render above the table. Focus, CI, attention and Actions-setup lines that the user opened by key stay as they are (user-invoked content, not status notices). The no-table panel (`contextualPanelLayout`) is unchanged: it replaces the table instead of pushing it.

### Notifications view

- Kept outside `TABS`/`TAB_KEYS`. `TABS` drives about 100 fetch/cache/state sites (research §5); a non-data entry there would need guards in each. A boolean `notificationsOpen` beside `activeIndex` selects the view; the tab bar renders five entries; polling still follows the last data tab.
- Keys: `5` opens; `1`–`4` close and select; Tab/Right and Shift-Tab/Left cycle through five positions; Up/Down/PgUp/PgDn scroll; `r` in this view requests a GitHub status check now. Help (`?`) lists these keys.
- Body: newest first, one row per entry: `HH:MM` (or `MM-DD HH:MM` if not today), level glyph, source, text, and `×N` for coalesced repeats. Header row: GitHub status summary (`All systems operational`, an incident name, `GitHub status checks off`, or `GitHub status not checked for <host>`).
- Badge: the unread count of `action`/`problem`/`wait` entries since the view was last opened. Red when any unread `action`/`problem` exists or a GitHub outage is active, yellow for unread `wait` only, dim otherwise.
- Idle frames: routine `info` events never change the badge, so an idle dashboard with the view closed keeps byte-identical frames (comment at `index.mjs:18922-18924`).

### Event source

Events come from one diff of a per-render snapshot (errors, acquisition failures, governor decisions, recovery causes, `lastOkRef` per tab, Security notes, disconnected flag). This avoids instrumenting the 12 `setErrors` sites and 6 `setSecurityNotes` sites. Conditions shorter than `COORDINATION_NOTICE_AFTER_MS` (800 ms, `index.mjs:213`) are not recorded, which matches today's inline debounce.

### GitHub status source

`GET https://www.githubstatus.com/api/v2/summary.json`, conditional with `If-None-Match`. Observed 2026-11-02: 4,310-byte body, weak ETag, `304` on revalidation, keys `page`, `components`, `incidents`, `scheduled_maintenances`, `status`. Cadence is every 10 minutes, plus on view open or `r`, plus once (rate-limited to one per minute) when a data tab enters a `problem` or `network-outage` state. Requests time out at 10 s and bodies over 256 KiB are refused. All remote text passes `safe()` and a length cap. Tracked components: `API Requests`, `Actions`, `Issues`, `Pull Requests`, `Git Operations`, `Webhooks`. The check runs only when the effective host is `github.com`. `GH_GLANCE_GITHUB_STATUS=off` disables it; an `http(s)` URL value overrides the endpoint (used by tests).

## Phases

| Phase | Scope | Gate |
|---|---|---|
| [1](2026-11-02-notifications-section-phases/phase-1.md) | Pure core: `noticeLevel`, notification log store, snapshot diff, journal seed. No UI change. | lint, `node --check`, `npm test` |
| [2](2026-11-02-notifications-section-phases/phase-2.md) | Fifth tab view, badge, keys, critical-only inline area, Security notes moved, help/README/CHANGELOG. | lint, `node --check`, `npm test`, `npm run test:pty` |
| [3](2026-11-02-notifications-section-phases/phase-3.md) | GitHub status source, env control, harness isolation, docs. | lint, `node --check`, `npm test`, `npm run test:efficiency`, `npm run test:pty` |

Phases are sequential. Each stops for owner acceptance.

**Batch eligibility:** none. All product code is in `index.mjs` (single-file rule in `CLAUDE.md`), so no two units are free of file overlap.

## Success criteria

### Automated

- Phase 1: `test/notifications.test.mjs` passes: level exhaustiveness, coalescing, bound, unread, debounce, journal seed for every journal `status`.
- Phase 2: PTY tests show zero rows between the panel top edge and the column header for a `wait` cause (`budget-stale` fixture), ≤3 rows for an `action` cause (`corrupt` fixture), the event in the Notifications view after `5`, and a single-row tab bar with all five digits visible at 120, 80, 60 and 40 columns.
- Phase 3: a local fixture server drives operational, incident, `304`, timeout, malformed and oversize responses; the poller never runs under `GH_GLANCE_GITHUB_STATUS=off`; `npm run test:efficiency` request counts are unchanged.
- All existing suites pass after the tests listed in each phase's consumer sweep are updated.

### Manual

- Owner runs a pane with a forced `wait` cause and confirms the table does not move and the badge colours as specified.
- Owner reads the Notifications view at the narrowest pane width they use.

## Stuck states and recovery

| State | Who sees what | How it ends | Test |
|---|---|---|---|
| A `wait` cause persists for a long time (D5) | Status bar keeps `Paused`/`Stale` (`index.mjs:17558-17618`); badge turns yellow; the entry shows its retry time in the view | Automatic retry clears it; a `clear` entry is logged | Phase 2 PTY: badge yellow, status bar `Paused`, zero inline rows, then cleared entry after fixture recovery |
| An `action` cause | Inline lines with the remedy (`gh-glance --doctor`, `gh auth status`, press `r`, restart) and a red badge | User follows the shown remedy; existing clear paths (`index.mjs:16579-16586`) | Phase 2 PTY: `corrupt` fixture shows `gh-glance --doctor` inline |
| A failed refresh (`other` verdict) | Tab bar red `x` (existing, `index.mjs:17434-17437`), red badge, raw text in view | Next successful poll logs `refreshed` and clears the tab `x` | Phase 2 PTY: failing fixture then recovery |
| Recovery journal `corrupt`/`unavailable` at seed | One `info` entry: "Earlier recovery history unavailable; run gh-glance --doctor" | Live events still record; doctor already reports the journal state (`index.mjs:11986-11987`) | Phase 1 unit for each status |
| History at capacity (500 entries) | View footer: "Showing the latest 500 events" | Oldest entries drop; never blocks | Phase 1 unit |
| Status feed unreachable, timeout, malformed or oversize | View header: "GitHub status unavailable; next check HH:MM"; one `info` entry per episode | Retries after 15 min, or `r` in the view; success replaces the header | Phase 3 unit + PTY |
| Status checks off or non-github.com host | View header names the reason and the env var | Unset the variable or change target; shown in text | Phase 3 unit |

## Consumer sweep

Search commands (run at `7686e40`):

```bash
grep -an "visibleSecurityLines\|tableNotices\|noticeLines\|recoveryLines" index.mjs
grep -an "TabBar(\|e(TabBar" index.mjs
grep -an "setActiveIndex(" index.mjs
grep -rlE "Waiting to update|GitHub budget|Coordinating with your other panes|GitHub quota pacing|not enabled here|insertedAbove" test
grep -lE "spawn|execFile|fork\(" scripts/*.mjs test/*.mjs test/pty/*.mjs | xargs grep -l "index.mjs\|GH_GLANCE_CAPTURE_ENTRY\|run.sh"
```

| Consumer | Disposition |
|---|---|
| `App()` notice assembly `index.mjs:19040-19166` (11 references) | Phase 2 replaces it |
| `TabBar` `index.mjs:17401` and its single render `index.mjs:22337` | Phase 2 |
| Key handler `setActiveIndex` `index.mjs:19746-19754` (and the earlier mouse/tab handlers found by the grep) | Phase 2 |
| `presentRecovery`, `dashboardPresentation`, `contextualPanelLayout`, `contextHelpPages` | Unchanged; still used for `action` lines, the no-table panel and help |
| Recovery journal format (`recordRecoveryTransition`, `readRecoveryTransitions`) | Unchanged; Phase 1 only reads it. Level is computed, never stored, so `RECOVERY_EVENT_KEYS` validation (`index.mjs:16868-16894`) is untouched |
| `test/pty/status.test.mjs` (notice text and placement at lines 88, 966-1017) | Phase 2 updates expectations to the view and badge |
| `test/pty/runtime-remediation.test.mjs` `insertedAbove` | Phase 2 re-verifies; it inserts Actions rows, not notices, and must stay green |
| `test/onboarding.test.mjs` ("not enabled here") | Phase 2 updates for D6 |
| `test/recovery.test.mjs`, `test/governor*.test.mjs`, `test/identity.test.mjs`, `test/context-help.test.mjs` | Pure-function tests of unchanged functions; must pass unchanged |
| `test/pty/capture.mjs` `captureEnvironment` | Phase 3 sets `GH_GLANCE_GITHUB_STATUS=off` unless the test supplies a value |
| Other process spawners from the last grep (6 scripts, 30 test files) | Phase 3: TUI launchers get the env through their shared env builders; non-TUI commands (`--doctor`, `--version`, args) never start the poller, and a unit test proves that |

## Out of scope

- Opening incident pages from the view; `--tab notifications`; persisting non-recovery history (D4); changing `--doctor`, the governor, the journal format or polling cadence; GitHub Enterprise Server status pages.

## Handoff

- Objective: plan accepted by owner before implementation. Decisions D1-D7 are final. Implementation is not yet authorized.
- Baseline: `develop` @ `7686e40`, primary checkout clean except the untracked research and plan documents. Implementation runs in a local worktree created from that `develop` SHA (isolation worktrees default to `main`; brief the SHA explicitly).
- Evidence limits: GitHub status incident field shape (`name`, `status`, `impact`, `shortlink`, `updated_at`, `components`) is inferred from the Statuspage v2 format; no incident existed on 2026-11-02. Phase 3 parser tolerates missing fields and its fixtures cover each.
- Next: owner acceptance of this plan, then `rpi-implement` Phase 1. Revalidate cited line numbers against current `develop` first.
