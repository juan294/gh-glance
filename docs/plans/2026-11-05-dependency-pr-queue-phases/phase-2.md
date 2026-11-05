# Phase 2: push, observe and close the queue

Parent plan: [dependency PR queue](../2026-11-05-dependency-pr-queue.md). Status: authorized by the owner on 2026-11-05. Outcome: [notes](../2026-11-05-dependency-pr-queue-notes.md). This phase is outward-facing.

## Objective

Land the Phase 1 candidate on `develop` with one push, confirm the hosted result for that exact commit, then close all six open PRs and confirm code-scanning alert 8 is gone.

## Entry conditions

- Phase 1 is accepted.
- The owner explicitly authorized this push and the six PR closures. Plan acceptance alone does not authorize them.
- No release is in scope. Nothing here touches `main`, a tag or npm.

## Work

### 1. Re-base onto current develop

```bash
cd /Users/juan/code/gh-glance-deps-2026-11
git fetch origin
git rebase origin/develop
```

If `origin/develop` did not move, Phase 1 evidence stands.

If it moved:

| What moved | Action |
| --- | --- |
| A digest input (`package.json`, `package-lock.json`, `ci.yml`, `scripts/test-select.mjs`) | Refresh the digests again and re-run the complete `broad` gate. |
| Anything else, such as the `Events` rename in `index.mjs` | Run `lint syntax package fast pty:smoke` on the rebased head and record that the PTY evidence is from the pre-rebase SHA. The next release PR runs the complete selection on the combined tree. |

### 2. Push once

```bash
sha=$(git rev-parse HEAD)
git push origin HEAD:develop
git fetch origin
git merge-base --is-ancestor "$sha" origin/develop && echo landed
```

`Everything up-to-date` proves nothing here, so rely on the ancestry check. If the push is rejected as non-fast-forward, return to step 1. That is the same authorized push, because nothing landed.

### 3. Observe the exact commit

Use the Monitor tool on `gh run list --commit <full-sha>`, with the full 40-character SHA. A short SHA returns an empty list. Do not delegate this to a background agent.

Expected: `CI` and `CodeQL` for `push`, and `Sutura repair monitor` skipped. The CodeQL result is the first hosted proof that `init` and `analyze` agree at v4.39.1. Ordinary `develop` pushes run quick checks only, so PTY does not run here. Phase 1 is the PTY evidence for this candidate.

On any failure, stop. Read the logs, repair locally and report. Do not run `gh run rerun`, do not push a fix and do not close PRs. A follow-up push needs new authorization.

### 4. Close the six PRs

Only after step 3 is green:

```bash
for n in 141 160 177 178 179; do
  [ "$(gh pr view "$n" --json state --jq .state)" = OPEN ] && \
    gh pr close "$n" --comment "Landed on develop in $sha with the digest refresh this update requires."
done
[ "$(gh pr view 145 --json state --jq .state)" = OPEN ] && \
  gh pr close 145 --comment "Already satisfied: develop has carried brace-expansion 5.0.12 since 2026-10-26. A merge of this branch produces no change."
```

Closing an unmerged Dependabot PR tells Dependabot not to offer that version again. That has no effect here, because these versions are already on `develop`. Dependabot may also close some PRs itself after the push, so the state check is needed.

### 5. Confirm the end state

```bash
gh pr list --state open --json number --jq length
gh issue list --state open --json number --jq length
gh api repos/juan294/gh-glance/code-scanning/alerts/8 --jq .state
```

### 6. Release local resources

Remove the worktree and local branch only after confirming the commit is on `origin/develop` and the worktree has no uncommitted work. No Docker, database or task service is allocated in this plan.

```bash
git -C /Users/juan/code/gh-glance worktree remove /Users/juan/code/gh-glance-deps-2026-11
git -C /Users/juan/code/gh-glance branch -d deps-2026-11
```

### 7. Hand the Sutura items over

Report the items in the parent plan's Sutura section, with their repository, commit and run URLs, for review in `/Users/juan/code/sutura`. Make no routing, cadence or Sutura-side change from this repository.

## Automated success criteria

- [ ] `git merge-base --is-ancestor <sha> origin/develop` exits 0.
- [ ] `CI` and `CodeQL` conclude `success` for the full SHA.
- [ ] `gh pr list --state open` count is 0, unless Dependabot opened a new PR since, which is then reported by number.
- [ ] `gh issue list --state open` count is 0.
- [ ] Alert 8 state is `fixed`.
- [ ] `git worktree list` shows the main clone only.

## Manual success criteria

None.

## Exit

Report the pushed SHA, hosted run URLs, PRs closed, alert state and Sutura hand-over. Stop. Shipping these updates in a release is a separate decision.
