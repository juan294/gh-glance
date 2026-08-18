# Plan: prevent API exhaustion and clarify refresh status

> 2026-08-18 | Branch `develop` @ `975a527bf3a33471771ffa92f47a8cc8bd9773ee`
> Research: [`docs/research/2026-08-18-concurrent-pane-refresh-feedback-and-api-coordination.md`](../research/2026-08-18-concurrent-pane-refresh-feedback-and-api-coordination.md)

## Goal

Keep many gh-glance panes useful without letting gh-glance consume the GitHub
account's complete API budget. Coordinate panes that use the same GitHub account
and host, preserve a hard reserve for other `gh` and `git` work, avoid startup and
reset bursts, and show whether the active tab is watching, checking, waiting,
paused, limited, or failed.

This plan replaces the earlier UI-only draft. It changes both request admission
and the footer. It does not change the independent `gh` fetchers, the last-good
dashboard cache, or GitHub authentication ownership.

## New evidence and corrected premise

At 2026-08-18 08:35:51 CEST, a live read of the account in the reported session
returned:

```text
core     limit=5000  used=5000  remaining=0
graphql  limit=5000  used=752   remaining=4248
core reset: 2026-08-18 08:41:19 CEST
```

The UI then reported `GitHub rate limit reached -- backing off, this clears on
its own`. This is evidence that the existing protection did not preserve usable
REST capacity. It does not prove that gh-glance alone spent all 5,000 calls;
other programs using the same credentials can also contribute.

| | Expected | Found | Why it matters |
|---|---|---|---|
| Budget margin | `BUDGET_SAFETY = 0.8` leaves 20% of the hourly limit for other work. | The factor is applied to the current remaining rate, not to a fixed reserve. The resulting curve can approach zero. | The controller has no invariant that keeps 1,000 calls unused. |
| Exhaustion | A pane stops spending a depleted resource. | `remaining <= 0` selects the 60-second cap and continues attempts (`index.mjs:1110-1120`). | Slower requests are still requests, and repeated panes can keep producing failures. |
| Startup | Budget state governs the first data request. | The first probe is fire-and-forget, while tick zero starts all four tab fetchers (`index.mjs:3689-3693`, `index.mjs:4839-4860`, `index.mjs:4929-4930`). | Many new panes can create a burst before any pane knows the budget. |
| Resource isolation | A depleted REST budget does not stop healthy GraphQL work. | The larger REST or GraphQL target sets one process-wide interval (`index.mjs:1145-1163`). | In the live state, Issues and pull requests can still work from GraphQL. |
| Shared control | Panes coordinate before requests. | Each process infers other consumers after GitHub reports token-wide spend; no local admission state is shared (`index.mjs:1088-1097`, `index.mjs:1202-1212`). | Delayed observation cannot prevent simultaneous startup, retry, or reset bursts. |

The released behavior and the research document remain valid records of what
exists at the stated commit. This plan supersedes their conclusion that the
token counter alone is sufficient protection.

## Safety contract

Use the existing 80% policy as a hard reserve definition for each GitHub rate
resource:

```text
reserve = ceil(limit * (1 - BUDGET_SAFETY))
spendable = max(0, remaining - reserve - unaccountedReservations)
```

For the normal 5,000-call `core` and `graphql` limits, the reserve is 1,000.
Every gh-glance data request must obtain an atomic, resource-specific grant
before its `gh` subprocess starts. A grant reserves the request's worst-case
cost. No automatic, startup, tab-switch, manual, open-item, failure-context, or
doctor endpoint path can bypass this rule. The free `rate_limit` probe and local
CLI/auth/version inspection do not need a quota grant.

The enforceable guarantee is:

> gh-glance starts no data request for a rate resource when its latest fresh,
> conservatively debited observation cannot cover the request without entering
> that resource's hard reserve.

This is not a promise that the GitHub account's global counter can never cross
the reserve. Another program can spend immediately after a probe, and GitHub
does not offer an atomic quota-reservation API. Separate gh-glance processes
that cannot share the local coordinator also cannot make a literal global
guarantee. The implementation must state this boundary and must fail closed
rather than fall back to independent five-second polling.

