# 5. Keep optional collection explicit, provider-fenced, and SSH-carried remotely

Date: 2026-09-05
Status: Accepted

## Context

File-backed acquisition already prevents duplicate producers on one machine,
but every dashboard process still owns identity, scheduling, and transport.
Users with many panes need an optional long-lived owner without making hosted
infrastructure, a GitHub App, or remote access part of default startup.

## Decision

Keep standalone mode as the default. An explicit `--serve --config <path>` runs
the existing acquisition and governor machinery as a foreground collector.
`--connect local` makes a normal terminal dashboard a data-only client, and
`--collector-stdio` is a narrow bridge to an already running collector.
`--connect ssh:<alias>` may carry that same bridge through an existing SSH
configuration. Service installation, daemonization, and GitHub App providers
remain outside this decision.

Use one fixed Unix-domain socket in the current OS user's private gh-glance
config root. Support macOS and Linux. Reject collector and bridge modes on
Windows rather than opening TCP. Require a private, versioned JSON configuration
whose exact host/repository targets map to named `gh` providers. Textual, known,
and newly discovered canonical aliases cannot cross provider ownership. Clients
select an allowlisted target but never select a provider or submit credentials.

Protocol version 1 is bounded newline JSON. Frames are at most 1 MiB. Large
snapshots use ordered, digest-checked parts no larger than 512 KiB and assemble
to at most 8 MiB within ten seconds. Per-client outbound queues are limited to
64 frames and 4 MiB, with 64 MiB across the service. Large snapshots stream one
part at a time; a stalled client is disconnected without holding other clients
or acquisition publication. A restart changes the server epoch, and generations
are monotonic only inside that epoch.

Wire snapshots contain sanitized display rows, pagination, source success and
change timestamps, and semantic holds. They exclude credentials, private
digests, local paths, provider details, validators, raw response bodies, and
quota state. The server owns identity, admission, request accounting, and shared
acquisition. A local client never falls back to GitHub polling when disconnected.

The SSH command and its argument vector are fixed. Only a restricted SSH config
alias is variable; repository and row data never reach a remote shell string.
Batch mode is mandatory, forwarding and agent forwarding are disabled, and host-key policy remains the
user's SSH policy. The child environment is allowlisted and excludes local
GitHub credentials and config roots. A client owns and cancels only its SSH
child, not the collector.

Remote receipt does not create source freshness. Snapshot transport carries
collector wall time, and the client persists a monotonic source-age lower bound
with the original source timestamps, server epoch, and client checkpoint under
a collector/target namespace. Reconnect and clock skew cannot make an old
observation younger. A disconnect preserves rows, reports the connection hold,
and follows a capped reconnect ladder without local acquisition fallback.

## Consequences

One OS user is the trust boundary. A collector is not a multi-tenant service.
Configuration or provider changes require restart and a new epoch. Existing
standalone processes using the same config root can join collector acquisitions
without starting another query generation. A service with no subscribers makes
no data poll, while bounded last-known-good snapshots remain available for a
later subscriber. Cross-computer operation depends on user-managed SSH and an
already running collector; the SSH path adds no TCP listener or hosted service.
The opt-in loopback webhook ingress below is the sole HTTP exception.

The same explicit collector configuration may enable one loopback-only HTTP
webhook route behind a user-managed HTTPS reverse proxy. The exact raw body is
HMAC-authenticated before parsing. Request buffering is bounded per body and
across all concurrent bodies. Durable state contains bounded delivery IDs
and compact invalidation keys, never event bodies or signatures. A delivery
marks a covered query dirty but supplies neither rows nor freshness: the worker
uses ordinary shared governor admission, and durable work completes only after
a newer API-validated generation publishes. Quiet covered resources reconcile
at `max(floor, 300 seconds)`, while running Actions and manual refresh retain
their ordinary behavior. Access-change events retire old bindings and require
repository-access validation before new publication. The listener does not
register hooks, expose a public client API, or introduce another dashboard
transport.

An optional `github-app` provider is now also inside this boundary. Provider
configuration contains a validated host/client/installation tuple, an absolute
private-key file, explicit repository IDs, and read-only permissions. The
collector alone signs and mints; clients still select only allowlisted targets
and cannot request authentication, choose a provider, or supply credentials.
Repository API work remains on `gh api` with a scrubbed per-child token
environment. The fixed native HTTPS installation-token request is an
authentication adapter, not a second data transport. It follows no redirects,
uses normal TLS verification, and has bounded time and response size.

App tokens remain in memory and never cross the socket or SSH protocol.
Authentication or permission failure retains stale rows and cannot activate the
personal-login provider. Optional Security permissions are enforced per source,
so a missing capability cannot become a false empty result. Installation
deletion, suspension, and repository removal webhook events must match the
configured installation before they advance the authority fence.
