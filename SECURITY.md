# Security Policy

## Supported Versions

Only the current major release receives security patches.

| Version | Supported |
|---------|-----------|
| 0.2.x   | Yes       |
| < 0.2   | No (never released)  |

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
- **Preserved:** everything else, including emoji and ZWJ sequences, CJK and
  other wide characters, combining marks, and right-to-left text. A sanitizer
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

The repository target is the one user-supplied value that both reaches a
subprocess argument and is interpolated into a `gh api` request path, so it is
validated once at the boundary. The `owner/name` half keeps the pattern and the
hostile-input tests it has always had. When a host is present
(`--repo host/owner/name`), it is validated separately -- as a dotted hostname,
which is what keeps a three-part typo a rejected typo rather than a request to
somewhere else -- and it is **never** interpolated into a request path. It is
passed to `gh` as a `--hostname` argument instead.

`--doctor` prints a report intended to be attached to a bug report, and it
never prints credentials. Token-valued environment variables are reported as
present or absent and never by value, not even a prefix; anything token-shaped
anywhere in the captured text is replaced; credentials embedded in proxy and
remote URLs are stripped; and no API response bodies are included, only their
sizes.

gh-glance never handles GitHub credentials directly -- authentication is
entirely delegated to your existing `gh auth login` session, including on
GitHub Enterprise and EMU hosts. It has no network code of its own; every
GitHub API call goes through the `gh` CLI.

## Scope

Out of scope: issues requiring physical access to the machine, vulnerabilities
in `gh` itself (report those to [cli/cli](https://github.com/cli/cli)), and
issues in development-only dependencies that don't affect the published
package.
