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

- **Tab bar tiers.** Plan: fall back to digit-only names, then truncate names. Chose measured tiers (two more were added after the final gate, see below): full names (margin 2) from 98 columns with the existing hysteresis, short names (margin 1, `Notices`), then digits with counts and no names (`[1(4)] 2(3) 3 4(0) 5(2)`, margin 1). Why: five short labels with margin 2 are 81 columns, so 80-column panes would have lost names; the digit tier fits 40 columns with counts.
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

### Phase 2 independent review (commit `28f4e28`)

| # | Finding | Disposition |
|---|---|---|
| 1 | Esc with help open over the view quit the app | Fixed: Esc closes help there; covered in the keys PTY case |
| 2 | Footer offered "Create remote" while the view was open | Fixed: `remoteSetup` hint suppressed in the view |
| 3 | Events arriving while help covered the view were marked seen | Fixed: `markSeen` only while the view itself is visible |
| 4 | Keys PTY case did not check each step | Fixed: asserts the full active-position sequence `1,4,5,1,5,1,2,5,3,5,3` |
| 5 | Cache restart test lost the request-limit cause check | Fixed: an extra interactive capture reads it from the view |
| 6 | Sustained-notice case asserts a `(\d+)` badge, not `(1)` | Accepted: other waits can share the count; zero rows and view text are covered by `test/pty/notifications.test.mjs` |

### Phase 2 simplify pass

Applied: one five-position navigation (`selectPosition`, `stepPosition`) shared by the view and the data tabs; the sync skips renders whose inputs are identical and re-arms its debounce timer only when the due time changes; `liveRetry` and the log summary are computed only while the view is open; `decisionRetryAt()` replaces two copies of the retry chain; the tab-bar margin is resolved once and the unreachable fallback removed; `notificationViewLines` returns `pageRows` and computes "today" once.

Skipped: one shared clock formatter with `dashboardPresentation` (different day formats); cell-width measurement in `tabBarWidth` (labels are ASCII plus one-cell spinner glyphs); moving PTY test helpers into `capture.mjs` (local helpers are the existing pattern); replacing `notificationBadgeRef` with a functional setState (that still schedules a render, which the ref avoids); one body-level branch for the view instead of per-element guards (larger JSX restructuring for no behavior gain); a simpler first-entry tab-bar regex (the five-digit pattern is stricter against table rows); returning the tone from `criticalInlineLines` and remedy-first ordering in `presentRecovery` (cosmetic; `presentRecovery` is outside this plan).

### Phase 3

- **History order.** Phase 2 fixes and the Phase 3 source were committed together (the fixes landed while Phase 3 was in progress in the same worktree).
- **Coalescing of open conditions.** An updated GitHub incident is recorded again under the same key. The Phase 1 barrier would have opened a second entry for it, and that entry would never end. Chose: the barrier applies to informational repeats (refreshes) only; a non-info record for an open key always coalesces and replaces the text.
- **First check at mount.** The plan lists the 10-minute cadence plus triggers. The monitor also checks once when the dashboard mounts, so an outage colours the badge without opening the view.
- **Header for an unchecked host or invalid value** reads `GitHub status not checked for <host>`, `GitHub status checks off (GH_GLANCE_GITHUB_STATUS)` or `GH_GLANCE_GITHUB_STATUS value not recognised; GitHub status checks off`.
- **Spawner sweep.** Every TUI launch in tests and scripts goes through `test/pty/capture.mjs` (`capture`, `captureAsync`, and the scripts `measure-feature-interaction.mjs`, `measure-jev-interaction.mjs`, `test/pty/readme-sample.mjs` import it), whose `captureEnvironment` now sets `GH_GLANCE_GITHUB_STATUS=off` unless a test supplies a value. The other spawners (`--serve`, `--collector-stdio`, `--doctor`, `--version`, argument and package checks) have no TTY or never mount the dashboard; `test/github-status.test.mjs` proves `--version`, `--help` and `--doctor` make zero requests to an override URL.

### Phase 3 independent review (commit `3c6e4ff`)

