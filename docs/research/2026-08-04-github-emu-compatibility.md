# Research: what gh-glance assumes about github.com, and where GitHub EMU diverges

> 2026-08-04 | Branch `develop` @ `38cfaa6`
> Documentarian pass — this describes what exists, in gh-glance and in
> chapa-cli, not what should change.

## Scope

The question: can `gh-glance` run against a GitHub Enterprise Managed Users
(EMU) account, and what does `chapa-cli` — which already runs against the
author's Avolta EMU tenant — do that is relevant.

This document covers four things: the `gh` boundary as it stands, the exact
places a non-personal account or non-default host meets a hardcoded assumption,
what chapa-cli actually does, and what the project's own written record already
commits to.

## 1. The one architectural fact that governs everything

`docs/decisions/0001-keep-the-gh-cli-data-layer.md:29-30` records the decision:

> **No-go.** The `gh` CLI stays the data layer. Actions, Issues, PRs and the
> three alert endpoints keep their own invocations.

`SECURITY.md:83-85` states the consequence for credentials:

> gh-glance never handles GitHub credentials directly -- authentication is
> entirely delegated to your existing `gh auth login` session. It has no
> network code of its own; every GitHub API call goes through the `gh` CLI.

Every host, token, SSO, proxy and TLS concern is therefore `gh`'s, not this
codebase's. That is the reason the EMU surface area here is small.

## 2. The `gh` subprocess boundary

One seam, `runGh()` at `index.mjs:297-313`:

```js
const { stdout } = await execFileAsync("gh", args, {
  timeout: GH_TIMEOUT_MS,
  killSignal: "SIGKILL",
  maxBuffer: GH_MAX_BUFFER,
  env: { ...process.env, ...GH_ENV_OVERRIDES },
  signal,
});
```

The environment is **merged, not replaced** (`index.mjs:304`). The comment at
`index.mjs:270-276` already names the enterprise variables as load-bearing:

> The environment is *overridden*, never replaced: `gh` needs GH_TOKEN,
> **GH_HOST (GitHub Enterprise)**, GH_CONFIG_DIR, HOME and the proxy variables
> to work at all, and GH_REPO is the one documented way to point this tool at
> another repository.

`GH_ENV_OVERRIDES` (`index.mjs:277-282`) sets only `GH_FORCE_TTY`, `NO_COLOR`,
`CLICOLOR_FORCE`, `GH_PAGER`. It touches no host, token, config-dir or proxy
variable. **`GH_HOST`, `GH_TOKEN`, `GH_ENTERPRISE_TOKEN`, `GH_CONFIG_DIR`,
`HTTPS_PROXY` all reach `gh` unmodified today.**

That comment at `index.mjs:272` is the only mention of GitHub Enterprise
anywhere in the repository.

## 3. Every `gh` invocation

| What | Where | Argv |
|---|---|---|
| Preflight | `index.mjs:630` | `gh --version` |
| Actions | `index.mjs:332-343` | `gh run list [--repo R] --limit N --json …` |
| Issues | `index.mjs:373-386` | `gh issue list [--repo R] --state open --limit 150 --search sort:updated-desc --json …` |
| PRs | `index.mjs:403-416` | `gh pr list [--repo R] --state open --limit 150 --search sort:updated-desc --json …` |
| Alerts ×3 | `index.mjs:524` | `gh api <path> --jq <projection>` |
| Open item | `index.mjs:612` | `gh <run\|issue\|pr> view [--repo R] <n> --web` |

The three alert paths (`index.mjs:452`, `:467`, `:482`):

```
repos/{owner}/{repo}/dependabot/alerts?state=open&per_page=100
repos/{owner}/{repo}/code-scanning/alerts?state=open&per_page=100
repos/{owner}/{repo}/secret-scanning/alerts?state=open&per_page=100
```

**No call passes `--hostname`.** `gh api` supports it — verified locally against
`gh` 2.97.0: `--hostname string   The GitHub hostname for the request (default
"github.com")`. The alert fetchers rely instead on `{owner}/{repo}` placeholder
resolution, or on the substitution below.

## 4. Repository resolution, and the first hard blocker

Three layers:

- `repoArgs()` (`index.mjs:317-319`) — appends `--repo <value>` for the list
  subcommands, empty when unset.
- `apiPath()` (`index.mjs:325-327`) — string-replaces `{owner}/{repo}` in the
  API path when `runtime.repo` is set, otherwise leaves the placeholder for
  `gh` to resolve from the working directory.
- `preflight()` (`index.mjs:641`) — skips the git-repo check when
  `runtime.repo || process.env.GH_REPO` is set.

The validation is `REPO_PATTERN` at `index.mjs:661`:

