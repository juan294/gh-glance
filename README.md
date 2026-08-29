# gh-glance

<a href="https://chapa.thecreativetoken.com/u/juan294">
  <img src="https://chapa.thecreativetoken.com/u/juan294/badge.svg" alt="juan294's Chapa Impact Badge" width="100%" />
</a>

[![CI](https://github.com/juan294/gh-glance/actions/workflows/ci.yml/badge.svg?branch=develop&event=push)](https://github.com/juan294/gh-glance/actions/workflows/ci.yml?query=branch%3Adevelop+event%3Apush)
[![CodeQL](https://github.com/juan294/gh-glance/actions/workflows/codeql.yml/badge.svg?branch=develop&event=push)](https://github.com/juan294/gh-glance/actions/workflows/codeql.yml?query=branch%3Adevelop+event%3Apush)
![Node.js](https://img.shields.io/badge/Node.js-22%2B-43853d)
[![license](https://img.shields.io/badge/license-MIT-blue)](./LICENSE)

A live-refreshing GitHub dashboard that fits in a narrow terminal pane --
**Actions, Issues, Pull Requests, and Security alerts**, one tab at a time,
with a healthy single-pane refresh floor of 5 seconds and no flicker. Shared
budget coordination can schedule a later safe check when several panes or other
tools use the same GitHub account.

Built for pairing with a terminal multiplexer/workspace tool (e.g. a sidebar
pane next to your editor) where you want an always-on glance at repo activity
without switching to the browser.

```
[1:Actions (4)]   2:Issues    3:PRs    4:Security
───────────────────────────────────────────────────────────────────────────
╭─ Actions · owner/repo ──────────────────────────────────────────────────╮
│     TITLE                  │WORKFLOW  │BRANCH        │TIME   │UPDATED   │
│ ─────────────────────────────────────────────────────────────────────── │
│ >+  ci: pin actions to com… #443 CI    develop        1m20s   28d ago   │
│  x  fix: restore the prima… #442 Code… develop        1m28s   28d ago   │
│  +  chore: bump dependenci… #441 CI    dependa…int-10 30s     28d ago   │
│  -  docs: update the readme #440 CI    develop        15s     29d ago   │
│                                                                         │
│                                                                         │
╰──────────────────────────────────────────────────────────────── 4 of 4 ─╯
· Watching               Refresh: r Quit: q Move: ↑↓ Open: Ent Width: w
```

> Generated from this candidate's real binary under the repository PTY harness
> at 76 columns, using its deterministic fixture data and
> `GH_GLANCE_ICONS=unicode`; the repeatable command is in
> [CONTRIBUTING.md](./CONTRIBUTING.md). With a Nerd Font (the default), row
> icons are Octicon glyphs instead.
>
> The `>` on the first row is the cursor. Four more markers appear when they
> apply: a `+` after a tab's count means the list was truncated by the fetch
> limit, a `!` after the Actions count means the newest run failed — so "is CI
> red" is answerable without switching to that tab — an `x` means the tab's
> latest fetch failed, and a `?` in place of the Security count means its
> endpoints could not be read, which is not the same as there being nothing to
> report.

<!-- contract:allow-emoji -- the check/cross above stand in for Nerd Font
     Octicons the app actually draws; they are literal examples, not decoration. -->

---

## Why

GitHub's own web UI already shows all of this. `gh-glance` exists for the
moment you don't want to alt-tab to a browser tab to check whether CI is
still red, whether someone commented on your PR, or whether Dependabot found
something new -- it's meant to sit in a corner of your terminal and just be
current.

## Features

- **Actions** -- recent workflow runs: status, title, workflow, branch,
  elapsed time, age
- **Issues** -- open issues: title, author, first label, age
- **Pull Requests** -- open PRs: title, author, branch, review status
  (approved / changes requested / pending), age
- **Security** -- open Dependabot, code-scanning, and secret-scanning alerts,
  sorted with the most severe first and with severity spelled out rather than
  carried by colour alone. Each source starts with its newest 100 open alerts.
  When that page is full, Dependabot and code scanning also fetch bounded
  critical/high priority lanes before merging and de-duplicating the result.
  The `+` marker means at least one bounded lane filled, so the visible priority
  set may still be incomplete. Code and secret scanning require GitHub Advanced
  Security -- see [Limitations](#limitations).
- Tab bar with live counts, pinned to the top of the pane above a divider,
  switchable via `1`-`4`, arrow keys, or `Tab`/`Shift+Tab`
- Adjustable full-table columns, with visible header grips, a keyboard width
  mode, and preferences kept separately for each tab
- `lazygit`-style panel frame: the tab name sits in the top border, the
  visible-of-total row count in the bottom
- A semantic footer for the active tab: **Watching** is settled or scheduled;
  **Checking** means admitted work is live; **Paused** protects a held or
  unavailable budget; **Failed** names a normal fetch error; and **Limited**
  means Security visibility is incomplete. Startup and manual Checking can
  animate. Adapted automatic checks, Watching, Paused, Failed, and Limited are
  static. A pure shared-lane wait adds `sharing N` without moving the key hints
- Row state icons are real GitHub Octicons (via the Nerd Font glyph set), not emoji
  -- with a plain-ASCII fallback for terminals without one
- Readable without colour: severity has its own column, a failing newest run puts
  a `!` on the Actions tab, and the active tab is bracketed, so `NO_COLOR=1` and
  colour-vision deficiency both stay navigable. Run-state *glyphs* are not all
  distinct -- timed-out, action-required and running share one, as do skipped,
  neutral, stale and queued -- so the tab marker, not the row icon, is what
  answers "is CI red" without colour
- Says when it is stale rather than showing old data silently, and marks a tab
  whose last refresh failed
- Keeps the last successfully parsed rows visible during temporary failures and
  across a restart, scoped to the repository being watched
- Adapts row count to the terminal pane's height live, on resize
- Enters the terminal's alternate screen buffer on launch (like `lazygit`,
  `htop`, `vim`) so the shell prompt that launched it stays out of view, and
  is restored cleanly on exit without old status lines accumulating below the
  frame

## Prerequisites

- [Node.js](https://nodejs.org/) `>=22` (Ink requires it; Node 20 is end-of-life)
- The [`gh` CLI](https://cli.github.com/) `>=2.20`, authenticated for the host
  you intend to watch (`gh auth login`, or `gh auth login --hostname <host>` on
  a GitHub Enterprise or EMU tenant -- see [GitHub Enterprise and
  EMU](#github-enterprise-and-emu))
- A terminal font with [Nerd Font](https://www.nerdfonts.com/) glyphs (for the
  row icons to render correctly -- without one, they'll show as blank
  boxes; see [Icons without a Nerd Font](#icons-without-a-nerd-font))

## Install

```bash
npm install -g gh-glance
```

That is the whole install. `gh-glance` ships as a single `index.mjs` with no
build step, so there is nothing to compile and nothing to configure -- the
package is the source you can read in this repository.

The installed package is a CLI, not a JavaScript library. The `gh-glance`
executable is supported; package-root and deep imports are intentionally
blocked so an internal test seam cannot become an accidental public API.

Every published version is built and signed by GitHub Actions from a tagged
commit on `main`, never from a maintainer's laptop, and carries [npm
provenance](https://docs.npmjs.com/generating-provenance-statements) linking
the tarball back to the workflow run and commit that produced it. The
"Provenance" section on the [package
page](https://www.npmjs.com/package/gh-glance) shows the exact source.

### First run

`gh-glance` uses the credentials and active account already selected by your
local `gh` CLI. It does not request, inspect, or store the token itself. Check
that account before starting the dashboard:

```bash
gh auth status

# Only when no account is active:
gh auth login

gh-glance
```

Cloning over SSH or HTTPS and authenticating `gh` are separate credential
paths, so a successful clone does not prove that the active `gh` account can
access the repository through the API. For a non-default host, authenticate it
explicitly with `gh auth login --hostname <host>`.

If several accounts are authenticated on the same host, inspect and select the
one you intend to use:

```bash
gh auth status
gh auth switch --hostname github.com --user <login>
```

`gh auth switch` is an explicit user command, not a gh-glance action. It changes
the active account globally for that `gh` configuration. If `gh auth switch
--help` is unavailable, update `gh` to use this optional multi-account workflow;
the core gh-glance minimum remains unchanged. To keep simultaneous panes on
different accounts, use separate `GH_CONFIG_DIR` values as described under
[No account pinning](#limitations).

### From a clone

For hacking on it, or to run an unreleased revision:

```bash
git clone https://github.com/juan294/gh-glance.git
cd gh-glance
npm install
npm link   # makes the `gh-glance` command available globally
```

`npm link` is what puts `gh-glance` on your `PATH`; it symlinks the global
bin at your Node version's `bin/` directory through to this checkout:

```
<node>/bin/gh-glance -> <node>/lib/node_modules/gh-glance -> /path/to/your/clone
```

Because the link resolves to the clone rather than to a copy, you can move
or rename the directory and the command keeps working. Two things do break
it, and both are fixed by re-running `npm link` from the clone:

- switching Node versions (nvm/fnm install their own global `bin/`)
- setting up on a fresh machine, or after `npm unlink -g gh-glance`

A linked clone shadows a global install, since both write the same bin name.
Run `npm unlink -g gh-glance` before `npm install -g gh-glance` if you want
to go back to the published version.

### Using it as a workspace pane

`gh-glance` takes no arguments and infers the repo from the working
directory, so it drops straight into a pane definition of whatever
workspace tool you use. With [summon](https://github.com/juan294/summon),
that's a one-line pane in a layout file:

```
pane.enhance=gh-glance
```

Point the pane at the bare command rather than an absolute path to
`index.mjs` -- resolving through `PATH` is what lets the clone move without
every layout needing an edit.

## Usage

Run it from inside any locally cloned GitHub repository:

```bash
gh-glance
```

It infers the repository from the current directory's git remote, the same
way `gh` itself does -- no flags or config needed.

```bash
gh-glance --help      # usage and keybindings
gh-glance --version   # print the version
```

It's an interactive full-screen dashboard, so it exits with an error if
stdout isn't a terminal rather than streaming redraw frames into a pipe.

### Keybindings

| Key | Action |
|---|---|
| `1` `2` `3` `4` | Jump to Actions / Issues / Pull Requests / Security |
| `←` / `→` | Previous / next tab |
| `Tab` / `Shift+Tab` | Next / previous tab |
| `↑` / `↓` or `j` / `k` | Move the cursor between rows |
| `PgUp` / `PgDn` | Move a page at a time |
| `Enter` | Open the selected item, or accept an onboarding prompt |
| `r` | Request a current-tab refresh; a safe grant is still required. |
| `w` | Adjust table column widths |
| `?` | Show the keys without leaving the dashboard (any key closes it) |
| `q` / `Esc` / `Ctrl+C` | Quit (`Esc` leaves width mode) |

### Adjusting column widths

Press `w` to adjust the named fixed-width columns in the visible full table.
The flexible **TITLE** or **SUMMARY** column, status and severity cells, and
compact layouts are not adjustable. Outside width mode, the normal arrow,
`Tab`, `Enter`, and refresh meanings above are unchanged.

| Key | In width mode |
|---|---|
| `Tab` / `Shift+Tab` | Select the next / previous adjustable column |
| `←` / `→` | Resize the selected column by one cell |
| `Shift+←` / `Shift+→` | Resize the selected column by five cells |
| `r` | Reset the selected column to its default |
| `R` | Reset every width on the active tab |
| `Enter` / `Esc` / `w` | Finish and leave width mode |
| `q` / `Ctrl+C` | Quit globally |

While the mode is active, the ordinary status hints are replaced by a bounded
line such as:

```text
Width: BRANCH 14  Tab select  <- -> resize  r reset  Esc done
```

After pressing `w`, you can also left-drag a visible `│` header grip. Mouse
reporting is enabled only while width mode owns the input, so a click outside
that mode does not enter it. Releasing the button, including outside the header,
ends the drag. Row clicking, hover behavior, and pointer-shape changes are not
supported.

While width mode is active, terminal-native text selection may require your
terminal's mouse-reporting bypass modifier, commonly `Shift`. Outside width
mode, gh-glance leaves mouse reporting disabled.

The cursor tracks the *item*, not the row position, so it stays on what you
selected as new rows arrive above it. `Enter` works on Actions, Issues and Pull
Requests; the Security tab has no per-alert `gh` command to open. It clears
itself after 60s with no cursor movement, so a pane left idle in the corner of
a screen doesn't sit there marked forever -- and the next arrow key picks up
from what is on screen rather than jumping back to the top of the list.

If the current local repository has no GitHub remote, gh-glance shows a setup
prompt instead of raw `gh` stderr. Press `Enter` to leave the dashboard and run
the interactive `gh repo create` flow, then choose **Push an existing local
repository**. Plain `gh repo create` is intentional: adding `--source` would
switch `gh` into non-interactive mode and require choosing a visibility in
advance. Press `q` or `Esc` to decline. To watch an existing repository without
attaching this folder, restart with `gh-glance --repo owner/name`.

When the repository was chosen explicitly, with `--repo` or `GH_REPO`, the panel
says so: `╭─ Actions · acme/widget ─`. That is what tells two side-by-side panes
apart. It is dropped before the tab name when the pane is too narrow for both.

If `gh-glance` is started without an interactive stdin (for example with stdin
redirected), the key handlers cannot run and the status bar shows only `Quit: ^C`
rather than advertising keys that would do nothing.

## Configuration

`gh-glance` still takes no arguments by default, so it drops straight into a
pane definition. Flags are there when you want them:

| Flag | Effect |
|---|---|
| `-R`, `--repo [host/]owner/name` | Watch a specific repository instead of the current directory's. Works from anywhere -- you do not need a local clone. The optional host targets a GitHub Enterprise or EMU data-residency tenant, e.g. `tenant.ghe.com/acme/widget`. |
| `--refresh <seconds>` | Minimum active-tab poll interval, 2-3600, default 5. Safe shared grants can make a check later; each background tab is considered about every 12 floors. |
| `--tab <name>` | Start on `actions`, `issues`, `prs` or `security`. |
| `--verbose` | Log one line per `gh` call to stderr, with timing and outcome. stderr must be redirected: `gh-glance --verbose 2>gh-glance.log`. |
| `--doctor` | Print a diagnostic report and exit. See [Diagnostics](#diagnostics). |

An unrecognised flag exits 2 rather than being ignored, so a typo fails loudly.

Environment variables work too, and the flags take precedence:

| Variable | Effect |
|---|---|
| `GH_REPO=[host/]owner/name` | Watch a specific repository instead of the current directory's. A qualified value supplies the host; an unqualified value means `github.com`. An explicit `--repo` wins. |
| `GH_HOST=<host>` | When no explicit `--repo` overrides it, send every call and the account governor to a GitHub Enterprise or EMU host instead of `github.com`. |
| `GH_TOKEN`, `GITHUB_TOKEN`, `GH_ENTERPRISE_TOKEN`, `GITHUB_ENTERPRISE_TOKEN` | Used by `gh`. gh-glance never logs or stores these values, but hashes each set value locally as part of the account-scoped cache and governor namespaces so panes with different credentials cannot share rows or admission. The raw values are not written to disk. |
| `GH_CONFIG_DIR` | Selects `gh`'s account configuration and contributes its normalized identity to the cache and governor namespaces. Separate values can isolate simultaneous panes on different accounts; see [No account pinning](#limitations). |
| `GH_GLANCE_REFRESH=<seconds>` | Minimum active-tab poll interval, 2-3600. Sets the floor for every pane in a shell; `--refresh` takes precedence. See [Rate limit](#rate-limit). |
| `GH_GLANCE_ICONS=unicode` | Unicode status glyphs and single-cell text substitutes for Nerd Font row icons |
| `GH_GLANCE_ICONS=ascii` | ASCII-only status and row icons |
| `GH_GLANCE_NO_ANIMATION=1` | Stop status and run-state motion. Semantic words such as Watching, Checking, and Paused still report what is happening. |
| `NO_COLOR=1` | Disable colour. Status stays readable: severity has its own column, a failing newest run puts a `!` on the Actions tab, and the active tab is bracketed. Note that run-state glyphs are not all distinct -- see the feature list above |
| `INK_SCREEN_READER=true` | Switch the renderer to a linear, unthrottled mode. Automated PTY coverage checks that status and selection labels reach this Ink path, but it has not been validated with real assistive technology — treat it as automated rendering coverage, not claimed screen-reader support. |

### Saved column widths

Width choices are saved automatically, globally for the current user and
separately for each tab. They are not repository-specific. Only deviations from
the built-in defaults are stored: `r` removes the selected column's deviation,
and `R` removes every deviation for the active tab.

The versioned preference file is resolved in this order:

```text
$XDG_CONFIG_HOME/gh-glance/preferences.json              absolute XDG root
~/Library/Application Support/gh-glance/preferences.json macOS fallback
~/.config/gh-glance/preferences.json                     Linux fallback
```

`XDG_CONFIG_HOME` is used only when it is a non-empty absolute path. An unknown
file version or a corrupt, malformed, or unreadable document falls back to the
built-in defaults rather than preventing the dashboard from starting. Within an
otherwise valid document, unknown or invalid entries are ignored individually
while valid deviations still load. If a write fails, resizing still works for
the live session and width mode reports `Widths not saved`; a later successful
write clears the warning. The UI owns this file, so direct editing is not the
primary configuration workflow.

### Last-known-good dashboard cache

Successfully parsed dashboard rows are also saved automatically, in
`dashboard-cache.json` beside `preferences.json`:

```text
$XDG_CONFIG_HOME/gh-glance/dashboard-cache.json
~/Library/Application Support/gh-glance/dashboard-cache.json
~/.config/gh-glance/dashboard-cache.json
```

The cache is scoped to the repository, host, and effective `gh` account
namespace. In inferred mode, the host and current working directory also form
the identity, so rows from one checkout or credential context cannot appear in
another. The namespace uses `GH_CONFIG_DIR`/`hosts.yml` identity plus one-way
digests of supported token environment variables; raw credentials are never
stored. It retains at most five recent targets and 60 rows per tab; a shortened
cached tab keeps its `+` marker rather than presenting the saved count as exact.

Only successfully parsed, non-blind observations replace saved rows. A failed
request can add a live error or `?` marker, but it cannot turn known Security
alerts or other last-known-good rows into an empty result. Missing, corrupt,
unknown-version, or unwritable cache state is ignored rather than blocking the
dashboard. On POSIX systems, gh-glance restricts its config directory to `0700`
and the cache file to `0600`. The file contains repository data, including
titles, authors, branches, and Security findings, but never GitHub credentials.
Both persistence files use a bounded advisory lock before atomic replacement.
The cache merges independent targets and tabs, while preferences merge columns,
so simultaneous panes do not overwrite one another's unrelated state. It is
recovery state owned by the UI, not a configuration interface.

### Private API governor state

API admission uses a separate file beside the cache:

```text
$XDG_CONFIG_HOME/gh-glance/rate-governor-v1-<scope hash>.json
~/Library/Application Support/gh-glance/rate-governor-v1-<scope hash>.json
~/.config/gh-glance/rate-governor-v1-<scope hash>.json
```

The hash binds the effective GitHub host to the local `gh` account namespace
without putting either raw value in the file name. The file records only the
protocol needed to coordinate panes: REST and GraphQL budget observations and
epochs, leases, intents, reservations, fair-lane cursors, probe ownership and
outcomes, and temporary rate-limit blocks. It stores no token, raw host, login,
repository, working directory, title, author, branch, alert, or other dashboard
row. Ephemeral lock records contain only a PID and random nonce.

This state has a stricter role than `dashboard-cache.json`. A missing cache can
be ignored because it only supplies last-good rows. Missing governor state can
be initialized under its private lock, but corrupt, stale, locked, or unwritable
coordination fails closed: quota-consuming calls wait or pause instead of
falling back to independent polling. On POSIX systems the directory is `0700`,
and governor, temporary, lock, recovery, and quarantine files are `0600`.

## GitHub Enterprise and EMU

**The common case needs no configuration.** Authenticate once --
`gh auth login --hostname <your-host>` -- then run `gh-glance` inside a clone of
a work repository. The repository and its host are both resolved from the git
remote, the same way `gh` does it.

**There are two EMU forms.** Standard Enterprise Managed Users lives on
`github.com`; EMU with data residency lives on `<slug>.ghe.com`. `gh auth
status` tells you which you have, and only the second needs a host mentioned
anywhere.

**To watch a repository you have not cloned**, on a non-default host:

```bash
gh-glance --repo tenant.ghe.com/acme/widget
```

The `[host/]owner/name` form is the same one `gh --repo` accepts. The host must
contain a dot, so `owner/name/extra` is still rejected as the typo it is rather
than read as a request to a host named `owner`.

**Every call and its governor use one effective host.** Resolution is explicit
and fail-closed: an explicit `--repo host/owner/name` uses that host, while an
explicit unqualified `--repo owner/name` means `github.com` even when `GH_HOST`
or `GH_REPO` is also set. Without `--repo`, `GH_HOST` is next, followed by a
qualified or unqualified `GH_REPO`, then one unambiguous host found across all
local remotes. An invalid present `GH_HOST`, or ambiguous remotes with no
explicit choice, cannot silently fall through to another server.

The resolved host routes list commands, alert endpoints, the free rate-limit
probe, and the shared account governor together. This corrects `gh api`'s native
behavior for host-qualified `GH_REPO`: gh-glance adds the required `--hostname`
itself. A running pane also rechecks the active account namespace and moves to a
fresh closed scope after `gh auth switch`, before it can receive another grant.

**SAML sessions expire.** When an enterprise session lapses, the endpoints
answer 403 and the tab shows the real `gh` message. Re-authorize in the browser
(or run `gh auth refresh`) and the dashboard recovers within about 30 seconds.
It will not claim a feature is "not enabled" because of a lapse.

### Diagnostics

```bash
gh-glance --doctor > report.txt
```

Collects, in one plain-text block: the `gh-glance`, Node and `gh` versions;
which hosts `gh` is authenticated for; how the repository target resolved and
from where; your remaining REST and GraphQL budget plus the configuration's
unpaced cost projection; shared governor health; the relevant environment
variables; a read-only `Repository access` probe; and each bounded dashboard
probe, including the Security priority lanes, with the exact argv it sent, its
outcome, and how any error was classified (`unavailable`, `rate-limited`,
`auth-problem` or `other`).

Doctor first makes one free `rate_limit` request to the effective host. It then
uses an ephemeral governor lease and admits every quota-consuming endpoint at
its exact declared cost. A probe whose safe slot is later, whose resource is
held, or whose budget is unavailable is reported as `SKIPPED`; diagnostics do
not bypass the reserve. The `API governor` section reports `healthy`, `waiting
for probe`, `stale`, `blocked`, or `unavailable`, plus the number of live leases
and each resource's remaining calls, hard reserve, and reset. It does not print
the scope hash, account identity, state path, lock owner, or reservation IDs.

The `Repository access` probe shows whether the target resolves for the active
`gh` credentials. A failed GitHub resolution response cannot distinguish a
nonexistent, renamed, or stale target from a private repository hidden from
that identity.

Add `--verbose` to get a log of every `gh` call it makes alongside the report.

It exits 0 and prints a report even when `gh` is missing or you are outside a
git repository -- those are conditions worth reporting rather than failing on --
and it works through a pipe, unlike the dashboard itself.

**Values are printed only for variables on a short curated list** -- the ones
that are the thing being diagnosed, like `GH_HOST`, `GH_REPO` and `NO_COLOR`.
Everything else it finds, including any `GH_*`/`GITHUB_*` variable it was never
told about, is reported as `set` or `not set` and never by value. On top of
that: anything token-shaped anywhere in the captured text is replaced, proxy and
remote URL credentials are stripped to scheme and host, and no API response
bodies are included, only their sizes. The report is safe to attach to a bug
report, and the same redaction covers the `--verbose` log and the message
printed if `gh-glance` crashes.

## Rate limit

The default five seconds is a healthy single-pane floor, not an unconditional
request frequency. Each check first needs an atomic grant from the private
governor shared by local panes using the same effective host and account
namespace. The active tab is considered at its floor. One rotating inactive tab
is considered every four floors, so each of the three background tabs is
considered about every 12 floors without starting them together.

The resources are independent. Actions and Security spend REST `core` calls;
Issues and Pull Requests are sorted with `--search`, which routes them through
GraphQL. The following table is the conservative demand before shared pacing,
not a promise that the governor will start every listed request. At the default
floor:

| Visible tab | REST / hour | GraphQL / hour |
|---|---|---|
| Actions | up to ~1,800 | ~240 |
| Issues or Pull Requests | up to ~480 | ~1,560 |
| Security | ~2,280 normally; up to ~4,440 | ~240 |

Security is the most expensive. A repository whose newest alert pages are not
full uses the three base endpoint calls and lands near 2,280 REST requests per
hour. A full page activates bounded critical/high lanes for Dependabot and code
scanning, raising the safe projection to about 4,440. Actions is not cheap
either: one `gh run list` issues two REST requests. `gh-glance --doctor` reports
this projection beside the server's actual REST and GraphQL budgets. Enterprise
ceilings can differ from 5,000.

For each resource, gh-glance reserves 20% of the reported limit for other work:

```text
reserve = ceil(limit * 0.2)
spendable = max(0, remaining - reserve - charged reservations)
```

That is 1,000 calls for a normal 5,000-call resource. Before any quota-consuming
`gh` process starts, its declared worst-case REST/GraphQL cost must fit inside
the latest fresh observation without entering the reserve. A grant is charged
immediately, then reconciled only when completion evidence proves a lower cost.
Started, interrupted, or process-lost work stays conservative until a later
clean probe can account for it. Missing, stale, corrupt, locked, or unwritable
coordination denies the call instead of returning to five-second polling.

One pane owns the free `rate_limit` probe for a control window and publishes it
for the others. Manual and diagnostic work is considered before tab-switch,
active, and background work; equal-priority panes rotate fairly. Manual `r`
coalesces repeated presses, gives immediate Watching or Paused feedback, and
clears an endpoint backoff only after admission. It cannot bypass a held budget
or force a request into the reserve.

The shared lane uses spendable capacity, time to reset, outstanding
reservations, and observed external spend. Startup and each new reset epoch add
a stable per-pane phase, so panes do not resume as a herd. There is no
60-second maximum: if the next safe slot is farther away, the pane waits that
long. `next 2m` is the coarse time until one current grant, not a promise of a
recurring polling interval. When another live local pane alone owns the lane
ahead of this pane, the detail says `sharing N` instead. The detail is capped
at `99m+`.

When a refresh fails, the last successful rows stay visible below the live
error instead of disappearing. If gh-glance is restarted while GitHub is still
rate-limiting, it loads the saved rows for that same target immediately. Their
age remains explicit through the `stale` label, and the rate-limit banner still
describes the current failed request; cached data never turns a failure into a
false success.

The enforceable boundary is local admission from fresh, conservatively debited
evidence. Another program can spend after the probe, and panes on another
machine or in a different local account scope cannot share this file. GitHub
does not offer an atomic global quota reservation. The token-wide counter still
lets gh-glance measure external use and reduce future capacity, but the hard
reserve is not a claim that unrelated consumers can never cross it.

`GH_GLANCE_REFRESH=30` sets a wider floor for every pane in a shell; `--refresh`
still wins per pane. A single pane on a healthy budget normally stays at its
floor and shows Watching between checks.

## Limitations

- **Security tab**: code scanning and secret scanning alerts require [GitHub
  Advanced Security](https://docs.github.com/en/code-security/getting-started/github-security-features).
  On repos/plans without it, `gh-glance` doesn't crash or spam errors -- it
  says so in a single collapsed line -- `Code scanning, Secret scanning: not
  enabled here` -- and still displays whatever it *can* get (Dependabot alerts
  work independently of GHAS). If your repo has GHAS enabled, those alerts just
  show up automatically -- no configuration needed.

  If the alert endpoints cannot be read at all -- an expired SAML session, a
  token without `security_events`, an org OAuth restriction -- the tab count
  shows `?` rather than a number. A blind Security tab and a clean one are not
  the same thing, and reporting `0` for both would be the worst available
  answer on that particular surface.
- Scrolling moves through what was fetched, not through everything on GitHub.
  Issues and Pull Requests fetch 150, so there is real range there. Actions
  deliberately fetches about a screenful -- its cost is linear in the number of
  runs requested -- so scrolling that tab has little to move through. The count
  in the bottom edge always says how much you are seeing out of how much was
  fetched.
- **Minimum width and compact layout.** Compact descriptors remain fixed and
  non-adjustable. With the built-in full widths, Security fits down to 44
  columns, Issues to 50, Actions to 56, and Pull Requests to 61. A narrower
  preference can lower the active tab's full-layout floor. An oversized
  preference is fitted temporarily toward the defaults as the pane narrows, so
  it never forces compact while the stock full table still fits. The saved width
  itself is not changed, and widening restores it. When no eligible full layout
  fits, the active tab uses its fixed compact layout. Below 24 columns the pane
  says `too narrow` and keeps the frame, tab bar and quit hint. The status bar
  has its own breakpoint and drops to bare keys (`↑↓ Ent r q`) rather than
  truncating.
- **Mouse reporting lifecycle.** Interactive sessions enable terminal mouse
  reporting only after `w` enters width mode, and disable it when that mode or
  the app exits. See [Adjusting column widths](#adjusting-column-widths) for
  text-selection behavior while it is active.
- Issues and pull requests are fetched 150 at a time. Each Security source has
  a newest-100 lane; full Dependabot and code-scanning pages activate bounded
  priority lanes. A count is shown as `n+` when any lane fills, so the number is
  never presented as exact when it is not.
- The Actions **TIME** column measures from the run's start to its last update.
  `gh` exposes no completion timestamp, so a workflow that was re-run later
  reports the span up to the re-run rather than its original duration.
- macOS/Linux terminals with ANSI + alternate-screen-buffer support. Not
  tested on Windows -- `npm` will not stop you installing it there, but the
  alternate-screen handling is unverified.
- **No account pinning.** `gh`'s active account is global, so with two accounts
  authenticated on the same host `gh-glance` follows whichever one `gh auth
  switch` last selected -- it has no way to pin a pane to one of them. If you
  need two panes on two accounts at once, give each its own `GH_CONFIG_DIR`.

### Icons without a Nerd Font

The row icons are Octicon glyphs from the [Nerd
Fonts](https://www.nerdfonts.com/) private-use-area range. If your terminal
font isn't a Nerd Font they render as blank boxes -- which would leave row state
carried by the colour of a blank box, and by nothing at all under `NO_COLOR`.

Set `GH_GLANCE_ICONS=unicode` for Unicode status glyphs and single-cell text
substitutes for the Nerd Font row icons:

```bash
GH_GLANCE_ICONS=unicode gh-glance
```

The row substitutes are deliberately single-cell ASCII rather than symbols like
`✓` and `✗`, because those are East-Asian-Ambiguous width and render two cells
wide in some terminals. Use `GH_GLANCE_ICONS=ascii` when the status glyphs must
also stay within plain ASCII:

```bash
GH_GLANCE_ICONS=ascii gh-glance
```

## Troubleshooting

| Symptom | Cause and fix |
|---|---|
| `the gh CLI is not installed` | Install it from [cli.github.com](https://cli.github.com), then `gh auth login`. |
| `not inside a git repository` | Run it from a cloned GitHub repository, or set `GH_REPO=owner/name`. |
| `No GitHub remote found` | Press `Enter` to start `gh repo create`, then choose **Push an existing local repository**. Or press `q` and run `gh-glance --repo owner/name` to watch an existing repository without attaching this folder. |
| `GitHub login or authorization required` | Run `gh auth status`. With no account, run `gh auth login`; with an expired authorization, run `gh auth refresh`; then press `r`. |
| `Repository not found or inaccessible to the active gh account` | The active identity cannot resolve the target. Check `gh auth status`, `git remote -v` or the explicit `--repo`, and use `gh auth switch` only if the wrong account is active. |
| `GraphQL: Could not resolve to a Repository...` in older gh-glance versions | The response has the same ambiguity: a missing or renamed target, or a private repository not visible to the active account. Run `gh-glance --doctor`. |
| Actions says `not available for this repository` while Repository access is `ok` | The repository resolved, but that endpoint is unavailable; inspect the corresponding doctor block. |
| Row icons are blank boxes | Your terminal font is not a Nerd Font. Use `GH_GLANCE_ICONS=unicode`. |
| Security tab shows a "not enabled" note | Code scanning and secret scanning need GitHub Advanced Security. Dependabot alerts work independently. The note now appears only when the feature genuinely is unavailable: auth, SSO and network failures show the real error instead. |
| `none of the git remotes ... point to a known GitHub host` | `gh` is not authenticated for that host. Run `gh auth login --hostname <host>`. |
| Security tab empty on an enterprise host in an older gh-glance version | Older versions could route alert endpoints separately. Current gh-glance routes every API call and the governor to one effective host; use `--repo host/owner/name`, `GH_HOST`, or a qualified `GH_REPO`, then confirm the resolved host with `--doctor`. |
| Tabs start failing after working for a while | The enterprise SAML session lapsed. Re-authorize in the browser; the dashboard recovers within about 30 seconds. Run `gh-glance --doctor` to confirm. |
| A tab's count is red | That tab's last fetch failed. The error itself is shown when you switch to it, translated into what to do about it where `gh-glance` recognises the failure. |
| Security tab shows `?` instead of a number | The alert endpoints could not be read at all -- an expired SAML session, a token without `security_events`, or an org OAuth restriction. `?` means "unknown", not "zero"; run `gh-glance --doctor` to see which probe failed and how it was classified. |
| `Watching` with `next 2m` | The active tab has a shared budget probe or safe grant scheduled. The interval names this grant only; it is not a recurring polling interval. Pressing `r` raises safe priority but cannot bypass the lane or reserve. |
| `Watching` with `sharing 4` | Four local panes share this account governor, and another pane owns the lane immediately ahead of this grant. This is pacing, not quota scarcity. |
| `Paused` with a reset time | The active tab's REST or GraphQL resource is at its reserve, exhausted, or under a shared rate-limit block. Wait for the stated reset/probe. Other tabs can continue when they use the healthy resource. |
| `Paused` without a reset time | Budget or coordinator evidence is unknown, corrupt, locked, or unwritable. No data call is started. Run `gh-glance --doctor`; also check the config directory permissions and whether another live process owns its private lock. |
| A failing tab seems to have stopped retrying | Recognized endpoint failures back off rather than re-spawning `gh` at the floor. Press `r` to request a higher-priority retry; the backoff clears only after a safe grant, so the tab remains Watching or Paused. |
| `unknown argument: -v` | `-v` used to mean `--version` and no longer does, because this CLI also has `--verbose`. Use `--version` or `--verbose` explicitly. |
| Cached rows plus `Paused` and `stale 2m` | The rows came from the separate last-known-good dashboard cache, while the live request is blocked or unsafe. Stale age is not extended by a pause. The error and footer describe current coordination; cached data never means the live check succeeded. |
| Repeated GitHub rate-limit messages | A classified rate-limit response is published as one shared resource block. Local panes make no data retry before that block's probe/reset deadline. Use `--doctor` to inspect the resource and reset; repeated manual refresh cannot override it. |
| It exits immediately when piped | Intentional. It is a full-screen dashboard, not a reporting command. |
| It stopped updating and you cannot tell why | Run `gh-glance --verbose 2>gh-glance.log`, reproduce, then read the log: one line per `gh` call with its duration and outcome. It is redacted the same way `--doctor` is, so it is safe to attach to a bug report. `--doctor --verbose` logs the probes too. |
| `--verbose` refuses to start | stderr is still your terminal, where the log would draw over the dashboard. Redirect it to a file. |

## Contributing

See [CONTRIBUTING.md](./CONTRIBUTING.md).

## Security

See [SECURITY.md](./SECURITY.md).

## License

[MIT](./LICENSE)
