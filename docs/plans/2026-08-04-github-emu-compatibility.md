# Plan: make gh-glance correct on GitHub EMU

> 2026-08-04 | Branch `develop` @ `38cfaa6`
> Research: [`docs/research/2026-08-04-github-emu-compatibility.md`](../research/2026-08-04-github-emu-compatibility.md)

## Goal

Run `gh-glance` against a GitHub Enterprise Managed Users tenant without it
reporting anything false. Two deployment forms are supported because the target
tenant's form is not yet confirmed: standard EMU on `github.com`, and data
residency on `<slug>.ghe.com`.

Scope, as chosen: **correctness, a diagnostics command, and documentation.**
`--repo` widens to the `[HOST/]OWNER/REPO` form `gh` itself already accepts. No
new *configuration* surface is added — the one new flag, `--doctor`, is a
reporting command that exits, like `--help` and `--version`.

`--doctor` was added to the scope after the initial decision, deliberately: the
largest risk in this plan is that the SSO-detection strings could not be
reproduced without an EMU tenant. A diagnostics command turns the work machine
into the evidence source instead of relying on a verbal description of what a
failure looked like.

## The two defects

Both are cases of the dashboard stating something confident and wrong — the
exact failure mode `index.mjs:239-243` says the error classifier exists to
prevent.

### D1 — a SAML SSO lapse is reported as "feature not enabled", for up to an hour

EMU tenants expire the SAML session periodically; the user re-authorizes in the
browser and continues. While lapsed, the API answers **403**.

`isUnavailable()` (`index.mjs:244-246`) matches `HTTP (403|404)` and returns
true. `fetchAlertSource()` (`index.mjs:542-547`) then latches the source's
fixed note — for code scanning, `"Code scanning: not enabled (needs GitHub
Advanced Security)"` (`index.mjs:469`) — and calls `recordFailure()`, whose
steps escalate `60s → 300s → 1800s → 3600s` (`index.mjs:104`).

So a lapse the user fixes in seconds can leave the Security tab blank, captioned
with a false explanation, for up to an hour after it is fixed. Backoff only
clears on a *successful* fetch (`index.mjs:525`), and no fetch is attempted
while the backoff is active (`index.mjs:519-522`).

This is the highest-value fix in the plan.

### D2 — on a `ghe.com` tenant, the three alert calls silently go to github.com

Verified against `gh` 2.97.0:

| Mechanism | `run`/`issue`/`pr list` | `gh api` placeholder |
|---|---|---|
| `--repo HOST/OWNER/REPO` | routes to host | *(no `--repo` flag)* |
| `GH_REPO=HOST/OWNER/REPO` | routes to host | supplies OWNER/REPO, **ignores HOST** |
| `GH_HOST` | routes to host | routes to host |
| `--hostname` | *(n/a)* | routes to host |

The second row is the defect: it is the only combination where the two halves
of the dashboard disagree about which host they are talking to.

`gh api` is invoked at `index.mjs:524` with no `--hostname`, and `apiPath()`
(`index.mjs:325-327`) substitutes only `{owner}/{repo}`. A host-qualified target
therefore makes the four list-driven tabs correct while the three alert
endpoints query `github.com`, 404, and — via D1 — render as "not enabled".

## What is already fine, and stays untouched

- `runGh()` merges rather than replaces the child environment
  (`index.mjs:304`), so `GH_HOST`, `GH_TOKEN`, `GH_ENTERPRISE_TOKEN`,
  `GH_CONFIG_DIR` and the proxy variables already reach `gh`. The comment at
  `index.mjs:270-276` already names them.
- Credentials stay entirely `gh`'s (`SECURITY.md:83-85`, ADR 0001). No token
  flag, no token handling. chapa-cli's `--emu-token` model is deliberately
  **not** adopted; it exists there only because that tool has no `gh`
  dependency.
- The zero-flag path already works on both EMU forms once
  `gh auth login --hostname <tenant>` has been run. Verified: a checkout whose
  remote points at an unauthenticated host fails with `none of the git remotes
  configured for this repository point to a known GitHub host`, and
  authenticating is what resolves it.
- No account-pinning feature. The work machine will hold the EMU account only,
  so `gh`'s single active account is always the right one.

