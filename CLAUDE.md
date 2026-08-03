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
npm run test:pty        # end-to-end under a pseudo-terminal (slower, advisory in CI)
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
- Implementation happens in git worktrees or temporary branches, never
  directly on `develop`

Conventional commits, lowercase, no scope required:
`feat|fix|docs|chore|refactor: description`

`develop` is protected: pushes to it are rejected, and changes land through a
pull request whose checks pass. No approving review is required, so a solo
maintainer is not deadlocked -- but CI is now a hard precondition rather than a
report that arrives after the fact.

```bash
# Branch, commit, push the branch, open a PR against develop
git checkout -b fix/short-slug
git add <files> && git commit -m "msg"
git push -u origin fix/short-slug
gh pr create --base develop --fill
gh pr merge --squash --delete-branch   # once checks are green
```

Open PRs against `develop`, never against `main`. Run verification
sequentially with `;` or `&&`, never as parallel Bash calls.

## Deployment

None currently -- not yet published to npm (clone + `npm link` is the
install path). `main` represents the released state of the source, not a
deployed service.

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