```js
const REPO_PATTERN = /^[A-Za-z0-9](?:[A-Za-z0-9._-]*[A-Za-z0-9])?\/[A-Za-z0-9._-]+$/;
```

Exactly two segments. `gh` itself accepts three — verified locally:

```
-R, --repo [HOST/]OWNER/REPO   Select another repository using the [HOST/]OWNER/REPO format
```

and `gh help environment` documents `GH_REPO` the same way: *"specify the GitHub
repository in the `[HOST/]OWNER/REPO` format"*.

**gh-glance rejects the host-qualified form deliberately, and there is a test
asserting it.** `test/args.test.mjs:54` lists `"owner/name/extra"` among the
hostile inputs, under the comment at `:48-51`:

> This value reaches a subprocess argument AND is interpolated into a `gh api`
> request path. […] an unvalidated value in the path would be a request-forgery
> primitive against arbitrary endpoints -- so the pattern is the boundary.

So `--repo myenterprise.ghe.com/org/repo` exits 2 today, and it does so for a
stated security reason rather than by oversight.

`GH_REPO` takes a different path: nothing validates it, and it is only ever
tested for presence (`index.mjs:641`). It reaches `gh` verbatim through the
merged environment. With `GH_REPO` set, `runtime.repo` stays `null`, so
`apiPath()` leaves `{owner}/{repo}` in place for `gh` to resolve.

## 5. What EMU actually changes

Two distinct deployments, and they are not the same problem:

| | Host | What breaks |
|---|---|---|
| **Standard EMU** | `github.com` | Nothing host-related. It is an *account* on the default host. |
| **EMU with data residency** | `<slug>.ghe.com` | Host-qualified repo refs, and `gh api` host targeting. |

GitHub's own documentation confirms both forms: *"you manage the lifecycle and
authentication of your users on GitHub.com or GHE.com from an external identity
management system"*, and *"EMU enterprises are hosted on GitHub.com and EMU
enterprises with data residency on GHE.com."*

**Evidence the Avolta tenant is the standard `github.com` form:** chapa-cli
hits a hardcoded `https://api.github.com/graphql` (`chapa-cli/src/fetch-emu.ts:190`)
with an EMU token and works. There is no host configuration anywhere in that
codebase. Worth confirming on the work machine with `gh auth status` before
building on it, since it is the fact the whole assessment pivots on.

If it is standard EMU, the problem is **account selection on one host**, not
host selection. `gh` scopes accounts per host; the documentation states: *"You
can also authenticate with multiple accounts on the same platform. To switch
between these accounts, you can use the `gh auth switch` command."* Verified
locally, `gh auth switch` takes `--hostname` and `--user`, and the active
account is global state in `~/.config/gh/hosts.yml` — which on this machine
holds a `users:` map and an active `user:` key under `github.com:`.

gh-glance has no account concept and no way to pin one. The available lever is
`GH_CONFIG_DIR`, which already passes through untouched (§2) and is named in the
`index.mjs:272` comment.

## 6. The error-classification hazard

`isUnavailable()` at `index.mjs:244-246`:

```js
return /HTTP (403|404)/.test(String(err?.stderr ?? err?.message ?? ""));
```

Used at `index.mjs:542`, a 403 latches a backoff (`index.mjs:544-547`) and
renders a fixed note — for code scanning, `"Code scanning: not enabled (needs
GitHub Advanced Security)"` (`index.mjs:469`).

The comment at `index.mjs:239-243` states the intended split:

> 403/404 is the honest "you can't see this here" -- everything else (auth
> expiry, rate limiting, DNS, a 502) is a real failure that used to be reported
> as a confident, plausible, and wrong claim that the feature was switched off.

Under EMU, 403 carries additional meanings it does not carry on a personal
account: SAML/SSO authorization not granted for the credential, and
enterprise policy restricting the endpoint. Both would currently render as
"not enabled for this repository" — the exact class of confident-and-wrong
claim the comment says the function exists to avoid. The backoff steps to one
hour (`index.mjs:104`).

`README.md:284` documents the intended behaviour: *"A genuine auth or network
failure shows the real error instead."*

## 7. What chapa-cli does, and how much of it transfers

chapa-cli solves a **different problem with a different mechanism**.

- It does not use `gh` at all. It issues raw GraphQL to a hardcoded
  `https://api.github.com/graphql` (`src/fetch-emu.ts:190`).
- It takes an explicit EMU identity and credential:
  `--emu-handle`, `--emu-token`, or `GITHUB_EMU_TOKEN` (`README.md:99-100`,
  `:81`), documented as a classic PAT created on the EMU account
  (`README.md:132`) with scopes `repo`, `read:user`, `read:org`,
  `read:discussion` (`README.md:141-146`).