## Design

### Repo target parsing

`REPO_PATTERN` (`index.mjs:661`) keeps its exact current meaning — it validates
the `owner/name` half — and a new parser wraps it.

```
HOST_PATTERN = /^[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?)+$/

parseRepoTarget(value):
    parts <- value.split("/")
    if parts.length == 3:
        [host, owner, name] <- parts
        require HOST_PATTERN.test(host)        # a dot is mandatory
        slug <- owner + "/" + name
    else if parts.length == 2:
        host <- null
        slug <- value
    else:
        throw
    require REPO_PATTERN.test(slug)
    return { host, slug }
```

**The mandatory dot is the safety property.** Without it, the existing hostile
input `"owner/name/extra"` (`test/args.test.mjs:54`) would silently become a
request to a host named `owner` — a typo turning into a cross-host request. With
it, every value in the current hostile list stays rejected. This is checked by
an executable artifact rather than argued: Phase 1 keeps that list intact and
adds host-form cases to it.

The thrown message becomes `--repo must look like owner/name or
host/owner/name, got: X`, which still satisfies the existing assertion regex
`/must look like owner\/name/` at `test/args.test.mjs:67`.

### Host routing

```
runtime.repo  : string | null    # the owner/name slug, as today
runtime.host  : string | null    # NEW, null unless the target was host-qualified

repoArgs()    -> runtime.repo ? ["--repo", qualified()] : []
                 where qualified() = host ? host + "/" + repo : repo
apiPath(p)    -> runtime.repo ? p.replace("{owner}/{repo}", runtime.repo) : p
apiHostArgs() -> runtime.host ? ["--hostname", runtime.host] : []      # NEW
```

`gh api` at `index.mjs:524` gains `...apiHostArgs()`. When no host was given the
argv vector stays byte-identical to today's, so the default path is provably
unchanged.

`--hostname` is *not* added when the repo is being inferred from the working
directory: in that case `gh` resolves host and repo together from the remote,
which the research verified is the correct behaviour.

### Error classification

A third predicate joins `isUnavailable()` and `isRateLimited()`:

```
isAuthProblem(err) -> /SAML|single[- ]sign[- ]on|\bSSO\b|must grant|not authorized|
                       Bad credentials|requires authentication|token.*scope|
                       re-?authoriz/i .test(stderr ?? message)
```

and the latch condition at `index.mjs:542` becomes:

```
unavailable <- isUnavailable(err) AND NOT isRateLimited(err) AND NOT isAuthProblem(err)
```

An auth problem therefore:
- reports `${source.name}: ${shortErr(err)}` — gh's real message, not a claim
  about repository configuration;
- takes a short **fixed** retry rather than the escalating ladder, so recovery
  after re-authorizing is bounded at `AUTH_RETRY_MS = 30_000` instead of an
  hour, while still bounding the cost of a lapse that lasts all night.

`recordFailure()` gains a `steps` argument so the two ladders stay one code path
rather than two.

### Diagnostics — `--doctor`

A reporting command that gathers, in one bounded plain-text block: versions and
platform, which `gh` hosts are authenticated, how the repo target resolved and
from where, which relevant environment variables are *set* (never their secret
values), and then **probes all six endpoints and reports how each error was
classified**.

That last part is the point. The report states, per endpoint, whether the
failure was read as `unavailable` / `rate-limited` / `auth-problem` / `other` —
which is exactly the signal needed to tell whether the Phase 2 detector fired on
a real SAML lapse, and to tighten it from evidence if it did not.

Redaction is a first-class requirement with its own test, not a review note. See
[`phase-3.md`](2026-08-04-github-emu-compatibility-phases/phase-3.md).

## Phases

| Phase | Title | Files | Batch | Done |
|---|---|---|---|---|
| 1 | Host-aware repo targets | `index.mjs`, `test/args.test.mjs` | — | [x] |
| 2 | Honest 403 classification | `index.mjs`, `test/unit.test.mjs` | — | [x] |
| 3 | `--doctor` diagnostics | `index.mjs`, `test/doctor.test.mjs` | — | [x] |
| 4 | pty coverage for argv routing | `test/pty/*` | `[batch-eligible]` with 5 | [x] |
| 5 | Documentation | `README.md`, `CHANGELOG.md`, `SECURITY.md` | `[batch-eligible]` with 4 | [x] |

