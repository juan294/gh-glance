# Phase 5: adaptive demand, smaller queries and refresh semantics

Parent: [complete plan](../2026-09-05-multi-instance-efficiency.md)  
Depends on: 4. Batch eligibility: no.

## Objective and files

Reduce data acquisition at its source while preserving actionable CI updates and list correctness. Change fetch descriptors, polling policy, viewport demand and key handling in `index.mjs` (`index.mjs:985`, `:1107`, `:1153`, `:1188`, `:4334`, `:6157`, `:6183`, `:7306`, `:7958`, `:8430`). Add `test/poll-policy.test.mjs`, `test/pagination.test.mjs`, `test/pty/adaptive-polling.test.mjs`; update args, keys, selection, conditional polling, doctor projections and fixture tests.

## Changes and pseudocode

Extract a pure policy taking floor, active demand, last outcome, unchanged count, in-progress CI and resource capability. Implement the exact cadence table in the parent. Errors do not increment unchanged count. A validated content change or newly active subscription resets quiet mode; known cached data can display immediately while the next check waits for its normal safety admission. Add `--background all|off`; off never requests inactive data but keeps existing cached counts visibly old/unknown as appropriate.

```text
nextDue(policy, sourceState, demand):
  if no demand: Infinity
  if explicit refresh: now, constrained by governor
  if active running/queued Actions: max(floor, 5s)
  if active unchanged twice: resource quiet interval
  if inactive: resource background interval, or Infinity when off
  otherwise: floor
```

Actions uses a stable 60-row variant to improve reuse across terminal sizes. Map workflow name from each run's `name`. Only missing names/unknown IDs use the existing conditional catalog, with a 15-minute TTL and one catalog generation per query owner. Catalog refresh failure keeps a valid run list with a missing/last-known name rather than blocking CI status. No new unbounded workflow pagination. Update costs from an unconditional two-request batch to separately admitted run and optional catalog operations.

Issues/PRs request 50 rows initially. At selection/scroll demand within ten rows of the end, acquire one next page, capped at 150. Repeated demand coalesces. Commit the first page without waiting on another tab or page. Maintain selected item by identity, deduplicate by node/number, and carry totalCount/hasNextPage so capped or partial data never looks complete. When first-page content changes, invalidate later cursor generations and refetch currently demanded pages; do not join pages from incompatible traversals. A failed next page preserves current rows and selection.

Split manual intention from cache invalidation outside Width mode: `r` = prioritized conditional refresh; `R` = one bounded resynchronization. Preserve Width mode precedence: its existing `r`/`R` width-reset actions emit no refresh (`index.mjs:7645`, `index.mjs:7647`). Ordinary refresh may join an acquisition that started after the manual demand, or schedule one follow-up if the acquisition predates it; further presses coalesce. Both replace the automatic deadline. Only refresh-mode `R` clears validators and negative capability backoff after admission. If a 304 has no valid associated entity, allow one separately admitted unconditional recovery, then surface unusable state rather than looping.

Replace the old fixed-per-tab cost projection with a policy-derived nominal demand range. Label projections separately from observed charges. Update README key/cadence guidance and generate the sample with `node test/pty/readme-sample.mjs` if visible hints change.

## Automated acceptance

- `POLL-01`: two unchanged observations enter quiet cadence; change/active CI restores the specified floor; background off emits zero inactive data calls.
- `POLL-02`: simulated running CI change reaches display within its interval plus two seconds under fixture capacity; quiet list within 30 seconds plus two seconds at default floor.
- `POLL-03`: complete run names cause no workflow-catalog request; missing names cause one conditional catalog request, reused for 15 minutes.
- `PAGE-01`: first display requires one 50-row page; scrolling adds exactly one; no more than 150 loaded rows; repeated scroll coalesces.
- `PAGE-02`: first-page reorder during pagination rejects old generations, removes duplicates, preserves selection when its item remains, and retains truthful incomplete markers.
- `REFRESH-01`: `r` sends validators and a quiet 304 spends zero primary REST; `R` drops them once and stays subject to budget/cooldown.
- `REFRESH-02`: a manual request during automatic work schedules at most one follow-up; invalid cached-pair recovery is one attempt, not an API loop.
- `REFRESH-03`: Width mode retains both reset behaviors and starts zero refresh requests for `r`/`R`.

Run parent gates sequentially. Change the old forced-`r` PTY expectation deliberately; retain a corresponding explicit-`R` regression.

## Manual success criteria

None required; terminal key and selection behavior are exercised through the PTY harness.

## Completion

- [ ] Policy, metadata reduction, demand paging and refresh controls implemented.
- [ ] POLL/PAGE/REFRESH scenarios and parent local gates passed.
- [ ] Independent compliance/quality review complete; integrated locally; stop.
