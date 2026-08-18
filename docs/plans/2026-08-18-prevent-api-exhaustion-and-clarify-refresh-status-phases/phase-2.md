# Phase 2: build the shared account governor

> Parent: [`../2026-08-18-prevent-api-exhaustion-and-clarify-refresh-status.md`](../2026-08-18-prevent-api-exhaustion-and-clarify-refresh-status.md)
> Depends on: Phase 1
> Batch eligibility: no

## Objective

Persist the Phase 1 policy as a private, account-and-host scoped coordination
protocol. Prove real multi-process locking, probe ownership, leases,
reservations, crash recovery, and privacy before the application poll loop uses
the governor.

## Source changes

### Host and account scope (`index.mjs:614-662`, `index.mjs:1441-1477`, `index.mjs:3404-3464`)

Add pure resolution helpers for the effective host. Keep API routing and
coordinator scope on the same normalized host. An unresolved host denies data
grants; it must never read a default-host budget and spend against another
host.

Build the scope hash from:

```text
sha256(JSON.stringify({version: 1, effectiveHost, authCacheIdentity}))
```

Re-use the existing one-way credential identity. Never persist its inputs.
Recompute the identity before each heartbeat/admission and migrate the pane to a
new closed scope when it changes.

### Governor storage (`index.mjs:3057-3114`, `index.mjs:3589-3666`)

Add this separate path under the existing gh-glance config directory:

```text
rate-governor-v1-<scopeHash>.json
```

Create the directory with `0700` and the file, temporary file, and lock with
`0600`. Use atomic temporary write plus rename. Normalize and bound all input:

- maximum live leases: 128;
- maximum pending intents: 512;
- maximum reservations: 512;
- reject unknown versions and invalid timestamps/costs;
- prune expired leases and unstarted intents on every mutation;
- preserve started reservations until probe reconciliation.

Do not use the dashboard cache target key, cache schema, or coalesced writer.
Admission must be a synchronous mutation under a new `withGovernorLock()`.
Reuse atomic-file primitives, but do not steal by elapsed time. Store PID and a
random nonce in the private lock owner record. Treat a live/suspended PID and
`EPERM` as owned. When `kill(pid, 0)` confirms `ESRCH`, atomically rename the
abandoned lock to a unique quarantine path before reacquiring the canonical
path. Unlock validates its nonce, atomically renames the owned lock to its own
release path, then deletes that path; it never unlinks the canonical path after
a successor can acquire it. PID reuse can conservatively leave the governor
paused, but cannot admit two owners. No subprocess or asynchronous wait runs
inside the lock. Keep existing cache and preference behavior unchanged.

### Governor protocol

Implement small operations rather than exposing arbitrary state writes:

```text
registerLease(scope, lease)
heartbeatLease(scope, leaseId, demand)
claimProbe(scope, leaseId, nowMs)
publishProbe(scope, leaseId, nonce, budgets, nowMs)
requestManualProbe(scope, leaseId, epoch, observedAt, nowMs)
registerIntent(scope, intent)
readIntentDecision(scope, intentId, nowMs)
startReservation(scope, reservationId, nowMs)
completeReservation(scope, reservationId, {outcome, actualCost}, nowMs)
recordResourceBlock(scope, resource, resetMs, reason)
releaseLease(scope, leaseId)
inspectGovernor(scope)
```

Each operation re-reads, validates, prunes, reduces, and atomically writes the
state. Return a discriminated result:

```text
{ok: true, value}
{ok: false, reason: "busy"|"corrupt"|"unwritable"|"stale"|"unknown-host"}
```

Every failure result means no data grant. It may allow a bounded retry or one
probe-claim attempt; it never means “continue independently.”

`startReservation()` is the final authority, not a blind status change. Under
the lock, revalidate the current auth/host scope, live lease, reservation owner
and scheduled status, `notBefore`, epoch, snapshot TTL, probe barrier, resource
block, and capacity after all current reservations. Any mismatch cancels or
reschedules the grant and starts no subprocess.

`requestManualProbe()` records `{epoch, baselineObservedAt}`. A manual
publication that confirms the hold marks the demand satisfied without clearing
it. More key presses return the existing pause until a scheduled probe or reset
clears the marker.

Only `outcome: "measured-success"` can reconcile to a smaller `actualCost`.
Reject, timeout, signal, abort, and process-loss outcomes retain worst-case cost
until a clean probe accounts for them.

### Shared budget probe (`index.mjs:1669-1712`)

Keep `readRateBudgets()` as the one `gh api rate_limit` seam. Add a coordinator
wrapper:

