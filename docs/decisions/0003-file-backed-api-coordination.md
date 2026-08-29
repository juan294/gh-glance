# 3. Coordinate API admission through a private local file

Date: 2026-08-18
Status: Accepted

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

The existing 0.8 policy now defines a hard reserve independently for REST
`core` and GraphQL:

```text
reserve = ceil(limit * (1 - BUDGET_SAFETY))
spendable = max(0, remaining - reserve - chargedReservations)
```

For a 5,000-call resource, the reserve is 1,000. Every quota-consuming
operation has one declared worst-case vector cost. Under the governor lock, an
intent can receive a grant only when a fresh observation can pay that cost
without entering the resource reserve. A grant becomes a conservative
reservation and is revalidated immediately before its `gh` process starts.

The exact enforceable guarantee is:

> gh-glance starts no data request for a rate resource when its latest fresh,
> conservatively debited observation cannot cover the request without entering
> that resource's hard reserve.

Manual refresh, tab changes, item opening, failure context, and diagnostic
probes use the same admission rule as automatic polling. Manual work has higher
queue priority, but it cannot bypass a held budget. Local version,
authentication, and Git inspection do not need a quota grant. The GraphQL
observer uses the free `rate_limit` endpoint. Core has one explicit
control-plane exception: one shared claimant can make a bounded `GET /user`
bootstrap request before an authoritative core observation exists. Its first
200 response can cost one unit and records that unit immediately. Later core
observations are conditional and a matching 304 costs zero.

Only a claimed observer can establish or change a resource epoch: conditional
`GET /user` owns core and `rate_limit` owns GraphQL. Endpoint response headers
can refine an absolute counter only when their full `(limit, reset)` epoch
matches the persisted observer epoch. A cached or endpoint-specific header from
another epoch is ignored and its request cost stays conservatively reserved.

## Protocol and recovery

The governor state records resource epochs and observations, fair lane cursors,
leases, pending intents, reservations, shared probe ownership and outcomes,
manual probe demand, rate-limit blocks, and a conservative external-spend
factor. REST and GraphQL are scheduled separately, so a held REST resource does
not stop Issues or Pull Requests from using healthy GraphQL capacity.

A short synchronous lock section validates and atomically writes each state
transition. One process owns the split budget observation claim while the
others wait for publication. It reads GraphQL only from `rate_limit` and core
only from response headers or conditional `/user`; `rate_limit` core data is
never admission evidence. Pending work is ordered by manual/diagnostic, tab-switch, active,
then background priority, with round-robin progress among equal-priority live
leases. Stable per-lease phases spread startup and reset work. There is no
60-second maximum wait: a request waits until its computed safe `notBefore`, or
the resource pauses when one request cannot be paid safely.

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
The token-wide probe measures that external use and reduces later lane capacity,
but GitHub provides no atomic global quota-reservation API. The reserve is
therefore a guarantee about gh-glance's own admissions from fresh local
evidence, not a promise that the account-wide counter can never cross it.

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
