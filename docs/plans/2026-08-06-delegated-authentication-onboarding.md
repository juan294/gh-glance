# Plan: delegated authentication onboarding and repository-access guidance

> 2026-08-06 | Branch `develop` @ `310eeed`
> Research: [`docs/research/2026-08-06-per-user-github-authentication-and-repository-resolution.md`](../research/2026-08-06-per-user-github-authentication-and-repository-resolution.md)

## Goal

Make a first-time or differently authenticated user understand, from inside
gh-glance, whether they need to log into `gh`, refresh authorization, switch the
active `gh` account, or correct an inaccessible repository target.

Authentication remains delegated to the user's installed `gh`. gh-glance does
not accept, read, persist, refresh, or print tokens; it does not add `--login`,
`--switch-account`, or an account-pinning flag; and it does not mutate global
`gh` state. This preserves the current credential boundary
(`SECURITY.md:128-131`) and the accepted `gh` data-layer architecture
(`docs/decisions/0001-keep-the-gh-cli-data-layer.md:27-30`).

## Chosen scope

The selected design is **delegated authentication plus failure-triggered
context**:

1. Recognize the actual unauthenticated and unresolved-repository strings that
   produced the supplied screenshots.
2. Replace them with short, honest, actionable messages.
3. After an ambiguous repository-unavailable failure, resolve active `gh`
   accounts and repository access in the background when the installed `gh`
   supports the required reporting flags. A direct auth failure already has a
   complete fixed remedy and launches no supplementary probes.
4. Keep the dashboard alive and retryable while that context is absent, slow,
   unsupported, or temporarily offline.
5. Extend `--doctor`, deterministic fixtures, and public onboarding so the same
   diagnosis is available outside the TUI.

Explicitly out of scope:

- prompting for credentials or tokens;
- invoking `gh auth login`, `gh auth refresh`, or `gh auth switch` on the user's
  behalf;
- a network-bound startup gate;
- automatically selecting or changing an account;
- changing the `GH_CONFIG_DIR` isolation model;
- adding a direct GitHub API client, dependency, build step, TypeScript, or a
  test framework.

## Why startup remains non-blocking

`preflight()` currently stops only on local, deterministic conditions: a
missing `gh` executable or an unusable inferred working directory. Auth and
network checks deliberately remain in-pane because they can recover without a
restart (`index.mjs:880-915`). The dashboard starts all four fetches
independently and commits each as it arrives (`index.mjs:2455-2474`), matching
ADR 0001's independent-tab consequence
(`docs/decisions/0001-keep-the-gh-cli-data-layer.md:89-95`).

This plan does not add `gh auth status` or `gh repo view` to `preflight()`. The
new context resolver runs only after an ambiguous `unavailable` failure,
through the existing bounded `runGh()` seam (`index.mjs:419-439`,
`index.mjs:489-504`). Its result can improve an error message, but it can never
decide whether the app is allowed to start or keep polling.

## Design

### 1. Failure taxonomy stays small

Keep the current public/internal verdict set:

```
ok | rate-limited | auth-problem | unavailable | other
```

The order in `classify()` remains rate limit, auth, unavailable, other
(`index.mjs:368-386`). No new ladder is introduced, so the executable parity
between `VERDICT_REMEDY` and `FAILURE_LADDER` remains intact
(`test/unit.test.mjs:380-395`).

Broaden only the evidence each existing verdict recognizes:

```
AUTH_MARKERS +=
    /not logged into any GitHub hosts/i
    /To get started with GitHub CLI/i
    /run:\s+gh auth login/i
    /none of the git remotes[\s\S]*known GitHub host/i

REPOSITORY_RESOLUTION_MARKERS =
    /Could not resolve to a Repository with the name .* \(repository\)/i

isUnavailable(err):
    return HTTP_403_OR_404(err) OR REPOSITORY_RESOLUTION_MARKERS.test(errText(err))
```

