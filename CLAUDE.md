# Project: gh-glance

## One-liner

A live-refreshing GitHub dashboard for the terminal -- Actions, Issues, Pull
Requests, and Security alerts in one narrow pane. Shells out to the `gh` CLI.

## Stack

Node.js (ESM, `>=22`), Ink v7 + React v19 for the terminal UI. No
TypeScript, no build step, no bundler -- the entire app is `index.mjs`, run
directly by Node. This is intentional; see CONTRIBUTING.md before adding
build tooling.

## RPI Workflow

This project follows Research-Plan-Implement (RPI).

1. /research -- Understand the codebase as-is
2. /plan -- Create a phased implementation spec
3. /implement -- Execute one phase at a time with review gates
4. /validate -- Verify implementation against the plan

Each phase is its own conversation. STOP after each phase.
Use /clear between tasks, /compact when context is heavy.

## Key Commands

```bash
npm run lint            # ESLint
npm start               # node index.mjs
npm test                # node:test unit suite
npm run test:pty        # end-to-end under a pseudo-terminal (slower; gates `main` only)
node --check index.mjs  # syntax check (no build step to catch this otherwise)
node index.mjs --version
node index.mjs --help
```

Tests are `node --test` (built-in runner, no framework) in `test/`: a fast unit
suite, plus `test/pty/` which drives the real binary under a pseudo-terminal
against a fixture `gh`. CI also runs a smoke job (syntax check, CLI boot,
exit-code assertions) across Node 22/24.

## Git Workflow

- Integration branch: `develop` (default branch, all work lands here first)
- Production branch: `main` (tracks released state; only moves via a
  `develop` -> `main` pull request)

Conventional commits, lowercase, no scope required:
`feat|fix|docs|chore|refactor: description`

`develop` is unprotected: commit directly to it. This is a solo project, so
the PR-per-change ceremony was pure overhead -- removed 2026-08-04. Run
verification locally *before* committing (lint, test, test:pty as needed);
CI on `develop` is now observed after the fact rather than gating the push,
so a green local run is what stands between a bad commit and a red `develop`.

```bash
git add <files> && git commit -m "msg"
git pull --rebase && git push
```

`main` stays protected (PR + passing checks, admins included) since it drives
npm publishing -- only move it via a `develop` -> `main` PR:

```bash
git checkout -b release/vX.Y.Z
# bump version, update changelog, etc.
git push -u origin release/vX.Y.Z
gh pr create --base main --fill
gh pr merge --squash --delete-branch   # once checks are green
```

Run verification sequentially with `;` or `&&`, never as parallel Bash calls.

## Deployment

Published to npm as [`gh-glance`](https://www.npmjs.com/package/gh-glance).
There is no server: `main` is the released state of the source, and the npm
package is the artifact.

`.github/workflows/release.yml` publishes automatically when a GitHub release
is published. It authenticates with **OIDC trusted publishing, not a token** --
there is no `NPM_TOKEN` secret in this repository and there must never be one.
npm restricted bypass-2FA granular tokens from account management in Aug 2026
and removes their direct-publish ability in Jan 2027.

The trust relationship is registered against three things that must stay in
lockstep, or publishing breaks with an opaque `401`:

| Bound to | Value |
|---|---|
| Repository | `juan294/gh-glance` |
| Workflow filename | `release.yml` |
| Environment | `npm` |

Re-register with `npm trust github gh-glance` if any of them changes. Note
that Node 22 bundles npm 10.9, which has no OIDC support at all -- the
workflow upgrades npm before publishing, and that step is load-bearing.

Rules load from `.claude/rules/` and `.claude/skills/` automatically.

## Agent Behavior

Exhaust tools before asking the user. Production actions need human authorization.
Save operational lessons to auto memory immediately. Don't wait to be asked.

## Project File Locations

Go directly to these paths -- never search for them.

| Topic | Path | Notes |
|-------|------|-------|
| Research | `docs/research/YYYY-MM-DD-*.md` | |
| Plans | `docs/plans/YYYY-MM-DD-*.md` | `-phases/` |
| ADRs | `docs/decisions/` | |
| App source | `index.mjs` | single file, keep it that way |
