# Research: per-user GitHub authentication and repository resolution

> 2026-08-06 | Branch `develop` @ `310eeed`
> Documentarian pass — this describes the current v0.5.1 behavior and the two
> supplied screenshots. It does not propose an implementation.

## Scope

The question is whether a separately installed copy of gh-glance can use each
person's own GitHub credentials, and what the errors in the supplied Actions and
Issues screenshots say about that path.

The current product contract is that `gh-glance` does not authenticate to GitHub
itself. Authentication is delegated to the user's existing `gh auth login`
session, and every GitHub API call goes through the `gh` CLI
(`SECURITY.md:128-131`). The published prerequisite already asks each user to
authenticate `gh` for the host they intend to watch (`README.md:96-102`).

## Summary answer

Per-user credentials are already supported through delegation. Every invocation
starts the `gh` executable found on that user's `PATH`, passes it the user's
environment, and relies on that user's active `gh` account and credential store
(`index.mjs:419-439`, `index.mjs:489-504`). `GH_TOKEN`,
`GH_ENTERPRISE_TOKEN`, and `GH_CONFIG_DIR` are passed through to `gh`; gh-glance
does not read or store them (`README.md:231-237`).

What does not exist is a gh-glance-owned login flow. Normal startup checks that
`gh` can run and, when the target is inferred, that the working directory is a
git repository. Authentication and network checks are intentionally left to the
tab fetches (`index.mjs:880-915`). The only `gh auth` command gh-glance runs is
`gh auth status` inside the optional `--doctor` report
(`index.mjs:1111-1132`).

The screenshots are consistent with a different boundary: the active `gh`
identity could not resolve the repository named in the remote. The same response
also occurs for a repository slug that is stale, renamed, deleted, or mistyped,
so the two screenshots alone do not distinguish repository existence from
repository visibility. The current classifier maps a bare HTTP 403/404 to
`unavailable`, while a GraphQL resolution message without an HTTP status remains
an unclassified raw error (`index.mjs:331-407`, `index.mjs:2522-2538`).

## 1. Credential ownership

### 1.1 The `gh` subprocess is the authentication boundary

The application has no GitHub HTTP client. Its header states that all data comes
from `gh issue`, `gh pr`, `gh run`, and `gh api` calls rather than direct GitHub
API calls (`index.mjs:1-7`). The accepted data-layer decision keeps the separate
`gh` invocations in place (`docs/decisions/0001-keep-the-gh-cli-data-layer.md:27-30`).

Every GitHub command reaches one function, `runGh()`. It executes the bare name
`gh` with an argument array, a timeout, a bounded output buffer, and the merged
parent environment (`index.mjs:489-504`). The four local overrides only disable
TTY formatting and paging; the surrounding comment explicitly preserves
`GH_TOKEN`, `GH_HOST`, `GH_CONFIG_DIR`, `HOME`, proxies, and `GH_REPO`
(`index.mjs:419-439`).

The consequence is that an npm-installed gh-glance does not carry the
maintainer's credential. The npm package exposes `index.mjs` as the executable
and ships source/docs only (`package.json:2-14`); credential handling remains in
the `gh` installation and user environment on the machine where the process is
running (`SECURITY.md:128-131`).

### 1.2 Supported credential sources are `gh` sources

The README documents three credential/config inputs that pass through untouched:
`GH_TOKEN`, `GH_ENTERPRISE_TOKEN`, and `GH_CONFIG_DIR`
(`README.md:231-237`). It also documents the stored-login path through
`gh auth login`, including host-specific login for GitHub Enterprise and EMU
(`README.md:96-102`, `README.md:243-253`).

The diagnostic report treats token values as secrets. `GH_TOKEN`,
`GH_ENTERPRISE_TOKEN`, and `GITHUB_TOKEN` are always presence-only fields, while
the small plain-value list includes target/config inputs such as `GH_HOST`,
`GH_REPO`, and `GH_CONFIG_DIR` (`index.mjs:928-987`). The report is assembled
through one redaction boundary before it is returned (`index.mjs:1182-1185`),
and tests plant token/proxy credentials and assert that their values do not reach
the output (`test/doctor.test.mjs:107-125`).

