# Project: gh-glance

## One-liner

A live-refreshing GitHub dashboard for the terminal -- Actions, Issues, Pull
Requests, and Security alerts in one narrow pane. Shells out to the `gh` CLI.

## Stack

Node.js (ESM, `>=20.19`), Ink v7 + React v19 for the terminal UI. No
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
node --check index.mjs  # syntax check (no build step to catch this otherwise)
node index.mjs --version
node index.mjs --help
```

There is no test suite. CI substitutes a smoke job (syntax check + CLI boot
check across Node 20/22/24) for unit tests.

## Git Workflow

- Integration branch: `develop` (default branch, all work lands here first)
- Production branch: `main` (tracks released state; only moves via a
  `develop` -> `main` pull request)
- Implementation happens in git worktrees or temporary branches, never
  directly on `develop`

Conventional commits, lowercase, no scope required:
`feat|fix|docs|chore|refactor: description`

```bash
# Push -- commit before pulling (hook enforced)
git add <files> && git commit -m "msg"
git pull --rebase && git push
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
