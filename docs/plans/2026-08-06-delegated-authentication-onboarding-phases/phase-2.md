# Phase 2 — Failure-triggered account and repository context

> Files: `index.mjs`, `test/unit.test.mjs`, `test/doctor.test.mjs`,
> `test/pty/e2e.test.mjs`
> Depends on: phase 1. Blocks: phases 3 and 4.
> Not batch-eligible: shares runtime/test files with phase 1 and defines the
> behavior phases 3 and 4 verify/document.

## Objective

Resolve repository visibility and active `gh` accounts only after an ambiguous
`unavailable` fetch failure, then let the phase-1 formatter distinguish an unavailable
feature on a visible repository from an unresolved repository/account target.

The resolver is read-only, optional, bounded by `runGh()`, and never part of
`preflight()`.

## Changes

### 1. Named context argv builders (`index.mjs`, beside `actionsArgs()`)

```
repoContextArgs():
    target = runtime.repo ? qualifiedRepo() : null
    return ["repo", "view", ...(target ? [target] : []),
            "--json", "nameWithOwner,url,viewerPermission"]

authContextArgs():
    return ["auth", "status", "--active", "--json", "hosts", "--jq",
            ".hosts | to_entries | map(.key as $host | .value[] | " +
            "select(.active == true) | {host: $host, login: .login})"]
```

`repo view` takes an optional positional repository; do not pass the list
commands' `--repo` form. Explicit host-qualified targets reuse
`qualifiedRepo()` (`index.mjs:507-517`); inferred targets omit the positional
argument and preserve `gh`'s remote resolution.

### 2. Pure parsers and context shape

```
parseRepoContext(raw):
    try:
      value = JSON.parse(raw)
      validate required object/string fields
      return {
        ok:true,
        nameWithOwner:safe(value.nameWithOwner),
        url:safe(value.url),
        viewerPermission:safe(value.viewerPermission),
      }
    catch: return null

parseAuthContext(raw):
    try:
      value = JSON.parse(raw)
      if NOT Array.isArray(value): return null
      return value
        .filter(row => row is an object with string host/login)
        .map(row => ({host:safe(row.host), login:safe(row.login)}))
    catch: return null

failedContext(err):
    return {ok:false, verdict:classify(err), raw:shortErr(err)}

buildFailureContext(repoSettlement, authSettlement):
    parsedRepo = repoSettlement fulfilled
      ? parseRepoContext(repoSettlement.value)
      : null
    return {
      repo: parsedRepo ?? (repoSettlement rejected
            ? failedContext(repoSettlement.reason)
            : {ok:false, verdict:"other", raw:"Repository context unavailable"}),
      accounts: authSettlement fulfilled
        ? parseAuthContext(authSettlement.value)
        : null,
    }
```

Treat parse failures as unavailable optional context, not as application
failures. No token field is requested or accepted.

### 3. Background resolver

```
resolveFailureContext(signal):
    [repo, auth] = await Promise.allSettled([
      runGh(repoContextArgs(), {signal}),
      runGh(authContextArgs(), {signal}),
    ])
    return buildFailureContext(repo, auth)
```

Keep it near the other data-layer functions rather than embedding subprocess
calls in React. Every call stays behind `runGh()` and its timeout, buffer,
environment, verbose logging, redaction boundary, and abort behavior
(`index.mjs:419-504`).

### 4. Testable context coordinator and App trigger

Add a pure async coordinator whose resolver and commit callback are injected:

```
createFailureContextCoordinator({resolve, commit, fallback}):
    epoch = 0
    value = null
    inFlight = null

    ensure(signal):
      captured = epoch
      if value != null: return Promise.resolve(value)
      if inFlight?.epoch == captured: return inFlight.promise
      promise = Promise.resolve()
        .then(() => resolve(signal))
        .then(result => {
          if epoch != captured: return false
          value = result
          commit(result)
          return true
        })
        .catch(() => {
          if epoch != captured: return false
          value = fallback
          commit(fallback)
          return false
        })
        .finally(() => {
          if inFlight?.epoch == captured: inFlight = null
        })
      inFlight = {epoch:captured, promise}
      return promise

    invalidate():
      epoch += 1
      value = null
      commit(null)
```

The coordinator owns one request per epoch and makes rejection non-fatal. The
fallback is the same sanitized failed-context shape returned for malformed
repository output, so even an unexpected resolver rejection is cached instead
of spawning a new probe every poll. Its captured epoch prevents an older promise
from committing after `invalidate()`. Export it for controlled-promise unit
tests; it performs no subprocess or React work itself.

Inside `App` (`index.mjs:2206-2233`, `:2455-2594`), add
`failureContext` state and a `contextCoordinatorRef`. The mount-only polling
effect constructs the coordinator with `(signal) =>
resolveFailureContext(signal)` as its injected resolver, the sanitized fallback
context, and a commit callback that checks `cancelled` before calling
`setFailureContext`.

Call `coordinator.ensure()` only when a stored fetch error has verdict
`unavailable`. A direct `auth-problem` already renders the complete fixed login/
refresh remedy; launching two unused context subprocesses for it adds latency
and failure surface without changing the message. `rate-limited` and `other`
also do not trigger context.

