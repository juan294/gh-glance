# Research: rate-limit rendering and restart state

> 2026-08-11 | Branch `develop` @ `9f5c09a`

## Scope

This document traces two observed states:

1. During a long rate-limit window, old status-bar lines remain visible and
   accumulate from the bottom of the terminal.
2. After exit and restart during the same rate-limit window, Actions shows its
   error banner and headers but no rows.

It describes the current implementation and test coverage only.

## Rate-limit state and the status bar

GitHub errors are classified as rate-limited before they can be classified as
authentication or availability failures (`index.mjs:362-417`). The rendered
remedy is `GitHub rate limit reached -- backing off, this clears on its own`
(`index.mjs:434-442`, `index.mjs:493-504`). Rate-limited calls use a flat
60-second retry ladder (`index.mjs:155-163`, `index.mjs:1137-1146`). The
backoff registry is module-scope state (`index.mjs:1115-1159`).

A failure after a successful fetch does not clear the prior payload. The
success path updates `lastOkRef`, data, metadata, and the tab error
(`index.mjs:3946-3977`). The failure path updates the error and backoff but does
not write `data` (`index.mjs:3983-4005`). This is the state in which old rows
remain visible while the active tab reports a rate-limit error.

Staleness is measured from the last successful poll (`index.mjs:3513-3517`,
`index.mjs:4222-4236`). The adaptive interval is held in React state and in the
poll effect closure (`index.mjs:3434-3437`, `index.mjs:4059-4109`). The status
bar renders fetching, stale, and throttled state on one line
(`index.mjs:3237-3328`, `index.mjs:4500-4511`). Polls change the loading state
on their start and completion paths (`index.mjs:3926-3929`,
`index.mjs:4007-4010`).

## Full-height incremental rendering

The root Ink box is the full reported terminal height
(`index.mjs:4361-4364`). The app enables Ink incremental rendering
(`index.mjs:4624-4633`, `index.mjs:4700`). Ink's incremental writer moves the
cursor to the prior frame's first row, walks unchanged rows, and writes only
changed rows (`node_modules/ink/build/log-update.js:105-197`). Ink also records
that a cursor/scroll desynchronization on an exact-fullscreen frame can leave
stale copies; its built-in full-clear fallback for that case is limited to
Windows consoles (`node_modules/ink/build/ink.js:83-111`).

The app has one column of horizontal slack because Ghostty split panes were
observed to clip or misrender the last column (`index.mjs:4262-4268`). There is
no matching vertical slack: the root continues to occupy the full reported row
count (`index.mjs:4361-4364`).

An active tab error adds one reserved line and reduces the table body by one
line (`index.mjs:3477-3486`). The root height stays fixed, and the status bar
remains the last child (`index.mjs:4361-4364`, `index.mjs:4494-4511`).

## Restart behavior

Each process initializes all four data slots to `null`, all four loading slots
to `true`, and the adaptive interval to `null` (`index.mjs:3412-3437`). Tick
zero starts a fetch for every tab (`index.mjs:3895-3899`,
`index.mjs:4029-4049`). If the initial Actions call is already rate-limited,
the failure path records only the error and its backoff
(`index.mjs:3983-4005`).

An error makes `firstLoad` false (`index.mjs:4150-4154`). When the payload is
still `null`, the body deliberately suppresses both the loading line and the
empty-state line (`index.mjs:4465-4493`). The resulting frame contains the
rate-limit banner and headers but no Actions rows.

No row payload, successful-fetch timestamp, failure backoff, or adaptive
interval is read from disk at startup. The current durable state is the table
width preference file: its path, load, and save functions are at
`index.mjs:2871-2883` and `index.mjs:2944-2980`, and App loads it at
`index.mjs:3381-3384`. The adaptive-rate implementation explicitly left learned
interval persistence outside its scope
(`docs/plans/2026-08-10-adaptive-rate-limit-budgeting-phases/phase-4.md:291-295`).

## Current automated coverage

The unit suite covers rate-limit classification and the retry ladder
(`test/doctor.test.mjs:59-75`, `test/unit.test.mjs:2059-2073`). The adaptive
control law has pure tests (`test/unit.test.mjs:2131-2279`).

The throttle PTY test gives `api rate_limit` a low remaining value while the
data calls still succeed (`test/pty/throttle.test.mjs:23-29`,
`test/pty/fixtures/gh:43-50`, `test/pty/fixtures/gh:92-105`). It checks that the
probe ran, the last parsed frame contains a throttle badge, terminal chrome was
present, and the data call count fell (`test/pty/throttle.test.mjs:31-68`). It
does not put a tab into a successful-then-rate-limited sequence or restart a
process from a prior successful state.

The PTY parser strips terminal control sequences and defines `finalFrame` from
the bytes after the last cursor-up, clear, or home boundary
(`test/pty/capture.mjs:35-38`, `test/pty/capture.mjs:108-124`). Geometry tests
inspect that parsed post-signal frame (`test/pty/e2e.test.mjs:90-101`,
`test/pty/e2e.test.mjs:125-176`). They do not reconstruct the live terminal
screen across successive cursor updates, so simultaneous visible copies of a
status line are not represented in their assertions.

## Historical points

Commit `9fff503e2669c9f5c62a85d4e853f6bb955fe258` enabled incremental rendering
for a full-height frame. Commit `ba6db4dde7a97a4332db8f5e1f8252a96b1ff37b`
added the horizontal safety column for terminal edge behavior. Commit
`1dd3aa9` added adaptive polling, and `2f91567` repaired its host routing and
closed-loop flapping while keeping control state in memory.

The earlier terminal research records that the original PTY checks missed a
real teardown defect because escape balance and width did not show what stayed
visible after the alternate screen was restored
(`docs/research/2026-08-03-pty-harness-attachment-points.md:197-221`).
