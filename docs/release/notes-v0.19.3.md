# gh-glance v0.19.3

This patch release stops one contradictory rate-limit reading from pausing every pane.

- **No hour-long pause after a contradictory reading.** GitHub can report a
  rate-limit window that disagrees with the one gh-glance stored. Before, later
  readings with an earlier reset were refused until the real window reset, so
  all panes on the account stopped refreshing for up to an hour. The budget
  check now accepts the newer reading, and panes continue at the next check,
  60 seconds at most.
- **An accurate message.** A rejected budget reading is shown as a failed
  budget check that retries automatically. It no longer says that local
  coordination is corrupt, and `gh-glance --doctor` no longer advises moving
  the state file for this case. Real state-file damage is reported as before.

No shared quota, collector or cache protocol version changed, and dependency
ranges are unchanged. Node.js 22 or newer remains required. Restart running
panes after the upgrade; panes on an older version keep the old behavior.

Known limitations are those of v0.19.2: the GitHub status request uses Node's
built-in `fetch`, which does not read `HTTPS_PROXY`, and `Events` history is per
pane and in memory. Existing personal/work EMU and native assistive-technology
qualification remain open or unmeasured.
