# Phase 2 · Revalidate the selected tab on focus-in

Baseline, decisions and stuck states are in the [main plan](../2026-11-28-refresh-on-terminal-focus.md). Entry condition: phase 1 accepted. Focus tokens are consumed and inert, and `terminalFocusRef` exists.

## Changes

1. **Constants** near `STALE_AFTER_MS` (`index.mjs:208`): `TERMINAL_FOCUS_MIN_AGE_MS = 15_000` and `TERMINAL_FOCUS_THROTTLE_MS = 15_000`, with a short comment that cites the assessment and SWR's 5 s focus throttle as the precedent.
2. **Pure decision**, exported for tests:

```
@ terminalFocusRevalidation({ nowMs, lastOkAt, lastAttemptAt, inFlight, fetcherReady }) -> { revalidate, reason }
pre: times are epoch ms or null
do:
  1. validate fetcherReady and not inFlight (reasons "unavailable", "in-flight")
  2. compute throttled = lastAttemptAt within TERMINAL_FOCUS_THROTTLE_MS (reason "throttled")
  3. compute age from lastOkAt; null means never loaded (reason "never-loaded", revalidate)
  4. emit revalidate when age >= TERMINAL_FOCUS_MIN_AGE_MS (reason "stale"), else reason "fresh"
risk: a future-dated lastOkAt must count as fresh, not as negative age
```

3. **Standalone entry point.** Inside the standalone branch of the acquisition effect, after the connected-mode early return (`index.mjs:21490-21582`), next to `fetchTabRef` (`index.mjs:22602`), set a `focusRevalidateRef.current = (key) => ...`. It does two things only: for an on-demand secondary tab it calls `requestedTabs.set(key, Date.now())`, so the one-shot survives an admission delay as other one-shot requests do (`index.mjs:21396-21405`), and then it returns `requestTab(key, "active")`. It must not reset `unchangedPolls`, call `requestedTabs.clear()`, cancel other pending items, or call `replaceActivePoll`. Those are tab-switch effects (`index.mjs:22603-22628`). The effect cleanup sets the ref to `null`. Connected mode never sets it.
4. **Handler.** In `App`, `terminalFocusRef.current` ignores `focused === false`. It also returns early when `notificationsOpenRef.current` is true, when `remoteSetupRef.current` is set, or when `focusRevalidateRef.current` is `null`. Otherwise it reads the selected tab (`activeIndexRef`), `lastOkRef.current[key]`, `inFlightRef.current[key]` and a per-tab `lastFocusAttemptRef`. When the decision says revalidate, it records the attempt time and calls `focusRevalidateRef.current(key)`.

```
@ focusRevalidate(key) -> Promise<requestTab result>
ctx: standalone acquisition effect (requestedTabs, requestTab)
pre: standalone mode; key is the selected data tab; Notifications closed
do:
  1. write requestedTabs[key] = now, only for an on-demand secondary tab (no clear)
  2. emit requestTab(key, "active") (in-flight, pending, backoff and follower branches unchanged)
fx: at most one governor intent, priority "active"
risk: must not reuse the tab-switch wrapper's counter reset or cancellations
```
5. **Disclosure.** Under `--background` in `--help` (`index.mjs:12550-12556`) and in the README freshness section (`README.md:905-913`, `README.md:451`): "In standalone mode, when the terminal reports focus, returning to the pane checks the selected tab if its data is older than 15 s. In tmux, enable `set -g focus-events on`." Add a CHANGELOG `## [Unreleased]` entry (memory: diff against the last tag so the entry does not land in a published section).

## Tests (write first, see them fail)

- `test/poll-policy.test.mjs` or a new `test/terminal-focus.test.mjs` unit table, one case per reason: unavailable, in-flight, throttled at 14,999 ms and not at 15,000 ms, never-loaded, fresh at 14,999 ms and stale at 15,000 ms, and future `lastOkAt` counted as fresh.
- `test/pty/terminal-focus.test.mjs`, extending phase 1 with the request counting from `test/pty/adaptive-polling.test.mjs:14-70` (`fixture`, `graphqlEvents`, `pathEvents`, `isConditional`, `waitForIssuePages`):
  - TF-10: `--repo acme/widget --refresh 2`. Press `2`, wait for one `issues.page`, sleep 16 s, send `\033[I`, wait for a second `issues.page`. Exactly 2 Issues pages, 0 `pulls.page`, 0 alerts requests. Every captured frame after the first page still shows a fixture issue title (cached rows visible throughout, no "Waiting to check" or empty state). Final frame shows `Cached`.
  - TF-11: after TF-10's second page, an immediate second `\033[I` and a `\033[O` cause no third page. Then `r` causes exactly one.
  - TF-12: focus-in less than 15 s after a page makes no request.
  - TF-13: on Actions, a focus-in after more than 15 s of quiet produces a runs request that carries `If-None-Match` and charges 0 core.
  - TF-14: with `GH_GLANCE_FIXTURE_FAIL` on `graphql-data`, the Issues error line shows. A focus-in during the backoff makes no new call, and a following `r` makes one.
  - TF-15: with the fixture GraphQL `remaining` below the reserve, a focus-in shows the existing hold status and makes no data call. After the fixture budget is restored, exactly one Issues page follows without another focus-in or key.
  - TF-16 (no tab-switch side effects): Actions with completed runs reaches the quiet 30 s cadence (two unchanged results, `test/pty/adaptive-polling.test.mjs:100`). A focus-in more than 15 s after the last check makes one conditional runs request. The next scheduled runs request then comes at least 25 s later, not at the 2 s floor. A second case starts an Issues request that is held by the fixture (`delayByCommand: { "graphql-data": ... }`) and then focuses on Actions. The Issues request still completes, so focus cancelled no pending work.
  - TF-17: open Notifications, wait more than 15 s, send `\033[I`. No Issues, PR, Actions or alerts request follows.
  - TF-18: in the existing local-collector setup of `test/pty/collector.test.mjs`, a focus-in sends no `refresh` message to the collector and makes no extra poll. Use the collector's own message log or call count, whichever the existing cases already assert.
- Efficiency: confirm `npm run test:efficiency` still passes unchanged. Focus events do not occur in its simulation, so any difference is a regression.

## Automated acceptance

The new tests pass, then the full main-plan sequence: lint, syntax, `npm test`, `npm run test:efficiency`, `npm run test:pty`. Run the unit suite and `terminal-focus.test.mjs` on Node 22 as well as 24. Record the commit, the Node versions and the exit codes.

## Manual acceptance (owner, visual)

In Rex, with the built checkout: put a pane on Issues, wait more than 15 s, focus another pane, return. The rows remain and then update in place. Optionally, in tmux with `focus-events off`, the behavior is unchanged from today.

## Completion

- [ ] Decision function, standalone entry point and handler, with unit table
- [ ] TF-10 to TF-18 green; efficiency unchanged; full local gates green on Node 24 and the focused set on Node 22
- [ ] Help, README and CHANGELOG updated, and checked against the last tag
- [ ] Independent review and simplify pass; owner visual check recorded
