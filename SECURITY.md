# Security Policy

## Supported Versions

Only the current major release receives security patches.

| Version | Supported |
|---------|-----------|
| 0.x     | Yes       |

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
surface, even though the dashboard renders untrusted repository content
(issue/PR titles, commit messages) to the terminal.

gh-glance never handles GitHub credentials directly -- authentication is
entirely delegated to your existing `gh auth login` session. It has no
network code of its own; every GitHub API call goes through the `gh` CLI.

## Scope

Out of scope: issues requiring physical access to the machine, vulnerabilities
in `gh` itself (report those to [cli/cli](https://github.com/cli/cli)), and
issues in development-only dependencies that don't affect the published
package.
