# Phase 3 — `--doctor` diagnostics

> Files: `index.mjs`, `test/doctor.test.mjs` (new)
> Depends on: phases 1 and 2 (shares `index.mjs`; reports phase 2's classification).
> Not batch-eligible.

## Why

The work machine is the only place the EMU failure modes exist, and it is not
this machine. Without a diagnostics command the loop is "run it, describe what
you saw, guess" — and the single largest risk in this plan is that the phase 2
SSO markers were written against documented strings rather than observed ones.

`--doctor` closes that loop: one command, one pasteable report, containing the
verbatim `gh` error text **and the classification each error received**.

## Shape

A reporting command, not configuration. It behaves like `--help` and
`--version`: gather, print to stdout, exit — never render the dashboard.

Three consequences that must be got right:

1. **It must bypass the non-TTY refusal** at `index.mjs:842-847`. The whole
   point is `gh-glance --doctor > emu-report.txt`. Handle `--doctor` in the same
   block as `--help`/`--version` (`index.mjs:812-819`), which returns before
   that guard and before ink is imported.
2. **It must not exit on a failed preflight.** `preflight()` (`index.mjs:628-651`)
   exits 3 when `gh` is missing or the cwd is not a repository. Those are exactly
   the conditions worth *reporting*. `--doctor` reports them and exits 0.
3. **It must be safe to paste.** See below — this is the primary constraint.

## Redaction — the primary design constraint

A diagnostics command that prints environment detail is a disclosure surface,
and this output is intended to be pasted into a chat. Rules, each with a test:

| Value | Treatment |
|---|---|
| `GH_TOKEN`, `GH_ENTERPRISE_TOKEN`, `GITHUB_TOKEN`, `GITHUB_EMU_TOKEN`, any `*_TOKEN`/`*_SECRET`/`*_PASSWORD`/`*_KEY` | **presence only** — `set` / `not set`. Never the value, not even a prefix. |
| `HTTPS_PROXY`, `HTTP_PROXY`, `ALL_PROXY` | scheme and host only; userinfo stripped (`http://user:pw@h:8080` → `http://h:8080`) |
| `GH_HOST`, `GH_REPO`, `GH_CONFIG_DIR`, `NO_PROXY` | printed as-is (these are the values being diagnosed) |
| API response bodies | **never** — byte counts only |
| `gh auth status` output | passed through `redact()` before printing; `gh` already masks tokens as `gho_****`, and `redact()` is belt-and-braces |
| Anything token-shaped anywhere in captured text | `redact()` replaces `gh[pousr]_[A-Za-z0-9]+` and `github_pat_[A-Za-z0-9_]+` with `<redacted>` |

```
redact(text):
    text.replace(/gh[pousr]_[A-Za-z0-9]{16,}/g,      "<redacted-token>")
        .replace(/github_pat_[A-Za-z0-9_]{16,}/g,    "<redacted-token>")
        .replace(/\/\/[^/\s:@]+:[^/\s@]+@/g,         "//<redacted>@")   # userinfo in any URL
```

`redact()` is applied to **every** captured string — stderr, `gh auth status`,
env values — at the single point where the report is assembled, not per call
site. Same reasoning as `safe()` at `index.mjs:174`: one boundary, not six.

## Report contents

```
gh-glance doctor
================
gh-glance         <version>
node              <process.version>  <platform>/<arch>
gh                <`gh --version` first line, or "NOT FOUND">

Authenticated hosts
-------------------
<redacted `gh auth status` output, or the error it failed with>

Repository target
-----------------
source            flag | GH_REPO | git remote | none
host              <runtime.host ?? "(default — gh infers it)">
slug              <runtime.repo ?? "(inferred from cwd)">
git remote        <`git remote get-url origin`, or "not a git repository">

Environment
-----------
GH_HOST           <value | not set>
GH_REPO           <value | not set>
GH_CONFIG_DIR     <value | not set>
GH_TOKEN          set | not set          # never the value
GH_ENTERPRISE_TOKEN set | not set
HTTPS_PROXY       <scheme://host | not set>
NO_PROXY          <value | not set>
GH_GLANCE_ICONS / GH_GLANCE_NO_ANIMATION / NO_COLOR / NODE_ENV

Endpoint probes
---------------
<for each of the six calls the dashboard makes>
  <name>
    argv        gh run list --repo ... --limit 20 --json ...
    outcome     ok 4821B in 812ms
             |  FAILED in 623ms
    http        403                        # when parseable from stderr
    classified  unavailable | rate-limited | auth-problem | other
    stderr      <redacted, first 400 chars>
```

The `classified` line is the payload of this whole phase. It is computed with
the *same* predicates the dashboard uses — `isUnavailable`, `isRateLimited`,
`isAuthProblem` — so the report states what `gh-glance` would actually have
concluded, not what a parallel implementation guesses.

```
classify(err):
    if err is null:                 return "ok"
    if isRateLimited(err):          return "rate-limited"
    if isAuthProblem(err):          return "auth-problem"
    if isUnavailable(err):          return "unavailable"
    return "other"
```

## Changes

### 1. argv (`index.mjs:674-700`, `:704-735`)

`--doctor` joins the boolean flags. No value, no validation beyond presence.
Unknown-argument behaviour is untouched.

### 2. Entry point (`index.mjs:812-819`)

```
if opts.doctor:
    runtime.repo <- opts.repo ; runtime.host <- opts.host   # so probes use the real target
    console.log(await runDoctor())
    process.exit(0)
```

Placed with `--help`/`--version`, i.e. **before** the `--verbose` stderr guard,
the non-TTY refusal, and `preflight()`.

### 3. `runDoctor()` — a new section before `// ---------- Command line ----------`

Probes reuse the existing fetchers rather than reimplementing their argv, so the
report cannot drift from what the dashboard does. Each probe is wrapped:

```
probe(name, thunk):
    started <- Date.now()
    try:    result <- await thunk() ; return {name, ok:true,  ms:…, bytes: result.raw.length}
    catch e: return {name, ok:false, ms:…, err:e, http: /HTTP (\d{3})/.exec(e.stderr)?.[1],
                     classified: classify(e)}
```

Probes run with `Promise.allSettled` so one hang cannot suppress the rest;
`runGh`'s existing `GH_TIMEOUT_MS` (`index.mjs:88`) bounds each one.

Note: `fetchSecurity()` swallows its own errors into notes
(`index.mjs:537-549`), so the three alert endpoints are probed via
`fetchAlertSource`-equivalent direct `runGh` calls, with `alertBackoff` cleared
first so a live backoff cannot make a probe silently skip.

### 4. `--help` (`index.mjs:741-789`)

```
gh-glance --doctor            Print a diagnostic report and exit
--doctor                      Gather versions, auth hosts, resolved repo target
                              and one probe per endpoint, then exit. Safe to
                              redirect to a file and share -- tokens are never
                              printed.
```

### 5. Exports (`index.mjs:2046-2071`)

Add `redact` and `classify` for unit testing. `runDoctor` itself stays internal.

## Tests (`test/doctor.test.mjs`, new)

`package.json:20` globs `test/*.test.mjs`, so a new file is picked up with no
config change.

```
test("redact removes every token shape, anywhere in the text"):
    for t in ["gho_0123456789abcdefghij", "ghp_ABCDEFGHIJKLMNOPQRST",
              "github_pat_11ABCDE_0123456789abcdefghij"]:
        out <- redact(`token is ${t} ok`)
        assert NOT out.includes(t)
        assert out.includes("<redacted-token>")

test("redact strips credentials from proxy and remote URLs"):
    out <- redact("HTTPS_PROXY=http://alice:hunter2@proxy.corp:8080")
    assert NOT out.includes("hunter2")
    assert out.includes("proxy.corp:8080")

test("redact leaves ordinary diagnostic text intact"):
    s <- "HTTP 403: Resource protected by organization SAML enforcement"
    assert redact(s) == s

test("classify agrees with the dashboard's own predicates"):
    assert classify(null)                                              == "ok"
    assert classify({stderr:"HTTP 403: API rate limit exceeded"})      == "rate-limited"
    assert classify({stderr:"HTTP 403: ...SAML enforcement..."})       == "auth-problem"
    assert classify({stderr:"HTTP 404: Not Found"})                    == "unavailable"
    assert classify({stderr:"dial tcp: lookup api.github.com"})        == "other"

test("rate limiting outranks the auth marker"):
    # "API rate limit exceeded" must not be read as an auth problem even though
    # a 403 carries it -- the dashboard's own ordering, mirrored here.
    assert classify({stderr:"HTTP 403: API rate limit exceeded"}) == "rate-limited"
```

An end-to-end check belongs in phase 4, where the pty fixture can supply a
failing `gh`.

## Success criteria

### Automated
- `npm test`, `npm run lint`, `node --check index.mjs` pass.
- `node index.mjs --doctor` exits **0** and prints a report when run outside a
  git repository, and when stdout is a pipe
  (`node index.mjs --doctor | cat` must not hit the `index.mjs:842` refusal).
- No synthetic token planted in the environment appears in the output.
- `classify()` returns the same verdict the dashboard's predicates would.

### Manual
- On the work machine: `gh-glance --doctor > emu-report.txt` during normal
  operation, and again during a SAML lapse. Both are pasteable and complete.
- The lapse report's `classified` line reads `auth-problem`. If it reads
  `other`, its verbatim `stderr` is the evidence used to revise the phase 2
  regex — which is the reason this phase exists.
