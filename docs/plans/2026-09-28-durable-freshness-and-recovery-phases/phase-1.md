# Phase 1: bounded accounting and complete runtime recovery

Parent: [durable freshness and recovery](../2026-09-28-durable-freshness-and-recovery.md). Entry: accepted parent; revalidated `develop` baseline. Status: planned, not implemented.

## Scope and order

Cover D1–D5 and F01–F07 in the parent. One owner changes `index.mjs` and shared fixtures in an isolated worktree. Schema migration, dispatch fences and settlement integration must land together; no interim release. Existing capacity retention is at [index.mjs:3923](../../../index.mjs:3923), control admission at [3257](../../../index.mjs:3257), dispatch at [747](../../../index.mjs:747), lease-bound settlement at [5167](../../../index.mjs:5167).

1. Write a sanitized v6 fixture with the reproduced 511 started/one completed shape, no identity attempts, expired and live leases, old core evidence and newer GraphQL evidence. Use synthetic identities, times and run payloads. Add a production-path regression that fails on the existing cap, plus a fresh-4999 variant. Verify residual totals core 456/GraphQL 162 independently.
2. Implement strict v7 schema, independent control slots, bounded owner/debt summaries and safe migration. Cover read/write/migrate/normalize and all budget arithmetic; no off-by-one allowance for controls hidden inside the 512 data cap. Enforce a 2 MiB serialized quota-ledger ceiling and bounded strings/arrays before writing. Reject oversize input safely without overwriting it; the valid maximum fixture must fit this ceiling.
3. Bind exact receipt capabilities throughout `requestIdentityStorage`, including standalone, nested acquisition, collector/App and doctor. Track per-dispatch issued/terminal state, boot/owner identity and operation deadlines. Use actual child termination evidence; retain uncertainty when process identity cannot be established safely. Never signal a reused PID based on number alone.
4. Implement idempotent terminalization, original-scope settlement after lease expiry and bounded completion retries. Fix pre-transport claim failure to settle never-issued work. Check every result at parent consumer-sweep locations; no ignored failure booleans.
5. Migrate acquisition v1 to v2 under parent D5: seed its 1,024-receipt cap, preserve snapshots/counters, fence legacy claims and replace uncertainty lists with at most 128 authoritative scope projections plus a fixed legacy diagnostic summary. Update normalization, serialization, publication, failure/claim release, reconciliation, diagnostics and fixtures. Preserve the existing 32 MiB acquisition-store cap; diagnostic projection capacity cannot deny successful publication. A fresh epoch alone cannot imply debt retirement.
6. Compact conservatively, reconcile only causally covered debt and make the independent observer reachable through cached-identity startup. Preserve secondary holds and registry attempt limits. Migrate existing state automatically; retain old-writer charges and reject legacy writes. Amend ADR 0003/0004's changed lifecycle contract in this phase.

```text
@ compactAndAdmit(scope, receipt, operation) -> admission
ctx: canonical quota lock and strict v7 ledger
pre: caller has verified original identity and requested operation cost
do:
  1. validate state, scope, receipt lifetime and owner
  2. transfer expired receipt residuals to bounded debt atomically
  3. compute available budget including all unresolved and control costs
  4. write receipt or a structured denial with finite retry/action
br: control request uses its resource slot independently of data slot count
fail: invalid state or unsafe accounting returns a visible blocked cause
```

```text
@ dispatchAndFinish(receiptCapability, request) -> result
ctx: shared permit, acquisition fence, child transport and original quota scope
pre: immutable capability identifies an admitted operation and owner
do:
  1. validate exact receipt, deadline, sequence allowance and publication fence
  2. write issued evidence before spawning the child
  3. record terminal evidence when actual child completion is known
  4. settle once or retain immutable evidence for bounded write retries
br: no dispatch releases unused charge; unknown outcome retains worst-case debt
fail: missing or compacted receipt rejects future dispatch without refund
```

```text
@ publishObserver(claim, observation) -> budget
ctx: resource observer slot and bounded debt revisions
pre: claimed transport has authoritative response evidence for the same scope
do:
  1. validate claim, resource, epoch and response chronology
  2. lookup the immutable quiescent units and count captured by this claim
  3. write budget and subtract that snapshot once while preserving later additions
br: unresolved ownership survives fresh observations and reset boundaries
fail: superseded or late response cannot change newer authority or debt
```

## Automated acceptance

- Record red failures before implementation. Run real normalization, coordinator and transport functions against private roots; mock only external API/clock/process faults.
- F01: packed normal CLI against the aged fixture obtains new source data within 60 seconds with short healthy responses and available quota. F02: at least 1,000 compactions/restarts preserve exact units and 512/2/128/2 MiB quota bounds.
- F03: actual child SIGSTOP/SIGCONT coverage before dispatch and during transport, plus injected multi-hour clock/reset cases; no stale owner issues a new uncharged request. Deadline expiration is tested separately from quiescence.
- F04/F05: inject multiple completion-lock failures, acquisition-start rejection, old-scope completion, dead owner and expired lease. Assert HTTP count, settlement count, debt and publication generation, not merely a return status.
- F06: observer before/after quiescence, compaction adding debt between claim/publication with exact old-portion subtraction, two same-owner children with one paused, replayed sealed-group acknowledgements, late/double completion, registry cleanup, numeric overflow, mixed-version writers and interrupted migration. Unknown legacy ownership remains charged and does not block the captured low-debt fixture.
- F02 acquisition variant: seed 1,024 legacy acquisition receipts plus the aged quota ledger; a new source result publishes automatically, outstanding quota totals remain truthful and no duplicate debt is charged. Missing/stale quota projection remains disclosed, never zeroed or allowed to block publication. Exercise two access keys sharing one quota scope and projection eviction.
- F07: both resource-isolation directions, exhausted exceptional allowances, Retry-After and actual reset. Optional collector/SSH/App/webhook paths exercise the same production transport seam.
- Apply all five sequential parent gates. Independent reviewer checks accounting proof, TOCTOU pause windows, migration and every consumer. Simplify and resolve findings before phase acceptance.

## Manual/live boundary and handoff

No live ledger migration, existing-pane restart or installation in this phase. Manual testing is not a substitute for the automated cases. Phase 1 completes locally only; Phase 4 still blocks incident resolution.

Save `phase-1-validation.md` with source identity, red/green evidence, consumer sweep, review dispositions, debt/concurrency traces and remaining Phase 2 entry. No batch-eligible unit because product/schema consumers overlap.
