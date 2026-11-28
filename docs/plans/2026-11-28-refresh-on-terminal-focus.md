# Refresh on terminal focus: implementation plan

**Phase 1 accepted by the owner on 2026-11-28, with both 15 s values. Phase 2 revised the same day after owner review (see "Revision after owner review").** Project: `juan294/gh-glance`. Worktree: `/Users/juan/code/gh-glance`. Baseline: local `develop` at `154930d11cb83c25b6eae7adfcc366472a4ae0e4` (v0.20.0, identical to `origin/develop`). The only local changes are the two untracked November 28 research documents. Inputs: [descriptive research](../research/2026-11-28-background-refresh-of-inactive-tabs-and-panes.md) and the [assessment](../research/2026-11-28-intermediate-background-refresh-assessment.md), especially its "Owner review and corrections" section.

## Outcome

When a **standalone** gh-glance pane regains terminal focus, it checks its **selected data tab** in the background if that tab's data is older than 15 s. Cached rows stay on screen while the check runs. There is no check while Notifications is open, and none in connected (`--connect`) mode. Nothing else changes: hidden tabs, the on-demand schedule, quiet-poll counters, the governor, the shared store and the network transport keep their current behavior. In terminals without focus reporting, or in tmux without `focus-events on`, no focus events arrive and gh-glance behaves exactly as it does today.

Owner decision (2026-11-28): plan this now. Out of scope: the shared GraphQL watermark, any 60 s cadence, prefetching hidden tabs, and the safety-net sweep.

## Verified basis

| Fact | Evidence |
| --- | --- |
| Rex delivers `ESC [ I` on focus and `ESC [ O` on blur after `ESC [ ? 1004 h` | Live probe, 2026-11-28 (assessment, external facts) |
| Ink 7.1.1 parses both as unrecognized CSI tokens with code `[I` / `[O`, and the app's `useInput` receives unrecognized CSI tokens without the leading Escape | `node_modules/ink/build/parse-keypress.js` run in this session; `index.mjs:20453-20461`; owner review |
| A bare Escape quits the dashboard, so a leaked or split Escape is the main safety risk | `index.mjs:20558-20561` |
| The terminal lifecycle owns mode toggles, and `restoreScreen` disables mouse modes before releasing the alternate screen | `index.mjs:23460-23495`, `index.mjs:23510-23512` |
| Every exit and handoff path calls `restoreScreen` | `index.mjs:23539`, `index.mjs:23614`, `index.mjs:23650`, `index.mjs:23693` |
| `requestTab` reuses fresh shared snapshots, joins work in flight (only a manual press queues a follow-up) and respects backoff. It assigns intent priority `manual`, `active` or `background`. The `"tab-switch": 1` constant is never assigned there | `index.mjs:22160-22185`, `index.mjs:22238-22265`, `index.mjs:22281`, `index.mjs:2843-2849` |
| The tab-switch wrapper adds side effects that a focus return must not have: it resets the quiet-poll counter, clears other on-demand requests and cancels other tabs' pending work | `index.mjs:22603-22628` |
| Connected-mode refresh is manual: it retries paused transport and starts a manual poll | `index.mjs:21567-21574`, `index.mjs:10937-10939`, `index.mjs:11349-11352` |
| Notifications is a separate open state, and `activeIndexRef` still points at the data tab under it | `index.mjs:19415-19417`, `index.mjs:19508` |
| Non-manual requests respect the tab's failure backoff | `index.mjs:22185` |
| A focus-driven Issues check costs 1 GraphQL point (2 reserved). A quiet Actions or Security check is a free `304` | Owner review; `index.mjs:2738-2739`, `index.mjs:2104-2160` |
| `xterm` mode 1004 can be combined with mouse modes | https://invisible-island.net/xterm/ctlseqs/ctlseqs.html (Patch #411), retrieved 2026-11-28 |
| SWR's default focus throttle is 5 s; TanStack refetches on focus only when the data is stale | https://swr.vercel.app/docs/api ; https://tanstack.com/query/latest/docs/framework/react/guides/important-defaults, retrieved 2026-11-28 |

## Design choices

