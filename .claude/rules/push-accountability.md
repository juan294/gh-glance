---
description: Push accountability -- commit before pull, CI verification after push, background monitoring
---

# Push Accountability

Always commit before `git pull --rebase` -- hook enforced.

`develop` and `main` are both protected and reject direct pushes. Work lands
through a pull request whose required checks pass; no approving review is
needed. CI is therefore a precondition for landing rather than something
observed afterwards, which is the point -- a red `develop` used to be
discovered only after it was already the branch everyone clones.

After pushing a branch, spawn a background agent to monitor its checks.
If CI fails, the agent investigates, fixes, and re-pushes to the same branch.
Main terminal continues -- verification is non-blocking.