```text
refreshSharedBudget(scope, leaseId, signal):
    claim = claimProbe(...)
    if another valid claim exists:
        return waiting for claim expiry/publication
    budgets = await readRateBudgets(signal)       // outside file lock
    publish only when owner and nonce still match
```

Publishing starts a new epoch when `resetMs` changes or `used` falls. It clears
only reservations known to be accounted for. A failed probe keeps a fresh
snapshot usable for active work only until its 65-second TTL; it pauses
background work. After TTL it grants no data request.

The probe claim is also a start barrier. Atomically record `claimAt` and the set
of reservations already started. New reservations cannot enter `started`. Wait
for the recorded set to finish, bounded by the first 30 seconds of the 70-second
claim. Before spawning `gh`, atomically verify the nonce and renew it to a fresh
35-second active-probe deadline. If renewal fails or the claim has expired, do
not probe. On publish, retire only entries completed before `claimAt`; retain
every uncertain overlap. Release the barrier on probe success and failure.

When a reset creates a new epoch, carry every old-epoch started or uncertain
reservation into the new epoch's debit set. A request can start before reset and
reach GitHub after it. Retire it only after completion followed by a clean probe
that accounts for the new window.

Expose governor health to the existing doctor data path
(`index.mjs:1767-1783`) without raw scope identifiers. Report `healthy`,
`waiting for probe`, `stale`, `blocked`, or `unavailable`, plus aggregate lease
count and per-resource reserve/remaining/reset.

## Tests

### New `test/governor.test.mjs`

Use temporary XDG roots and fake clocks. Cover:

- path and scope stability;
- account and host isolation;
- unknown/ambiguous host denial;
- schema version and bounds;
- corrupt/truncated/future state;
- atomic replacement and private modes;
- lock busy and dead-owner quarantine/recovery;
- a suspended live owner is never stolen from;
- unlock cannot remove a successor's canonical lock;
- lease registration, heartbeat, expiry, and migration;
- probe owner/nonce publication and dead-owner takeover;
- intent coalescing and priority;
- reservation start/completion/reconciliation;
- Security actual-cost reconciliation;
- started reservation retention after process death;
- rate block publication;
- repeated manual-probe demand before and after publication coalesces for the
  unchanged held epoch/sample;
- reset epoch transition;
- stale planned grants, changed auth/host scope, expired leases, new resource
  blocks, and stale snapshots all fail the planned-to-start revalidation;
- calls completing before, during, and after a probe watermark reconcile only
  when their ordering is certain;
- a near-timeout started request followed by a near-timeout budget probe keeps
  one renewed claimant and never admits a takeover;
- a request that straddles reset stays charged in the new epoch;
- unwritable storage fail-closed behavior;
- persisted JSON privacy scan.

### New spawned worker fixture

Create a small Node worker under `test/fixtures/` that imports the test seam and
performs requested governor operations. Spawn 12 workers against one temporary
scope. This is real process contention, not sequential stale-snapshot coverage.

Prove:

1. one initial probe claimant and 11 waiters;
2. no lost leases or duplicate reservation identifiers;
3. total reservations never exceed spendable capacity;
4. equal-priority workers make round-robin progress;
5. bounded active concurrency and staggered slots;
6. a killed probe owner is replaced after claim expiry;
7. a killed request owner does not release its started cost;
8. same scope shares, while a different host or auth identity does not;
9. reset produces one new claimant and a new phased order;
10. a suspended live lock owner is never replaced;
11. dead-owner quarantine and owner unlock cannot remove or overwrite a newer
    canonical lock.

### Existing tests

- Add host-scope cases near `test/args.test.mjs:26-116` and
  `test/pty/routing.test.mjs:19-91`.
- Add doctor privacy/status cases near `test/doctor.test.mjs:120-140` and
  `test/doctor.test.mjs:195-223`.
- Do not put governor state into `test/cache.test.mjs`; cache persistence remains
  a separate recovery feature.

## Automated success criteria

- Twelve real workers coordinate through one file with no duplicate unsafe
  grants or lost updates.
- Lock, corruption, permission, and stale-snapshot errors grant zero data work.
- Only one live probe owner exists per scope.
- Governor state contains no raw token, host, login, repo, cwd, title, or PID.
  Ephemeral private lock metadata contains only the required PID and nonce.
- Existing cache/preferences tests remain unchanged and green.
- Run sequentially:

  ```bash
  npm run lint
  npm test
  node --check index.mjs
  git diff --check
  ```

## Manual success criteria

Inspect one temporary governor file created by the tests. Confirm its mode is
`0600`, its parent directory is private, and its content contains only hashes,
random IDs, numeric scheduling data, and enum values.

## Stop condition

Stop when the governor protocol and multi-process tests pass. Do not change the
application polling effect or footer in this phase.
