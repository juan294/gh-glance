# gh-glance v0.20.0

This release makes panes start faster and do less work while they run. The Issues and Pull requests queries change version, so panes on older versions do not share those results with upgraded panes.

- **A sooner first row.** A standalone pane that opens with no cached rows for the selected tab now starts its first request as soon as its request slot is due. Before, it waited for the next scheduled poll wake, so the first fresh row could appear about a second later than needed. A pane whose slot is still in the future, that opens with cached rows, or whose rate-limit budget is exhausted starts as before.
- **Faster explicit targets.** Starting with a valid `--repo` or `GH_REPO` no longer reads the current folder's git remotes or its `gh` default repository. The dashboard also loads its interface while its startup checks run, so the first frame appears slightly sooner.
- **Quieter idle panes.** The status animation stops while nothing animated is on screen: in Help, in Notifications, when the running row is scrolled out of view or when the pane is too narrow. It starts again when an animated row or label is visible.
- **Smaller requests and cache.** The Issues and Pull requests tabs ask GitHub for fewer fields, so each response is about 10% smaller. The display cache file is written without indentation, which makes it about 39% smaller.
- **Collector catalog reuse.** The collector (`--serve`) now reuses the Actions workflow catalog for 15 minutes, as the standalone dashboard does. Before, it requested the catalog again on every poll while a run had no workflow name.

**Upgrade.** The acquisition query version for Issues and Pull requests moves from 2 to 3. While panes for one repository run both v0.20.0 and an older version, the two versions do not share Issues and Pull requests results, and each version makes its own requests. Restart every pane after the upgrade to share again. The quota, collector protocol, display cache format and Actions and Security query versions are unchanged, and dependency ranges are unchanged. Node.js 22 or newer remains required.

Known limitations are those of v0.19.4: the GitHub status request uses Node's built-in `fetch`, which does not read `HTTPS_PROXY`, `Events` history is per pane and in memory, and after `gh repo set-default` the dashboard needs a restart. Existing personal/work EMU and native assistive-technology qualification remain open or unmeasured.
