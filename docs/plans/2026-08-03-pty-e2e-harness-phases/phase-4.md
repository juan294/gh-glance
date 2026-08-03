# Phase 4 — CI job, advisory

Depends on: Phases 2 and 3. The harness must be green before it runs in CI.

## Files

- `.github/workflows/ci.yml` — one new job

## Change

```
  pty:
    name: PTY (advisory)
    runs-on: ubuntu-latest
    timeout-minutes: 10
    # Deliberately NOT added to required_status_checks. Issue #37 records pty
    # capture as "the classic source of flaky CI" and "the only item here that
    # can make CI flaky". This runs on every PR and reports, but a timing flake
    # cannot block a merge. Promote it to required once it has a clean streak.
    steps:
      - uses: actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1 # v7
      - uses: actions/setup-node@820762786026740c76f36085b0efc47a31fe5020 # v7
        with:
          node-version: 22
          cache: npm
      - run: npm ci
      - run: npm run test:pty
```

Single Node version, not a matrix: this exercises terminal behaviour, which does
not vary by Node minor, and every extra matrix leg multiplies the flake surface
for no signal.

Actions stay pinned to full SHAs with the version comment, per `ci.yml:16-19`.

## Explicitly not done

**Do not add `PTY (advisory)` to `required_status_checks` on either branch.**
`DO-M1`'s regression note records the failure mode: a required context that
misbehaves blocks every PR indefinitely, and the same applies to one that
flakes. Promotion is a later, separate decision — a one-line settings change
once the job has demonstrated stability.

## Platform note

CI is `ubuntu-latest`, so the GNU branch of `run.sh` is what executes here; the
BSD branch only ever runs on a developer's machine. This is the first time both
branches are exercised, and it is the reason Phase 1 implements both rather than
only the one that works locally — #37 records that otherwise the harness "will
only ever run in one place".

`util-linux` `script` is present on the GitHub runner image; the GNU form was
verified in `ubuntu:24.04` during research.

## Success criteria

**Automated**

- The `PTY (advisory)` job appears on a PR and passes on `ubuntu-latest`.
- All existing required checks stay green: `Lint`, `Test (Node 22|24)`,
  `Smoke (Node 22|24)`, `analyze (javascript-typescript)`, `dependency-review`.
- `gh api repos/juan294/gh-glance/branches/{main,develop}/protection/required_status_checks`
  still lists exactly the seven existing contexts — the new job is absent.

**Manual**

- Confirm on the PR page that a deliberately failing pty assertion shows as a
  red check but leaves the PR mergeable. That is the whole point of advisory,
  and it is worth seeing once rather than assuming.
- Run the job three times and record whether it was stable, as the input to the
  promotion decision.
