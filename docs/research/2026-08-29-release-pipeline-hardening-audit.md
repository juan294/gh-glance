# Research: Release-pipeline hardening audit (Coach case-study comparison)

**Question:** Is gh-glance repeating the mistakes documented in the Coach
release-pipeline hardening/recovery case study (`~/code/coach/docs/release/release-pipeline-hardening-recovery-case-study.md`)?
Inventory every blocking check, branch-protection rule, hook, and
release-adjacent script currently in force.

## GitHub Actions workflows

Five workflow files under `.github/workflows/`, 394 lines total. All
third-party actions are pinned to full commit SHAs with a trailing version
comment.

### `ci.yml` (147 lines)

- Triggers: `push` and `pull_request` on `[main, develop]` (`ci.yml:3-7`).
  `permissions: contents: read` (`ci.yml:9-10`). Concurrency group
  `ci-${{ github.ref }}`, `cancel-in-progress: true` (`ci.yml:12-14`).
- Job `lint` ("Lint"): `ubuntu-latest`, `timeout-minutes: 10` (`ci.yml:23-24`),
  runs `npm run lint` = `eslint . --max-warnings 0` (`ci.yml:32`).
- Job `test` ("Test (Node ${{ matrix.node-version }})"): matrix
  `node-version: [22, 24]`, `fail-fast: false` (`ci.yml:41-43`),
  `timeout-minutes: 10` (`ci.yml:37`), runs `npm test` =
  `node --test test/*.test.mjs` (`ci.yml:54`). Comment at `ci.yml:51-53`:
  before this job existed, no gate executed any `index.mjs` function body.
- Job `smoke` ("Smoke (Node ${{ matrix.node-version }})"): matrix
  `[22, 24]`, `fail-fast: false` (`ci.yml:64-67`), `timeout-minutes: 10`
  (`ci.yml:63`). Steps: `node --check index.mjs` (`ci.yml:75-76`); CLI boots
  via `--version`/`--help` (`ci.yml:77-80`); non-TTY stdout must exit exactly
  `1` and stderr must contain `not a terminal` (`ci.yml:85-98`, comment at
  `ci.yml:81-84` notes it previously only checked "nonzero"); unknown-flag
  must exit exactly `2` (`ci.yml:99-108`).
