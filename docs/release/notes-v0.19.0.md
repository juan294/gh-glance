# gh-glance v0.19.0

This minor release stops status notices from pushing the table down and adds a
fifth section, Notifications, that keeps the pane's status history and reports
GitHub's own platform status.

- **Only what needs you stays above a table.** A cause that needs your action
  (`gh-glance --doctor`, `gh auth status`, an inaccessible repository, a
  repeated limit that waits for `r`) still shows its remedy above the table.
  Automatic waits such as "GitHub budget evidence is old", `Waiting to update`,
  `Checked HH:MM`, `cached` ages, failed refreshes and the Security "not
  enabled" notes no longer take rows from it.
- **Notifications (`5`).** The new section lists those events newest first:
  waits with their next retry, failed refreshes with their text, Security
  source notes, refreshes and the moment each cause cleared, with repeats
  counted. It starts with earlier recovery transitions from the shared journal,
  dimmed, and keeps the latest 500 events in memory. `5` opens it, `1`-`4` or
  `Esc` return, and Tab and the arrow keys cycle through all five sections.
- **Unread badge.** The tab shows how many waits and problems arrived since you
  last opened it: red when any is a problem or needs action, yellow when all are
  waits. Routine refreshes never change it, so an idle pane still redraws
  nothing.
- **GitHub platform status.** The first row of the view reads
  `https://www.githubstatus.com/api/v2/summary.json` every 10 minutes, when you
  open the view, on `r` in the view and when a tab starts failing (at most once
  a minute). It spends no GitHub API quota. Incidents and outages for API
  Requests, Actions, Issues, Pull Requests, Git Operations or Webhooks are
  problems and keep the badge red until they resolve; an incident posted
  without a component is a problem only when its name names something the
  dashboard shows. It runs only for `github.com` and is off with
  `GH_GLANCE_GITHUB_STATUS=off`.
- **Tab bar.** Five sections fit one row: full names from about 98 columns,
  short names (`PRs`, `Notices`) below that, then digits with counts. At 80
  columns the bar now uses short names.

No shared quota, collector or cache protocol version changed. Node.js 22 or
newer remains required.

Known limitations: the status request uses Node's built-in `fetch`, which does
not read `HTTPS_PROXY`; where only a proxy reaches the internet, the status row
reads "GitHub status unavailable" (turn it off with
`GH_GLANCE_GITHUB_STATUS=off`). Notification history is per pane and in memory;
only recovery transitions persist across restarts, through the existing
journal. The shape of a live incident was validated against GitHub's published
past incidents, not a live one. Existing personal/work EMU and native
assistive-technology qualification remain open or unmeasured.
