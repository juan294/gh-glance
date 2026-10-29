# gh-glance v0.18.0

This release adds local search, exact CI evidence and a personal attention queue,
with optional Jev interpretation behind explicit opt-in and consent.

- **Focus loaded work:** press `/` on Issues or Pull requests to search loaded
  titles, labels and branches locally. Topic words combine with exact number,
  author, branch and updated-date filters without extra GitHub requests.
- **Inspect CI evidence:** on Actions, select a run and press `d` for its exact
  attempt, SHA, jobs and steps. Select a failed or timed-out job and press `l`
  to capture its bounded plaintext log. Enter opens the exact job on GitHub.
- **Personal attention:** press `a` to see personal review requests, assignments
  and authored PRs among loaded work. Details load in explicit 25-item batches;
  `m` requests more, `r` refreshes and `u` exposes unknown relationships. This
  requires standalone mode and a verified human GitHub identity.
- **Optional Jev interpretation:** start standalone with `--jev` and
  `TYPESAFE_API_KEY`, then press `J` in Focus, a loaded CI log or attention.
  Semantic Focus can match related topics beyond literal keywords. CI
  observations cite original log lines. Attention badges identify reported
  regression or described user impact without changing exact queue membership,
  reasons or order. Calls require scoped consent, use a four-second action
  deadline and share a session cap; startup, typing and polling send nothing.
  `x` revokes permission and clears semantic results; in CI it also clears the
  active log and excerpt.
- CI sends always preview the sanitized excerpt. Known credential patterns
  block submission of the selected range; `e` selects a smaller range for a new
  review. Redaction does not guarantee secret-free text. Separate identity fields
  are omitted, but literal metadata and log text may still contain private or
  identifying content. Jev results are observations, not proven causes or fixes.
- Maintainer CI records exact checkout evidence for Sutura's protected
  native-proof pilot. Full repair verification does not grant publication or
  merge authority.
- Refreshing attention keeps unchanged source metadata usable across live and
  cached reads; real metadata changes still invalidate prior results.

**Upgrade all panes together.** Shared quota protocol 8 migrates the existing
ledger in place and saves its exact original bytes in a private
`.pre-v8.backup`. Restart every gh-glance pane with this version; keep the ledger
and backup. Never clear, replace or downgrade the ledger to resolve a version
mismatch. Live older leases delay migration. An unproven log-connection closure
retains its conservative quota charge until the stated recovery boundary.

Node.js 22 or newer remains required. CI details and personal attention are
standalone-only; connected collectors keep their ordinary views and browser
links. Jev is optional and requires the user's TypeSafe credential. Live provider
contract behavior remains unverified; semantic accuracy and developer benefit
remain unmeasured. Existing personal/work EMU and native assistive-technology
qualification remain open or unmeasured.
