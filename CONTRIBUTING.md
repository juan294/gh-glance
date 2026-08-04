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
npm run test:pty  # end-to-end, drives the real binary under a pty (slower)
```

Tests live in `test/` and use Node's built-in runner, so they add no build step
and no test-framework dependency. `index.mjs` guards its entry point behind a
main-module check, which is what makes it importable from a test without
launching the dashboard -- please keep that guard intact.

### The pty harness

`npm run test:pty` runs `test/pty/`. It launches the real `index.mjs` inside a
pseudo-terminal with a fixture `gh` on `PATH`, then asserts over the captured
bytes. It covers what unit tests structurally cannot: rendered frame geometry,
terminal state on exit, and the key handlers. It found the scrollback bug fixed
in `[Unreleased]`.

It is a separate script from `npm test` on purpose. The unit run is fast and is
a required CI check; the pty run is slow, is timing-sensitive by nature, and
runs in CI as **advisory** -- it reports on every PR but cannot block a merge.
If you make it flake, the right response is to delete the offending assertion,
not to add retries.

One rule keeps it worth having: **assert structure, never cell contents.** Line
counts, widths, escape-sequence balance and exit codes survive a copy change.
The text inside a cell does not, and asserting it would turn every wording
change into a red build.

Two things to know before editing it:

- `script(1)` is mutually incompatible between macOS (BSD) and Linux (GNU) --
  different argument order, different command form, and GNU needs `-e` to
  propagate the exit code. `test/pty/run.sh` implements both; a change to one
  branch needs checking against the other, and CI only exercises the GNU one.
- The fixture `gh` will drift from the real CLI over time. That is expected: it
  pins the contract the app depends on, not the CLI's behaviour.

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

Publishing a `main` commit to npm is automatic: publishing a GitHub release
triggers `.github/workflows/release.yml`, which republishes from the tagged
commit. Nothing is ever published from a maintainer's machine, because
`npm pack` reads the working tree rather than the tag and would happily ship
uncommitted edits.

The workflow authenticates with OIDC trusted publishing and holds no
credentials. Do not add an `NPM_TOKEN` secret to this repository -- npm is
withdrawing token-based publishing (Jan 2027), and the trust relationship
already covers it. The relationship is registered against the repository, the
workflow *filename*, and the `npm` environment, so renaming
`.github/workflows/release.yml` or that environment breaks publishing until
`npm trust github gh-glance` is re-run.

`develop` is protected and rejects direct pushes, including from maintainers.
No approving review is required, so a single contributor is not blocked, but the
required checks have to be green before anything lands.

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
