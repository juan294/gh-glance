# 4. Separate quota identity from private-data authorization

Date: 2026-09-05
Status: Accepted

## Context

The original coordination scope hashed configuration paths and every supported
token environment variable. Equal effective credentials could receive separate
ledgers because of irrelevant environment or configuration differences. Two
tokens for one GitHub user also spent from the same remote quota while their
local ledgers admitted independently. Conversely, sharing private rows solely
by account ID would cross credential permissions.

## Decision

Resolve the effective credential using `gh`'s host-specific environment
precedence. Without an applicable environment token, use the local
`gh auth token --hostname` command through a dedicated non-logging seam. Hash
the captured value immediately, discard raw references, and cache resolution
until relevant configuration changes. Do not inspect keychain databases,
change login configuration, or put credential bytes in arguments, files, logs,
errors, or UI state.

An authenticated, admitted `/user` response establishes the user principal from
its numeric ID and authoritative core evidence. A private registry maps the
credential digest to that verified identity. Quota keys hash effective host,
principal kind and principal ID. Access keys hash the effective credential and
authorization generation. Tokens verified as one user share quota but retain
separate private-data partitions. Hosts and principal kinds remain distinct.
Token prefixes are never identity evidence. Installation identities require a
separate provider and are not inferred from user credentials.

The `coordination-v2` directory contains a private registry and separate quota
ledgers. Registry transactions serialize identity mappings, migration and
bootstrap receipts; lock ordering is registry before quota ledger. No network
request runs while either lock is held. Quota ledgers contain protocol data;
the separate registry may contain verified host, numeric ID and sanitized login.
Directories use `0700` and files use `0600` on POSIX, with atomic replacement
and nonce-checked lock ownership.

Unknown identity requires a persisted bootstrap claim before its subprocess
starts. Allow at most three attempts per credential/resource and twelve
unknown-principal attempts per host in a rolling fifteen-minute window. Retry
starts no sooner than sixty seconds with exponential delay, subject to actual
reset and shared secondary holds. Crashes, malformed responses, manual refresh
and restarted panes do not replenish this allowance. Each started control
attempt retains a worst-case unit of debt until authoritative reconciliation
or its applicable reset. Identity proof transfers the same history to the quota
principal exactly once; mapping cannot reset the allowance.

The per-host cap bounds reserve-bypassing control attempts per host whether or
not the principal is known: a verified principal whose core budget is unknown or
already past its reset makes an exceptional attempt too, and that attempt draws
on the same host allowance. The cap is therefore stricter than "unknown
principals only", which is the safe direction.

Retirement is bounded in both directions. An attempt that never proved a
principal owns no ledger receipt, so once its rolling window and its own backoff
have both passed there is nothing left to reconcile and the record is dropped;
without that the registry fills to its hard attempt cap behind a captive portal
or an SSO-blocked org and refuses every later bootstrap permanently. An attempt
that was mapped but never obtained reset evidence is retired once a full primary
window has demonstrably elapsed since it started, which is the "applicable
window reset" branch rather than a forgiveness of unproven debt.

`authorizationGeneration` is persisted and validated but nothing increments it
today, so an access scope is currently a function of the effective credential
alone. A token rotation changes the credential digest and repartitions retained
rows on its own; an authorization change on an unchanged token does not. Phase 2
defines no re-verification cadence, so this is recorded as a known limit rather
than left to look like an implemented control.

All current HTTP operations use a shared permit, one at a time with at least
250 ms between starts. At most 128 transport waiters per host retain FIFO
order during that gap, so a later request cannot win a polling race against
earlier admitted work. Waiters contain only process ownership, nonce and timing
data; dead or expired waiters are pruned, and cancellation removes only the
matching nonce. Bootstrap yields to live queued requests. Persisted cooldown
deadlines merge by maximum. Each
actual call obtains its own permit; an outer fetch batch cannot retain a permit
while waiting for nested calls. Existing porcelain commands remain bounded
legacy operations until explicit endpoint acquisition replaces them.

Credential changes cancel work that has not started and fence old data
completion. Started work settles in the original ledger even when its rows can
no longer be published. Authentication failure context uses a cached verified
identity or an honest unavailable state and starts no `gh auth status` request.

## Controlled migration

The new namespace cannot activate while a discoverable legacy lease is live.
The UI asks the user to stop and restart old panes; migration never kills them
or deletes evidence. Once leases stop, old started or uncertain costs and
cooldowns must be accounted for or held through the affected reset. Missing
authoritative coverage cannot become an empty new budget. Corrupt and unknown
legacy schemas fail closed. A root migration transaction prevents concurrent
new panes from independently bootstrapping empty scopes.

Legacy files are preserved and rechecked during operation. Reappearing live
leases pause admission. This only covers the discoverable configuration root:
old binaries do not read the new protocol, and panes in other roots or machines
cannot share its locks. Users must stop old panes during upgrade. No sentinel
can provide a mixed-version guarantee against arbitrary old binaries started
later.

## Consequences

Quota coordination no longer fragments on an unused environment variable or
an equivalent local configuration path. Private data remains credential-scoped.
An identity failure leaves data unavailable rather than guessing an account.
Migration may wait for a real rate-limit reset, and damaged coordination needs
investigation rather than automatic state deletion. The independent fixture
oracle, pinned legacy protocol fixture and identity scenarios verify these
boundaries without network credentials.

## Amendment: explicit GraphQL requests (phase 3)

