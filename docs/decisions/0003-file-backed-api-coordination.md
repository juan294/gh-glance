# 3. Coordinate API admission through a private local file

Date: 2026-08-18
Status: Accepted

Amended 2026-09-05 by [ADR 0004](0004-quota-and-acquisition-identities.md):
the new namespace uses verified quota principals and separate authorization
identities. Transition requires stopping discoverable legacy panes and
preserving old uncertain charges and holds. Legacy files remain evidence;
corrupt or unknown schemas fail closed. Reappearing discoverable legacy leases
pause new admission. This is a controlled restart boundary, not a mixed-version
guarantee: an old binary launched later or using another configuration root
cannot be forced to participate in a protocol it does not read. Descriptions
below of the original authentication fingerprint record the initial design
and are superseded by ADR 0004.

## Context

Seven panes were observed consuming about 142 REST calls per minute. The shared
GitHub `core` counter reached `5000/5000` and stayed exhausted for the rest of
the window. A later live sample showed `core` at 5,000 used with zero remaining,
while the independent GraphQL resource still had 4,248 of 5,000 remaining.
Other programs using the same credentials can contribute to these counters, so
the observation does not assign every call to gh-glance. It does prove that the
released controller did not preserve useful REST capacity.

The old controller treated `BUDGET_SAFETY = 0.8` as a multiplier on the rate
that remained. That slowed each process as the counter fell, but it did not keep
20% of the limit unused. It also inferred external use only after GitHub
reported it. This delayed feedback could react to spend, but it could not stop
several panes from admitting the same startup, reset, manual, or retry work at
the same time. When remaining capacity reached zero, the old 60-second clamp
still permitted attempts. Slower unsafe requests were still unsafe requests.

## Decision

gh-glance uses a versioned, private, file-backed governor for every effective
GitHub host and account namespace. It coordinates local panes before a data
subprocess starts. It is not a daemon and adds no service or dependency.

The existing 0.8 policy defines a reserve independently for REST `core` and
GraphQL:

```text
reserve = ceil(limit * (1 - BUDGET_SAFETY))
spendable = max(0, remaining - reserve - chargedReservations)
```

For a 5,000-call resource, the reserve is 1,000. Every quota-consuming
operation has one declared worst-case vector cost. Under the governor lock, an
intent can receive a grant only when a fresh observation can pay that cost
without entering the resource reserve. A grant becomes a conservative
reservation and is revalidated immediately before its `gh` process starts.

For REST `core`, response headers close the feedback loop. Its exact enforceable
guarantee is:

> gh-glance starts no core data request when its latest fresh, conservatively
> debited authoritative observation cannot cover the request without entering
> the core hard reserve.

GraphQL does not currently have the same guarantee. The porcelain `gh issue`
and `gh pr` commands do not expose their response rate-limit headers, and the
free `rate_limit` endpoint has been observed reporting a constant GraphQL
counter while real GraphQL response headers increased. The governor still
fails closed when that probe is missing or stale and paces declared local
GraphQL costs, but its GraphQL counter is open-loop and cannot prove the
account-wide reserve. Closing this loop requires a separately designed
response-header observation path.

Manual refresh, tab changes, item opening, failure context, and diagnostic
probes use the same admission rule as automatic polling. Manual work has higher
queue priority, but it cannot bypass a held budget. Local version,
authentication, and Git inspection do not need a quota grant. The GraphQL
observer uses the free `rate_limit` endpoint as its currently available, but
non-authoritative, counter input. Core has one explicit
control-plane exception: one shared claimant can make a bounded `GET /user`
bootstrap request before an authoritative core observation exists. Its first
200 response can cost one unit and records that unit immediately. Later core
observations are conditional and a matching 304 costs zero.

Only a claimed observer can establish or change a resource epoch: conditional
`GET /user` owns core and `rate_limit` owns the local GraphQL probe epoch. That
protocol ownership does not make the GraphQL counter authoritative. Endpoint
response headers can refine an absolute counter only when their full
`(limit, reset)` epoch matches the persisted observer epoch. A cached or
endpoint-specific header from another epoch is ignored and its request cost
stays conservatively reserved.

## Protocol and recovery

The governor state records resource epochs and observations, fair lane cursors,
leases, pending intents, reservations, shared probe ownership and outcomes,
manual probe demand, rate-limit blocks, and a conservative external-spend
factor. REST and GraphQL are scheduled separately, so a held REST resource does
not stop Issues or Pull Requests when the current GraphQL probe permits them.