All five phases are implemented; two deviations are recorded in
`2026-08-04-github-emu-compatibility-notes.md`. The Manual success criteria
below still require the work machine and an EMU tenant.

Phases 1, 2 and 3 all edit `index.mjs`, so they run sequentially in that order.
Phase 3 reports the classification Phase 2 introduces, so it genuinely follows
it. Phase 4 depends on Phase 1's argv changes. Phase 5 shares no file with
Phase 4 and its content is fully determined by this plan, so the two can be
batched.

Phase files: [`phase-1.md`](2026-08-04-github-emu-compatibility-phases/phase-1.md),
[`phase-2.md`](2026-08-04-github-emu-compatibility-phases/phase-2.md),
[`phase-3.md`](2026-08-04-github-emu-compatibility-phases/phase-3.md),
[`phase-4.md`](2026-08-04-github-emu-compatibility-phases/phase-4.md),
[`phase-5.md`](2026-08-04-github-emu-compatibility-phases/phase-5.md).

## Success criteria

### Automated

- `npm test`, `npm run lint`, `node --check index.mjs`, `npm run test:pty` all pass.
- Every value in the existing hostile list at `test/args.test.mjs:52-65` still
  throws.
- `--repo tenant.ghe.com/acme/widget` parses to `{host: "tenant.ghe.com", slug:
  "acme/widget"}`; `--repo acme/widget` parses to `{host: null, slug:
  "acme/widget"}`.
- With no `--repo`, the argv vector for every `gh` call is byte-identical to
  `develop` — asserted from the pty fixture log.
- A 403 carrying SAML/SSO text does not produce a "not enabled" note and does
  not enter the escalating backoff.
- A 403 with no auth markers still produces the existing note and ladder.
- `--doctor` output contains no token, no proxy credential, and no `Authorization`
  header, asserted against synthetic secret-bearing inputs.
- `--doctor` exits 0 with a report when `gh` is unauthenticated, when the
  process is outside a git repository, and when stdout is a pipe.

### Manual (work machine, EMU tenant)

The first step is now a single command rather than a description:

```bash
gh-glance --doctor > emu-report.txt
```

- That report settles which EMU form the tenant is — `github.com` or
  `<slug>.ghe.com` — the one fact the research could not determine.
- `gh-glance` run inside a work clone populates all four tabs with no flags.
- During a SAML lapse, `--doctor` records the verbatim `gh` error text and the
  classification it received. If any lapse was classified `other` rather than
  `auth-problem`, the detector regex is tightened from those strings.
- The Security tab shows gh's real message during a lapse and recovers within
  ~30s of re-authorizing, rather than staying blank for up to an hour.
- On a `ghe.com` tenant only: `gh-glance --repo <tenant>/<org>/<repo>` from
  outside a clone populates the Security tab rather than showing "not enabled".

## Risks

- **The SSO detector is written against message text that could not be
  reproduced locally.** No EMU tenant was available. The regex is deliberately
  broad and fails safe: an unmatched SSO message degrades to today's behaviour,
  never to something worse. This is the risk `--doctor` (phase 3) exists to
  retire — it captures the verbatim strings and the classification each one
  received, so the pattern is tightened from evidence rather than guessed twice.
- **A diagnostics command that prints environment detail is a disclosure
  surface.** Treated as the primary design constraint of phase 3: values of
  token-shaped and credential-bearing variables are never printed, only their
  presence; proxy URLs are stripped to scheme and host; response bodies are
  never included, only sizes. The redaction has its own test with synthetic
  secrets.
- **Widening `REPO_PATTERN` touches a stated security boundary**
  (`test/args.test.mjs:48-51`). Mitigated by keeping that pattern's meaning
  unchanged, keeping the whole hostile list, and requiring a dot in the host.
- If the tenant turns out to be standard EMU on `github.com`, Phase 1 is
  unnecessary for this user but not wasted — it is what makes the tool correct
  for GHES and data-residency users, and D2 would otherwise remain a latent
  silent-wrong-data bug.