## Chosen architecture

### 1. File-backed account governor

Add a versioned, private, file-backed governor. It is not a daemon and adds no
dependency. It uses the existing locked, atomic persistence patterns
(`index.mjs:3057-3114`, `index.mjs:3589-3666`) but has stricter failure
semantics than the advisory cache writer.

Scope one file to a hash of the effective GitHub host and the existing
credential namespace from `authCacheIdentity()` (`index.mjs:3404-3447`). The
file name contains only the hash. The governor state contains no token, raw
host, login, repository, working directory, title, or PID. The ephemeral private
lock owner record contains only a PID and random nonce so a live/suspended owner
is never mistaken for a dead one.

Resolve the host before granting data work in this order:

1. explicit `runtime.host`;
2. `GH_HOST`;
3. host-qualified `GH_REPO`;
4. `github.com` for an explicit `owner/repo` slug;
5. one unambiguous host parsed locally from Git remotes.

If the host is still missing or ambiguous, use one conservative unknown scope
only to coordinate host resolution and a budget probe. Deny ordinary data
grants until the host is known. Route `gh api rate_limit` to the same effective
host (`index.mjs:614-662`, `index.mjs:1695-1706`). Refresh the auth namespace on
heartbeat so `gh auth switch` moves a running pane before its next grant.

Use this normalized shape:

```text
GovernorState v1:
    epoch
    budget[core|graphql]:
        limit, remaining, used, resetMs, observedAt
        blockUntil, blockReason
        laneNextAt, roundRobinCursor
        lastExternalFactor
    probeClaim:
        ownerLeaseId, nonce, leaseUntil, nextAt
        claimAt, startedReservationIds
    leases[leaseId]:
        expiresAt, floorMs, activeTab, phaseSeed
        demand[core|graphql]
    intents[intentId]:
        leaseId, tab, priority, cost, requestedAt, expiresAt
    reservations[reservationId]:
        leaseId, intentId, cost, actualCost, notBefore, status
        epoch, startedAt, completedAt, outcome
    manualProbe:
        requestedEpoch, baselineObservedAt, satisfiedAt
```

Create random lease and intent identifiers. Keep a 20-second heartbeat and a
90-second lease TTL. Keep the existing one-minute budget-probe target. A probe
claim spans 70 seconds: up to 30 seconds for an existing request to drain, then
the 30-second `gh` timeout, plus ten seconds of recovery margin. After draining,
renew the same nonce to a fresh 35-second probe deadline before spawning `gh`.
Treat a budget snapshot as fresh for at most 65 seconds.
Use a two-second reset grace before the first post-reset probe. Derive a stable
zero-to-five-second phase from the lease ID and budget epoch for startup and
reset spreading. These constants are part of the pure test contract.

All admission mutations are synchronous read-modify-write operations under a
governor-specific lock. Reuse the atomic-file pattern, but do not use time-based
lock stealing. The lock owner record contains PID and nonce. A live, suspended,
or permission-unknown PID is never stolen from. When the PID is confirmed gone,
atomically rename the abandoned lock to a unique quarantine path before a new
owner acquires the canonical path. Unlock also atomically renames its owned
nonce path before deletion, so it cannot unlink a successor's lock. Do not use
the 200 ms coalesced cache writer (`index.mjs:3289-3388`). Lock busy, abandoned
lock recovery failure, corrupt state, unknown host, stale budget, or unwritable
storage denies data work and schedules a bounded retry. It never silently
grants at the configured floor.

### 2. One shared budget probe

Before the first data request, a pane registers its lease and either claims the
scope's probe or waits for the claimant. The claimant records an owner, nonce,
and expiry under the lock, releases the lock, calls `gh api rate_limit`, then
publishes the result only if the nonce still matches. A dead claimant is
recoverable after claim expiry.

Run budget control on its own one-shot timer. It must not depend on the data
poll interval. Wake at the earlier of the next one-minute probe or the known
reset plus grace. At reset, require a fresh probe before reopening the resource.
A stale pre-reset sample cannot release requests.