A short synchronous lock section validates and atomically writes each state
transition. Each resource has its own observer claim: one process owns core's
and one owns GraphQL's, and the others wait for that resource's publication.
Core is read from response headers or a conditional `/user`; GraphQL from a
claimed observer that selects only the meter and reports what it cost.
`rate_limit` is not admission evidence for either resource. Pending work is ordered by
manual/diagnostic, tab-switch, active, then background priority, with
round-robin progress among equal-priority live leases. Stable per-lease phases
spread startup and reset work. There is no 60-second maximum wait: a request
waits until its computed safe `notBefore`, or the resource pauses when one
request cannot be paid safely.

The state file is replaced atomically. The lock contains only a PID and random
nonce. A live or suspended owner is never stolen; a PID-confirmed dead owner is
recovered through nonce-checked quarantine. Expired leases release only work
that is known not to have started. Started, timed-out, signalled, aborted, or
process-lost reservations remain charged until completion evidence and a later
clean probe can account for them. A missing file is initialized while holding
the lock. Corrupt, stale, locked, or unwritable governor state denies calls
instead of falling back to independent polling.

## Scope and privacy

The file name contains a SHA-256 hash of the normalized effective host and the
existing local authentication namespace. The state contains no token, raw host,
login, repository, working directory, title, or other dashboard row data. The
canonical state, lock, recovery marker, quarantine file, and temporary files
are created with mode `0600`; their parent configuration directory is `0700` on
POSIX systems.

The host is resolved once for both API routing and coordination. An explicit
qualified `--repo` supplies its host; an explicit unqualified `--repo` means
`github.com` and wins over environment defaults. Otherwise gh-glance uses
`GH_HOST`, then `GH_REPO`, then one unambiguous host from all local remotes.
Running panes re-evaluate the account namespace and migrate to a newly selected
scope before receiving another grant.

The local scope is the boundary of the guarantee. An unrelated program can
spend after the latest probe, a process using a different local configuration
scope cannot share the file, and another machine cannot take the local lock.
The token-wide core observer measures that external use and reduces later lane
capacity, but GitHub provides no atomic global quota-reservation API. The core
reserve is therefore a guarantee about gh-glance's own admissions from fresh
local authoritative evidence, not a promise that the account-wide counter can
never cross it. GraphQL remains weaker: without authoritative response
counters, even that local-admission guarantee cannot be tied to the real
GraphQL remaining value.

## Alternatives considered

- **Process-local hard reserve:** rejected because several panes can all admit
  against the same observation before any of them reports its spend.
- **Token-counter inference alone:** retained as an external-spend signal, but
  rejected as the admission mechanism because it is delayed feedback.
- **Local daemon or socket broker:** rejected because it adds installation,
  lifecycle, compatibility, and crash-recovery work that a small locked file
  avoids.
- **Network coordinator, GitHub App, or webhook service:** out of scope. These
  would change the product and authentication model.
- **A 60-second pacing clamp:** removed because presentation convenience cannot
  override the safe interval calculated from remaining capacity and reset time.

## Consequences

- Startup and reset require one shared fresh probe before data work, then phase
  active panes instead of releasing a herd.
- One rotating background tab is considered at a time. Background work yields
  before active work under pressure and becomes visibly stale if it cannot run.
- The dashboard cache and governor remain separate. The cache is last-good UI
  recovery data and can be ignored when unavailable; the governor is admission
  authority and fails closed.
- `--doctor` uses the same split observer, reports the winning redacted source,
  and admits or skips each quota-consuming diagnostic through the same policy.
- ADR 0001's independent `gh` fetchers remain intact. Each can still commit as
  soon as it finishes; the governor controls only whether and when it may start.
- ADR 0002's explicit terminal lifecycle remains intact. The controller uses
  independent one-shot control, data, and heartbeat timers, while the footer
  renders their semantic state without permanent animation or accumulated
  terminal lines.

## Amendment: GraphQL authority (phase 3)

`gh api rate_limit` is no longer a source of spendable GraphQL capacity. It is
retained as an explicitly non-authoritative diagnostic, reported and labelled as
such, and a budget observation it produced can never be published as authority.

