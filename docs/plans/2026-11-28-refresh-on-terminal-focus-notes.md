# Refresh on terminal focus: implementation notes

Plan: `2026-11-28-refresh-on-terminal-focus.md`. Base: `develop` at `154930d11cb83c25b6eae7adfcc366472a4ae0e4`. Worktree: `../gh-glance-focus`, branch `feat/terminal-focus-refresh`. The owner authorized all phases without stopping, then a local merge into `develop` and worktree removal (2026-11-28). No push was authorized.

No project overlay exists for `rpi-implement` (`.rpi/project/rpi-implement.md` is absent).

## Deviations

### Phase 1

| Plan said | Found | Chose | Why |
| --- | --- | --- | --- |
| TF-01 checks the TERM exit in `terminal-focus.test.mjs` | A signal-terminated capture backgrounds the app, so stdin is not a TTY and focus reporting is never enabled. The mouse suite already drives SIGTERM, crash and `gh` handoff through a preloader | Focus assertions added to those three real-run cases in `test/pty/mouse.test.mjs`. The `q` exit stays in TF-01 | Reuses the proven signal harness. No duplicated preloader |
| TF-02 covers the CI line-range draft in the new file | The draft needs the Jev, CI log and HTTPS fixtures of `test/pty/ci-observations.test.mjs` | Focus reports are sent while the draft is open in the existing "range editor owns q" case. The draft must read `CI range > q` afterwards | Same assertion, no second copy of the CI fixture setup |
| TF-05 is a new run with no focus input | That run would duplicate "default on-demand tabs stop after opening" (`test/pty/adaptive-polling.test.mjs`), which now runs with focus reporting on | That case asserts `focus1004Enter === 1` with its existing request counts | Same evidence without another 35 s PTY run |
| Frame unchanged after a focus report | Whole-frame equality is unstable because ages tick | The tab bar line, the selected row and a view marker must be identical before and after | Detects every leak we can produce (the guard removed makes TF-02 fail at "help: selection changed") |
| Focus guard is "the very first branch" | It is the second branch, after the SGR mouse `[<` branch. The two never match the same input | Kept | Recorded after independent review; no behavior impact |

Phase 1 review (fresh-context agent, 2026-11-28): no blocking findings. Repairs applied in the phase 2 commit:

- A focus report read together with a user's Escape arrives as meta plus `\x1b[I`; it is now consumed too.
- Focus reporting is off while remote setup owns the terminal, so a buffered report cannot reach `gh repo create`. The remote-setup PTY assertion now requires every enable to have a later disable.
- TF-02 now proves a selected row exists before comparing it (the first version compared two empty strings on Issues, because nothing is selected until you move), and asserts that no `gh` call follows a focus report.

Rejected as non-actionable: the TF-03 split cannot prove two reads through `script(1)`. This is the same limit as the SGR mouse precedent and is recorded in the plan's evidence limits.

### Phase 2

