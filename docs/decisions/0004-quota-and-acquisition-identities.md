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