| Decision | Choice | Alternatives considered and why rejected |
| --- | --- | --- |
| Request path | A small standalone entry point inside the acquisition effect: for an on-demand secondary tab, add the tab's one-shot request without clearing any other entry, then call `requestTab(key, "active")`. No quiet-counter reset, no `requestedTabs.clear()`, no cancellation of other pending work, no deadline replacement | The tab-switch wrapper (`index.mjs:22603-22628`) has those side effects: on a quiet Actions pane it would return polling to the floor. `manual` (the `r` path) bypasses the failure backoff and can request a budget probe (`index.mjs:22185`, `index.mjs:22198-22203`). A new request kind would add scheduler branches for no gain |
| Minimum age | 15 s from the tab's last successful source observation (`lastOkRef`) | 30 s (`STALE_AFTER_MS`) skips most quiet Actions checks, which are free, and makes PTY tests slow. 5 s (SWR) re-checks on almost every return |
| Throttle | At most one focus-triggered request per tab every 15 s, timed from the attempt. This bounds retries when the age does not advance (failure, hold) | No throttle allows a request on every return while a tab is failing. A longer throttle hides real changes from users who move between panes often |
| When focus applies | Interactive TTY, standalone mode, every `--background` mode, including width mode and while Help or a feature view is open. Skipped while Notifications is open, during remote setup, and in connected mode (the entry point is installed only on the standalone path) | Connected refresh is manual and retries paused transport (`index.mjs:10937-10939`), which breaks the promise to respect holds and join existing work; it is deferred until verified in the collector. Notifications would fetch the data tab hidden behind it. Width mode suppresses `r` because `r` resets widths there (`index.mjs:16146-16151`); a focus event is not a key, so that conflict does not apply |
| User control | No new flag or environment variable | Terminals that lack mode 1004 ignore it. Add an opt-out only if a terminal proves to misbehave (revisit trigger) |
| Mode lifetime | Enable once after mount for an interactive TTY. Disable on unmount and in `restoreScreen`, before `?25h`/`?1049l`, together with the mouse modes | Toggling focus reporting per view adds states without any benefit |
| Naming | "terminal focus" in code and docs | The existing "Focus" is the Jev semantic filter (`test/focus.test.mjs`) and must not be confused with this |

Cost ceiling (INFERRED): the throttle caps focus attempts at 240 per hour for one tab. At the measured 1 point per Issues page that is about 240 GraphQL points for a single-page list. The app reserves 2 points per page (480). A tab that has loaded extra pages costs more per check. The governor still decides admission and keeps the 20% reserve. Normal use is one attempt per return to a pane with data older than 15 s.

## Phases

| Phase | Work | Primary acceptance evidence |
| --- | --- | --- |
| [1. Focus reporting lifecycle and input safety](2026-11-28-refresh-on-terminal-focus-phases/phase-1.md) | Mode 1004 on and off through the terminal lifecycle. Consume `[I` and `[O` before every key binding, with no refresh yet | Unit lifecycle ordering. PTY: focus events in every view change nothing and never quit; a split Escape+`[I` inside Ink's pending window never quits; exit disables 1004 before leaving the alternate screen; headless output has no 1004 |
| [2. Revalidate the selected tab on focus-in](2026-11-28-refresh-on-terminal-focus-phases/phase-2.md) | A pure decision function plus a standalone-only entry point into `requestTab`, with no tab-switch side effects. Help text, README, CHANGELOG | Unit decision table. PTY request counts: one Issues page for a stale focus-in, none for fresh/throttled/blur, no hidden-tab requests, conditional Actions that keeps its quiet cadence, backoff and reserve hold respected, nothing under Notifications or in connected mode, cached rows visible throughout |

Both phases change `index.mjs` and the same PTY files, and phase 2 depends on phase 1. No unit is batch-eligible. Execute and accept them sequentially.

## Implementation and acceptance

Use an isolated local worktree from the baseline above. One owner integrates locally into `develop`. Follow the atomic loop: failing test, implement, independent review, repair, simplify, verify. Stop after each phase for owner acceptance unless the owner authorizes continuation. A push or release needs its own authorization and the release playbook.

**Automated, each phase, sequentially:** `npm run lint`, `node --check index.mjs`, `npm test`, `npm run test:efficiency` (phase 2 adds automatic requests), `npm run test:pty` (terminal lifecycle and rendering). Before reporting, run both `npm test` and the new PTY files on Node 22 as well as Node 24 (memory: AbortSignal timing differs on 22). Record exit codes, Node versions and the tested commit.

**Manual (owner, after phase 2):** in Rex, leave a pane on Issues for at least 15 s, focus another pane, return, and watch the rows update in place without an empty or loading state. Optionally repeat inside tmux with `focus-events off` (no change in behavior) and `on` (refresh on return). This is a visual check only; correctness is proven by the automated request counts.

## Stuck states and recovery

