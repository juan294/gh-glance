# Phase 8: optional local collector

Parent: [complete plan](../2026-09-05-multi-instance-efficiency.md)  
Depends on: 7. Batch eligibility: no.

## Objective and files

Host the existing acquisition engine as an explicitly started local broker. Change CLI/mode dispatch and engine hosting in `index.mjs` (`index.mjs:4334`, `:4533`, `:4631`); add `test/collector.test.mjs`, `test/collector-protocol.test.mjs`, `test/pty/collector.test.mjs`. Extend args/package-boundary/doctor tests. Add ADR 0005 and collector documentation to README/SECURITY; no runtime dependency or new production file.

## CLI and configuration

- `gh-glance --serve --config <path>` runs a foreground collector without TTY/Ink/alternate-screen setup. Configuration is strict versioned JSON, private by default, with named GitHub providers and exact host/repository target mappings.
- `gh-glance --connect local` runs a normal terminal dashboard subscribed to the current user's collector socket. `--repo` is required when local remote resolution is unavailable; local git discovery itself stays offline.
- `gh-glance --collector-stdio` is a narrow non-TTY bridge from stdin/stdout to the already running collector. It never starts a second collector or executes arbitrary input.

IPC has one fixed discovery path, `<gh-glance private config root>/collector-v1.sock`, with directory mode 0700 and socket mode 0600 on macOS/Linux. Serve, local client and stdio bridge use the same existing config-root resolution; this version has no custom socket option. For SSH, the remote bridge uses the remote OS user's normal config root, never the client's environment. Windows collector hosting/bridge modes are explicitly unsupported initially; reject them before opening any endpoint, retaining existing standalone behavior. Never fall back to a public unauthenticated TCP listener. Only the current OS-user trust boundary is supported, not multi-tenant hosting. No auto-daemonization, LaunchAgent/systemd installation or remote service startup.

Each configured target has exactly `{host, repo, provider}` after canonical alias resolution. A target maps to one named provider. Textual or already-known alias conflicts are rejected before network work. Newly discovered canonical alias conflicts are rejected before subscription/data acquisition; only admitted identity-resolution requests may precede that discovery. Such duplicate targets are configuration errors even if both credentials can access the repository. Clients cannot choose or override providers; their `(host,repo)` subscription selects the unique configured mapping. A provider/config change requires collector restart, new server epoch and access-generation validation. This removes credential guessing from wire/API behavior.

## Protocol and lifecycle

```text
client -> hello { protocolVersion:1 }
server -> welcome { protocolVersion:1, serverEpoch, capabilities }
client -> subscribe { id, host, repo, resource, demand }
client -> demand | refresh | unsubscribe | inspect { id, ...bounded fields }
server -> snapshot | hold | diagnostic | error { id, serverEpoch, generation, ... }
```

Use length-bounded newline JSON, max 1 MiB for the complete encoded frame. Small snapshots fit one frame; larger snapshots use `snapshot-begin`, indexed `snapshot-part`, and `snapshot-end` messages with one snapshot ID, source generation, total encoded length and digest. Limit encoded chunks to 512 KiB including JSON escaping, assembled snapshot to 8 MiB, assembly to ten seconds, and one pending assembly per subscription. Publish to the UI only after complete length/digest/schema validation; malformed/missing parts retain the last valid snapshot. A result exceeding 8 MiB produces an explicit bounded-result error rather than truncating rows silently.

Bound outbound queues to 64 frames and 4 MiB per client, with 64 MiB aggregate queued bytes. Stream parts with backpressure rather than enqueueing a whole large snapshot; disconnect a stalled client. Validate exact message types, sizes, repository syntax, configured allowlist and per-client subscriptions (max 64; global caps from parent). No arbitrary API paths, queries, CLI arguments, filesystem reads, provider creation or credential submission on the wire. Reject incompatible versions before subscription/API work.

Server owns credentials and engine subscriptions; bridge/client owns none of its quota work. Wire snapshot fields contain sanitized rows, pagination, source timestamps and semantic holds, but no local digests/paths. A server epoch changes at restart; a generation is monotonic within it. Clients reject out-of-order frames and only adopt a new epoch after a handshake/full snapshot.

```text
serve(config):
  validate config/permissions; obtain exclusive local service lock
  initialize same engine used by standalone
  accept only bounded protocol requests through allowlist
  publish independent resource snapshots
  on disconnect: remove that client's demand, retain other subscribers
  on signal: stop accepting; cancel unstarted work; account uncertain started work
             close engine, sockets and exact owned socket path; exit
```

No subscriber means no data polling; retain bounded snapshots for reconnect. Existing standalone panes on the collector machine can share the same acquisition root/provider partitions without creating another producer. Slow clients are disconnected after bounded backpressure; one cannot block other clients or engine publication. Serve/bridge diagnostics go to redacted stderr; stdout is protocol only. Rearrange entry initialization so modes do not run before required declarations or import Ink accidentally.

## Automated acceptance

- `COL-01`: local 12-client subscription produces one stream per query; zero client-side GitHub API requests; all source timestamps identical.
- `COL-02`: unknown repo/provider, arbitrary command/path, malformed/oversized frame and incompatible version cause zero GitHub requests.
- `COL-03`: slow consumer/backpressure cannot grow memory unbounded or delay other subscribers; unsubscribe only cancels unused demand.
- `COL-04`: duplicate collector startup fails safely; stale socket recovery requires dead-owner evidence; signals remove only owned artifacts.
- `COL-05`: collector/bridge work without TTY and no terminal escapes; normal dashboard still refuses non-TTY; packed CLI modes work with exports closed.
- `COL-06`: provider/access partitions remain distinct; standalone/collector users sharing a root produce no duplicate query generation.
- `COL-07`: textual/known-alias provider conflicts fail before network; newly discovered canonical conflicts fail before acquisition subscriptions/data fetches, allowing only admitted identity resolution. Fixed socket discovery is identical in serve/local/bridge modes and never takes paths from protocol input.
- `COL-08`: near-limit entities plus metadata/merged pages transfer through bounded chunks; incomplete/oversized/mismatched assemblies do not publish or freshen data; queue limits cover encoded bytes, not just row counts.

Run parent gates sequentially, including real local IPC tests. Document chosen platform behavior and test it with OS-specific CI-equivalent local environments before claiming support.

## Manual success criteria

None for local protocol correctness. OS service installation is outside this phase; the supported command runs in the foreground.

## Completion

- [ ] Foreground collector, private IPC and bounded protocol implemented.
- [ ] COL scenarios and parent local gates passed.
- [ ] Independent compliance/quality review complete; integrated locally; stop.