### 1.3 Account selection and isolation

gh-glance has no account identifier in its runtime state; the state holds only a
repository slug, optional host, refresh interval, verbosity, and initial tab
(`index.mjs:161-174`). On a host with multiple authenticated accounts, the
README states that gh-glance follows whichever account `gh auth switch` most
recently made active (`README.md:373-379`).

The same section records the simultaneous-account form: separate panes can use
separate `GH_CONFIG_DIR` values (`README.md:376-379`). That works within the
existing subprocess boundary because the entire parent environment is preserved
for every `gh` call (`index.mjs:426-439`, `index.mjs:489-497`). There is no
per-pane account-pinning flag in the current argument parser; its accepted
options are help, version, doctor, repository, refresh, tab, and verbose
(`index.mjs:1255-1295`).

## 2. Repository identity and host resolution

### 2.1 Default invocation delegates remote resolution to `gh`

With no arguments, `runtime.repo` and `runtime.host` are both `null`; the source
comment defines that as letting `gh` infer the target from the git remote
(`index.mjs:161-170`). In that state, `repoArgs()` returns no `--repo` argument
and `apiPath()` leaves `{owner}/{repo}` placeholders for `gh` to resolve
(`index.mjs:507-537`). The public usage text describes the same behavior
(`README.md:168-177`).

Normal startup verifies only that the working directory is a git repository. It
does not read the origin URL, resolve a repository, or test access before the UI
starts (`index.mjs:888-915`). `git remote get-url origin` is called only by
`--doctor`, where it is reported alongside whether the target source was a flag,
`GH_REPO`, or the git remote (`index.mjs:1042-1057`).

The panel names an explicit `--repo` or `GH_REPO` target, but deliberately does
not spend a subprocess to label an inferred target (`index.mjs:2738-2754`). The
two supplied screenshots show only `Actions` and `Issues` in the panel edge,
which matches the inferred-target rendering path rather than the explicit-target
path.

### 2.2 Explicit targets

`--repo` accepts `[host/]owner/name`. The parser validates the optional host and
repository slug separately, and stores them separately in runtime state
(`index.mjs:1188-1242`, `index.mjs:1297-1330`). Tests cover both the two-part
and host-qualified forms (`test/args.test.mjs:38-46`,
`test/args.test.mjs:72-89`).

Actions, Issues, and Pull Requests receive the qualified target through
`--repo`. Security uses the bare slug in its REST path and, for a host-qualified
flag, sends the host through `gh api --hostname`
(`index.mjs:507-537`, `index.mjs:545-558`, `index.mjs:587-634`,
`index.mjs:715-717`).

`GH_REPO` follows a different route: it is inherited by `gh`, and its presence
also makes preflight skip the local-git-repository check
(`index.mjs:902-906`). The README records that a host-qualified `GH_REPO` does
not route the `gh api` alert calls by itself; `GH_HOST` or a host-qualified
`--repo` supplies that host routing (`README.md:231-237`,
`README.md:265-269`).

## 3. What the screenshots exercise

### 3.1 Actions: normalized HTTP 404/403 path

Actions executes `gh run list`, optionally with `--repo`, and parses the JSON
only after the subprocess succeeds (`index.mjs:545-574`). A failed subprocess
is classified in this priority order: rate-limited, recognized authentication
problem, generic HTTP 403/404 unavailable, or other (`index.mjs:331-386`).

The exact Image 1 text, `not available for this repository`, is the fixed remedy
for the generic unavailable verdict (`index.mjs:403-407`). List-tab failures use
that remedy when a classifier match exists (`index.mjs:2522-2538`), and the
active tab renders the result as one red line above the table header
(`index.mjs:2806-2832`).

### 3.2 Issues: raw GraphQL resolution path

Issues executes `gh issue list` with the inferred target unless an explicit
`--repo` was supplied (`index.mjs:587-615`). The Image 2 message,
`GraphQL: Could not resolve to a Repository with the name
'Nvteca/cashflor-forecast'. (repository)`, contains none of the current rate,
auth, or HTTP-status markers (`index.mjs:331-386`). It therefore takes the
`other` path, where the dashboard displays `shortErr(err)` rather than replacing
the message (`index.mjs:389-407`, `index.mjs:2522-2532`).

