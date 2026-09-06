# Phase 6: shared acquisition, validators, capabilities and retention

Parent: [complete plan](../2026-09-05-multi-instance-efficiency.md)  
Depends on: 5. Batch eligibility: no.

## Objective and files

Make duplicate local panes consumers of one acquisition stream and retain useful data across restarts. Extract the acquisition engine within `index.mjs`, keeping UI rendering and lifecycle separate. Replace process-local entity ownership (`index.mjs:1021`, `:7327`) and extend persistence (`index.mjs:5872`, `:5930`, `:6053`, `:6108`). Add `test/acquisition.test.mjs`, `test/fixtures/acquisition-worker.mjs`, `test/pty/shared-acquisition.test.mjs`; extend cache, runtime-remediation and fixture tests.

## Changes and pseudocode

```text
engine.subscribe(validated target/resource, access context, demand):
  resolve canonical repository alias through admitted evidence
  choose versioned canonical query/page key
  register subscriber lease and aggregate demand
  return stored validated snapshot immediately, preserving source timestamps

acquire(query):
  under private query lock: claim owner nonce + generation if due/unowned
  release lock
  owner obtains governor grant and fetches
  validate/sanitize representation
  under query lock: publish only if owner nonce/generation/access still current
  notify generation change; owner alone settles quota

follower:
  inspect bounded generation metadata at most once per second
  load changed snapshot only; never independently reserve that acquisition
```

Engine API is `subscribe`, `updateDemand`, `refresh`, `unsubscribe`, `inspect`, `close`; inputs/outputs are plain data and callbacks, with injected transport, clock and storage. No React hooks, terminal globals or cwd inference inside the engine after canonicalization. UI subscribes once and updates demand through refs, preserving the existing no-cancellation-on-resize behavior. The collector later reuses this engine unchanged.

Store parsed sanitized representations and an ETag/body pair in one atomic generation record. The persisted body is the validated bounded projection needed to reconstruct rows; no full raw advisory, token or unchecked terminal text. Keep query/projection version, access partition and timestamps with the pair. A 304 advances source lastSuccess only; content changes advance both clocks. Never replay persisted quota headers as a new observation.

Claim TTL is 45 seconds with heartbeat every ten seconds; a suspended live owner is not stolen by wall time alone. Expired claims require local PID-confirmed death or an explicit owner cancellation before takeover; nonces fence stale writes. The existing 30-second request timeout bounds healthy work. If PID status is indeterminate, deny takeover and show a coordination hold. Owner death after start retains uncertain quota in the governor; takeover does not refund it. Do not nest cache/query and governor locks across I/O; claim acquisition, quota admission, publication and settlement are separate idempotent steps with durable identifiers.

Aggregate active/quiet demand once per query, taking the most demanding eligible subscriber while applying governor fairness per distinct repository/query, not pane count. Share expiring unavailable-capability observations only within access partition, using the existing 1m/5m/30m/1h ladder. Authentication/permission failures remain distinct from a genuinely unavailable feature. A resynchronization invalidates one query generation, not unrelated consumers.

Implement the parent's 32-target/32-MiB/512-entity bounds and active pinning. Display-cache migration accepts old validated rows but cannot invent missing validators. Explicit and inferred names map to one admitted canonical repository identity; unresolved aliases remain conservative. Private directories/files and exact-path cleanup follow the existing persistence model.

## Automated acceptance

- `SHARE-01`: 12 duplicate panes create exactly one data request per due query generation; all receive it; quota is settled once.
- `SHARE-02`: ten repositories produce ten streams, and one slow repository does not hold unrelated publication; a stable 60-row Actions result serves short/tall panes.
- `SHARE-03`: explicit/inferred aliases deduplicate after canonical resolution; different hosts/access scopes/query versions/cursor generations do not mix.
- `SHARE-04`: full exit/restart displays cached rows and sends the paired ETag; 304 retains content and source time semantics.
- `SHARE-05`: owner crash before/after start, suspended owner, stale nonce, malformed payload, missing pair, partial Security blindness and unwritable store cannot poison data or refund uncertain cost.
- `SHARE-06`: ten live projects retain rows; cache pressure evicts inactive entries first; hard-cap rejection is bounded and causes no duplicate polling fallback.
- `SHARE-07`: subscribers joining/leaving/resizing/manual-refreshing do not create extra producers or cancel work still needed by another subscriber.
- `SHARE-08`: equal unchanged snapshots retain object/frame stability; no unsafe text, credentials or rate headers become new authority from disk.

Run parent gates sequentially; update `SECURITY.md` and ADR 0004 with storage limits and ownership semantics.

## Manual success criteria

None. Separate processes and private fixture directories exercise ownership and restart boundaries.

## Completion

- [ ] Shared engine/store, fencing, capability reuse and retention implemented.
- [ ] SHARE scenarios and parent local gates passed.
- [ ] Independent compliance/quality review complete; integrated locally; stop.
