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
refreshing every 5 seconds with no flicker.

Built for pairing with a terminal multiplexer/workspace tool (e.g. a sidebar
pane next to your editor) where you want an always-on glance at repo activity
without switching to the browser.

```
[1:Actions (4)]   2:Issues (3)    3:PRs (2)    4:Security (0)
────────────────────────────────────────────────────────────────────────────
╭─ Actions ────────────────────────────────────────────────────────────────╮
│     TITLE                   │WORKFLOW  │BRANCH        │TIME   │UPDATED   │
│ ──────────────────────────────────────────────────────────────────────── │
│ >+  ci: pin actions to comm… #443 CI    develop        1m20s   9d ago    │
│  x  fix: restore the primar… #442 Code… develop        1m28s   9d ago    │
│  !  chore: bump dependencies #441 CI    dependa…int-10 222h8m  9d ago    │
│  -  docs: update the readme  #440 CI    develop        15s     10d ago   │
│                                                                          │
│                                                                          │
╰───────────────────────────────────────────────────────────────── 4 of 4 ─╯
⣾ Fetching  Move: ↑↓ | Open: Ent | Refresh: r | Width: w | Quit: q     0.9.1
```

> Captured from a real run at 76 columns with `GH_GLANCE_ICONS=unicode`, so the
> status icons render in a browser. With a Nerd Font (the default) they are
> Octicon glyphs instead.
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
- A `Fetching` indicator that brightens while a tab's first request is settling
  or during a manual refresh. Settled automatic polls do not flash it; the
  spinner still animates during first load or while a workflow run is executing