| Plan said | Found | Chose | Why |
| --- | --- | --- | --- |
| Call `requestTab(key, "active")` unchanged | A non-manual, non-forced request returns the shared snapshot as `fresh` while `snapshot.nextDueAt` is in the future (`acquisitionEngine.refresh`, `requestedGeneration <= record.generation && record.snapshot?.nextDueAt > now()`). A quiet Actions tab is due 30 s after its last check, so a focus-in at 16 s would fetch nothing | New `revalidate` option on `requestTab`: the engine call uses `force: manual \|\| force \|\| revalidate`. Transport `force` (validators), priority, backoff and the manual probe are unchanged | Without it the plan's outcome ("checks if older than 15 s") and TF-13/16 cannot hold. A fresh shared observation from another pane still updates `lastOkRef`, so the 15 s age check suppresses a duplicate |
| TF-13 and TF-16 are separate | Both need the same quiet-Actions setup | One test: a conditional request with 0 core, starting within 3 s of the focus-in, and the next scheduled check at least 25 s later | One 60 s run instead of two |
| TF-16 second case: a held Issues request completes after focus on Actions | Reaching Actions from Issues needs a tab switch, which is the path under comparison, and the Issues request is in flight rather than governor-pending, which neither path cancels. The test could not tell the two paths apart | Not added. The entry point is reviewed to contain no `cancelPending`, `requestedTabs.clear()`, `unchangedPolls` write or `replaceActivePoll` | A test that cannot fail on the regression is not evidence |
| TF-14 uses `GH_GLANCE_FIXTURE_FAIL` | With `GH_GLANCE_FIXTURE_STATE` set, the fixture runs `gh-state.mjs`, which takes failures only from its state file | State `failure: { selector: "graphql-data", remaining: 2, message: "HTTP 404: Not Found" }` ("unavailable", 60 s ladder) | Same verdict and ladder through the fixture's supported switch |
| TF-15: focus-in during a hold, then the fixture budget is restored | Lowering the budget mid-run is not observed until the next response | GraphQL starts below the reserve with a reset at 14 s. Opening Issues is held; two focus-ins during the hold add no request; after the reset exactly one Issues page completes | Same property: focus joins the held intent and adds none |
| TF-13 "0 GraphQL" | The GraphQL budget observer runs on its own schedule | Assert no GraphQL data page (`*.page`) | The observer is control-plane work, not a focus request |

Phase 2 review (fresh-context agent, on `ea87155`): no blocking findings. Dispositions:

- Should-fix, fixed: README and CHANGELOG said "one conditional request". Issues and PRs are GraphQL pages without validators, extra loaded pages are fetched too, and Security makes several source requests. The text now says the check covers that tab only and is a free conditional request on a quiet Actions tab. "Older than 15 s" became "at least 15 s old", matching `>= 15_000`.
- Should-fix, fixed in part: TF-11 could not fail if the throttle or the blur guard were removed, because its second focus-in lands on fresh data. TF-10 now sends a focus-out on data at least 15 s old and requires no request. The attempt throttle cannot be observed in a PTY run, because backoff, holds and in-flight work already block a repeat. Its evidence is the unit table (14,999 ms throttled, 15,000 ms not). This corrects the plan's stuck-state row "second focus-in within 15 s makes no call", which claimed PTY proof.
- Should-fix, addressed below: the gate evidence now names the final commit, and the full `npm run test:pty` and the Node 22 and 24 focus runs are recorded against it.
- Nits accepted without change: `void` on the request promise has the same exposure as the existing `fetchTabRef` callers; a focus-in before the first scope exists behaves like the mount tab switch; focus still fires under Help, width mode and feature views, as the plan allows.
- `revalidate` (renamed `newGeneration` in the simplify pass) was accepted. A cancelled or failed forced claim leaves `requestedGeneration` one ahead, which only makes the next scheduled refresh claim instead of follow. Manual `r` already does this.

Simplify pass (four parallel reviewers: reuse, simplification, efficiency, altitude). Applied:

- `terminalFocusRevalidation` no longer takes `fetcherReady`; the caller checks the entry point once. The `terminalFocusRef` indirection became a plain `handleTerminalFocusIn`, called only on focus-in. One regex replaces four string comparisons. Shorter comments.
- `requestTab`'s option is named `newGeneration`, after what it asks of the engine.
- `parseCapture` computes `focusEnableAfterAltEnter`; both `assertFocusLifecycle` copies use it.
- TF-18 moved into `test/pty/collector.test.mjs` to reuse its entry, fixture, config and `waitForExit`, and it now waits for the collector to exit.
- The driver parses the fixture state once per read and the screen once per sample. TF-13/16 checks a 26 s window instead of waiting for a fifth run (about 4 s shorter). TF-18's trailing wait is 2 s.

