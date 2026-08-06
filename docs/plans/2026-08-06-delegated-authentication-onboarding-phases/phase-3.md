# Phase 3 — Deterministic doctor and PTY evidence `[batch-eligible]`

> Files: `test/pty/fixtures/gh`, `test/doctor.test.mjs`,
> `test/pty/capture.mjs`, `test/pty/e2e.test.mjs`
> Depends on: phase 2. Batch-eligible with phase 4 after phase 2.

## Objective

Exercise the real binary/fixture boundary for no-login, repository-resolution,
repository-context, and auth-context calls without asserting unstable cell copy.

The PTY suite continues to assert structure rather than text
(`CONTRIBUTING.md:53-69`). Exact message and formatter behavior remains in unit
tests; doctor output is plain reporting output and may be asserted semantically.

## Changes

### 1. Generalize failure injection (`test/pty/fixtures/gh:19-25`)

Current `GH_GLANCE_FIXTURE_FAIL` fails only `gh api`. Add a comma-separated
exact selector list while preserving that default:

```
GH_GLANCE_FIXTURE_FAIL_ON = ${value:-api}

if GH_GLANCE_FIXTURE_FAIL is set:
    split GH_GLANCE_FIXTURE_FAIL_ON on commas
    for selector:
      if $1 == selector:
        write GH_GLANCE_FIXTURE_FAIL to stderr
        exit 1
```

Accepted selectors used by tests are `run`, `issue`, `pr`, `repo`, `auth`, and
`api`. Do exact equality checks after splitting—no shell wildcard matching. A
typo must fail no command rather than all commands. Compound values such as
`issue,repo,auth` let one list failure trigger context while selected context
legs fail too.

### 2. Teach the fixture the context calls

Extend dispatch without changing existing outputs:

```
repo view ...:
    echo '{"nameWithOwner":"acme/widget","url":"https://github.com/acme/widget","viewerPermission":"READ"}'

auth status --active --json hosts ...:
    echo '[{"host":"github.com","login":"octocat"}]'

auth status (doctor's existing human form):
    echo 'github.com'
    echo '  Logged in to github.com account octocat (keyring)'
    echo '  - Active account: true'
```

Dispatch on enough argv to distinguish the JSON context call from the human
doctor call. Never emit token text.

Keep `--version`, run/issue/pr payloads, and the three API success arrays
byte-compatible with existing healthy captures (`test/pty/fixtures/gh:27-52`).

### 3. Doctor end-to-end cases (`test/doctor.test.mjs`)

Using the existing `doctor()` helper (`test/doctor.test.mjs:77-90`), add:

```
test("doctor classifies the real no-login issue failure"):
    fail_on = "issue"
    message = "To get started with GitHub CLI, please run: gh auth login"
    assert Issues block classified == auth-problem
    assert stderr preserves message

test("doctor classifies the screenshot GraphQL failure"):
    fail_on = "issue"
    message = "GraphQL: Could not resolve to a Repository with the name 'Nvteca/cashflor-forecast'. (repository)"
    assert Issues block classified == unavailable
    assert stderr preserves message

test("doctor reports a failed repository-access probe separately"):
    fail_on = "repo"
    message = screenshot GraphQL resolution string
    assert Repository access block classified == unavailable
    assert Actions/Issues/PR blocks still succeed
```

Scope matches to the named block, not merely the first occurrence of a verdict;
the report contains seven classifications after phase 2.

Retain the SAML API failure test unchanged except for the fixture selector's
default (`test/doctor.test.mjs:135-146`). Retain token/proxy redaction checks
unchanged (`test/doctor.test.mjs:107-125`).

### 4. Environment-aware capture helper (`test/pty/capture.mjs`)

Add an optional `env = {}` field to `capture()` and merge it over
`process.env` in the existing `execFileSync()` options:

```
capture({ ..., env = {} }):
    execFileSync("/bin/sh", argv, {
      ...existingOptions,
      env: {...process.env, ...env},
    })
```

This passes synthetic fixture settings through the existing runner without
interpolating them into a shell command. Existing call sites omit `env` and
remain byte-for-byte equivalent.

### 5. Structural PTY failure capture (`test/pty/e2e.test.mjs`)

Add one module-scope capture using `capture({env: {...}})` with a fixture
GraphQL repository-resolution failure on `issue,repo` and
`args: "--tab issues"`. Failing `repo` keeps the context in the inaccessible
repository branch, while selecting Issues ensures the changed one-line error is
actually rendered. Assert only:

- the app reaches both the failing issue call and the context calls in the
  fixture log;
- `repo view` and JSON `auth status` occur no more than once during the capture;
- final frame line count equals terminal rows;
- widest line stays within terminal columns;
- alternate-screen enter/exit and primary-buffer cleanliness remain intact.

Do not assert `GitHub login`, repository names, account names, colors, or any
other cell text. Unit tests own copy; this capture owns orchestration and
geometry.

### 6. Routing regression checks

`test/pty/routing.test.mjs` is not edited. Its healthy inferred/slug/host
captures must continue to prove that the default list/API argv vectors and
enterprise host routing are unchanged (`test/pty/routing.test.mjs:21-74`). The
new context calls occur only in the failure capture and therefore do not alter
those fixture logs.

## Automated success criteria

Run sequentially:

```bash
npm run lint && npm test && node --check index.mjs && npm run test:pty
```

The exact no-login and screenshot GraphQL forms are covered through the real
binary's doctor path. The PTY capture proves one-shot context orchestration
without making copy a terminal-test contract.

## Manual success criteria

None. This phase exists to replace manual reproduction with deterministic local
fixtures.