The existing priority is load-bearing: a 403 containing rate-limit or SAML/SSO
text remains `rate-limited` or `auth-problem`, not `unavailable`
(`index.mjs:376-386`). The new GraphQL marker reaches `unavailable` only because
it has neither a rate nor auth marker.

### 2. List-tab remedies become honest about ambiguity

Security endpoint failures keep their source-specific feature notes. They are
constructed inside `fetchAlertSource()` rather than through
`VERDICT_REMEDY.unavailable` (`index.mjs:752-790`). Only Actions, Issues, and
Pull Requests use the generic remedy table (`index.mjs:2522-2538`).

Use these one-line list-tab contracts:

```
auth-problem:
  GitHub login or authorization required -- run `gh auth status`, then `gh auth login` or `gh auth refresh`

unavailable, repository context unresolved/failed:
  Repository not found or inaccessible to the active `gh` account -- check `gh auth status` and the repository target

unavailable, repository context succeeds:
  not available for this repository
```

Each fixed string must contain no newline and fit `MAX_ERR_LENGTH` (120), the
same one-row budget as `shortErr()` (`index.mjs:299-321`). The inaccessible
wording deliberately does not claim whether the target is private, renamed,
deleted, or mistyped; GitHub returns the same resolution shape for those cases.

### 3. Store failure semantics, not already-formatted copy

The current `errors` state stores one string per tab (`index.mjs:2206-2233`).
That prevents a message from gaining account/repository context when the
background resolver finishes. Replace fetch-failure strings with structured
records while retaining a text form for browser-open failures:

```
TabError =
    { kind: "fetch", verdict, raw }
  | { kind: "text", text }

toTabError(err):
    return { kind: "fetch", verdict: classify(err), raw: shortErr(err) }

formatTabError(tabError, failureContext):
    if tabError.kind == "text": return tabError.text
    if tabError.verdict == "other": return tabError.raw
    if tabError.verdict == "unavailable" AND failureContext?.repo?.ok:
        return "not available for this repository"
    if tabError.verdict == "unavailable" AND failureContext?.repo?.ok == false:
        return unavailableRemedy(failureContext.accounts, failureTargetHost(...))
    return VERDICT_REMEDY[tabError.verdict]
```

`Boolean(errors[key])`, error-line height accounting, red tab labels, and
success clearing continue to work with either record shape
(`index.mjs:2242-2270`, `index.mjs:2495-2538`, `index.mjs:2688-2704`). The
renderer calls `formatTabError()` immediately before drawing the existing one
red line (`index.mjs:2806-2825`). No second banner or permanent account row is
added, so terminal geometry is unchanged.

### 4. Failure-triggered context resolver

Add named argv builders beside the existing endpoint builders so the dashboard,
doctor, and tests cannot drift (`index.mjs:541-544`):

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

The resolver is best-effort and read-only:

```
resolveFailureContext(signal):
    [repoResult, authResult] = await Promise.allSettled([
        runGh(repoContextArgs(), {signal}),
        runGh(authContextArgs(), {signal}),
    ])
    return {
        repo: parse success as {ok:true,nameWithOwner,url,viewerPermission}
              or {ok:false,verdict:classify(error),raw:shortErr(error)},
        accounts: parse success as sanitized [{host,login}] or null,
    }
```

Each parser validates its JSON shape. A malformed repository result becomes a
failed optional context and malformed auth JSON becomes `null`; neither escapes
the resolver as a render-path exception.

If an older supported `gh` does not understand `--active`/`--json`, the auth
leg resolves to `null`; the repository error and actionable fixed copy remain.
The minimum documented `gh >=2.20` is therefore unchanged
(`README.md:96-102`). The resolver never parses or requests a token. Parsed
account/repository fields pass through `safe()` before entering state; command
errors retain the existing bounded `shortErr()` treatment
(`index.mjs:202-321`).

Use the exported, injected context coordinator specified in phase 2 inside the
mount-only polling effect:

