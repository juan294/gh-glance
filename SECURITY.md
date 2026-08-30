# Security Policy

## Supported Versions

Only the current release line receives security patches.

| Version | Supported           |
| ------- | ------------------- |
| 0.11.x  | Yes                 |
| 0.10.x  | No                  |
| 0.9.x   | No                  |
| 0.8.x   | No                  |
| 0.7.x   | No                  |
| 0.6.x   | No                  |
| 0.5.x   | No                  |
| 0.4.x   | No                  |
| 0.3.x   | No                  |
| 0.2.x   | No                  |
| < 0.2   | No (never released) |

## Reporting a Vulnerability

**Please do not report security vulnerabilities through public GitHub issues.**

### Preferred: GitHub Private Vulnerability Reporting

Use GitHub's built-in private disclosure mechanism:

1. Go to https://github.com/juan294/gh-glance/security/advisories
2. Click "Report a vulnerability"
3. Fill in the details -- include steps to reproduce, impact assessment, and any suggested mitigations

### Alternative: Email

Send a report to **juan294@gmail.com** with the subject line:
`[gh-glance] Security vulnerability report`

Include:

- Description of the vulnerability
- Steps to reproduce
- Potential impact
- Suggested fix (if any)

## Disclosure Timeline

| Milestone | Target |
|-----------|--------|
| Acknowledge receipt | Within 48 hours |
| Initial assessment | Within 5 days |
| Patch for critical issues | Within 14 days of confirmation |
| Patch for non-critical issues | Within 60 days |
| Public disclosure | After patch is released |

We follow coordinated disclosure and will notify you before publishing any advisory.

## Security Model

gh-glance shells out to the `gh` CLI via Node's `execFile` with fixed argument
arrays (`execFile("gh", ["run", "list", ...])`) -- never a shell string built
by concatenating repository data. There is no code path that interpolates
issue titles, branch names, commit messages, or any other repository-supplied
text into a shell command. This rules out shell injection as an attack
surface.

The dashboard also renders untrusted repository content -- issue and pull
request titles, commit messages, branch and label names, advisory summaries.
On a public repository anyone can choose those strings, and a commit subject has
no byte restrictions at all. Because a terminal interprets control characters,
that content is sanitized where it enters the application, in the parsing step,
before it is stored or rendered:

- **Stripped:** C0 control characters (`U+0000`-`U+001F`), `DEL`, and C1
  (`U+0080`-`U+009F`). That covers `ESC`, so no escape sequence an attacker
  writes can be assembled by the terminal -- no hyperlink spoofing, no cursor
  movement over already-drawn rows, no bell, and no newline inflating one row
  into several. Each run is replaced with a space rather than deleted.
- **Deleted:** the explicit bidirectional overrides and isolates
  (`U+202A`-`U+202E`, `U+2066`-`U+2069`). A single `RLO` in an issue title makes
  the rest of that cell render reversed on any terminal that applies bidi
  reordering, which is the same "the row shows something other than its data"
  failure the control-character strip prevents -- and because these measure as
  zero columns, they cost no width and survived truncation untouched. Deleted
  rather than replaced with a space, precisely because they measure zero: a
  space would add a visible column and shift every cell to its right.
- **Preserved:** everything else, including emoji and ZWJ sequences, CJK and
  other wide characters, combining marks, and genuine right-to-left text. `LRM`
  and `RLM` (`U+200E`/`U+200F`) are untouched, because they are how ordinary
  mixed-direction Arabic and Hebrew titles render correctly -- the deletion above
  is scoped to the explicit overrides, not to bidi as a category. A sanitizer
  that stripped by "printability" would also erase the tool's own status icons
  and desynchronize column alignment.
- **Clamped:** each field is limited to 300 codepoints, cut on a codepoint
  boundary so a surrogate pair is never severed.

This is the application's own guarantee, made at its own boundary. It does not
rely on the rendering library's behaviour, which is documented to preserve some
escape sequences on purpose so that callers can pass styled strings through.

Values arriving from the API are also read through an own-property check before
being used as lookup keys, so a field whose value happens to be `constructor` or
`__proto__` cannot return an unexpected object into the render path.

Successfully parsed rows can be persisted in an account-and-target-scoped
`dashboard-cache.json` beside the width-preference file. The cache contains
sanitized repository data such as titles, authors, branches, and Security
findings, but it never contains a GitHub token or other credential. It retains
at most five repository targets and 60 rows per tab. The account namespace is
derived from the normalized `GH_CONFIG_DIR`/`hosts.yml` identity and one-way
SHA-256 digests of any supported token environment variables that are set. Raw
token values are never serialized. On POSIX systems, gh-glance restricts the
parent config directory to `0700`, writes temporary and final files as `0600`,
and replaces them atomically. A bounded advisory lock plus three-way merge
preserves unrelated targets, tabs, and width choices when several panes write
at once. Missing, corrupt, future-version, locked, or unwritable state is
advisory: it is ignored rather than weakening authentication or preventing
startup. A failed or blind Security observation never replaces a
last-known-good alert set with an empty one.

