# 5. Keep optional collection local, explicit, and provider-fenced

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
`--collector-stdio` is a narrow bridge to an already running collector. Service
installation, daemonization, SSH, webhooks, and GitHub App providers are outside
this decision.

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

## Consequences

One OS user is the trust boundary. A collector is not a multi-tenant service.
Configuration or provider changes require restart and a new epoch. Existing
standalone processes using the same config root can join collector acquisitions
without starting another query generation. A service with no subscribers makes
no data poll, while bounded last-known-good snapshots remain available for a
later subscriber.