```
ensureFailureContext():
    coordinator.ensure(controller.signal)
    # coordinator caches one result per epoch and suppresses stale commits

on fetch failure:
    tabError = toTabError(err)
    store tabError
    if verdict == "unavailable":
        ensureFailureContext()

on manual r:
    coordinator.invalidate()
    clear current tab backoff
    retry current tab immediately
```

The existing abort controller, in-flight discipline, and mount-only effect
remain intact (`index.mjs:2294-2303`, `index.mjs:2455-2594`). Automatic polling
does not repeatedly spawn context probes: one result, including an unavailable
result, is cached until the user presses `r` or the app remounts.

Account context is supplementary and is used only when the repository probe
fails. Resolve the target host from an explicit host-qualified `--repo`,
`GH_HOST`, a host-qualified `GH_REPO`, or—when none exists—the sole active host
returned by `gh`. When that produces exactly one account,
`formatTabError()` may include a sanitized `login@host`: construct the complete
candidate, use it only if it is at most 120 characters, and otherwise use the
fixed `active gh account` remedy. Never truncate the command at the end of the
remedy. The original endpoint error remains in the structured record and in
`--doctor`; optional context never replaces evidence.

### 5. `--doctor` reuses the repository-access builder

`--doctor` already prints authenticated hosts, target source/host/slug/remote,
and the exact endpoint probes (`index.mjs:1111-1185`). Add one read-only
`Repository access` probe using `repoContextArgs()` before the six endpoint
blocks. It reports the same `ok`/failure, duration, stderr, HTTP status, and
classification fields as the existing probes.

The raw `gh auth status` section remains the canonical full account report. The
dashboard's compact active-account parser is not printed as a second competing
truth. The report continues to pass through the existing single redaction
boundary (`index.mjs:1182-1185`).

### 6. Documentation teaches the actual ownership model

Add a first-run sequence immediately after installation:

```
gh auth status
gh auth login                    # when no account is active
gh auth switch                   # when supported and the wrong account is active
gh-glance
```

For a non-default host, retain the existing `--hostname` guidance. For
multiple-account guidance, tell older-`gh` users whose install lacks `gh auth
switch` to update `gh`; this optional workflow does not raise gh-glance's core
minimum. For simultaneous accounts, retain separate `GH_CONFIG_DIR` values
rather than claiming a pane can pin an account (`README.md:243-269`,
`README.md:373-379`).

Troubleshooting gains the two exact supplied symptoms and the truthful combined
cause: repository not found **or** not visible to the active account. The next
evidence command is `gh-glance --doctor`; the recovery commands are owned by
`gh`, not gh-glance.

## Phases

| Phase | Title | Files | Batch | Done |
|---|---|---|---|---|
| 1 | Failure semantics and one-line remedies | `index.mjs`, `test/unit.test.mjs` | — | [x] |
| 2 | Failure-triggered account/repository context | `index.mjs`, `test/unit.test.mjs`, `test/doctor.test.mjs`, `test/pty/e2e.test.mjs` | — | [x] |
| 3 | Deterministic doctor and PTY evidence | `test/pty/fixtures/gh`, `test/doctor.test.mjs`, `test/pty/capture.mjs`, `test/pty/e2e.test.mjs` | `[batch-eligible]` with phase 4 after phase 2 | [x] |
| 4 | First-run and troubleshooting documentation | `README.md`, `CHANGELOG.md`, `SECURITY.md` | `[batch-eligible]` with phase 3 after phase 2 | [x] |

Phases 1 and 2 are sequential because both edit `index.mjs` and Phase 2 consumes
Phase 1's structured failure contract. After Phase 2, Phases 3 and 4 share no
files and neither consumes the other's output; both are fully specified here,
so they are batch-eligible.

Phase files:

