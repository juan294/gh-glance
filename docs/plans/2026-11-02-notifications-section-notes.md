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
