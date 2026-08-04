# Phase 4 — pty coverage for argv routing `[batch-eligible]`

> Files: `test/pty/fixtures/gh`, `test/pty/e2e.test.mjs` (or a new
> `test/pty/routing.test.mjs`)
> Depends on: phases 1-3 (asserts their argv). Batch-eligible with phase 5 —
> no file overlap, and neither reads the other's output.

## Why

Phases 1 and 3 change what argv `gh-glance` hands to `gh`. Unit tests cover the
parser; nothing covers the vector that actually reaches the subprocess. That gap
is precisely where defect D2 lived — the argv was right for four tabs and wrong
for three endpoints, and no test could have seen it.

The harness already has the instrument. `test/pty/fixtures/gh:15` appends every
invocation to `GH_GLANCE_FIXTURE_LOG`:

```sh
echo "$*" >> "$GH_GLANCE_FIXTURE_LOG"
```

`CONTRIBUTING.md:56-62` describes this harness as covering what unit tests
structurally cannot. Argv routing belongs there.

## Changes

### 1. Fixture (`test/pty/fixtures/gh`)

The `case "$1"` dispatch (`:19-44`) is unchanged — it already ignores extra
arguments, so a host-qualified `--repo` and a `--hostname` flag pass through
harmlessly and land in the log.

Add one branch so failure paths are reachable, gated on an env var so existing
tests are unaffected:

```sh
# Lets a test drive the error classifier end to end. Unset by default, so
# every existing pty test sees exactly the fixture it saw before.
if [ -n "$GH_GLANCE_FIXTURE_FAIL" ] && [ "$1" = "api" ]; then
  echo "$GH_GLANCE_FIXTURE_FAIL" >&2
  exit 1
fi
```

### 2. Tests

```
test("with no --repo, the argv vector is byte-identical to the default"):
    log <- run(args: [])
    assert no line contains "--hostname"
    assert no line contains "--repo"
    # This is the regression guard for "the default path did not change".

test("a two-part --repo passes --repo and never --hostname"):
    log <- run(args: ["--repo", "acme/widget"])
    assert every list line contains "--repo acme/widget"
    assert no line contains "--hostname"

test("a host-qualified --repo routes BOTH halves to the host"):
    log <- run(args: ["--repo", "tenant.ghe.com/acme/widget"])
    for line matching /^(run|issue|pr) /:
        assert line contains "--repo tenant.ghe.com/acme/widget"
    for line matching /^api /:
        assert line contains "--hostname tenant.ghe.com"   # the D2 regression guard
    # api paths carry the bare slug, never the host
    for line matching /^api /:
        assert line contains "repos/acme/widget/"
        assert NOT line contains "repos/tenant.ghe.com/"

test("--doctor prints a report, exits 0, and works through a pipe"):
    { code, stdout } <- runBinary(["--doctor"], stdout: pipe)
    assert code == 0
    assert stdout contains "gh-glance doctor"
    assert stdout contains "Endpoint probes"

test("--doctor classifies a SAML 403 as an auth problem, end to end"):
    { stdout } <- runBinary(["--doctor"],
        env: GH_GLANCE_FIXTURE_FAIL="HTTP 403: Resource protected by organization SAML enforcement")
    assert stdout contains "classified  auth-problem"
    assert NOT stdout contains "not enabled"
```

The last test is the executable statement of the plan's central claim: a SAML
403 must never be reported as a disabled feature.

## Notes

- `npm run test:pty` is advisory in CI (`README`/`CONTRIBUTING`), so a flake
  here does not gate the merge — but the two regression guards above are the
  only automated protection against D2 recurring, so they must be written to be
  deterministic: assert on the fixture log, never on rendered frame content.
- `--doctor` exits before ink loads, so its tests need no pty at all and can use
  a plain child process. Put them in the pty directory only if that keeps the
  harness helpers reusable; otherwise `test/doctor.test.mjs` from phase 3 is the
  better home and this phase covers only the argv assertions.

## Success criteria

### Automated
- `npm run test:pty` passes, including all pre-existing tests unmodified.
- The default-path test proves the argv vector is unchanged when no host is
  configured.
- The `--hostname` assertion fails if phase 1's `apiHostArgs()` is reverted.
- The `auth-problem` assertion fails if phase 2's `isAuthProblem()` is reverted.

### Manual
- None.