Spendable GraphQL capacity now comes from a claimed observer that selects
`rateLimit { cost limit used remaining resetAt }` and nothing else. The reason is
not tidiness: `/rate_limit` is a different endpoint's view of the meter, it can
lag behind the spend it is meant to bound, and it can never say what a
particular query cost. The observer costs one point and reports exactly what it
cost, which is what makes it reconcilable against the ledger. A counter obtained
for free is not authority; it is a rumour with a number in it.

Provenance is recorded accordingly. A GraphQL budget written by the observer
carries `graphql-observer`. `rate-limit-probe` remains *readable* so that a
ledger written before this change still parses, but nothing writes it, nothing
may admit work against it, and neither source may ever stand as core authority.
Migration from the v1 protocol therefore drops the GraphQL budget outright, as
it already dropped the core one: "never a source of spendable capacity" cannot
have an exception for numbers that happened to arrive before the rule existed.
The claimed observer re-establishes capacity on the next probe.

`GOVERNOR_STATE_VERSION` moves to 3 because of this provenance. An older build
does not recognise `graphql-observer` and would reject the budget -- and its
normalizer turns one rejected budget into total loss, discarding every live
pane's leases, intents and reservations. The version gate makes such a build
fail closed on the file instead, which is what a version gate is for. The
legacy inspector can still *read* the previous protocol, because recognising
that an older pane holds a live lease is exactly what the restart boundary
depends on.

Only a claimed observer opens a new epoch. A data page's counters constrain the
same epoch -- they are real evidence of spend -- but a page cannot declare a
reset, because an old or reordered response would otherwise appear to restore
capacity that was never restored.

Both observers are exempt from the data-admission recheck at the subprocess
boundary, for the reason that the control plane cannot be gated on the capacity
it exists to establish: a resource whose budget is unknown would otherwise
refuse the one request able to learn it. The exemption is from data admission
only. They remain bounded by the rolling attempt allowance, the shared transport
permit and the secondary cooldown, and every attempt is still charged.

## Amendment: per-resource observers and secondary throttles (phase 4)

Observer claims, readiness and outcomes are per resource. Core and GraphQL each
have their own claim; a slow or failed observer for one no longer holds up the
other's readiness, because nothing about the resources couples them. What still
couples them is the shared HTTP permit and any account-wide secondary hold, and
those are enforced where they belong rather than by serialising the observers.

`GOVERNOR_STATE_VERSION` moves to 4 because the *shape* changed rather than a
field's contents: `observers` and `probeClaims` are keyed by resource and
`probeOutcome` is gone. Versions 3 and 2 stay readable as evidence, but reading
them needs more than accepting an old version number — those files are in the
pre-split shape, and the legacy inspector adapts that shape before reading it.
Recognising that an older pane holds a live lease is what the restart boundary
depends on, so this is not optional.

One coupling is deliberate and survives: a core reset opens a new shared
accounting epoch, so the GraphQL counter is due with it. Independent claims make
that harder to state than it was, because a core publication moves core's reset
an hour out and any rule phrased in terms of that reset stops being true the
moment it fires. It is therefore phrased against the observation instead —
GraphQL is due at a core reset only until it has observed since that reset — and
stated in both places it is decided. Phrased in terms of the reset alone, one
refresh order produced no GraphQL observation at all and the other produced one
per pane.

Secondary limits are classified from evidence rather than inferred from a status
code. A permission-only 403 carries no rate-limit headers and no secondary
marker, and is not a throttle: treating it as one would hold the shared
transport for every pane over a single repository the user cannot read. Primary
exhaustion holds only its own resource until that resource's reset. A confirmed
secondary limit or a generic 429 holds the account.

A server-supplied `Retry-After`, in seconds or as an HTTP date, is honoured
exactly and is never shortened; holds merge by maximum, so a shorter concurrent
error cannot erode a longer one. Without a supplied deadline the client chooses
60, 120, 240, 480 then 900 seconds by consecutive throttle, and the 900-second
cap applies only to that locally chosen delay — never to a deadline the server
asked for, which may legitimately be hours. After five consecutive throttles the
transport stops choosing delays and waits for an explicit retry or a
reset-triggered recovery: continuing to climb keeps a wedged credential politely
hammering a limit it cannot satisfy. Only a request that returns without
throttle evidence clears the ladder — waiting out a deadline is what produced
the previous throttle.

These are conservative client-side limits. They do not promise immunity from
GitHub's secondary limits, which are undocumented and may change.
