---
description: Push accountability -- commit before pull, local gates before one authorized push, CI observed for the exact commit
---

# Push Accountability

Always commit before `git pull --rebase` -- hook enforced.

`develop` is unprotected (removed 2026-08-04 -- solo project, PR-per-change was
pure overhead): direct pushes land immediately, and CI on `develop` is
observed *after* the fact rather than gating it. Run the complete applicable
local gate before committing, since a green local run is the only thing
standing between a bad commit and a red `develop`. Working branches and
worktrees stay local; integrate locally, then push `develop` once when that
push is authorized.

`main` stays protected and rejects direct pushes: it drives npm publishing, so
changes land through a `develop` -> `main` pull request whose required checks
pass (no approving review needed, so a solo maintainer is not deadlocked). The
release sequence and its authority are in
[`docs/release/release-playbook.md`](../../docs/release/release-playbook.md).

After a push, observe the workflows for that exact full commit SHA. A failure
is diagnosed from existing logs and fixed locally; there is no automatic
fix-and-repush loop on either branch. What a follow-up push needs is in the
playbook's [failure handling](../../docs/release/release-playbook.md#failure-handling).
Implementation-phase acceptance is separate from release progression.
