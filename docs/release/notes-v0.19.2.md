# gh-glance v0.19.2

This patch release gives the fifth section one name and calms its unread badge.

- **One name, `Events`.** At every width that shows a name, the fifth section
  is now `5:Events` in the tab bar, its view title and the help text. Narrow panes no longer switch it to a
  different word (`Status`, earlier `Notices`). The shorter name also lets full
  tab names fit in panes 7 columns narrower.
- **A quieter badge.** A wait that ends in under two minutes no longer counts
  toward the unread badge. The view still lists it. Each wait is measured on
  its own, so repeated short waits do not add up. Problems, causes that need
  action, active waits and longer waits count as before.

No shared quota, collector or cache protocol version changed, and dependency
ranges are unchanged. Node.js 22 or newer remains required.

Known limitations are those of v0.19.1: the GitHub status request uses Node's
built-in `fetch`, which does not read `HTTPS_PROXY`, and `Events` history is per
pane and in memory. Existing personal/work EMU and native assistive-technology
qualification remain open or unmeasured.