`shortErr()` prefers `gh` stderr, collapses newlines, and truncates the result to
one 120-character row (`index.mjs:299-321`). That is the raw GraphQL line visible
in Image 2.

### 3.3 Read-only reproduction

Using the repository slug visible in Image 2, the current local `gh` returned the
same two underlying response shapes on 2026-08-06:

```text
$ gh run list --repo Nvteca/cashflor-forecast --limit 1 --json databaseId
failed to get runs: HTTP 404: Not Found

$ gh issue list --repo Nvteca/cashflor-forecast --limit 1 --json number
GraphQL: Could not resolve to a Repository with the name 'Nvteca/cashflor-forecast'. (repository)
```

Those responses feed the two code paths described above: HTTP 404 becomes
`unavailable`, while the GraphQL message remains `other`
(`index.mjs:331-407`, `index.mjs:2522-2538`).

With `GH_CONFIG_DIR` pointed at an empty temporary directory and all token
variables removed, `gh auth status` instead reported no authenticated hosts and
`gh issue list` instructed the operator to run `gh auth login`. In gh-glance,
that missing-login text is not one of the current `AUTH_MARKERS`, so it also
falls through as a raw `other` error (`index.mjs:361-386`,
`index.mjs:2522-2532`). Normal preflight does not intercept it
(`index.mjs:888-915`).

### 3.4 What can and cannot be inferred from the pair

The pair establishes that the selected `gh` context could not resolve/read the
named repository. GitHub uses the same 404/resolution response shape when a
repository does not exist and when the active identity cannot see a private
repository, so the rendered messages do not distinguish those cases. The
dashboard also does not import git transport credentials; its API calls use the
separate `gh` subprocess environment (`index.mjs:419-439`,
`index.mjs:489-504`).

The pair does not match the clean unauthenticated-`gh` response observed with an
empty config, which directly names `gh auth login`. It is compatible with an
authenticated but different account, a private-repository permission boundary,
or a stale/renamed/mistyped origin slug. The current diagnostic surface is what
records the active hosts, remote, target source, environment, and per-endpoint
responses needed to distinguish those cases (`index.mjs:1111-1185`,
`.github/ISSUE_TEMPLATE/bug_report.yml:96-115`).

## 4. Current onboarding and diagnostics

The published install path is `npm install -g gh-glance`, after the Node and
authenticated-`gh` prerequisites (`README.md:96-115`). Default use is the bare
`gh-glance` command inside a clone (`README.md:168-177`); `--repo` supports a
target outside a clone (`README.md:216-227`).

On a fresh machine, preflight has dedicated top-level messages for a missing
`gh` executable and for being outside a git repository
(`index.mjs:893-915`). It has no top-level authentication or repository-access
gate because those are intentionally allowed to reach the recoverable in-pane
fetch path (`index.mjs:888-892`). Recognized auth failures in list tabs are
translated to `GitHub authorization failed -- try gh auth login or gh auth
refresh`; unclassified failures retain `gh`'s message
(`index.mjs:389-407`, `CHANGELOG.md:124-129`).

`gh-glance --doctor` runs `gh auth status`, reports the target source, host,
slug, origin remote, relevant environment and API budget, and executes the same
six endpoint command builders used by the dashboard (`index.mjs:1111-1185`).
The README documents that report as shareable after redaction
(`README.md:276-303`), and the bug report form asks for it specifically because
it exposes authenticated hosts, target resolution, exact argv, and error
classification (`.github/ISSUE_TEMPLATE/bug_report.yml:96-115`).

## 5. Supported identity configurations in v0.5.1

