# Phase 5 — Documentation `[batch-eligible]`

> Files: `README.md`, `CHANGELOG.md`, `SECURITY.md`
> Depends on: the plan only — content is fully determined here. Batch-eligible
> with phase 4 (no file overlap).

## Why

Nothing in the repository currently mentions GitHub Enterprise, EMU, `GH_HOST`,
or multiple accounts, except one code comment at `index.mjs:272`.
`README.md:87-93` and `CONTRIBUTING.md:22-26` say only *"authenticated (`gh auth
login`)"*. A user on an EMU tenant has no way to learn that the tool works, what
to run first, or what a SAML lapse looks like.

## `README.md`

### 1. Prerequisites (`README.md:87-93`)

Extend the `gh` line: authenticated for the host you intend to watch, with a
pointer to the new section.

### 2. New section: "GitHub Enterprise and EMU", after Configuration (`README.md:198-216`)

Content, stated as fact rather than aspiration:

- **The common case needs no configuration.** Authenticate once —
  `gh auth login --hostname <your-host>` — then run `gh-glance` inside a clone of
  a work repository. The repo and its host are both resolved from the git
  remote, the same way `gh` does it.
- **Two EMU forms.** Standard EMU lives on `github.com`; EMU with data residency
  lives on `<slug>.ghe.com`. `gh auth status` tells you which you have. Only the
  second needs a host anywhere.
- **Watching a repo you have not cloned**, on a non-default host:
  `gh-glance --repo tenant.ghe.com/acme/widget`. The `[host/]owner/name` form is
  the same one `gh --repo` accepts. The host must contain a dot, so
  `owner/name/extra` is still rejected as the typo it is rather than read as a
  host.
- **`GH_HOST` works too**, and is the better lever when every repo you watch is
  on one enterprise host — it routes both the list commands and the alert
  endpoints. Note explicitly that a host-qualified **`GH_REPO`** does *not* route
  `gh api`, which is why `--repo` is preferred for a one-off cross-host target.
- **SAML sessions expire.** When the enterprise session lapses, endpoints answer
  403 and the tab shows the real `gh` message. Re-authorize in the browser (or
  `gh auth refresh`) and the dashboard recovers within about 30 seconds. It will
  not claim a feature is "not enabled" because of a lapse.

### 3. New "Diagnostics" subsection

```bash
gh-glance --doctor > report.txt
```

State what it collects — versions, authenticated hosts, how the repo target
resolved, and one probe per endpoint with its classification — and state
plainly that **tokens are never printed**, proxy credentials are stripped, and
no response bodies are included, so the report is safe to attach to a bug
report.

### 4. Configuration table (`README.md:203-210`)

- `-R, --repo` row: `[host/]owner/name`.
- New `--doctor` row.
- Environment table (`README.md:214-220`): add `GH_HOST`, and note that
  `GH_TOKEN` / `GH_ENTERPRISE_TOKEN` / `GH_CONFIG_DIR` are passed through to
  `gh` untouched — which `index.mjs:270-276` already relies on.

### 5. Troubleshooting table (`README.md:276-287`)

Add rows:

| Symptom | Cause and fix |
|---|---|
| `none of the git remotes ... point to a known GitHub host` | `gh` is not authenticated for that host. Run `gh auth login --hostname <host>`. |
| Security tab empty on an enterprise host, other tabs fine | The alert endpoints were sent to the wrong host. Use `--repo host/owner/name` or set `GH_HOST` — a host-qualified `GH_REPO` alone does not route them. |
| Tabs fail after working for a while | The enterprise SAML session lapsed. Re-authorize in the browser; the dashboard recovers within ~30s. Run `gh-glance --doctor` to confirm. |

Amend the existing "Security tab shows a 'not enabled' note" row
(`README.md:284`): a note now appears only when the feature genuinely is
unavailable; auth and SSO failures show the real error.

### 6. Limitations (`README.md:238-262`)

State what was **not** built, so it is a documented boundary rather than a
surprise: no account pinning. `gh`'s active account is global, so with two
accounts authenticated on one host, `gh-glance` follows whatever `gh auth switch`
last selected. Point at `GH_CONFIG_DIR` as the per-pane workaround.

## `CHANGELOG.md`

New `## [Unreleased]` section above `## [0.3.1]` (`CHANGELOG.md:8`).

**Check the section boundary before writing** — in-flight entries have
previously drifted under the last released heading. Diff against the `v0.3.1`
tag to confirm the new heading sits above it.

- **Fixed** — a lapsed enterprise SAML session was reported as "not enabled for
  this repository" and latched for up to an hour. Auth failures now surface the
  real message and retry within ~30s.
- **Fixed** — on a non-default host the three security-alert endpoints were
  queried against `github.com` while the other tabs were correct, so the Security
  tab could report "not enabled" for a repository whose alerts it never asked
  for.
- **Added** — `--repo` accepts `[host/]owner/name`.
- **Added** — `--doctor`.

## `SECURITY.md`

Extend the Security Model section (`SECURITY.md:48-54`), which currently
addresses shell injection and rendering of untrusted content:

- The repo target is validated before it reaches a `gh api` path. The host
  component, when present, is validated separately and is **never** interpolated
  into a request path — it is passed as `--hostname`. The `owner/name` half keeps
  the pattern and the hostile-input tests it already had
  (`test/args.test.mjs:47-69`).
- `--doctor` never prints credentials: token-shaped values are replaced, proxy
  and remote URL userinfo is stripped, token env vars are reported as
  present/absent only, and no API response bodies are included.

Reaffirm unchanged: gh-glance still handles no credentials of its own
(`SECURITY.md:83-85`).

## Success criteria

### Automated
- The verify-edit hook passes. Avoid U+2600-27BF glyphs — this plan's own first
  draft was blocked for exactly that. Box-drawing, arrows and em-dash are fine.
- `npm run lint` passes (it does not read markdown, but the phase gate runs it).
- Every command shown in the README is one that exists after phases 1-3:
  `--doctor`, `--repo host/owner/name`, `gh auth login --hostname`.

### Manual
- A reader on an EMU tenant can get from "just installed" to a populated
  dashboard using only the README, with no reference to this plan.
- The `--doctor` description matches the report phase 3 actually emits.