- Job `pty` ("PTY"): single Node 22 run (not matrixed, rationale
  `ci.yml:128-130`), `timeout-minutes: 20` (`ci.yml:136`, raised from 10 by
  commit `9e96901`), runs `npm run test:pty` (`ci.yml:147`). In-file history
  at `ci.yml:110-129`: advisory at first (issue #37, PTY capture called "the
  classic source of flaky CI"), promoted to required-on-`main` 2026-08-04
  after 38 consecutive clean runs (2026-08-02 → 2026-08-04); `ci.yml:115-117`
  states plainly that since `develop` is unprotected, this check "gates the
  `develop` -> `main` release PR and nothing else"; `ci.yml:123-126` notes
  branch protection matches by job name, so demoting it requires a rename.

### `codeql.yml` (41 lines)

- Triggers: `push`/`pull_request` on `[main, develop]` plus a Monday 06:00 UTC
  cron (`codeql.yml:3-9`). Concurrency group + `cancel-in-progress`
  (`codeql.yml:19-21`). In-file rationale at `codeql.yml:14-18`: it is a
  required check that previously had no concurrency group or timeout, so
  rapid pushes left superseded analyses running to completion; observed
  runtime ~1m30s against a 15-minute timeout (`codeql.yml:26`).
- Job `analyze` has no `name:` key, so its check context is the job id plus
  matrix value: `analyze (javascript-typescript)` (`codeql.yml:24-33`).

### `coverage.yml` (54 lines)

- Triggers: `push` on `[develop]` only, a daily 03:23 UTC cron, and
  `workflow_dispatch` (`coverage.yml:3-8`). **No `pull_request` trigger** —
  cannot be a PR-blocking check and is not in branch protection's required
  list (confirmed below).
- Runs `npm run test:coverage`, extracts metrics via
  `scripts/extract-coverage-metrics.mjs`, and reports them to an external
  "Portfolio" dashboard through `scripts/report-coverage.sh`, signed with
  `COVERAGE_SECRET` (`coverage.yml:29-48`).
- A conditional step measures PTY child-process coverage only on schedule/
  dispatch, `if: github.event_name != 'push'` (`coverage.yml:49-54`).

### `dependency-review.yml` (25 lines)

- Trigger: `pull_request` on `[main, develop]` only (`dependency-review.yml:3-5`).
  In-file comment (`dependency-review.yml:7-11`): this is "the only pre-merge
  check on new dependencies"; explicitly forbids switching to
  `pull_request_target` to fix the cosmetic fork-PR comment limitation.
- Job `dependency-review` has no `name:` key (context = job id). No severity
  threshold or license allow/deny list configured — defaults only
  (`dependency-review.yml:20-25`).

### `release.yml` (127 lines)

- Trigger: `release: types: [published]` **only** (`release.yml:20-22`).
  Comment at `release.yml:18-19`: adding a `push: tags` trigger too would
  double-publish and hard-fail the second run on E403. Never runs on PRs —
  not a merge gate, a post-publication pipeline.
- `environment: npm`, job-scoped `id-token: write` added only at the job
  level so it isn't leaked to every job in the workflow (`release.yml:33-38`).
- Steps, in order: checkout with `fetch-depth: 0` (`release.yml:40-43`);
  upgrade npm globally because Node 22 bundles npm 10.9 with no OIDC support
  and trusted publishing needs npm ≥ 11.5.1 (`release.yml:51-59`, unpinned
  version — see Historical findings below); `npm ci && npm run lint &&
  node --check index.mjs && npm test` (`release.yml:60-63`); verify the tag
  matches `package.json` version and a matching `## [version]` CHANGELOG
  section (`release.yml:65-76`); verify the tag is an ancestor of
  `origin/main` and that `git rev-list -n1 $GITHUB_REF_NAME` equals
  `$GITHUB_SHA` (`release.yml:78-92`, comment: "a release can be cut from any
  ref through the API"); pack the tarball, assert it contains exactly
  `package/index.mjs`, `package/README.md`, `package/LICENSE`, then globally
  install it and run `--version`/`--help` against the installed binary
  (`release.yml:94-109`); skip-if-already-published idempotency check via
  `npm view` (`release.yml:111-120`); `npm publish --provenance
  --access public` with no `NODE_AUTH_TOKEN` present anywhere
  (`release.yml:122-127`).
- `npm publish` itself re-triggers `package.json`'s `prepublishOnly` script
  (`npm run lint && node --check index.mjs && npm test`, `package.json:17`),
  so lint/syntax-check/test run a second time, back-to-back with no working-
  tree change in between, inside the same job that already ran them explicitly
  at `release.yml:60-63`.
- No `concurrency:` block in this workflow (present in the other four).

## Branch protection (live, read via `gh api`)

`gh api repos/juan294/gh-glance/branches/main/protection` → 200:

- `required_status_checks.strict: true`; eight required contexts:
  `Smoke (Node 22)`, `Smoke (Node 24)`, `Lint`,
  `analyze (javascript-typescript)`, `Test (Node 22)`, `Test (Node 24)`,
  `dependency-review`, `PTY`.
- Seven of the eight `checks[]` entries carry `app_id: 15368` (GitHub
  Actions app). **The `PTY` entry carries `app_id: null`** — unlike its
  siblings from the same `ci.yml` file, it is not pinned to the Actions app
  and so is satisfiable by a status update from any source using that exact
  context string.
- `required_pull_request_reviews.required_approving_review_count: 0`,
  `dismiss_stale_reviews: true`, `require_code_owner_reviews: false`.
- `enforce_admins.enabled: true` — the repo owner is not exempt from the
  eight required checks when merging to `main`.
- `allow_force_pushes.enabled: false`, `allow_deletions.enabled: false`.
- No workflow job maps to a required context from `coverage.yml` or
  `release.yml` — neither is required, matching their non-PR triggers.

`gh api repos/juan294/gh-glance/branches/develop/protection` → **404**
(`{"message":"Branch not protected", ...}`). `develop` carries zero branch
protection. `ci.yml`, `codeql.yml`, and `dependency-review.yml` still *run*
on `develop` pushes/PRs but only report there; they block merges only on
`main`.

## Git hooks and agent-side push guards

- `core.hooksPath` = `.husky/_` (husky v9 active).
- `.husky/pre-commit:1` runs `npm run lint && node --check index.mjs` —
  **no test run** at commit time.
- There is **no `.husky/pre-push` file**; the husky-generated pre-push shim
  under `.husky/_/` sources a dispatcher that finds nothing to run and exits
  0. Pushes are not gated by a local git hook.
- `.claude/hooks/guard-bash.sh` is a PreToolUse Bash guard (not a git hook)
  that blocks specific dangerous command shapes for the agent: uncommitted
  changes before `pull --rebase` (Error #33), `git push --tags` (Error #44),
  and direct pushes to `main`/`master` (Error #48, `--follow-tags` allowed
  for the release flow).
- `.claude/hooks/verify-edit.sh` is a PostToolUse markdown-verification hook,
  described as "Level 1 editor-time" checking, independent of CI.

## package.json / npm scripts

`package.json:14-22`: `lint` (`eslint . --max-warnings 0`), `prepare`
(conditional husky install, guarded so a tarball without `.git` doesn't
fail), `prepublishOnly` (`npm run lint && node --check index.mjs && npm
test`), `test` (`node --test test/*.test.mjs`), `test:coverage`,
`test:coverage:runtime`, `test:pty` (`node --test --test-concurrency=1
--test-timeout=240000 test/pty/*.test.mjs`). No `preversion`, `version`,
`postversion`, `prepack`, or `postpublish` hooks. `test:pty` is not part of
`prepublishOnly`.

## Test suite composition

- Unit tier: 10 files matched by `test/*.test.mjs`, 266 `test()` cases total
  (largest: `test/unit.test.mjs` at 3166 lines / 126 cases, `test/governor.test.mjs`
  at 1915 lines / 50 cases).
- PTY tier: 10 files under `test/pty/`, 77 `test()` cases total. Harness:
  `test/pty/run.sh` (189 lines, drives a real pty via `script(1)` rather than
  node-pty specifically to avoid a native dependency — rationale at
  `run.sh:6-9` matches the project's no-build-step stance); `test/pty/capture.mjs`
  (563 lines) parses Ink's terminal control sequences into a bounded grid
  rather than byte-slicing (`capture.mjs:117-127`), isolates each capture in
  its own `mkdtempSync` `XDG_CONFIG_HOME` (`capture.mjs:503-521`), and polls
  readiness with shell-side `awk`/`sleep` loops capped at ~15s
  (`capture.mjs:49-52`) — there are no in-JS retries.
- `CONTRIBUTING.md:70-71`: explicit no-retries policy — "If you make it
  flake, the right response is to delete the offending assertion, not to add
  retries."
- `test:pty` gained `--test-concurrency=1` in commit `d68662a`
  ("stabilize governor PTY readiness"); `CLAUDE.md:39-44` records the reason
  as avoiding parallel files starving each other's PTY deadlines, not a
  general anti-flake measure.

## The `/release` command (`.claude/commands/release.md`, 324 lines)

Three explicit STOP gates: after presenting the version-bump plan (waits for
the user to state the version number, never auto-increments — `:81`, `:320`);
after presenting the full diff of version-bump/changelog changes, before
publishing (`:144`); after the release PR merges, before tagging
(`:294`). Verification commands are run sequentially, "never as parallel
Bash calls" (`:115-119`, `:324`). The publish step is explicit: "Never run
`npm publish` manually in this repository" (`:321-323`) — the OIDC workflow
is the only path. The develop→main flow requires a merge commit, never
squash, never `--delete-branch` (`:278-292`), because squashing the
permanent integration branch causes `develop` to diverge from `main`, which
(combined with `strict: true` on required checks) blocks the *next* release
PR until reconciled.

## Chronology: this project already ran the Coach playbook once

There is **no ADR** covering branch protection, CI, or release process —
`docs/decisions/` holds three ADRs, all about application architecture
(0001 gh-CLI-as-data-layer, 0002 own-the-terminal-lifecycle, 0003 file-backed
API coordination), none about pipeline governance. The 2026-08-04 policy
change is recorded only as commit-message prose and in `CLAUDE.md`/
`.claude/rules/push-accountability.md`.

**2026-08-02** — `28863cc` initial commit already ships `ci.yml`, `codeql.yml`,
`dependency-review.yml`.

**2026-08-03** — a `/pre-launch` audit (`docs/agents/pre-launch-report-2026-08-03.md`,
1690 lines) drives a hardening wave in one day:
- `c8bbe6e` "ci: make the checks gate what they claim to gate" — drops Node 20
  from matrices, adds the `test` job ("the first time CI executes any
  application logic" per its body), switches Smoke to exact-exit-code
  assertions, adds concurrency+timeout to CodeQL, adds read-only permissions+
  timeout to Dependency Review, SHA-pins every action, **creates `release.yml`**,
  and updates branch protection on both `main` and `develop` in the same pass.
- `1fa782a` adds the PTY job as *advisory only* (`docs/plans/2026-08-03-pty-e2e-harness.md:27,136-137`
  plan it as advisory pending "three clean runs in a row" before promotion).
- `e0f7c18` adds OIDC npm publishing to `release.yml`.
- `docs/agents/update-docs-report-2026-08-03.md:30` records the peak state:
  *"`develop` now PR-only (0 reviews, admin-enforced, 8 required checks)."*

**2026-08-04** — same-week reversal:
- `a4651a0` "docs: drop PR-per-change workflow on develop, keep main protected"
  — `develop`'s branch protection removed via the GitHub API (not tracked in
  a workflow file); commit body: "pure overhead for a solo maintainer... CI
  on develop is observed after the fact rather than gating it."
- `f051a34` same day, opposite direction on `main`: promotes PTY from
  advisory to required after "38 runs from 2026-08-02 to 2026-08-04, zero
  failures," and states explicitly that since `develop` is unprotected, this
  "gates the develop -> main release PR and nothing else."
- The standing policy memory `no-release-pipeline-hardening.md` is written
  this same day (`modified: 2026-08-04T11:05:03Z`), naming branch protection,
  new `release.yml` gates, tarball-integrity comparison, pre-commit test
  hooks, and "test-harness expansion" as reject-by-default categories, with
  the explicit target: *"a good outcome from an audit is 'the release
  pipeline gained zero new gates.'"*

**2026-08-11** — a second `/pre-launch` (`docs/agents/pre-launch-report.md`)
files five DevOps findings under §7 (`:182-243`): DO-H1 (release runbook
contradicts the deployed model), DO-M1 (unpinned `npm install -g npm@latest`
in the privileged publish job), DO-M2 (idempotent-skip path doesn't compare
artifact identity), DO-M3 (no concurrency control on `release.yml`), DO-M4
(no rollback/incident-response procedure). **Disposition: only DO-H1 (a
documentation fix) was acted on**, via `bab3485` "docs: refresh remediation
and release guidance," which rewrote `.claude/commands/release.md`,
`CLAUDE.md`, `CONTRIBUTING.md`, `README.md`, `SECURITY.md`. No workflow file
was touched that day for DO-M1/M2/M3/M4.

**2026-08-18** — `docs/agents/triage-report.md:11,29-35,63-67` makes the
rejection explicit and durable: *"The four release-pipeline findings...
remain unimplemented by design — they collide with the standing
`no-release-pipeline-hardening` instruction... Not re-raised unless the
policy changes."* DO-M1 (unpinned npm-CLI upgrade) and DO-M3 (no concurrency
group on `release.yml`) are therefore still present in the workflow today,
by explicit, recorded decision rather than oversight.

**2026-08-19** — the PTY promotion's downstream cost is paid in two follow-up
commits: `1bf5afb` doubles the `test:pty` script timeout (120000ms →
240000ms) and `9e96901` doubles the CI job's `timeout-minutes` (10 → 20),
both citing serialized PTY files needing more wall-clock time to finish.

**2026-08-29** — the policy is still being carried into new planning:
`docs/plans/2026-08-29-conditional-polling-and-calm-status.md:260` lists
under "Out of scope": *"Release-pipeline gates, branch rules, or added CI
machinery."*

## Duplicated verification steps found in the current pipeline

- The checkout → setup-node → `npm ci` triplet appears six times across
  `ci.yml` (four jobs), `coverage.yml`, and `release.yml`.
- `npm run lint` runs in `ci.yml:32`, in `release.yml:61` explicitly, and a
  third time implicitly via `prepublishOnly` when `npm publish` fires at
  `release.yml:127` — the explicit run and the `prepublishOnly` run happen
  back-to-back in the same job with no working-tree change between them.
- `node --check index.mjs` runs in `ci.yml:76` (both Node versions),
  `release.yml:62`, and again via `prepublishOnly`.
- `npm test` runs in `ci.yml:54` (both Node versions), `release.yml:63`, and
  again via `prepublishOnly`.
- `--version`/`--help` boot assertions run twice against two different
  artifacts: the working-tree source in `ci.yml:79-80` and the packed,
  globally-installed tarball in `release.yml:108-109` (this pairing is
  called out in-file, `release.yml:95-96`, as intentionally testing
  different artifacts, not pure duplication).
