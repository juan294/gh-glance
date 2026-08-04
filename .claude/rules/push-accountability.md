---
description: Push accountability -- commit before pull, CI verification after push, background monitoring
---

# Push Accountability

Always commit before `git pull --rebase` -- hook enforced.

`develop` is unprotected (removed 2026-08-04 -- solo project, PR-per-change was
pure overhead): direct pushes land immediately, and CI on `develop` is
observed *after* the fact rather than gating it. Run lint/test/test:pty
locally before committing, since a green local run is the only thing standing
between a bad commit and a red `develop`.

`main` stays protected and rejects direct pushes: it drives npm publishing, so
changes land through a `develop` -> `main` pull request whose required checks
pass (no approving review needed, so a solo maintainer is not deadlocked).

After pushing to either branch, spawn a background agent to monitor CI.
If it fails on `develop`, the agent investigates and fixes forward with a new
commit. If it fails on a `main`-bound PR branch, the agent investigates, fixes,
and re-pushes to the same branch. Main terminal continues -- verification is
non-blocking.
