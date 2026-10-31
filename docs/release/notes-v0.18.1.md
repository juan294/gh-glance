# gh-glance v0.18.1

This patch release fixes caching, rate-limit recovery and real-time freshness
defects found in the 2026-10-31 performance and real-time review (#163 to #174).

- **Isolation between repositories:** a collector that serves several
  repositories through one provider gives each target its own request scope, so
  rows from one repository can no longer be fetched or published under another
  (#163). Security capability backoff is scoped by host and repository (#165).
- **Rate-limit recovery:** a secondary rate limit no longer blocks a resource
  until the hourly reset; it keeps GitHub's retry deadline (#164). After
  repeated limits the transport pauses: press `r` (or `R`) once to resume it, or
  wait for the primary reset. Resuming never shortens GitHub's retry deadline.
- **Quieter polling:** unchanged collector Issues and PR results now reach the
  quiet cadence instead of polling at the floor (#166, #167). GraphQL and core
  work no longer delay each other (#169), and governor waits that change nothing
  no longer rewrite the shared ledger (#174).
- **Truthful freshness:** a Security check answered only from capability backoff
  sends no request and no longer counts as a new observation (#168). The Actions
  clock advances in collector mode, and collector source age counts time spent
  suspended (#171).
- **Collector connections:** a same-epoch reconnect shows Connected again
  without waiting for a newer generation (#170), and followers no longer re-send
  unchanged snapshots (#173).
- **Display cache:** in inferred mode the cache key includes the repository
  resolved from the git remote, so a changed remote in the same directory no
  longer restores another repository's rows (#172). Existing directory-only
  cache entries start cold once after the upgrade.

No shared quota, collector or cache protocol version changed. Node.js 22 or
newer remains required.

Known limitations: with `--background all`, a repository whose Security features
are disabled can show Stale between backoff probes for up to one hour. Any
collector client refresh resumes a paused transport, not only `r`. Existing
personal/work EMU and native assistive-technology qualification remain open or
unmeasured.