| State | Who sees what | How it ends | Proof |
| --- | --- | --- | --- |
| Terminal or tmux sends no focus events | User sees today's behavior: Cached view, `r` to check | Nothing to end. README and `--help` say focus refresh needs focus reporting, and that tmux needs `set -g focus-events on` | Phase 1 PTY with no focus input: request counts equal the existing on-demand test. Phase 2 doc assertion in the help test |
| Focus-in while the tab is in failure backoff | Existing error line and "Press r" action remain; no new request | `r` bypasses the backoff as today; the ladder also expires by itself | Phase 2 PTY: failing `graphql-data` fixture, focus-in during backoff makes no call, then `r` makes one |
| Focus-in while the governor holds the resource (reserve, reset, throttle) | Existing Waiting/Paused status with reset or next time | Existing wake admits the pending intent when budget allows; the focus throttle prevents repeated intents | Phase 2 PTY: GraphQL fixture below reserve shows the existing hold status, and after the fixture budget recovers the pending request completes once |
| Throttle skips a focus-in that came within 15 s of the previous one | Cached age keeps counting up | The next focus-in after 15 s, a tab switch, or `r` | Phase 2 PTY: second focus-in within 15 s makes no call; `r` then makes one |
| Focus-in while Notifications is open | Notifications stays as it is; no data request for the tab behind it | Close Notifications. The usual tab-switch check runs, or press `r` | Phase 2 PTY TF-17 |
| Focus-in in connected mode | Today's connected behavior; no collector refresh | Not a stuck state: focus refresh is not offered there. `r` and tab switch work as today | Phase 2 PTY TF-18 |
| Escape split from `[I` beyond Ink's pending window | Dashboard quits, as for a real Escape press (same limit as mouse reports) | User relaunches. A split inside the window is consumed safely | Phase 1 PTY pins the inside-window split, modeled on the split SGR mouse report in `test/pty/mouse.test.mjs` |
| Crash, signal or `gh repo create` handoff while focus reporting is on | No stray `^[[I`/`^[[O` in the shell afterwards | `restoreScreen` disables 1004 on every path | Phase 1 unit ordering test plus PTY: `?1004l` precedes `?1049l` on normal exit and signal exit |

## Consumer sweep

Search: `rg -n "createTerminalLifecycle|enableMouseReporting|disableMouseReporting|restoreScreen\(|isMouseReportingEnabled|useInput\(" index.mjs test`. Repeat against the implementation base before editing.

| Consumer | Coverage |
| --- | --- |
| `createTerminalLifecycle` and its wrapper, `index.mjs:23460-23512` | Phase 1 adds focus functions; the existing mouse functions keep their return values |
| `restoreScreen` callers `index.mjs:23539`, `:23614`, `:23650`, `:23693` | Phase 1: no caller changes, because ordering is inside `restoreScreen` |
| Mouse effect `index.mjs:20168-20178` | Unchanged. Focus gets its own effect, gated only on `interactive` |
| `useInput` handler `index.mjs:20453` | Phase 1 adds the first branch |
| Unit lifecycle test `test/unit.test.mjs:2204-2230` | Phase 1 extends it. Existing assertions keep their byte strings |
| PTY parser `test/pty/capture.mjs:28-37`, `:415-440` | Phase 1 adds focus enter/exit counters next to the mouse counters. The generic `CSI` stripper already removes `?1004h`/`l` |
| Byte-exact restore fixture `test/pty/mouse.test.mjs:135-137` | Synthetic input to the parser; unaffected. Phase 1 confirms it still passes |
| Clean-capture helper `test/pty/keys.test.mjs:86-93` | Phase 1 confirms it still passes |
| `fetchTabRef` standalone `index.mjs:22602` and connected `index.mjs:21567` | Not called by focus. Phase 2 adds a standalone-only entry point next to `requestTab` (`index.mjs:22160`). Connected mode is explicitly excluded, and TF-18 proves that no collector refresh is sent |
| `requestTab` `index.mjs:22160` | Called unchanged with `kind: "active"`. Its existing in-flight, pending, backoff and follower branches give the join and hold behavior |
| `requestedTabs` `index.mjs:21397` | Phase 2 adds the focused key only. It never clears entries |

## Revision after owner review, 2026-11-28

| Owner finding | Verified | Change |
| --- | --- | --- |
| The tab-switch path is more than a refresh: quiet-counter reset, clearing other on-demand requests, cancelling other pending work | `index.mjs:22603-22628` | Focus uses its own standalone entry point into `requestTab(key, "active")`, with none of those effects. New TF-16 |
| Connected refresh is manual: it retries paused transport and can queue another poll | `index.mjs:10937-10939`, `index.mjs:11349-11352` | Scope reduced to standalone. New TF-18 |
| Notifications leaves `activeIndexRef` on the data tab | `index.mjs:19508` | Skip while Notifications is open. New TF-17 |
| 240 per hour is a ceiling on attempts; 240 points is a single-page estimate, and 2 are reserved per page | Owner review; `index.mjs:2739` | Wording corrected |
| (Self-found) The plan claimed priority 1 for tab-switch intents | `index.mjs:22281` | Corrected: intents are `manual`/`active`/`background` |

## Handoff

- Accepted decisions: focus refresh only, in standalone mode; phase 1 accepted; 15 s age and 15 s throttle kept by the owner. The revised phase 2 design above was chosen from repository evidence and owner review.
- Evidence limits: real end-to-end latency on GitHub (fixture timings only) and terminals other than Rex are unverified. Whether Ink always keeps a terminal's `ESC [ I` in one read is pinned only inside its pending window.
- No project overlay (`.rpi/project/rpi-plan.md` is absent). No delegated work in planning. No local resources allocated.
- Entry conditions for phase 1 (accepted): start `/rpi-implement` for phase 1 in a fresh session; `git status` and `HEAD` match the baseline or the differences are reconciled; re-run the consumer-sweep search.