API admission uses a separate `rate-governor-v1-<scope hash>.json` file in the
same private directory. The SHA-256 file-name scope binds the normalized
effective GitHub host to the existing local authentication namespace; neither
raw value is stored in the name or canonical state. The governor contains only
protocol data: REST/GraphQL observations and epochs, leases, intents,
reservations, fair-lane cursors, probe state, and shared rate-limit blocks. It
contains no token, raw host, login, account identifier, repository, working
directory, title, author, branch, alert, or other cached row. The canonical
state also contains no PID; an ephemeral lock-owner record contains only a PID
and random nonce so a live or suspended owner cannot be mistaken for a dead
one.

Unlike the advisory row cache, the governor is an authorization boundary for
quota-consuming subprocesses. Its directory is `0700`, and canonical,
temporary, lock, recovery-marker, and quarantine files are created as `0600` on
POSIX systems. State replacement is atomic; lock release and dead-owner
quarantine require the exact nonce. Missing state is initialized only while the
private lock is held. Corrupt, stale, busy, or unwritable coordination denies
the request instead of falling back to process-local polling. Started,
interrupted, or process-lost reservations stay charged conservatively until a
later clean probe can account for them.

The repository target is the one user-supplied value that both reaches a
subprocess argument and is interpolated into a `gh api` request path, so it is
validated once at the boundary. The `owner/name` half is matched against what
GitHub actually issues as a name: it must contain at least one character that is
not a dot, and may not end in `.git`. That is what rejects `owner/..`, which
otherwise reached the path as `repos/owner/../dependabot/alerts` -- `gh`
forwards the dot segment unnormalized and GitHub resolves it server-side to a
different endpoint than the one intended. Names that merely contain or begin
with a dot, like `owner/.github`, stay valid. When a host is present
(`--repo host/owner/name`), it is validated separately -- as a dotted hostname,
which is what keeps a three-part typo a rejected typo rather than a request to
somewhere else -- and it is **never** interpolated into a request path. It is
passed to `gh` as a `--hostname` argument instead.

`--doctor` prints a report intended to be attached to a bug report, and it never
prints credentials. Environment values are printed only for a short curated list
-- the variables that are themselves the thing being diagnosed, such as
`GH_HOST`, `GH_REPO` and `NO_COLOR`. Every other variable it finds, including any
`GH_*`/`GITHUB_*` name it was never told about, is reported as present or absent
and never by value, not even a prefix. Presence-only is the default and printing
is the exception, rather than the other way round, so a credential in a variable
nobody anticipated fails safe. On top of that: anything token-shaped anywhere in
the captured text is replaced; credentials embedded in proxy and remote URLs are
stripped; and no API response bodies are included, only their sizes.

The same redaction covers the other two things this program writes outside the
dashboard: the `--verbose` log, and the message printed if it crashes. Both are
artifacts users are invited to attach to a bug report, and `gh` error messages
quote the URL they failed on -- which is a real path for a credential to reach
them.

GitHub authentication is delegated to the existing `gh auth login` session,
including on GitHub Enterprise and EMU hosts. gh-glance has no network code of
its own; every GitHub API call goes through the `gh` CLI. It never requests
`--show-token`, invokes `gh auth token`, or supplies a token argument. Its one
credential-adjacent operation is local and non-authenticating: it hashes each
set `GH_TOKEN`, `GITHUB_TOKEN`, `GH_ENTERPRISE_TOKEN`, and
`GITHUB_ENTERPRISE_TOKEN` value into the cache and governor namespaces so
different effective credentials cannot hydrate the same saved rows or share
admission state. The raw value is not retained, rendered, logged, or written to
disk. Failure context invokes only the read-only
`gh auth status` and `gh repo view` commands. Optional account and repository
strings are sanitized before rendering, and doctor output remains protected by
the presence-only and redaction rules above. Login, authorization refresh, and
account switching remain explicit user-owned `gh` commands.

Repository creation is also user-owned. When a local repository has no remote,
gh-glance invokes plain `gh repo create` only after the user presses `Enter`;
that is `gh`'s interactive form, so `gh` owns the setup questions and repository
creation. Quitting the prompt invokes no creation command.

## Scope

Out of scope: issues requiring physical access to the machine, vulnerabilities
in `gh` itself (report those to [cli/cli](https://github.com/cli/cli)), and
issues in development-only dependencies that don't affect the published
package.
