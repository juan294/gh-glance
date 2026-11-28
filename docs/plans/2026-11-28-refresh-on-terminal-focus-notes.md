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
