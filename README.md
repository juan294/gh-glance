# gh-glance

<a href="https://chapa.thecreativetoken.com/u/juan294">
  <img src="https://chapa.thecreativetoken.com/u/juan294/badge.svg" alt="juan294's Chapa Impact Badge" width="100%" />
</a>

[![CI](https://github.com/juan294/gh-glance/actions/workflows/ci.yml/badge.svg?branch=develop&event=push)](https://github.com/juan294/gh-glance/actions/workflows/ci.yml?query=branch%3Adevelop+event%3Apush)
[![CodeQL](https://github.com/juan294/gh-glance/actions/workflows/codeql.yml/badge.svg?branch=develop&event=push)](https://github.com/juan294/gh-glance/actions/workflows/codeql.yml?query=branch%3Adevelop+event%3Apush)
![Node.js](https://img.shields.io/badge/Node.js-20.19%2B-43853d)
[![license](https://img.shields.io/badge/license-MIT-blue)](./LICENSE)

A live-refreshing GitHub dashboard that fits in a narrow terminal pane --
**Actions, Issues, Pull Requests, and Security alerts**, one tab at a time,
refreshing every 5 seconds with no flicker.

Built for pairing with a terminal multiplexer/workspace tool (e.g. a sidebar
pane next to your editor) where you want an always-on glance at repo activity
without switching to the browser.

```
╭─ Actions ────────────────────────────────────────────────────────────────╮
│    TITLE                          WORKFLOW   BRANCH         TIME    AGE  │
│ ──────────────────────────────────────────────────────────────────────── │
│ ✓  ci: align release-probes acti… CI #443    develop        1m0s    4d   │
│ ✓  ci: align release-probes acti… CodeQL #3… develop        1m28s   4d   │
│ ✗  chore(deps-dev): bump the dev… CI #442    develop        49s     5d   │
│ ●  chore(deps-dev): bump the dev… CI #441    dependabot/np… 1m10s   5d   │
│ ✓  github_actions in / for actio… Dependabo… develop        34s     5d   │
│ ✓  npm_and_yarn in / for typescr… Dependabo… develop        56s     5d   │
│                                                                          │
╰──────────────────────────────────────────────────────────── 6 of 150+ ───╯
 1:Actions (150+)   2:Issues (0)   3:Pull requests (2)   4:Security (1)
⠧ Fetching  Tabs: ←/→ │ Jump: 1-4 │ Quit: ^C
```

> Status icons are Octicon glyphs from a Nerd Font; they're shown here as
> `✓` `✗` `●` so they render in a browser.

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
- **Security** -- open Dependabot alerts: package, summary, age, with
  severity carried by the icon's colour.
  Code scanning and secret scanning alerts are included too, on repos/plans
  that have GitHub Advanced Security enabled -- see [Limitations](#limitations).
- Tab bar with live counts, pinned to the bottom of the pane alongside the
  status line, switchable via `1`-`4`, arrow keys, or `Tab`/`Shift+Tab`
- `lazygit`-style panel frame: the tab name sits in the top border, the
  visible-of-total row count in the bottom
- A spinning `Fetching` indicator while a refresh is in flight, so the pane
  says when it's working without spending a line on it
- Status icons are real GitHub Octicons (via the Nerd Font glyph set), not emoji
- Adapts row count to the terminal pane's height live, on resize
- Enters the terminal's alternate screen buffer on launch (like `lazygit`,
  `htop`, `vim`) so the shell prompt that launched it stays out of view, and
  is restored cleanly on exit

## Prerequisites

- [Node.js](https://nodejs.org/) `>=20.19`
- The [`gh` CLI](https://cli.github.com/), authenticated (`gh auth login`)
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
| `Ctrl+C` | Quit |

## Limitations

- **Security tab**: code scanning and secret scanning alerts require [GitHub
  Advanced Security](https://docs.github.com/en/code-security/getting-started/github-security-features).
  On repos/plans without it, `gh-glance` doesn't crash or spam errors -- it
  shows a one-line note per unavailable feature and still displays whatever
  it *can* get (Dependabot alerts work independently of GHAS). If your repo
  has GHAS enabled, those alerts just show up automatically -- no
  configuration needed.
- No pagination/scrolling within a tab yet -- it shows as many rows as fit
  the pane height, oldest overflow is simply not shown.
- macOS/Linux terminals with ANSI + alternate-screen-buffer support. Not
  tested on Windows.

### Icons without a Nerd Font

The status icons are Octicon glyphs from the [Nerd
Fonts](https://www.nerdfonts.com/) private-use-area range. If your terminal
font isn't a Nerd Font, they'll render as blank boxes. Either install a Nerd
Font (many terminal setups already have one for prompt tools like
[Starship](https://starship.rs/)), or swap the `OCT` glyph table near the top
of `index.mjs` for plain-unicode equivalents (`✓` `✗` `●` etc.) -- see the
git history for the pre-Octicon version.

## Contributing

See [CONTRIBUTING.md](./CONTRIBUTING.md).

## Security

See [SECURITY.md](./SECURITY.md).

## License

[MIT](./LICENSE)