| # | Finding | Disposition |
|---|---|---|
| 1 | A 304 after an unavailable check left the header "unavailable" for 10 minutes | Fixed: the monitor keeps the last good summary apart from reachability; test "a 304 after an unavailable check restores the last good summary" |
| 2 | `--help` did not list `GH_GLANCE_GITHUB_STATUS` | Fixed; the non-TUI test asserts it in `--help` output |
| 3 | No tests for stop() during a fetch or a declared oversize body | Added both |
| 4 | Coalescing change had no direct log test | Added "an open condition recorded again updates its entry past newer problems" |
| 5 | Non-TUI test discarded command outcomes | Now asserts `--version` and `--help` output and that `--doctor` reports |
| 6 | Incident updates raised the repeat count | Fixed: only informational repeats count; an update replaces the text |
| 7 | An unresolved host (null) still checks github.com | Accepted: an unresolved host means github.com everywhere else in gh-glance (`normalizeHost`, `dashboardTarget`) |
| 8 | `fetch` ignores `HTTPS_PROXY` | Documented in README with the off switch; adding proxy support is new scope |
| - | `--doctor` could show the variable | Not done: an override URL is user-supplied and doctor lists only vetted plain values; out of scope |

### Phase 3 simplify pass

Applied: one map of open GitHub conditions and one loop instead of two; the component status label stored once at parse time; `summary` and `unavailable` replace the mixed `result`; the 304 outcome no longer carries an unused validator; the App keeps the config in a ref and stores only `monitor.current()`; the header line is built only while the view is open.

Skipped: Node `mock.timers` instead of the test's fake clock (the explicit clock awaits each check); a "sticky while open" log property instead of the outage override in App (one line in App is simpler than a new log concept); suppressing `onChange` after a 304 (one render per 10 minutes); sharing `readBoundedText` with the Jev reader (outside this plan).

### Final gate findings (candidate `7a5f875`)

The first complete gate passed lint, syntax, `npm test` (1,099) and `npm run test:efficiency` (9), and failed 5 of 265 PTY tests:

| Test | Cause | Disposition |
|---|---|---|
| SET-06 storage recovery at 24x10 | Regression from Phase 2 (passes 2/2 at `7686e40`, fails at `28f4e28` and `7a5f875`): at 24 columns the digit tier plus a `(1)` badge is 25 cells in a 23-cell frame, so the bar overflowed. Before this change Ink truncated the four names. | Fixed: two more tiers, no gaps (`tight`) and bare digits that keep only the Notifications badge (`digits`); unit test at 33, 32, 23 and 19 columns |
| Stale acquisition-busy at 24 columns (badge `5(n)`) | Same overflow | Fixed by the same tiers |
| Cache restart: `Paused 2m0s` | Exact seconds: the rows are aged two minutes before launch, and a badge render after the first second shows `2m1s`. Failed 1 of 3 runs at `28f4e28` too. Badge renders happen only when a new wait or problem arrives, never on routine refreshes. | Test now matches `Paused 2m\d+s` |
| Notifications wait case header | Captures now default `GH_GLANCE_GITHUB_STATUS=off`, so the header says so | Test expectation updated |
| Jev Focus 60/60/30 at 100 columns (and Jev Focus 40 in one rerun) | Did not reproduce: both passed in the next run of `test/pty/jev-focus.test.mjs` | Recorded as an unreproduced timing failure |

### Post-merge: untagged GitHub incidents (2026-11-02)

- **Found:** githubstatus.com's `incidents.json` (the last 50 real incidents) showed every field the parser reads, and that 6 of the latest 20 incidents carry no component tag. Phase 3 kept all untagged incidents as problems, so Copilot-only or billing incidents would have turned the badge red.
- **Owner decision (2026-11-02):** untagged incidents are problems only when the name names a surface the dashboard shows (`GITHUB_STATUS_RELEVANT_NAME`: Actions, runners, issues, pull requests, requests, webhooks, Git, API, repositories, Dependabot, code or secret scanning, security, "GitHub services"); otherwise they are `info` entries, never an outage, and the header reads `GitHub status: no incident affecting this dashboard (N others)`. An unnamed untagged incident is `info`.
- **Evidence:** of the 50 real incidents, 41 are kept (9 are tagged only with untracked products); the untagged ones split as listed in `test/github-status.test.mjs` `RECENT_INCIDENTS`. The 50-incident body is 274 KB (over the 256 KiB cap), but the live summary carries only unresolved incidents; the largest real incident was 23 KB.