- [`phase-1.md`](2026-08-06-delegated-authentication-onboarding-phases/phase-1.md)
- [`phase-2.md`](2026-08-06-delegated-authentication-onboarding-phases/phase-2.md)
- [`phase-3.md`](2026-08-06-delegated-authentication-onboarding-phases/phase-3.md)
- [`phase-4.md`](2026-08-06-delegated-authentication-onboarding-phases/phase-4.md)

## Success criteria

### Automated

- The exact no-login strings observed with an empty `GH_CONFIG_DIR` classify as
  `auth-problem`.
- The exact GraphQL repository-resolution string in Image 2 classifies as
  `unavailable`; a REST 404 remains `unavailable`.
- Rate limiting still outranks auth markers; SAML/SSO stays `auth-problem`;
  DNS/network errors remain `other`.
- List-tab fixed remedies have no newline and are at most 120 characters.
- A successful repository context keeps a feature-level unavailable message;
  a failed repository context selects the repository/account remedy.
- Failure context runs once per unresolved episode, never blocks startup, and
  is invalidated by manual `r`.
- An unsupported/failing `gh auth status --active --json hosts` during an
  unavailable-repository diagnosis leaves the core remedy intact and does not
  create an unhandled rejection.
- `--doctor` prints seven classified probe blocks: Repository access plus the
  existing six endpoints.
- Planted tokens, proxy credentials, and URL userinfo remain absent from doctor
  output.
- The PTY fixture can inject exact or compound failures across `run`, `issue`,
  `pr`, `repo`, `auth`, and `api` without changing healthy captures.
- Existing frame height/width, alternate-screen, cursor, signal-exit, and
  primary-buffer assertions stay green.
- After every phase, run sequentially:

  ```bash
  npm run lint && npm test && node --check index.mjs && npm run test:pty
  ```

### Manual/read-only

Use temporary config directories and read-only API calls only; do not mutate the
developer's real active account merely to prove the feature.

1. **Fresh user:** with an empty temporary `GH_CONFIG_DIR` and token variables
   unset, run against a public `--repo`. The dashboard shows the login/
   authorization remedy, launches no supplementary context probes, remains
   alive, and `r` retries. `--doctor` reports no authenticated hosts and
   classifies failures as `auth-problem`.
2. **Invisible or stale target:** with a valid login, run against a guaranteed
   nonexistent slug. Actions' REST 404 and Issues' GraphQL resolution failure
   converge on the same repository/account guidance without claiming whether
   the repository is private or nonexistent.
3. **Accessible control:** a known visible repository still populates all
   supported tabs and the Repository access doctor probe is `ok`.
4. **Multiple accounts:** only when two already-isolated `GH_CONFIG_DIR`
   fixtures exist, run each independently and verify the optional context names
   the matching active account. Do not use `gh auth switch` as part of automated
   or manual verification.

## Risks and guardrails

- **Optional account context depends on newer `gh` reporting flags.** It is a
  best-effort enhancement, never the basis of the verdict. Core classification
  and remedies work on the documented minimum. Multi-account docs capability-
  check `gh auth switch` and direct older users to update `gh` for that workflow.
- **A repository 404 is intentionally ambiguous.** Copy always says “not found
  or inaccessible”; it never claims permission failure, deletion, or typo.
- **A feature endpoint can be unavailable while the repository is visible.** A
  successful `gh repo view` preserves the existing feature-level message rather
  than replacing it with an account diagnosis.
- **Extra subprocesses can amplify a failure loop.** The context resolver is
  failure-triggered, in-flight guarded, abortable, and cached until `r`.
- **Account names and repository strings are remote/untrusted text.** They pass
  through `safe()` before state/rendering, and doctor output remains behind
  `redact()`.
- **Structured error state touches layout indirectly.** The design retains one
  rendered line and the existing `Boolean(error)` height calculation; the full
  PTY suite is mandatory.
- **Docs must not imply gh-glance handles credentials.** README and SECURITY
  continue to state that login, refresh, switching, token storage, and account
  selection belong to `gh`.