| Configuration | Current behavior | Evidence |
|---|---|---|
| One GitHub.com account logged into `gh` | All calls use that user's active `gh` session | `SECURITY.md:128-131`; `index.mjs:489-504` |
| Token supplied through the environment | Token variables pass to `gh`; gh-glance does not store them | `README.md:231-237`; `index.mjs:426-439` |
| GitHub Enterprise or EMU host | Stored host login, `GH_HOST`, or host-qualified `--repo` routes through `gh` | `README.md:243-269`; `index.mjs:507-537` |
| Multiple accounts on one host, used one at a time | gh-glance follows the account last selected by `gh auth switch` | `README.md:373-379` |
| Multiple same-host accounts used simultaneously | Separate `GH_CONFIG_DIR` values isolate the panes | `README.md:376-379`; `index.mjs:489-497` |
| No authenticated `gh` session | Dashboard starts; tab fetches surface the `gh` error; doctor reports no authenticated hosts | `index.mjs:888-915`; `index.mjs:1111-1143` |
| Active account cannot resolve the inferred private repo | Actions can normalize 403/404 to unavailable while Issues/PRs can show raw GraphQL resolution text | `index.mjs:331-407`; `index.mjs:2522-2538` |

## 6. Existing verification coverage

Repository and host parsing are covered in the argument suite, including default
remote inference, explicit two-part targets, host-qualified targets, and rejected
shapes (`test/args.test.mjs:21-126`). Error formatting and the distinctions among
HTTP 404, SAML/SSO, bad credentials, missing scopes, and rate limits are covered
by unit tests (`test/unit.test.mjs:90-171`).

Doctor tests cover report structure, credential redaction, a missing `gh`
executable, end-to-end SAML classification, and host-qualified routing
(`test/doctor.test.mjs:93-156`). The PTY fixture intercepts the bare `gh`
executable through `PATH`, logs every call, and can inject API failures
(`test/pty/fixtures/gh:1-25`); the baseline PTY test asserts that the dashboard
actually reaches that data layer (`test/pty/e2e.test.mjs:27-39`).

The current automated suite does not model an empty real `gh` credential store,
an inaccessible private repository, or two real accounts on the same host. The
existing tests instead cover the argument/environment seams and representative
error strings described above (`test/args.test.mjs:21-126`,
`test/unit.test.mjs:120-171`, `test/doctor.test.mjs:93-156`).

## 7. Historical context

The earlier EMU research is explicitly a point-in-time snapshot of
`develop@38cfaa6` (`docs/research/2026-08-04-github-emu-compatibility.md:1-5`).
Its then-current inventory recorded no enterprise/multiple-account guidance or
coverage (`docs/research/2026-08-04-github-emu-compatibility.md:257-271`); the
completed phases and v0.4.0 release below are the later state.

The completed 2026-08-04 EMU plan kept credentials entirely inside `gh` and
explicitly did not adopt a token flag or token handling
(`docs/plans/2026-08-04-github-emu-compatibility.md:67-76`). That plan also kept
account pinning outside its scope for its single-account work-machine case
(`docs/plans/2026-08-04-github-emu-compatibility.md:77-83`), and all five of its
host, classification, diagnostics, routing-test, and documentation phases are
recorded as complete (`docs/plans/2026-08-04-github-emu-compatibility.md:183-195`).

The resulting v0.4.0 release added host-qualified targets, `--hostname` routing
for security endpoints, SAML-aware error handling, and `--doctor`
(`CHANGELOG.md:230-259`, `CHANGELOG.md:293-310`). The credential-delegation
boundary remains explicit in the current security policy
(`SECURITY.md:128-131`).

v0.5.0 then applied recognized remedies and backoff behavior to Actions, Issues,
and Pull Requests while preserving raw `gh` text for unclassified failures
(`CHANGELOG.md:106-129`). The two screenshot messages therefore exercise the
current post-v0.5 distinction between a normalized 404 and an unclassified
GraphQL resolution error.

## Conclusion

gh-glance is already usable by other people with their own credentials because
credential ownership belongs to each person's installed `gh`, not to the npm
package (`README.md:96-102`, `README.md:231-237`, `SECURITY.md:128-131`). The
current UX expects authentication to happen before startup through `gh auth
login`; it does not contain its own login prompt or credential store
(`index.mjs:888-915`, `index.mjs:1255-1295`).

The supplied errors sit after that boundary. They show that the selected `gh`
context could not resolve the inferred `Nvteca/cashflor-forecast` target, and
the code rendered the REST 404 and GraphQL resolution failure through two
different existing classifier paths (`index.mjs:331-407`,
`index.mjs:2522-2538`).
