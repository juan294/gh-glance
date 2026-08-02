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
- A config file for refresh interval, tab order, or icon style (plain unicode
  vs. Nerd Font Octicons)
- Handling repos where `gh` isn't authenticated, or where a tab's underlying
  feature is disabled, more gracefully

## Prerequisites

- Node.js `>=20.19`
- The [`gh` CLI](https://cli.github.com/), authenticated (`gh auth login`)
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
- Run `npm run lint` before submitting a PR.
- Keep the four data-fetching functions (`fetchActions`, `fetchIssues`,
  `fetchPRs`, `fetchSecurity`) shelling out via `execFile` with argument
  arrays -- never build a shell string from repository data. See
  `SECURITY.md` for why this matters.

## Submitting a Pull Request

1. Fork the repo and create a branch off `develop`
2. Make your change, keeping it scoped to one concern
3. Run `npm run lint` and `node --check index.mjs`
4. Open a PR against `develop` describing what changed and why
5. Make sure CI is green before requesting review

## Code of Conduct

This project follows the [Contributor Covenant Code of
Conduct](CODE_OF_CONDUCT.md). By participating, you are expected to uphold
this code.

## Security

If you discover a security vulnerability, please follow the [Security
Policy](SECURITY.md) instead of opening a public issue.
