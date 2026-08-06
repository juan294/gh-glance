# Phase 4 — First-run and troubleshooting documentation `[batch-eligible]`

> Files: `README.md`, `CHANGELOG.md`, `SECURITY.md`
> Depends on: phase 2. Batch-eligible with phase 3 after phase 2.

## Objective

Teach an npm installer that credentials belong to their local `gh`, show the
short first-run sequence, explain active-account behavior, and document the two
supplied failure shapes without claiming whether a hidden repository exists.

## `README.md`

### 1. Add “First run” after Install (`README.md:107-123`)

```
gh auth status

# Only when no account is active:
gh auth login

gh-glance
```

State:

- gh-glance uses the credentials and active account from the caller's `gh`;
- it never receives or stores the token itself;
- cloning over SSH/HTTPS and authenticating `gh` are separate credential paths,
  so a successful clone does not prove API access for the active `gh` account;
- on a non-default host, use the existing
  `gh auth login --hostname <host>` path.

### 2. Add same-host account guidance near first run

```
gh auth status
gh auth switch --hostname github.com --user <login>
```

Describe switching as an explicit user command that changes `gh`'s active
account globally for that config. Do not present it as a gh-glance action. If
`gh auth switch --help` is unavailable on an older install, tell the reader to
update `gh` for multi-account support; do not raise the core gh-glance minimum
for an optional workflow. Link to the existing limitation: simultaneous panes
use separate `GH_CONFIG_DIR` values (`README.md:373-379`).

### 3. Expand Diagnostics (`README.md:276-303`)

Add the new `Repository access` probe to the collection list. State that it can
show whether the repository resolves for the active `gh` credentials, but a
failed GitHub resolution response cannot distinguish a nonexistent/stale target
from a private repository hidden from that identity.

Keep the shareability/redaction language unchanged except to include the new
probe under the same single redaction boundary.

### 4. Add exact troubleshooting rows (`README.md:398-416`)

| Symptom | Cause and next evidence |
|---|---|
| `GitHub login or authorization required` | Run `gh auth status`. With no account, run `gh auth login`; with an expired authorization, run `gh auth refresh`; then press `r`. |
| `Repository not found or inaccessible to the active gh account` | The active identity cannot resolve the target. Check `gh auth status`, `git remote -v` or the explicit `--repo`, and use `gh auth switch` only if the wrong account is active. |
| `GraphQL: Could not resolve to a Repository...` in older gh-glance versions | Same ambiguity: missing/renamed target or private repository not visible to the active account. Run `gh-glance --doctor`. |
| Actions says `not available for this repository` while repository access is `ok` | The repository resolved, but that endpoint is unavailable; inspect the corresponding doctor block. |

Keep the enterprise host/SAML/security rows and their current meanings.

### 5. Configuration and limitations

In the environment table (`README.md:231-240`), preserve the statement that
token/config variables pass through untouched. Add a cross-reference from
`GH_CONFIG_DIR` to the simultaneous-account limitation. Do not add a new
gh-glance flag or variable.

## `CHANGELOG.md`

Add entries under the existing top unreleased/release-preparation section after
checking the heading boundary:

- **Fixed:** clean no-login messages were unclassified raw `gh` errors; they now
  produce delegated-login/authorization guidance and remain retryable.
- **Fixed:** Actions' REST 404 and Issues' GraphQL repository-resolution error
  described the same inaccessible target through two unrelated messages; list
  tabs now converge on honest “not found or inaccessible” wording.
- **Added:** failure-triggered, read-only active-account/repository context and a
  Repository access doctor probe.

Do not claim that gh-glance logs users in, switches accounts, or distinguishes a
private repository from a nonexistent one.

## `SECURITY.md`

Extend the final credential paragraph (`SECURITY.md:128-131`):

- failure context invokes only read-only `gh auth status` and `gh repo view`;
- no `--show-token`, `gh auth token`, token argument, or credential value is
  requested;
- optional account/repository strings are sanitized before rendering;
- doctor output remains protected by its existing presence-only and redaction
  rules (`SECURITY.md:111-126`);
- login, refresh, and account switching remain explicit user-owned `gh`
  commands.

Do not weaken or replace the current statement that every GitHub API call goes
through `gh`.

## Automated success criteria

Run sequentially even though the phase edits Markdown only, as required by the
RPI phase gate:

```bash
npm run lint && npm test && node --check index.mjs && npm run test:pty
```

Also run:

```bash
node index.mjs --help
git diff --check
```

The help command exits zero and `git diff --check` reports no Markdown
whitespace errors.

## Manual success criteria

- A reader starting immediately after `npm install -g gh-glance` can identify
  and authenticate their own `gh` account using only the README.
- A reader seeing either supplied screenshot message can reach
  `gh auth status`, target verification, and `gh-glance --doctor` without this
  plan or the research document.
- The docs make global account switching and separate-`GH_CONFIG_DIR` pane
  isolation distinct.
- Compare README commands with `node index.mjs --help` and `gh auth --help`; no
  gh-glance flag or unsupported ownership claim is invented.
- No sentence implies that gh-glance receives, stores, refreshes, or selects a
  credential.