Do not add new dependencies to the mount-only polling effect. Read current
coordinator through its ref, following `runLimitRef` and `activeIndexRef`; the
empty dependency array remains load-bearing (`CONTRIBUTING.md:79-87`).

### 5. Formatting with optional context

Pass `failureContext` to `formatTabError()` at render time.

Rules:

```
if verdict == unavailable AND context.repo.ok:
    return "not available for this repository"

if verdict == unavailable AND NOT context.repo.ok:
    return unavailableRemedy(context.accounts, failureTargetHost(...))
```

Add pure helpers with one explicit precedence:

```
failureTargetHost({runtimeHost, ghHost, ghRepo, accounts}):
    return runtimeHost
        ?? ghHost
        ?? safely parsed host-qualified GH_REPO host
        ?? sole distinct account host
        ?? null

unavailableRemedy(accounts, targetHost):
    account = exactly one account matching targetHost
    candidate = account
      ? "Repository not found or inaccessible to <login>@<host> -- check the target or run `gh auth switch`"
      : null
    return candidate != null AND candidate.length <= 120
      ? candidate
      : VERDICT_REMEDY.unavailable
```

Do not guess a host from an arbitrary remote string. `runtimeHost` represents a
host-qualified `--repo`; `GH_HOST` and a host-qualified `GH_REPO` are existing
environment target sources. A successful repository context returns earlier
with feature-level copy and therefore is not a host source for the failed-repo
account branch.

Every interpolated login/host already passed through `safe()`. Construct and
length-check the whole candidate; if it is too long, use the fixed remedy rather
than truncating away `gh auth switch`. Do not add another rendered line or
change `bodyRows`.

### 6. Manual refresh invalidates context

When `r` force-refreshes the active tab (`index.mjs:2419-2425`):

```
contextCoordinatorRef.current?.invalidate()
clear current tab backoff
fetch current tab with force=true
```

If the retry remains `unavailable`, it starts one fresh context resolution; a
direct `auth-problem` retains the fixed auth remedy without probing. An older
in-flight resolution may finish, but its captured epoch
prevents it from committing stale context. This is how a user who ran `gh auth
login`, `gh auth refresh`, or `gh auth switch` in another terminal gets updated
context immediately. Automatic ticks reuse the cached result and do not spawn
more probes.

### 7. Doctor repository-access probe (`index.mjs:1111-1185`)

Insert before Actions:

```
["Repository access", repoContextArgs()]
```

Reuse `probe()` exactly, so the block reports argv, duration, byte count or
stderr, HTTP status, and the same classification. Do not add the compact auth
JSON call to the report; the existing `Authenticated hosts` section already
prints the canonical `gh auth status` output (`index.mjs:1126-1148`).

Update the doctor completeness assertion from six classified blocks to seven
(`test/doctor.test.mjs:93-105`).

### 8. Exports

Export only pure/testable helpers needed by unit tests: `parseRepoContext`,
`parseAuthContext`, `buildFailureContext`, `failureTargetHost`,
`unavailableRemedy`, `formatTabError`, and `createFailureContextCoordinator`.
Keep `resolveFailureContext()` internal; it only runs the two named argv builders
through `runGh()` and passes their settlements to the exported builder.

## Tests

### `test/unit.test.mjs`

- repository parser sanitizes `nameWithOwner`, URL, and permission;
- auth parser returns only rows with host/login and sanitizes both;
- auth parser never accepts/exposes a token-shaped extra field;
- visible repository + unavailable endpoint selects feature-level copy;
- failed repository context selects repository/account copy;
- one matching account can appear as `login@host` only when the full line is at
  most 120 characters;
- ambiguous/missing accounts fall back to `active gh account`;
- unsupported/malformed auth JSON yields no optional account context rather
  than throwing into the render path;
- malformed repository JSON becomes a failed optional context rather than an
  unhandled resolver rejection;
- rejected repository and auth settlements produce failed repo context plus
  `accounts:null`, and formatting retains the fixed repository remedy;
- host selection follows runtime host, `GH_HOST`, host-qualified `GH_REPO`, sole
  active host, then null;
- a controlled deferred resolver commits at most once per epoch;
- invalidating while that resolver is pending prevents the stale result from
  committing, and the next `ensure()` starts a fresh resolution.

### `test/doctor.test.mjs`

- complete report contains a `Repository access` block;
- classified probe count is seven;
- host-qualified doctor invocation sends the full host-qualified target to
  `gh repo view` while security API paths still contain only the bare slug;
- planted secrets remain absent after the additional probe.

## Automated success criteria

Run sequentially:

```bash
npm run lint && npm test && node --check index.mjs && npm run test:pty
```

No healthy startup performs either context call; fixture logs from a healthy PTY
capture explicitly contain neither `repo view` nor JSON `auth status`. Add those
negative assertions to the existing healthy `wide` capture in
`test/pty/e2e.test.mjs`.

## Manual/read-only success criteria

- With an empty temporary `GH_CONFIG_DIR`, a no-login failure triggers no
  supplementary context attempt, retains the actionable login remedy, and
  remains retryable.
- With a visible repository whose Actions endpoint is unavailable, the
  repository probe succeeds and the Actions message remains feature-level.
- With a nonexistent target, the repository probe fails and the list tabs use
  the repository/account message.