Place a shared probe barrier before a probe starts so no new reservation can
enter `started`. At claim time, record `claimAt` and the exact set of started
reservation IDs. Wait for them to drain, bounded by the existing request timeout
plus the five-second claim margin. On publication, retire only reservations that
completed before `claimAt`; retain any request that was started or uncertain at
the watermark. Release the barrier on publication and failure. This explicit
watermark prevents an overlapping request from creating extra apparent balance.

A data call that receives a GitHub rate-limit response writes a shared block for
that resource until its reported reset. Local auth, network, unavailable, and
no-remote failures keep the current local backoff behavior
(`index.mjs:1219-1237`).

### 3. Atomic, fair request grants

Map every tab to the existing worst-case resource costs
(`index.mjs:995-1011`):

| Tab | `core` | `graphql` |
|---|---:|---:|
| Actions | 2 | 0 |
| Issues | 0 | 2 |
| Pull requests | 0 | 2 |
| Security | 6 | 0 |

Use the same registry for auxiliary operations: repository/failure context
reserves one GraphQL call; opening an Actions item reserves two core calls;
opening an Issue or pull request reserves two GraphQL calls; doctor uses those
same costs plus one core call for each individual Security endpoint probe.
Free/local commands have explicit zero entries so a new `runGh` call cannot
silently omit its quota policy.

Security reserves six REST calls before it starts. After completion, reconcile
only a proven unused amount. Failed calls stay billed conservatively. If a
process dies after marking a reservation started, keep that reservation until
a later clean probe accounts for it; do not expire it into extra capacity.

An admitted request must satisfy all of these checks under the lock:

```text
budget snapshot is fresh and belongs to the current epoch
resource has no rate-limit or reset block
remaining - reserve - current reservations >= worstCaseCost
request is next in the resource's fair schedule
no probe barrier prevents the start
```

Revalidate all of these conditions at the planned-to-start transition, together
with current auth/host scope, live lease, reservation ownership, `notBefore`,
and status. A future grant becomes invalid if a new block, probe, scope, stale
snapshot, or epoch appears before its timer fires.

Schedule pending intents by priority, then round-robin across live leases:

```text
manual refresh
active-tab switch
active automatic check
background check
```

Manual `r` gets prompt feedback and the highest safe priority, but it does not
bypass the reserve. Repeated `r` presses coalesce into one intent. Clear the
tab's local failure backoff only after the request receives a grant. At zero
REST, `r` on Actions requests an immediate shared probe and remains paused if
the probe confirms the hold; `r` on Issues can proceed when GraphQL is open.
Persist that manual probe request against the current budget epoch and
baseline `observedAt`. A manual publication that confirms the hold marks it
satisfied but does not clear it. Further presses stay Paused until the next
scheduled probe or reset clears the marker; they cannot start one probe for
every key press.

Pace the shared resource lane from spendable capacity and time to reset:

```text
externalFactor = max(1, globalUsedDelta / sharedCompletedDelta)
callsPerMs = spendable / max(1, resetMs - nowMs) / externalFactor
notBefore = max(nowMs, laneNextAt, leasePhaseAt)
laneNextAt = notBefore + worstCaseCost / callsPerMs
```

Update `externalFactor` only when `sharedCompletedDelta >= MIN_SAMPLE_CALLS` and
`globalUsedDelta > 0`; otherwise retain the last factor. Require a finite factor
of at least one. A non-finite value pauses the resource. Preserve the factor
across reset so a new window does not reopen optimistically.

If `notBefore >= resetMs`, do not reserve capacity in the expiring epoch. Return
Waiting until `resetMs + BUDGET_RESET_GRACE_MS`; the fresh post-reset probe will
schedule a new-epoch slot.

There is no 60-second safety clamp. The old cap was a liveness presentation
choice, not a quota invariant (`index.mjs:1013-1016`). If a safe slot is more
than 60 seconds away, the pane waits and tells the user. If spendable capacity
cannot cover one request, the resource is paused. Active work receives slots
before background work; background observation pauses first under pressure.

