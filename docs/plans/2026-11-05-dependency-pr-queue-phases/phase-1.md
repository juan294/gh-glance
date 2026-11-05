# Phase 1: local batch candidate

Parent plan: [dependency PR queue](../2026-11-05-dependency-pr-queue.md). Status: complete. Evidence and deviations: [notes](../2026-11-05-dependency-pr-queue-notes.md).

## Objective

Build one local commit on top of current `origin/develop` that carries all five real dependency changes, the digest refresh they force, the Dependabot grouping and the code-scanning fix, then pass the complete `broad` local gate. Nothing leaves this machine in this phase.

## Entry conditions

- The plan is accepted.
- `git fetch origin` is done and the base SHA is recorded. The dry run used `1f395d3`.
- The main clone is not touched. It held another session's uncommitted `Events` rename on 2026-11-05 (`CHANGELOG.md`, `README.md`, `index.mjs`, three test files). Never stage, stash, reset or revert those paths.

## Work

There are no `[batch-eligible]` units. Every unit feeds the digest step, so one owner runs them in order.

### 1. Create the worktree

```bash
git -C /Users/juan/code/gh-glance fetch origin
git -C /Users/juan/code/gh-glance worktree add /Users/juan/code/gh-glance-deps-2026-11 -b deps-2026-11 origin/develop
cd /Users/juan/code/gh-glance-deps-2026-11
```

Name the base explicitly. A default isolation worktree starts from `main`, not `develop`. Move this plan and its phase files from the main clone into the worktree so they land with the candidate and cannot collide with a later pull.

### 2. Apply the five Dependabot commits without committing

```bash
for sha in f1c3a3d 702879c 13b6383 fc41bd0 74ee72c; do git cherry-pick -n "$sha" || break; done
npm ci
```

These are the exact bytes of #177, #178, #179, #160 and #141. Fetch `refs/pull/<n>/head` first if a SHA is not present. Stop and re-plan if a PR head changed from the table in the parent plan.

### 3. Group CodeQL updates in Dependabot

Add to the `github-actions` entry in `.github/dependabot.yml`:

```yaml
    groups:
      codeql-action:
        patterns:
          - "github/codeql-action*"
```

This is the fix the failing CodeQL step itself recommends. It is dependency-update configuration and changes no CI cadence or routing.

### 4. Fix code-scanning alert 8

In `test/pty/context-help.test.mjs:131` replace `assert.ok(body.includes("tenant.ghe.com"));` with `assert.match(body, /tenant\.ghe\.com/);`. The assertion keeps its meaning. The alert is a false positive on a test substring check, and a code change clears it with no manual dismissal state.

### 5. Refresh the pinned digests last

```text
@ refreshDigests() -> updated policy files
ctx: .github/workflows/ci.yml, .github/native-policy.json, .sutura.json
pre: steps 2-4 are complete; no further edits to digest inputs follow
do:
  1. compute git blob sha1 of ci.yml; write receiptProducers[native].blobSha
  2. compute sha256 of each reproductionProfiles[0].sourceInputs path
  3. replace only the stale sha256 strings, preserving file formatting
fx: edits two JSON files; no other key changes
fail: any other key differs in the diff -> restore the file and redo by hand
risk: a later edit to ci.yml, package.json or the lockfile invalidates both files
```

Expected values on base `1f395d3`, from the dry run:

| Target | Value |
| --- | --- |
| `native-policy.json` `receiptProducers[native].blobSha` | `f72b4cfffb858dee26b5668254f85b53c6ab0a93` |
| `.sutura.json` `package.json` | `c1646b62a3cd4487bc081bd87ef9bbad0f569723ad4dd4c6552748a07241fa2b` |
| `.sutura.json` `.github/workflows/ci.yml` | `17e5fe938da5834fb13c3adbdf321d24e2ff6ca93d418ae7677ddcf43fcd1789` |
| `.sutura.json` `package-lock.json` | `3dac2b03161799fc28e6ef99e9077ac37ffe46bbdb1a5ad39efeb4adbe718258` |

`.sutura.json` was already stale for `package.json` and `package-lock.json` at `1f395d3`, because the v0.19.1 release changed both. The refresh repairs that as well. Commit `1a194e2` is the precedent.

Compute with a one-off `node -e`. Do not add a repository script.

### 6. Review

Get one independent review of the staged diff against this phase. It must confirm that:

- the diff contains only the paths listed below;
- each action pin equals its upstream tag;
- the digests equal freshly computed values.

Resolve findings before the gate. The dry run already resolved `download-artifact` v8.0.2 to `9000827` and `codeql-action` v4.39.1 to `9b32540`.

Expected paths: `.github/dependabot.yml`, `.github/native-policy.json`, `.github/workflows/ci.yml`, `.github/workflows/codeql.yml`, `.github/workflows/release.yml`, `.sutura.json`, `package-lock.json`, `test/pty/context-help.test.mjs`, and the plan files.

### 7. Run the complete gate, sequentially

```bash
uptime
node scripts/test-select.mjs plan --base origin/develop --head HEAD
node scripts/test-select.mjs run lint syntax package fast pty:smoke recovery efficiency pty --receipt <scratchpad>/receipt-node24.json
```

Then run `fast` once on Node 22, which CI tests and the workstation does not use by default:

```bash
~/.nvm/versions/node/v22.22.2/bin/node --test --test-skip-pattern='E2E-' test/*.test.mjs
```

Plan on about 50 minutes (estimate from hosted job durations). Start `pty` when the 15-minute load average is at or below 12 (`hw.ncpu`). The dry-run machine was at 25-50. A PTY failure at higher load is recorded and the unchanged candidate is re-run once after load drops. The earlier failure stays in the record. A failure that repeats at normal load is a real finding and stops the phase.

### 8. Commit locally

Stage explicit paths only, then create one commit:

```text
chore(deps): batch action and npm updates, refresh sutura digests
```

The body names #141, #160, #177, #178, #179 as plain references. Do not use closing keywords. Phase 2 closes the PRs after the push is verified. End with the attribution lines from the session.

## Automated success criteria

- [x] `git diff --name-only origin/develop...HEAD` equals the expected path list.
- [x] The Node 24 receipt shows every `broad` selection passing.
- [x] Node 22 `fast` passes, including `WF-13`.
- [x] `node scripts/test-select.mjs plan` reports `broad`, which proves the gate above was the right size.
- [x] Freshly computed digests equal `.github/native-policy.json` and `.sutura.json`.
- [x] `grep -c 'codeql-action/.*@9b3254085494b55a0f7c4c2b3d2d52cc712ce370' .github/workflows/codeql.yml` prints 2.
- [x] `grep -c 'download-artifact@9000827ccba6bdab643e8b6fd33ac0654aef8333' .github/workflows/ci.yml .github/workflows/release.yml` prints 3 and 1.
- [x] `git -C /Users/juan/code/gh-glance status --short` still shows the other session's paths unchanged by this phase.

## Manual success criteria

None. The owner accepts the phase from the reported evidence.

## Exit

Stop. Report the candidate SHA, receipt, load at gate time and every failed attempt. Phase 2 needs explicit push authorization.
