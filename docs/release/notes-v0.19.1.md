# gh-glance v0.19.1

This patch release makes the tab bar show full section names in more panes.

- **Full names whenever they fit.** The tab bar used to switch to short names
  below a fixed 98 columns, a width sized for counts on every tab. It now
  measures the full names against the pane. With few counts they appear from
  about 85 columns, and with counts on every tab from about 97. After the bar
  has dropped to short names, full names return only with 4 spare columns, so a
  pane parked on the boundary does not flip back and forth.
- **Short name for Notifications.** The short name of the fifth section is now
  `Status` (was `Notices`).

No shared quota, collector or cache protocol version changed, and dependencies
are unchanged. Node.js 22 or newer remains required.

Known limitations are those of v0.19.0: the GitHub status request uses Node's
built-in `fetch`, which does not read `HTTPS_PROXY`, and notification history
is per pane and in memory. Existing personal/work EMU and native
assistive-technology qualification remain open or unmeasured.