The probe remains the authority for external spend. Compare the token-wide
`used` delta with completed shared reservations, retain the last measurable
external factor across small samples/reset, and reduce future lane capacity
when other tools are consuming the token. The hard reserve and atomic local
reservations do not depend on this inference to deny a known-unsafe request.

### 4. Startup, reset, and background shaping

Replace the tick-zero all-tabs burst. Startup order is:

```text
resolve host and account namespace
register lease
obtain or await one shared budget probe
apply stable startup phase
request one active-tab grant
arm independent budget and data wakes
```

Do not fetch background tabs on tick zero. Spread one background tab at a time
across the existing 12-tick cycle instead of fetching all background tabs in
one periodic batch. This keeps the same average observation goal while removing
the synchronized burst (`index.mjs:3689-3693`, `index.mjs:4839-4860`).

At a GitHub reset, create a new epoch, preserve the last conservative external
factor, require one fresh shared probe, and phase live leases again. Do not let
all panes and all tabs resume at once. Carry started or uncertain old-epoch
reservations into the new epoch's debit: a request started before reset can
reach GitHub after reset. Retire it only after completion and a later clean
probe accounts for it.

Every request path uses the same grant seam before `commit()`:

- startup;
- automatic active and background checks;
- tab-switch refresh (`index.mjs:4943-4949`);
- manual `r` (`index.mjs:4570-4577`);
- open-item commands (`index.mjs:1410-1415`);
- failure-context repository resolution (`index.mjs:760-765`);
- quota-consuming doctor endpoint probes (`index.mjs:1728-1755`).

`commit()` remains the in-flight/result/cache boundary
(`index.mjs:4670-4815`). A denied or future grant does not set loading and does
not spawn `gh`; it records a pending state and one local one-shot wake.

### 5. Truthful footer states

Keep the fixed 12-cell left slot and one-line footer
(`index.mjs:3858-3988`). Render the active tab only:

| State | Glyph and copy | Motion | Meaning |
|---|---|---|---|
| Setup | `· Setup` | static | Repository or host setup is required. |
| Watching | `· Watching` | static, dim | Budget is open and the next check is scheduled. |
| Checking | spinner + `Checking` | animated for startup/manual, static for adapted automatic work | A granted `gh` data request is in flight. |
| Waiting | `· Waiting` | static | A request is pending for its assigned shared slot. |
| Paused | `‖ Paused` | static, amber | The resource is at its reserve, expired, unknown, or blocked until a fresh probe/reset. |
| Failed | `! Failed` | static, amber/red body detail | The latest non-budget request failed. |
| Limited | `? Limited` | static, amber | Security visibility is incomplete because one or more sources could not be observed. |

Do not rely on color or animation for meaning. Keep `GH_GLANCE_NO_ANIMATION=1`
truthful. Preserve quiet, byte-identical healthy automatic polling at the normal
floor. Show static automatic `Checking` only when the shared schedule is adapted
or the request follows `Waiting`/`Paused`. Background activity never owns the
active tab's footer.

Use one optional detail selected by a pure width allocator:

- `next 08:42` while waiting for a scheduled grant;
- `reset 08:41` while paused on a known reset;
- `probing` when budget knowledge is being refreshed;
- no scheduling detail beside `Failed`, `Limited`, or `Setup`.

`next` is the current grant's `notBefore`, not a general polling promise. `next`
and `reset` are stable absolute local times, so they do not force one render per
second.

Layout priority is: left state, actionable `r`/`q` hints, optional detail, other
hints, version. Test explicit layouts at 80, 60, 45, and the 24-column minimum.
At the minimum, omit detail before removing Refresh or Quit. Never wrap into the
physical guard row.

Status precedence is:

```text
width mode
remote/setup
admitted visible request -> Checking
shared budget hold or known rate limit -> Paused
pending future grant/probe -> Waiting
non-budget active-tab error -> Failed
incomplete Security observation -> Limited
Watching
```