- Its purpose is to read *one* EMU identity's contribution stats and merge them
  into a personal badge — it is explicitly a bridge between two identities
  (`README.md:14`), not a tool that operates as the EMU user.
- There is **no** `GH_HOST`, no hostname option, no host configuration, and no
  `gh auth` interaction anywhere in the repository.

Three things it learned about corporate environments, all in
`README.md:180-190`:

| Symptom | Cause | Fix |
|---|---|---|
| TLS certificate errors | Corporate TLS interception | `--insecure` |
| `fetch failed → ECONNREFUSED` | Corporate firewall blocking `api.github.com` | — |
| PRs/lines/reviews zero, commits work | SAML SSO not authorized | Authorize token for the org |

`--insecure` is implemented as `process.env.NODE_TLS_REJECT_UNAUTHORIZED = "0"`
(`src/background.ts:22-23`), scoped to the fetch in `src/http.test.ts:10-21`.

**One documented claim has no code behind it.** `README.md:161` says *"Run
`chapa merge --verbose`. If you see `saml_failure` in the error output…"*, but
the error categories are `"auth" | "network" | "graphql" | "server" | "unknown"`
(`src/telemetry.ts:7`) and a grep for `saml` across `src/` and `docs/` returns
nothing. A 403 is classified as `"auth"` (`src/fetch-emu.ts:135-137`).

### Transferability

The token plumbing does not transfer. gh-glance delegating auth entirely to
`gh auth login` is the stated position of `SECURITY.md:83-85` and the whole
point of ADR 0001; a `--emu-token` flag would reintroduce credential handling
this codebase currently disclaims. The TLS and proxy concerns are `gh`'s to
handle, not this process's — gh-glance makes no network calls of its own.

What does carry over is knowledge, not code: that EMU handles differ from
personal handles, that SAML authorization is a distinct failure mode that
presents as partial/zero data rather than an error, and that corporate TLS
interception and firewalls are live concerns in that environment.

## 8. Test and fixture assumptions

The fixture `gh` at `test/pty/fixtures/gh:19-44` branches on `$1` only —
`--version`, `run`, `issue`, `pr`, `api` — and ignores every other argument,
including `--repo` and any hostname. It logs the full argv to
`GH_GLANCE_FIXTURE_LOG` (`:15`), so argv assertions are possible without the
fixture needing to understand what it received.

`test/unit.test.mjs:115` is the only test touching a hostname, and only as an
error string:

```js
assert.ok(!isUnavailable({ code: 1, stderr: "dial tcp: lookup api.github.com" }));
```

No test exercises a non-default host, a second account, or a host-qualified
repo reference beyond rejecting the three-segment form.

## 9. Absences, stated explicitly

- No occurrence of `GH_HOST`, `GH_ENTERPRISE_TOKEN`, `EMU`, `--hostname`, or
  "enterprise" anywhere in the repository except the single comment at
  `index.mjs:272`.
- `README.md:87-93` (Prerequisites), `README.md:198-216` (Configuration) and
  `CONTRIBUTING.md:22-26` state only *"authenticated (`gh auth login`)"* — no
  host, account, scope or enterprise guidance.
- `README.md:238-262` (Limitations) does not mention hosts or account types.
- No ADR, plan, or research document mentions enterprise, EMU, or multiple
  accounts.
- `preflight()` (`index.mjs:628-651`) checks only that `gh` is executable and
  that a git repo exists. `index.mjs:622-627` records that auth is deliberately
  *not* checked, because `gh auth status` makes a network call and exiting on it
  would break offline use.

## 10. Constraints any change sits inside

- Single file. `CLAUDE.md` project-file table: *"App source | `index.mjs` |
  single file, keep it that way"*.
- No build step. `CONTRIBUTING.md:36`: *"There's no build step -- it's plain ESM
  JavaScript, run directly by Node."*
- The main-module guard must survive. `CONTRIBUTING.md:50-52`: *"`index.mjs`
  guards its entry point behind a main-module check […] please keep that guard
  intact."*
- `REPO_PATTERN` is a security boundary with a test that documents why
  (`test/args.test.mjs:48-51`). Widening it is a security-relevant change, not a
  validation tweak.
- Any interpolation into a `gh api` path inherits that same boundary
  (`index.mjs:322-327`).

## Open questions for the planning phase

1. Is the Avolta tenant standard EMU on `github.com`, or data residency on
   `<slug>.ghe.com`? `gh auth status` on the work machine settles it, and the
   answer determines whether host support is needed at all.
2. Will both a personal and an EMU account be authenticated on the work
   machine simultaneously, or only the EMU one? Only the former needs account
   pinning.
3. Does `gh api repos/{owner}/{repo}/…` resolve the placeholder from `GH_REPO`
   when the process is outside a checkout? The alert tabs depend on it, and it
   is untested here.