- Status icons are real GitHub Octicons (via the Nerd Font glyph set), not emoji
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
  status icons to render correctly -- without one, they'll show as blank
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
| `r` | Refresh the current tab now |
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
| `--refresh <seconds>` | Active-tab poll interval, 2-3600, default 5. Background tabs stay at 12x this. |
| `--tab <name>` | Start on `actions`, `issues`, `prs` or `security`. |
| `--verbose` | Log one line per `gh` call to stderr, with timing and outcome. stderr must be redirected: `gh-glance --verbose 2>gh-glance.log`. |
| `--doctor` | Print a diagnostic report and exit. See [Diagnostics](#diagnostics). |

An unrecognised flag exits 2 rather than being ignored, so a typo fails loudly.

Environment variables work too, and the flags take precedence:

| Variable | Effect |
|---|---|
| `GH_REPO=owner/name` | Watch a specific repository instead of the current directory's. A host-qualified `GH_REPO` does **not** route the security-alert endpoints -- use `GH_HOST` or `--repo host/owner/name` for that |
| `GH_HOST=<host>` | Send every call to a GitHub Enterprise or EMU host instead of `github.com`. Routes both the list commands and the alert endpoints |
| `GH_TOKEN`, `GITHUB_TOKEN`, `GH_ENTERPRISE_TOKEN`, `GITHUB_ENTERPRISE_TOKEN` | Used by `gh`. gh-glance never logs or stores these values, but hashes each set value locally as part of the account-scoped cache namespace so panes with different credentials cannot hydrate each other's rows. The raw values are not written to disk. |
| `GH_CONFIG_DIR` | Selects `gh`'s account configuration and contributes its normalized identity to the cache namespace. Separate values can isolate simultaneous panes on different accounts; see [No account pinning](#limitations). |
| `GH_GLANCE_REFRESH=<seconds>` | Active-tab poll interval, 2-3600. Sets it once for every pane in a shell; `--refresh` takes precedence. This is a floor -- see [Rate limit](#rate-limit) |
| `GH_GLANCE_ICONS=unicode` | Plain ASCII status icons, for terminals without a Nerd Font |
| `GH_GLANCE_NO_ANIMATION=1` | Freeze the spinner — no motion at all |
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

**`GH_HOST` works too**, and is the better lever when every repository you watch
lives on one enterprise host -- it routes the list commands and the alert
endpoints alike. A host-qualified **`GH_REPO`**, by contrast, does *not* route
`gh api`: it supplies the owner and repository and ignores the host, which is
why `--repo` is the right tool for a one-off cross-host target.

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
from where; your remaining REST and GraphQL budget plus what this configuration
will spend per hour; the relevant environment variables; a read-only
`Repository access` probe; and each bounded dashboard probe, including the
Security priority lanes, with the exact argv it sent, its outcome, and how any
error was classified (`unavailable`, `rate-limited`, `auth-problem` or `other`).

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

The visible tab refreshes every 5 seconds; the other three refresh every 60
seconds, purely to keep their counts honest.

The tabs do not all draw on the same budget. Actions and Security spend REST
calls; Issues and Pull Requests are sorted with `--search`, which routes them
through GraphQL instead — a separate 5,000/hour allowance. With the default
5-second refresh:

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
the conservative projection beside the server's actual REST and GraphQL
budgets, which matters on a GitHub Enterprise tenant where the ceilings may not
be 5,000.

Two things pull the real number down. Any endpoint that fails in a way
`gh-glance` recognises backs off instead of being re-asked every tick — a
feature that is not enabled for the repository retries on a ladder up to an
hour, an authorization failure every 30 seconds, a rate limit every minute.
Pressing `r` clears that backoff and retries immediately. And `--refresh`
scales the whole figure: doubling the interval halves it.

When a refresh fails, the last successful rows stay visible below the live
error instead of disappearing. If gh-glance is restarted while GitHub is still
rate-limiting, it loads the saved rows for that same target immediately. Their
age remains explicit through the `stale` label, and the rate-limit banner still
describes the current failed request; cached data never turns a failure into a
false success.

One pane on Actions costs about a third of an hourly REST budget, so roughly
three panes fill it. Past that, `gh-glance` widens its own poll interval: it
reads your remaining budget once a minute, works out how much of it belongs to
this pane by comparing its own spend against the token's total, and slows down
to fit -- up to a 60-second ceiling. The status bar says `throttled 18s` while
that is in effect, and `r` still refreshes immediately. Nothing is shared
between panes: the token's own counter is what they all read, so it also notices
a `gh pr checks --watch` or anything else spending on the same token.

`GH_GLANCE_REFRESH=30` sets a wider floor for every pane in a shell; `--refresh`
still wins per pane. The adaptive interval only ever widens from that floor, so
a single pane on a healthy budget stays at 5 seconds and shows no badge.

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

The status icons are Octicon glyphs from the [Nerd
Fonts](https://www.nerdfonts.com/) private-use-area range. If your terminal
font isn't a Nerd Font they render as blank boxes -- which would leave status
carried by the colour of a blank box, and by nothing at all under `NO_COLOR`.

Set `GH_GLANCE_ICONS=unicode` for plain ASCII equivalents:

```bash
GH_GLANCE_ICONS=unicode gh-glance
```

They are deliberately single-cell ASCII rather than prettier symbols like `✓`
and `✗`, because those are East-Asian-Ambiguous width and render two cells wide
in some terminals, which would shift every column to their right.

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
| Status icons are blank boxes | Your terminal font is not a Nerd Font. Use `GH_GLANCE_ICONS=unicode`. |
| Security tab shows a "not enabled" note | Code scanning and secret scanning need GitHub Advanced Security. Dependabot alerts work independently. The note now appears only when the feature genuinely is unavailable: auth, SSO and network failures show the real error instead. |
| `none of the git remotes ... point to a known GitHub host` | `gh` is not authenticated for that host. Run `gh auth login --hostname <host>`. |
| Security tab empty on an enterprise host, other tabs fine | The alert endpoints were sent to the wrong host. Use `--repo host/owner/name` or set `GH_HOST` -- a host-qualified `GH_REPO` alone does not route them. |
| Tabs start failing after working for a while | The enterprise SAML session lapsed. Re-authorize in the browser; the dashboard recovers within about 30 seconds. Run `gh-glance --doctor` to confirm. |
| A tab's count is red | That tab's last fetch failed. The error itself is shown when you switch to it, translated into what to do about it where `gh-glance` recognises the failure. |
| Security tab shows `?` instead of a number | The alert endpoints could not be read at all -- an expired SAML session, a token without `security_events`, or an org OAuth restriction. `?` means "unknown", not "zero"; run `gh-glance --doctor` to see which probe failed and how it was classified. |
| A failing tab seems to have stopped retrying | It backs off deliberately, rather than re-spawning `gh` every five seconds against an endpoint that is refusing. Press `r` to clear the backoff and retry now. |
| `unknown argument: -v` | `-v` used to mean `--version` and no longer does, because this CLI also has `--verbose`. Use `--version` or `--verbose` explicitly. |
| `stale 2m` in the status bar | The visible tab has not refreshed successfully for a while — usually a network drop or rate limit. Last-known-good rows can remain visible, including after restart; the live error above the table explains why they are stale. |
| It exits immediately when piped | Intentional. It is a full-screen dashboard, not a reporting command. |
| It stopped updating and you cannot tell why | Run `gh-glance --verbose 2>gh-glance.log`, reproduce, then read the log: one line per `gh` call with its duration and outcome. It is redacted the same way `--doctor` is, so it is safe to attach to a bug report. `--doctor --verbose` logs the probes too. |
| `--verbose` refuses to start | stderr is still your terminal, where the log would draw over the dashboard. Redirect it to a file. |

## Contributing

See [CONTRIBUTING.md](./CONTRIBUTING.md).

## Security

See [SECURITY.md](./SECURITY.md).

## License

[MIT](./LICENSE)