Skipped: one shared one-shot helper for the three `requestedTabs` sites (unifying them would change the existing Actions behavior at the two older sites); a leading-Escape strip for mouse reports too, and moving the disable into `createRemote` (both change mouse behavior outside this diff); a boolean-only decision result and a single constant (the plan's table pins the reasons, and the owner accepted the age and the throttle as separate values).

## Gate evidence

Recorded per run. Exit code 0 means every test in the selection passed.

| Candidate | Check | Node | Result |
| --- | --- | --- | --- |
| Phase 1 (`5b74e0e`) | `npm run lint`, `node --check index.mjs` | 24.22.3 | 0, 0 |
| Phase 1 (`5b74e0e`) | `npm test` | 24.22.3 | 0 (1146/1146) |
| Phase 2 working tree (committed below as the phase 2 commit) | `npm run lint`, `node --check index.mjs` | 24.22.3 | 0, 0 |
| Phase 2 working tree | `npm test` | 24.22.3 | 0 (1148/1148) |
| Phase 2 working tree | `npm run test:efficiency` | 24.22.3 | 0 (9/9) |
| Phase 2 working tree | `npm test` equivalent (`node --test --test-skip-pattern='E2E-' test/*.test.mjs`) | 22.22.2 | 0 (1148/1148) |
| Phase 2 working tree | `test/pty/terminal-focus.test.mjs` | 22.22.2 | 0 (8/8) |
| Phase 1 (`5b74e0e`) | `npm run test:pty` | 24.22.3 | 0 (273 passed, 0 failed, 2,678 s) |
| Final (`81a3056`) | `npm run lint`, `node --check index.mjs` | 24.22.3 | 0, 0 |
| Final (`81a3056`) | `npm test` | 24.22.3 | 0 (1148/1148) |
| Final (`81a3056`) | `npm run test:efficiency` | 24.22.3 | 0 (9/9) |
| Final (`81a3056`) | `npm test` equivalent | 22.22.2 | 0 (1148/1148) |
| Final (`81a3056`) | `test/pty/terminal-focus.test.mjs`; TF-18 in `test/pty/collector.test.mjs` | 22.22.2 | 0 (7/7); 0 (1/1) |
| Final (`81a3056`) | `test/pty/terminal-focus.test.mjs`, `test/pty/mouse.test.mjs`; TF-18 | 24.22.3 | 0 (14/14); 0 (1/1) |
| Final (`81a3056`) | `npm run test:pty` | 24.22.3 | **1** (278 passed, 1 failed, 2,825 s) |
| Final (`81a3056`) | `test/pty/status.test.mjs` rerun | 24.22.3 | 0 (26/26) |

### Resolved: intermittent "linear screen-reader output retains startup, holds..." failure

The one failure in the final `npm run test:pty` run is `test/pty/status.test.mjs:1244`. Its core-exhausted capture expected `reset \d+m`. Instead it showed "Paused coordination" with the fallback copy "Local coordination unavailable". The capture lasted 1.86 s and made no core observer call (`api -i user`). The test's barrier waits for any "Paused", so a transient coordination pause satisfies it before the reset hold is published.

- VERIFIED: the test sends no focus input. A file probe in `handleTerminalFocusIn` (positive control: 5 entries in TF-01) logged no focus-in in 14 runs of this test.
- VERIFIED: in isolated reruns on `81a3056`, it failed 1 of 3 at first, then passed 18 in a row. The whole file passed once (26/26). It passed 13 of 13 on the base `154930d`.
- INFERRED: a startup coordination race that the loose "Paused" barrier exposes. It is not caused by focus code, which no run reached. With 2 failures in 22 candidate runs and 0 in 13 base runs, the sample cannot rule out a timing contribution from the extra `?1004h` write at mount. The root cause is unproven.
- Disposition: recorded as an open risk for owner review. Next step if it recurs: tighten the barrier to wait for `reset \d+m`, and compare failure rates with the focus effect disabled.

Resolved 2026-11-28. The owner accepted the focus feature and diagnosed the test. In three diagnostic runs on the same fixture, waiting for the reset time showed "Paused coordination" followed by "Paused reset 60m" every time. The barrier now waits for `reset [0-9]+m` and the assertion is unchanged, so the test still fails if the rate-limit message never appears. After the change the test passed 5 of 5 in isolation and `test/pty/status.test.mjs` passed 26 of 26 (Node 24.22.3). No focus code changed. The recorded full `npm run test:pty` result for `81a3056` stays 278 passed, 1 failed.