For `INK_SCREEN_READER=true`, keep Setup, startup/manual Checking, Waiting,
Paused, Failed, Limited, stale, and error text. Suppress routine adapted
automatic `Checking` transitions so the linear renderer does not announce each
poll boundary.

Freshness remains the time of the last successful observation, including an
unchanged response (`index.mjs:4692-4755`). Failed and incomplete Security
observations do not advance it. Keep the configured-floor threshold for
Watching and Checking. When Waiting has a valid current-epoch grant, extend the
deadline through `notBefore + GH_TIMEOUT_MS`; the UI must not call data stale
before its assigned request can finish. Paused, Failed, expired, and unknown
coordination get no extension, so old cached rows become visibly stale.

## Alternatives considered

| Option | Decision | Reason |
|---|---|---|
| Footer-only wording change | Rejected | The live REST budget reached zero. Better copy cannot make continued requests safe. |
| Keep token-counter inference as the only coordination | Rejected | It observes shared spend after it occurs and cannot prevent startup, retry, or reset herds. |
| Hard reserve in each process only | Rejected | Twelve panes can read the same balance and all admit against it. It remains a useful fail-closed fallback, not the normal protocol. |
| Clamp at 60 seconds | Rejected | A clamp spends faster than the safe rate when the computed interval is longer. It caused zero to mean “continue once per minute.” |
| Stop all tabs when REST is empty | Rejected | GitHub budgets REST and GraphQL separately. Healthy Issues and pull requests must continue. |
| Local daemon or socket broker | Rejected | It adds lifecycle, installation, recovery, and platform work that a small locked state file can avoid. |
| GitHub webhooks or GitHub App | Out of scope | They require a service and different authentication/product architecture. |
| Conditional REST/ETag rewrite | Deferred | It can reduce cost later, but it does not provide cross-process atomic admission. |

## Implementation phases

| # | Phase | Batch | Done |
|---|---|---|---|
| 1 | Define hard-reserve policy, resource decisions, and grant scheduling as pure tested behavior | no | [x] |
| 2 | Build the private account governor, shared probe ownership, and process-concurrency tests | no | [x] |
| 3 | Route every fetch path through grants and reshape startup, reset, and background scheduling | no | [x] |
| 4 | Add the truthful footer model and end-to-end multi-pane terminal evidence | no | [ ] |
| 5 | Record the architecture, update user guidance, and validate the complete candidate | no | [ ] |

Phase files:
`docs/plans/2026-08-18-prevent-api-exhaustion-and-clarify-refresh-status-phases/phase-N.md`

No phase is `[batch-eligible]`. Phases 1 through 4 all change `index.mjs` and
each consumes the preceding phase's executable contract. Phase 5 documents and
validates the exact implementation from Phase 4.

## Complete success criteria

### Automated

- Pure tests prove a 1,000-call reserve for a 5,000 limit, no grant at or below
  reserve, monotonic pacing, reset expiry, stale/unknown fail-closed behavior,
  REST/GraphQL independence, manual priority without bypass, and Security's
  six-call reservation.
- A closed-loop simulation covers 1, 3, 7, 12, and 20 leases; mixed active tabs;
  pane join/leave; external spend bursts; and a full reset. gh-glance grants do
  not enter either resource reserve.
- A real 12-process worker test shares one temporary account/host scope and
  proves one probe owner, no lost state, bounded concurrent grants, round-robin
  progress, startup/reset spreading, and no all-tab burst.
- Crash tests kill a lease, probe owner, and request owner. Probe ownership
  recovers, unstarted work is reclaimed, and started reservations remain
  conservative until a clean probe.
- A suspended live lock owner is never recovered or replaced. Dead-owner
  recovery atomically quarantines the old lock, and unlock cannot remove a
  successor's lock.
- Scope tests prove same account+host coordination and different account/host
  isolation. Governor state is versioned, bounded, atomic, private, and contains
  no raw credential, host, login, repo, cwd, title, or PID. Ephemeral private
  lock metadata contains only PID and nonce.
