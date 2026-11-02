# Notes: Notifications section and critical-only inline notices

> Plan: [`2026-11-02-notifications-section.md`](2026-11-02-notifications-section.md)
> Implementation worktree: `/Users/juan/code/gh-glance-wt-notifications`, branch `feat/notifications-section`, from `develop` @ `7686e40d2b2298785b53c7681fefeebe9e444574`.

## Deviations

### Phase 1

- **Diff signature.** Plan said `diffNotificationSnapshots(previous, current, nowMs) -> { begin, end, pending }` with `previous` a snapshot. Found the debounce needs per-condition start times that a snapshot does not hold. Chose: `previous` is the prior call's returned `state`, and the result is `{ state, begin, end, pending }`. Why: keeps the function pure without a second store.
- **Unread watermark.** Plan said unread = non-info entries with `firstAt > seenAt`. Chose an entry-id watermark (`markSeen()` takes no time). Why: two events in the same millisecond, or a seeded entry with an old `firstAt`, would otherwise be miscounted.
- **Earlier-session entries never count as unread.** Plan was silent. Chose: entries from the journal seed (source `Earlier session`) are context and never raise the badge. Why: otherwise every new pane would open with a yellow or red badge for history the user has already lived through.
- **Extra verdicts.** Plan listed fetch verdict `other` as `problem`. Found `classify()` also returns `unusable-output`, and some tab errors are `kind: "text"`. Chose: both are `problem`. An `other` error whose text is the shared-budget pause (`API budget paused …`) is `wait`. Why: the pause is a self-resolving wait; a failed refresh is a problem.
- **Coalescing barrier includes affected tabs.** Plan said a repeat coalesces "if no non-info entry of that source came after". Review found a Core-sourced wait would not split Actions refreshes. Chose: the barrier is a later non-info entry with the same source or one that affects the same tab (`tabs` on each entry). A coalesced entry moves to the newest position.
- **Fetch condition keys include the level** (`fetch:<tab>:<level>:<verdict>`). Why: review found a budget pause and a real failure share verdict `other`, so a pause turning into `HTTP 502` was never recorded.
- **Journal seed of a cause re-journaled for a new origin or tab** stays one entry.

### Phase 2

- **Tab bar tiers.** Plan: fall back to digit-only names, then truncate names. Chose three measured tiers: full names (margin 2) from 98 columns with the existing hysteresis, short names (margin 1, `Notices`), then digits with counts and no names (`[1(4)] 2(3) 3 4(0) 5(2)`, margin 1). Why: five short labels with margin 2 are 81 columns, so 80-column panes would have lost names; the digit tier fits 40 columns with counts.
- **PTY harness tab-bar detection.** `test/pty/capture.mjs` recognized a dashboard frame only by `1:Act`. The digit tier has no names, so the pattern now also accepts a line with the five digits in order (unit test added in `test/pty/capture.test.mjs`).
- **Esc in the view returns to the last data tab.** Plan was silent. Esc quits from ordinary navigation, but every other view (Focus, CI, attention) uses Esc for "back"; the view follows them.
- **Data-tab keys are ignored in the view** (Enter, `/`, `s`, `g`, `w`, `d`, `a`). Why: they would act on a hidden tab.
- **`r` in the view** refreshes the last data tab until Phase 3 replaces it with a GitHub status check, as the phase file says.
- **Repeat count glyph.** Plan: `×N`. Chose `xN`: `×` is East Asian Ambiguous width and this file avoids such glyphs in fixed-width rows.
- **View rows show the remedy for `action` entries only**; open waits show their live next retry (from the current cause or governor hold), which the time an entry began cannot tell.
- **Wait-cause PTY fixture.** Plan named a `budget-stale` fixture; none exists. Used a live governor lock (`busy`, "Coordinating with your other panes"), which is the same level and a reliable sustained wait.
- **Existing PTY expectations changed by design** (all were waits or Security notes that moved): `cache` rate-limit restart (badge instead of inline text), `context-help` NAV-06 (waits for the badge to settle before opening help, because a linear reader reprints on change), `status` D6 (cause and action read from help), live-locked storage (badge, no inline notice), stale acquisition-busy (read from the view at 80 columns, badge at 24), sustained coordination notice (badge latency instead of inline latency), linear screen-reader stale limit (read from the view).
- **`test/onboarding.test.mjs`** needed no change: it tests `dashboardPresentation()`, which still feeds the no-table panel and help. The inline Security rows (`visibleSecurityLines`) were removed from the table path; Security notes reach Notifications through the snapshot (`notificationConditions`, unit-tested).

## Findings and dispositions

### Phase 1 independent review

| # | Finding | Disposition |
|---|---|---|
| 1 | Budget pause and real failure shared one key | Fixed; test "a budget pause that becomes a real failure records the failure" |
| 2 | Resource-sourced wait did not split tab refreshes | Fixed (`tabs` barrier); test "a resource wait affecting a tab splits that tab's refreshes" |
| 3 | No seed test for a superseded cause | Added |
| 4 | Unavailable seed test could pass vacuously | Test now asserts `readRecoveryTransitions(...).status` first |
| 5 | Same code re-journaled showed twice | Fixed; test added |
| 6 | Seeded entries stay open forever | Phase 2 renders `Earlier session` entries dimmed |
| 7 | `end()` after truncation is silent | Documented in a comment |

### Phase 1 simplify pass

Applied: shared `recoveryResourceLabel()` (also used by `presentRecovery`); `NOTICE_RESOURCE_TABS` computed once; direct `RECOVERY_COPY` lookup in conditions; `list()` cached until the log changes; `shift()` for the bound; `findLast` in `end()`; removed the `seeded` flag (source decides) and the `note` option (a superseded seeded cause now gets the same "Cleared" line a live one gets); boolean debounce checks.

Skipped: a `budget-paused` verdict in `classify()` (changes retry ladders outside this plan); storing levels as a fourth `RECOVERY_COPY` element (the plan chose the exhaustiveness test); building action codes from `HARD_STORAGE_REASONS` (the exact-set test already catches drift); a single verdict table (the explicit 4-entry table reads more clearly); lazy text building (negligible cost).
