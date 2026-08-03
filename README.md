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
╭─ Actions ────────────────────────────────────────────────────────────────╮
│     TITLE                    WORKFLOW   BRANCH         TIME    UPDATED   │
│ ──────────────────────────────────────────────────────────────────────── │
│ >+  ci: pin actions to comm… #443 CI    develop        1m20s   2d ago    │
│  x  fix: restore the primar… #442 Code… develop        1m28s   2d ago    │
│  !  chore: bump dependencies #441 CI    dependa…int-10 56h49m  2d ago    │
│  -  docs: update the readme  #440 CI    develop        15s     3d ago    │
│                                                                          │
│                                                                          │
╰───────────────────────────────────────────────────────────────── 4 of 4 ─╯
[1:Actions (4)]   2:Issues (3)    3:PRs (2)    4:Security (0)
⠋ Fetching            Move: jk | Open: Ent | Refresh: r | Quit: q
```

> Captured from a real run at 76 columns with `GH_GLANCE_ICONS=unicode`, so the
> status icons render in a browser. With a Nerd Font (the default) they are
> Octicon glyphs instead.
>
> The `>` on the first row is the cursor. Two more markers appear when they
> apply: a `+` after a tab's count means the list was truncated by the fetch
> limit, and a `!` after the Actions count means the newest run failed — so
> "is CI red" is answerable without switching to that tab.

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
- **Security** -- open Dependabot alerts: package, summary, age, sorted with the
  most severe first and with severity spelled out in its own column, not carried
  by colour alone.
  Code scanning and secret scanning alerts are included too, on repos/plans
  that have GitHub Advanced Security enabled -- see [Limitations](#limitations).
- Tab bar with live counts, pinned to the bottom of the pane alongside the
  status line, switchable via `1`-`4`, arrow keys, or `Tab`/`Shift+Tab`
- `lazygit`-style panel frame: the tab name sits in the top border, the
  visible-of-total row count in the bottom
- A spinning `Fetching` indicator while a refresh is in flight, so the pane
  says when it's working without spending a line on it
- Status icons are real GitHub Octicons (via the Nerd Font glyph set), not emoji
  -- with a plain-ASCII fallback for terminals without one
- Readable without colour: severity has its own column, run states have distinct
  glyphs, and the active tab is bracketed, so `NO_COLOR=1` and colour-vision
  deficiency both stay navigable
- Says when it is stale rather than showing old data silently, and marks a tab
  whose last refresh failed
- Adapts row count to the terminal pane's height live, on resize
- Enters the terminal's alternate screen buffer on launch (like `lazygit`,
  `htop`, `vim`) so the shell prompt that launched it stays out of view, and
  is restored cleanly on exit

## Prerequisites

- [Node.js](https://nodejs.org/) `>=22` (Ink requires it; Node 20 is end-of-life)
- The [`gh` CLI](https://cli.github.com/) `>=2.20`, authenticated (`gh auth login`)
- A terminal font with [Nerd Font](https://www.nerdfonts.com/) glyphs (for the
  status icons to render correctly -- without one, they'll show as blank
  boxes; see [Icons without a Nerd Font](#icons-without-a-nerd-font))

## Install

```bash
git clone https://github.com/juan294/gh-glance.git
cd gh-glance
npm install
npm link   # makes the `gh-glance` command available globally
```

(Not yet published to npm -- clone + `npm link` is the current install path.)

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
| `Enter` | Open the selected item in your browser |
| `r` | Refresh the current tab now |
| `q` / `Esc` / `Ctrl+C` | Quit |

The cursor tracks the *item*, not the row position, so it stays on what you
selected as new rows arrive above it. `Enter` works on Actions, Issues and Pull
Requests; the Security tab has no per-alert `gh` command to open.

If `gh-glance` is started without an interactive stdin (for example with stdin
redirected), the key handlers cannot run and the status bar shows only `Quit: ^C`
rather than advertising keys that would do nothing.

## Configuration

`gh-glance` still takes no arguments by default, so it drops straight into a
pane definition. Flags are there when you want them:

| Flag | Effect |
|---|---|
| `-R`, `--repo owner/name` | Watch a specific repository instead of the current directory's. Works from anywhere -- you do not need a local clone. |
| `--refresh <seconds>` | Active-tab poll interval, 2-3600, default 5. Background tabs stay at 12x this. |
| `--tab <name>` | Start on `actions`, `issues`, `prs` or `security`. |
| `--verbose` | Log one line per `gh` call to stderr, with timing and outcome. stderr must be redirected: `gh-glance --verbose 2>gh-glance.log`. |

An unrecognised flag exits 2 rather than being ignored, so a typo fails loudly.

Environment variables work too, and the flags take precedence:

| Variable | Effect |
|---|---|
| `GH_REPO=owner/name` | Watch a specific repository instead of the current directory's |
| `GH_GLANCE_ICONS=unicode` | Plain ASCII status icons, for terminals without a Nerd Font |
| `GH_GLANCE_NO_ANIMATION=1` | Freeze the spinner — no motion at all |
| `NO_COLOR=1` | Disable colour. Status stays readable: severity has its own column, run states have distinct glyphs, and the active tab is bracketed |
| `INK_SCREEN_READER=true` | Switch the renderer to a linear, unthrottled mode. The status icons carry text labels for it, but this path has not been tested against a real screen reader — treat it as unverified rather than supported. |

## Rate limit

The visible tab refreshes every 5 seconds; the other three refresh every 60
seconds, purely to keep their counts honest. That works out at roughly 500
REST requests an hour, about 10% of the 5,000/hour authenticated limit — so
leaving a pane open all day does not exhaust the budget your other `gh`
commands share.

## Limitations


- **Security tab**: code scanning and secret scanning alerts require [GitHub
  Advanced Security](https://docs.github.com/en/code-security/getting-started/github-security-features).
  On repos/plans without it, `gh-glance` doesn't crash or spam errors -- it
  shows a one-line note per unavailable feature and still displays whatever
  it *can* get (Dependabot alerts work independently of GHAS). If your repo
  has GHAS enabled, those alerts just show up automatically -- no
  configuration needed.
- Scrolling moves through what was fetched, not through everything on GitHub.
  Issues and Pull Requests fetch 150, so there is real range there. Actions
  deliberately fetches about a screenful -- its cost is linear in the number of
  runs requested -- so scrolling that tab has little to move through. The count
  in the bottom edge always says how much you are seeing out of how much was
  fetched.
- **Minimum width.** Below about 61 columns the table drops to a compact layout
  (icon, title, and one other column) so the frame, tab bar and status line stay
  on screen. Below about 24 columns it will not lay out sensibly.
- Issues and pull requests are fetched 150 at a time and alerts 100 at a time.
  A count is shown as `n+` when it was truncated, so the number is never
  presented as exact when it is not.
- The Actions **TIME** column measures from the run's start to its last update.
  `gh` exposes no completion timestamp, so a workflow that was re-run later
  reports the span up to the re-run rather than its original duration.
- macOS/Linux terminals with ANSI + alternate-screen-buffer support. Not
  tested on Windows -- `npm` will not stop you installing it there, but the
  alternate-screen handling is unverified.

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
| Status icons are blank boxes | Your terminal font is not a Nerd Font. Use `GH_GLANCE_ICONS=unicode`. |
| Security tab shows a "not enabled" note | Code scanning and secret scanning need GitHub Advanced Security. Dependabot alerts work independently. A genuine auth or network failure shows the real error instead. |
| A tab's count is red | That tab's last fetch failed. The error itself is shown when you switch to it. |
| `stale 2m` in the status bar | The visible tab has not refreshed successfully for a while — usually a network drop. |
| It exits immediately when piped | Intentional. It is a full-screen dashboard, not a reporting command. |
| It stopped updating and you cannot tell why | Run `gh-glance --verbose 2>gh-glance.log`, reproduce, then read the log: one line per `gh` call with its duration and outcome. Attach it to a bug report. |
| `--verbose` refuses to start | stderr is still your terminal, where the log would draw over the dashboard. Redirect it to a file. |

## Contributing

See [CONTRIBUTING.md](./CONTRIBUTING.md).

## Security

See [SECURITY.md](./SECURITY.md).

## License

[MIT](./LICENSE)