- With `core={limit:5000,used:5000,remaining:0}`, the budget probe precedes all
  data calls and there are zero Actions/Security calls before reset. Pressing
  `r` causes at most a coalesced probe and no unsafe data call.
- With core held and GraphQL open, Issues and pull requests continue. The inverse
  case blocks GraphQL tabs without blocking safe REST tabs.
- Open-item, failure-context, and doctor endpoint commands have declared costs
  and skip quota-consuming work when an immediate safe grant is unavailable.
- A reset sequence requires a new shared probe and resumes active requests in
  phased order. Background requests do not burst at startup or reset.
- A returned rate-limit error creates a shared resource block; twelve panes do
  not retry together every 60 seconds.
- Cached rows, live errors, protective pause, and stale age coexist. Healthy
  single-pane five-second behavior and last-good cache semantics do not regress.
- Corrupt, locked, or unwritable governor state shows Paused with an actionable
  local coordination error and makes zero data calls.
- PTY captures cover Watching, admitted Checking, Waiting, Paused, Failed,
  Limited, Setup, manual animation, quiet automatic operation, no animation,
  no color, ASCII icons, screen-reader policy, tab switching, and
  80/60/45/24-column layout.
- Terminal captures retain one footer, one blank physical guard row, bounded
  width, and usable Refresh/Quit controls.
- Sequential verification passes:

  ```bash
  npm run lint
  npm test
  node --check index.mjs
  npm run test:pty
  git diff --check
  ```

### Manual

- Start 12 real panes with one account and host. Confirm only one shared budget
  probe per control window, active checks make fair progress, background checks
  are spread, and the footer never looks inert.
- Leave the panes open for at least 20 minutes and across one GitHub reset. For
  gh-glance-attributed spend, REST and GraphQL remain outside their 20% reserves;
  no synchronized reset or retry burst occurs.
- While REST is paused, switch to Issues and refresh. GraphQL data still checks.
  Switch back to Actions and press `r`; the pane gives immediate Waiting/Paused
  feedback and does not send an unsafe REST request.
- Repeat one pane with `GH_GLANCE_NO_ANIMATION=1` and `NO_COLOR=1`. The words and
  symbols alone explain the state, and there is no permanent footer motion.
- Run `--doctor` during coordination. It reports resource budgets and governor
  health without exposing account or token material.

## Risks and controls

- **False global guarantee.** Document the exact admission guarantee and the
  limits of controlling unrelated consumers or separate local config scopes.
- **Lock contention.** Keep lock sections synchronous and small, run subprocesses
  outside the lock, never steal from a live PID, quarantine dead locks atomically,
  and deny rather than fail open.
- **Crash leaks capacity.** Reclaim only unstarted work from expired leases;
  preserve started reservations until a fresh probe accounts for them.
- **Clock and reset skew.** Validate timestamps, use reset grace, require a fresh
  post-reset sample, and use a new epoch for all future grants.
- **Fairness starvation.** Schedule priorities explicitly and round-robin equal
  priorities across live leases; prove eventual active checks in 12 processes.
- **Background starvation.** Background work yields first under pressure but is
  not silently healthy: its freshness continues to age and its next eligibility
  is observable when selected.
- **Credential scope drift.** Re-evaluate the auth namespace on heartbeat; a new
  scope starts closed until it obtains a fresh budget.
- **Terminal churn.** Animate only admitted startup/manual work. Waiting, Paused,
  and automatic adapted checks are static and request-boundary driven.
- **Cache coupling.** Keep governor state in a separate file and preserve the
  existing dashboard cache format and last-good merge semantics.

## Out of scope

- Controlling the quota use of unrelated `gh`, Git, IDE, or agent processes.
- A cross-machine coordinator or a literal global quota reservation guarantee.
- A daemon, network service, GitHub App, webhook receiver, or new dependency.
- Combining independent tab fetchers or reversing ADR 0001.
- Conditional REST requests, ETags, or replacing `gh run list`.
- A per-second countdown or permanent animation.

## Open questions

None. The plan selects a hard per-resource reserve, a private account-and-host
governor, atomic fair grants, independent budget control, staggered polling, and
truthful footer states.
