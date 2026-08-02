# gh-glance

[![CI](https://github.com/juan294/gh-glance/actions/workflows/ci.yml/badge.svg)](https://github.com/juan294/gh-glance/actions/workflows/ci.yml)
[![CodeQL](https://github.com/juan294/gh-glance/actions/workflows/codeql.yml/badge.svg)](https://github.com/juan294/gh-glance/actions/workflows/codeql.yml)
[![license](https://img.shields.io/badge/license-MIT-blue)](./LICENSE)

A live-refreshing GitHub dashboard that fits in a narrow terminal pane --
**Actions, Issues, Pull Requests, and Security alerts**, one tab at a time,
refreshing every 5 seconds with no flicker.

Built for pairing with a terminal multiplexer/workspace tool (e.g. a sidebar
pane next to your editor) where you want an always-on glance at repo activity
without switching to the browser.

```
 1:Actions (150)   2:Issues (0)   3:Pull requests (2)   4:Security (1)
    TITLE                            WORKFLOW   BRANCH         TIME    AGE
────────────────────────────────────────────────────────────────────────────
 ✓  ci: align release-probes acti… CI #443    develop        1m0s    4d ago
 ✓  ci: align release-probes acti… CodeQL #3… develop        1m28s   4d ago
 ✗  chore(deps-dev): bump the dev… CI #442    develop        49s     5d ago
 ●  chore(deps-dev): bump the dev… CI #441    dependabot/np… 1m10s   5d ago
 ✓  github_actions in / for actio… Dependabo… develop        34s     5d ago
 ✓  npm_and_yarn in / for typescr… Dependabo… develop        56s     5d ago

updated just now · refreshing every 5s · ←/→ or 1-4 to switch tabs
```

> Status icons are Octicon glyphs from a Nerd Font; they're shown here as
> `✓` `✗` `●` so they render in a browser.

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
- Tab bar with live counts, switchable via `1`-`4`, arrow keys, or `Tab`/`Shift+Tab`
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