Issues and pull requests are fetched with fixed, versioned GraphQL documents
carrying typed variables on stdin, replacing `gh issue list` / `gh pr list`.
The porcelain was not merely opaque: its `--search sort:updated-desc` routed the
call through GraphQL at a price nothing in this codebase could name, so the
budget was debited by a number that had been measured once by hand and written
down. The documents are separate per resource on purpose -- one document with
two connections cannot publish either tab until both halves resolve, which is a
completion barrier, not an optimisation.

The document travels on stdin rather than in argv, so a query never appears in
`ps` output or in an error string, and its size is bounded by a pipe rather than
by the platform argument limit.

Each page declares a conservative two-point bound and each observer one point.
An actual cost above its bound is recorded at its real value and pauses that
operation for reconciliation; it is never clamped to the bound, because a clamp
would under-charge the ledger precisely when the estimate was wrong. Absent cost
evidence never refunds: an unobserved page keeps its conservative reservation.

A GraphQL response can be HTTP 200 and still be a refusal, carrying `errors` and
no data, or partial data alongside errors. Headers and envelope are therefore
settled separately. Budget evidence from such a response is ingested; its rows
are not published. Treating a refusal as a successful empty page would render
"no open issues" for a repository that has plenty.

Pages past the first reserve their own envelope. A denial there is an ordinary
scheduling outcome: the rows already gathered stay, and the result is marked
incomplete rather than published as complete. Losing page one because page two
was refused would turn a budget decision into data loss.

Opening a row's page spends nothing. `gh <kind> view --web` spent a request to
be told a URL the app was already holding, and then had to refuse the user the
page when the budget was tight. Issues and pull requests select their `url`;
a run's page is derived from the repository and its databaseId. Every URL is
admitted before use -- https only, and only the host this pane is talking to --
because a row is remote data, and an unadmitted `url` would let a crafted row
point the user's browser anywhere or hand a `file:` URL to the platform opener.

## Amendment: shared acquisition ownership (phase 6)

The access identity now also partitions a private, file-backed acquisition
store. Query identity includes host, admitted repository identity, resource,
projection version, filters, page size, and cursor generation. Equivalent
explicit and inferred repository names converge on the same conservative slug
identity until admitted GitHub evidence provides a stable database ID; an
unresolved alias is never guessed across targets.

Each due query generation has one producer claim, identified by PID, nonce and
generation. Claims live for 45 seconds and are heartbeated every ten seconds.
Expiry is necessary but not sufficient for takeover: the local PID must also be
confirmed dead. An inaccessible or suspended process retains ownership, while
an explicit cancellation releases it. Publication checks nonce, generation and
access partition, so an old completion cannot overwrite newer evidence.

Claiming, governor admission, transport, settlement, and publication are
separate operations. The acquisition lock is never held across GitHub I/O, and
only the producer obtains and settles the quota reservation. Followers inspect
generation metadata at most once per second, adopt validated snapshots, and do
not fall back to their own request when coordination is busy or unwritable.

The coordination file contains lightweight claim, subscription, generation and
bounded-digest metadata. Sanitized parsed rows and each validator with the
bounded validated body it governs live in private per-query artifacts. The
artifact is complete before an atomic coordination-file replacement publishes
its reference; followers inspect only metadata until the generation changes.
A 304 advances `lastSuccessAt` while preserving `lastChangedAt`; a changed
representation advances both. Persisted quota headers are not replayed.
Storage is capped at 32 MiB total, 1 MiB per entity, 512 entities, 32 live
targets, and 128 subscriptions. Active targets are pinned and inactive
least-recently-used generations are evicted first.

## Amendment: GitHub App installation identities (phase 11)

An explicitly configured collector provider may establish an installation
principal by minting a repository-restricted installation token at the exact
configured App installation endpoint. Its quota key binds host, principal kind
`installation`, and installation ID. Its access key additionally binds provider
name, the sorted repository and permission restrictions, and authorization
generation. Equivalent token renewal does not split either identity; changed
authority fences retained data without changing the installation's quota
ledger. Installation core authority comes from conditional
`/installation/repositories?per_page=1` observations under the installation
token. `/user` remains exclusive to human identity proof.

JWT signing and mint attempts have their own persisted rolling allowance and
redacted control metrics. Token-mint response headers do not establish data
quota authority. Started attempts survive collector restart, concurrent callers
share one refresh, and a durable PID/nonce lease fences abandoned owners. The
authorization generation and mint revision are persisted independently of the
memory-only token, so a late response cannot cross a repository or permission
change. The bounded 60/120/240/480-second retry ladder cannot be replenished by
token rotation. Private keys, JWTs, and tokens are excluded from the registry
and quota ledgers.

## Amendment: sustained acceptance evidence (phase 12)

Release acceptance exercises these identity and accounting decisions for one
simulated hour through the production acquisition engine and governor with an
injected clock and transport. The independent request oracle, not production
cost declarations, owns server counters and scripted 200/304, GraphQL, external
spend, reset, secondary-hold, producer-loss, and account-switch evidence. The
accelerated workload is paired with real process, lock, IPC, bridge, and PTY
tests so injected time cannot stand in for ownership or lifecycle behavior.

Correctness is a fixed gate: one producer per due canonical query, independent
fair progress for distinct repositories, no client-side GitHub work in remote
mode, no stale-generation publication across an access change, and no admitted
data crossing the known reserve. CPU, RSS, and latency percentages are evidence,
not universal thresholds. They may be compared only when baseline and candidate
share the same workload, machine, platform, and runtime; otherwise the report
names the incompatibility and makes no improvement claim.
