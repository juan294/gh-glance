# Contributing to gh-glance

Thanks for your interest in contributing! Whether it's a bug fix, a new tab, or better
documentation, contributions are welcome.

## Ways to Contribute

- Report bugs or suggest features via [GitHub Issues](https://github.com/juan294/gh-glance/issues)
- Fix bugs or implement features via pull requests
- Improve documentation

### Contributions We'd Love

- More tabs (e.g. discussions, releases)
- Configurable columns / widths
- A config file or flags for refresh interval, tab order, or target repository
  (see [#35](https://github.com/juan294/gh-glance/issues/35))
- Row selection and scrolling, so you can open what you are looking at
  (see [#33](https://github.com/juan294/gh-glance/issues/33))

## Prerequisites

- Node.js `>=22` (Ink requires it; Node 20 is end-of-life)
- The [`gh` CLI](https://cli.github.com/) `>=2.20`, authenticated (`gh auth login`)
- A terminal font with [Nerd Font](https://www.nerdfonts.com/) glyphs, to see
  the status icons correctly (see the README for the plain-unicode fallback)

## Local Development

```bash
git clone https://github.com/juan294/gh-glance.git
cd gh-glance
npm install
node index.mjs   # run it from inside any locally cloned GitHub repo
```

There's no build step -- it's plain ESM JavaScript, run directly by Node.

### Tests

```bash
npm test          # node:test, no framework, no config
npm run lint      # eslint, fails on warnings
node --check index.mjs
```

Tests live in `test/` and use Node's built-in runner, so they add no build step
and no test-framework dependency. `index.mjs` guards its entry point behind a
main-module check, which is what makes it importable from a test without
launching the dashboard -- please keep that guard intact.

Worth knowing about the app's shape before changing it:

- The polling effect's empty dependency array is deliberate. Every value it
  needs is read through a ref precisely so the interval is created once; adding
  dependencies would rebuild it on every tab keypress and every resize and
  cancel in-flight requests.
- `commit()` skips both the parse and the state update when the raw payload is
  unchanged, and returns the same state object, so an idle repo stops redrawing
  entirely. Anything that returns a fresh object per tick undoes that.
- Everything from `gh` goes through `safe()` before it is stored. See
  `SECURITY.md`.

## Branching Model

`develop` is the default branch and where all work lands. `main` tracks
released state, and only ever moves via a `develop` -> `main` pull request.

```bash
git checkout develop
git pull origin develop
git checkout -b feat/your-feature
```

Open your pull request against `develop`, never against `main`.

## Commit Format

Use lowercase [Conventional Commits](https://www.conventionalcommits.org/):

```
feat: add a releases tab
fix: handle repos with no workflow runs
docs: clarify the Nerd Font fallback
chore: bump dependencies
refactor: extract the row-height calculation
```

## Code Style

- No TypeScript, no build tooling, no bundler -- this project intentionally
  stays a single small script. If a change needs a build step, that's a sign
  to open an issue and discuss the tradeoff first.
- Run `npm run lint` and `npm test` before submitting a PR.
- The sample output block in `README.md` is captured from a real run. If you
  change a column, a limit, or the status bar, regenerate it rather than editing
  it by hand -- it drifted out of date once already.
- Keep the four data-fetching functions (`fetchActions`, `fetchIssues`,
  `fetchPRs`, `fetchSecurity`) shelling out via `execFile` with argument
  arrays -- never build a shell string from repository data. See
  `SECURITY.md` for why this matters.

## Submitting a Pull Request

1. Fork the repo and create a branch off `develop`
2. Make your change, keeping it scoped to one concern
3. Run `npm run lint`, `npm test` and `node --check index.mjs`
4. Open a PR against `develop` describing what changed and why
5. Make sure CI is green before requesting review

## Code of Conduct

This project follows the [Contributor Covenant Code of
Conduct](CODE_OF_CONDUCT.md). By participating, you are expected to uphold
this code.

## Security

If you discover a security vulnerability, please follow the [Security
Policy](SECURITY.md) instead of opening a public issue.
