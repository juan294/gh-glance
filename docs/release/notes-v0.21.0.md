# gh-glance v0.21.0

This release refreshes a pane when you return to it.

- **Refresh on return.** In standalone mode, when the terminal reports focus changes, returning to a gh-glance pane checks the selected tab if its data is at least 15 seconds old. Cached rows stay on screen while the check runs. The check covers that tab only, runs at most once every 15 seconds per tab, and respects rate-limit holds and failure backoff. On a quiet Actions tab it is a free conditional request. Hidden tabs, Notifications and `--connect` panes are not checked.
- **Terminal support.** Terminals that report focus (xterm mode 1004) get the refresh automatically. Terminals without focus reporting behave as before. In tmux, add `set -g focus-events on` to forward focus changes. Focus reporting is turned off again on every exit, so the shell does not receive stray focus codes.

**Upgrade.** No configuration is needed. The quota, collector protocol, display cache format and acquisition query versions are unchanged, so panes on v0.20.0 and v0.21.0 share results. Dependency ranges are unchanged. Node.js 22 or newer remains required.

Known limitations are those of v0.20.0: the GitHub status request uses Node's built-in `fetch`, which does not read `HTTPS_PROXY`, `Events` history is per pane and in memory, and after `gh repo set-default` the dashboard needs a restart. Existing personal/work EMU and native assistive-technology qualification remain open or unmeasured.
