# Contributing to gh-glance

Thanks for your interest in contributing! Whether it's a bug fix, a new tab, or better
documentation, contributions are welcome.

## Ways to Contribute

- Report bugs or suggest features via [GitHub Issues](https://github.com/juan294/gh-glance/issues)
- Fix bugs or implement features via pull requests
- Improve documentation

### Contributions We'd Love

- More tabs (e.g. discussions, releases)
- Configurable column visibility / ordering
- A config file for defaults such as refresh interval, tab order, or repository
  targets (see [#35](https://github.com/juan294/gh-glance/issues/35))

## Prerequisites

- Node.js `>=22` (Ink requires it; Node 20 is end-of-life)
- The [`gh` CLI](https://cli.github.com/) `>=2.20`, authenticated (`gh auth login`)
- A terminal font with [Nerd Font](https://www.nerdfonts.com/) glyphs, to see
  the row icons correctly (see the README for Unicode and ASCII fallbacks)

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
npm run test:coverage:runtime  # informational PTY child-process function coverage
```

Tests live in `test/` and use Node's built-in runner, so they add no build step
and no test-framework dependency. `index.mjs` guards its entry point behind a
main-module check, which is what makes it importable from a test without
launching the dashboard -- please keep that guard intact. That source import is
an internal test seam only: the installed package sets `exports: {}`, so package
and deep imports must stay blocked and the `gh-glance` executable remains the
only public surface.

### The pty harness

`npm run test:pty` runs `test/pty/`. It launches the real `index.mjs` inside a
pseudo-terminal with a fixture `gh` on `PATH`, then asserts over the captured
bytes. It covers what unit tests structurally cannot: rendered frame geometry,
terminal state on exit, keyboard handlers, direct SGR mouse input, and state
shared across real process restarts. Its capture parser replays the alternate
screen into a bounded terminal grid, so it can detect a transient duplicate
status line even when a later repaint is clean. It found the scrollback bug
fixed in `0.3.0`.

It is a separate script from `npm test` on purpose. The unit run is fast and is
required everywhere; the pty run is slow and timing-sensitive, so it reports on
every pull request but is **required only on `main`** -- which in practice means
it gates the release and nothing else. It was advisory until 2026-08-04 and was
promoted after 38 consecutive runs without a failure. If you make it flake, the
right response is to delete the offending assertion, not to add retries.

`npm run test:coverage:runtime` repeats the PTY suite under V8 coverage and
summarizes observed `index.mjs` functions. It is an informational scheduled or
manual signal, not a threshold or release gate, and is skipped by the coverage
workflow on ordinary `develop` pushes because CI already runs the PTY suite.

One default keeps it worth having: **assert structure, not incidental dashboard
copy.** Line counts, widths, escape-sequence balance and ordering, and exit codes
survive a wording change. The narrow exception is a semantic data-flow test
whose subject is the fixture value itself. The restart-cache test, for example,
asserts one stable title both positively for the same target and negatively for
a different target; without that pair it would not prove persistence or
isolation. Do not use that exception for ordinary rendering or copy tests.

Each capture gets an isolated temporary config root by default. A test that
must cross a process boundary can pass one caller-owned `configHome` to several
captures. Create it with `mkdtempSync`, keep the exact returned path, and remove
only that path after every capture has finished.

Governor changes need both concurrency layers. `test/governor.test.mjs` launches
12 real worker processes against one private state file and covers atomic
grants, probe ownership, scope isolation, lock recovery, and process loss.
`test/pty/governor.test.mjs` and `test/pty/throttle.test.mjs` launch real
dashboard panes against the lock-safe shared fixture to prove startup, manual,
exhaustion, resource isolation, reset, external spend, and crash behavior. The
fixture keeps its own state and lock independent from the production governor,
so it cannot hide a lost update in the mechanism it is validating. PTY files
run serially; their individual cases still create the required concurrent
panes.

Direct SGR mouse tests must enter width mode before sending reports, then send
each logical report through the foreground pty as its own timed write, plus one
intentionally split report that exercises the pending token boundary. Assert
that reporting is disabled before width mode, balanced while it is active, and
disabled before the alternate screen exits. When a path intentionally writes on
the primary buffer -- a crash diagnostic or an interactive child handoff --
that transcript is not dashboard frame geometry; assert its after-restore tail
separately. For an interactive child, synchronize input with an explicit
fixture-ready marker instead of guessing when the child owns the terminal.

Two things to know before editing it:

- `script(1)` is mutually incompatible between macOS (BSD) and Linux (GNU) --
  different argument order, different command form, and GNU needs `-e` to
  propagate the exit code. `test/pty/run.sh` implements both; a change to one
  branch needs checking against the other, and CI only exercises the GNU one.
- The fixture `gh` will drift from the real CLI over time. That is expected: it
  pins the contract the app depends on, not the CLI's behaviour.

Worth knowing about the app's shape before changing it:

- `OPERATION_COSTS` is the one quota-cost authority. Every `runGh()` operation
  must have an exact REST/GraphQL vector there, and every non-free data call must
  obtain and revalidate a governor grant before its subprocess starts. A new
  call path is incomplete until both statements are true. ADR 0003 names one
  bounded control-plane exception: the single shared core observer may make one
  initial `GET /user` request before an authoritative core sample exists. Its
  registry vector is still `{core:1, graphql:0}` because its first 200 can cost
  one unit. It records that counter immediately and persists the validator so
  later observations can return a free 304.
- GraphQL admission is currently open-loop. `gh issue` and `gh pr` do not expose
  response headers through their normal output, and `gh api rate_limit` can lag
  the real GraphQL counter. Keep the probe freshness failure closed, but do not
  describe that probe as authoritative or claim that it proves the GraphQL
  reserve. ADR 0003 records the required follow-up boundary.
- Budget control, data work, and lease heartbeats use independent one-shot
  schedulers. A slow request must not suppress a probe or lease renewal, and a
  control wake must not create an unconditional data poll.
- Governor storage is fail-closed. A busy, corrupt, stale, or unwritable lock or
  state file denies the call; never recover by using a process-local request
  interval. Started, interrupted, and uncertain reservations remain charged
  until completion evidence and a later clean probe account for them.
- Loading and animated Checking state begin only after admission. A pending or
  scheduled request is Watching; an unsafe request is Paused. Neither starts a
  quota-consuming `gh` call before admission.
- The polling effect's empty dependency array is deliberate. Every value it
  needs is read through a ref precisely so the interval is created once; adding
  dependencies would rebuild it on every tab keypress and every resize and
  cancel in-flight requests.
- `commit()` skips both the parse and the state update when the raw payload is
  unchanged, and returns the same state object, so an idle repo stops redrawing
  entirely. Anything that returns a fresh object per tick undoes that.
- Only a successfully parsed, non-blind observation can replace live or cached
  last-known-good rows. A blind Security result updates its notes and `?` marker
  without clearing known alerts or advancing freshness. It also invalidates the
  raw comparison so an identical healthy response commits after recovery.
- Persistence is account-scoped and multi-process. Keep the bounded advisory
  lock, per-tab/per-column three-way merge, and post-save adoption of the merged
  snapshot together; removing any one can let simultaneous panes overwrite
  unrelated state on a later save.
- Everything from `gh` goes through `safe()` before it is stored in memory,
  persisted, or rendered. See `SECURITY.md`.

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

`develop` is not protected: the maintainer commits to it directly. The
PR-per-change requirement was removed on 2026-08-04 as pure overhead on a solo
project. CI still runs on `develop`, but it now reports *after* a push rather
than gating it, which makes a green local run the only thing standing between a
bad commit and a red default branch -- so run lint and the tests before you
commit, not after.

None of that applies to an outside contribution. You cannot push to this
repository, so fork it and open a pull request against `develop` as described
above; the same checks run on your PR and are worth waiting for.

`main` is still protected and still rejects direct pushes, because it is what
drives npm publishing.

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
- Keep the npm package CLI-only. Do not expose the internal named test seams
  through `exports`; use direct source imports from this repository in tests.
- Run `npm run lint` and `npm test` before submitting a PR.
- The sample output block in `README.md` is generated from the real candidate
  under the deterministic PTY fixture. If you change a column, a limit, or the
  status bar, regenerate it rather than editing it by hand -- it drifted out of
  date once already. Run
  `node test/pty/readme-sample.mjs`; it executes the current `index.mjs` under a
  76x14 PTY with deterministic fixture data and prints the exact replayed frame
  to paste as one unchanged block.
- Keep every call to `gh` going through the single `runGh()` seam, which uses
  `execFile` with an argument array -- never build a shell string from
  repository data. The four data-fetching functions (`fetchActions`,
  `fetchIssues`, `fetchPRs`, `fetchSecurity`) compose argv vectors and hand them
  to it; a second path to the subprocess is what this rule exists to prevent.
  See `SECURITY.md` for why it matters.

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
