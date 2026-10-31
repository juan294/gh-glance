# Verification A: collector targets, same-epoch reconnect, follower hydration, display clocks

Repository: /Users/juan/code/gh-glance at 2b21de9e2e228a07765e55d2f99801f448fed9ce (HEAD verified with `git rev-parse HEAD`). All line numbers refer to `index.mjs` at that commit unless a file is named. No repository file was changed and no test suite was run. Two throwaway reproductions were written under `/private/tmp/claude-501/-Users-juan-code-archy/bdf74263-0214-4fde-bf03-d21ba31a7a8e/scratchpad/glance-astra/repro-A/` and import exported functions from `index.mjs`.

Overlap: PC-06 and RT-05 describe the same defect (same lines, same mechanism, same fix). They are verified once below. PC-07's proposal and RT-04's suspend finding both interact with that defect; the interactions are noted in those sections.

## PC-01: Collector targets share a mutable repository scope

Verdict: CONFIRMED (static trace; no runtime reproduction of the race). Severity: high.

Evidence:
- `providerContexts` is keyed only by provider name: 10124 `const providerContexts = new Map();`, 10153 `let context = providerContexts.get(target.provider);`, 10181 `providerContexts.set(target.provider, context);`.
- Every `defaultResolve` call overwrites the shared object after an await: 10202-10213 `context.identity = identity; context.scope = { ...createQuotaScope(identity, ...), ..., repository: target.repo, ... }`.
- The config allows several targets on one provider: 7990-8002 only rejects a canonical alias owned by two providers or duplicated; up to 32 targets (7972).
- Every standalone-default poll re-resolves through the shared object: 10529-10531 `: !resolveProvider ? await defaultResolve(item.target, providerAbort.signal) : item.provider`, then 10534 `item.provider = refreshedProvider;` (the same shared object for all targets of that provider), then 10535 `await engine.refresh(...)`, then 10580 `requestIdentityStorage.run(item.provider.scope, produceBound)` reads the shared scope after that await.
- `defaultProduce` reads `context.scope` again after more awaits (10223 `await refreshProviderBudget`, 10231 `await awaitCollectorReservation`, which can wait for admission) and builds the fetch scope from it: 10270 `const transportScope = { ...context.scope, receiptCapability: ... }`, 10292 `requestIdentityStorage.run(transportScope, () => descriptor.fetch(...))`.
- The fetch picks the repository from that async-local scope: 1321-1324 `effectiveRuntimeRepository` uses `bound?.repository ?? runtime.repo`; 1361-1363 `apiPath` substitutes it into REST paths; 1183/1189 GraphQL variables default to it.
- `defaultTargetIdentity` has the same pattern: 10357 `await refreshProviderBudget(...)`, then 10365 `scope: context.scope` for the `repository` identity query. Its result is persisted by `admitCollectorCanonicalOwnership` at 10405.

Trigger: two configured targets A and B on provider P, default `defaultResolve` path (production; no `resolveProvider` injection). A's poll resolves (scope=A), then awaits `engine.refresh` or budget/admission; B's poll runs `defaultResolve` (scope=B) in that window; A resumes and fetches B's repository under A's claim and query. At startup, `resolveCollectorTarget` single-flights per `provider\0host\0repo` (10388-10390), so A and B initialize concurrently and can also cross in `defaultTargetIdentity`.

Detection after the fact: Actions (REST) results carry no `repositoryIdentity`, so 10600 `admitCanonical(item.target, produced.repositoryIdentity)` returns true for `undefined` (10427-10428), and 15308 skips identity admission. B's runs are published into A's query. For GraphQL tabs, `repositoryIdentity` is returned (2490) but both canonical keys belong to the same provider, so `admitCanonical` passes; `admitAcquisitionRepositoryIdentity` (14387-14440) would then treat A's query as a rename to B, write `aliases[A] = B.id` and merge or remap A's records. INFERRED from reading 14387-14440, not reproduced: the GraphQL case may be worse than the model states, because it can durably corrupt the alias table.

Tests: every runtime test in `test/collector.test.mjs` injects `resolveProvider` (521, 561, 598 and so on), which bypasses `defaultResolve`. The two-target test at 736-737 uses two different providers. No test covers two targets on one provider through the default path, so no test contradicts the claim.

Rationale and proposal: The mechanism is real and the trigger is ordinary (two repositories on one personal `gh` login, both polling every 5 s). The proposal is sound: keep the coordinator, lease ID, budget reader and quota identity per provider (createQuotaScope is keyed by identity, so per-target copies still share one ledger and governor), and return a per-target immutable scope object from resolution. Two cautions. First, `context.identity`, `credentialEnvironment` and `capabilities` are also overwritten in place (10184-10194), so the per-operation capture must cover them, and `onRetainedWait` (10248-10249) compares the shared `context.identity`. Second, the fix must also cover the outer async-local binding at 10580 and `defaultTargetIdentity`. No extra GitHub requests or quota cost result from the fix.

## PC-06 and RT-05 (duplicate): Same-epoch reconnect stays Disconnected until a newer generation arrives

Verdict: CONFIRMED (reproduced). Severity: medium.

Evidence:
- 11004 `if (!item || frame.serverEpoch !== serverEpoch || snapshot.generation <= item.generation) return;` runs before 11011-11015 `if (!ready) { ready = true; reconnectAttempt = 0; onReady(true); }`.
- On close: 11114-11119 `ready = false; if (wasReady) onReady(false);`. App clears its markers: 20379 `if (!ready) receivedSnapshots.clear();` and sets `collectorDisplayDecision({ connected: false, ... })`.
- On a same-epoch welcome: 11058-11063 `epochChanged` is false, so `resubscribe(false)` keeps `item.generation` (11035-11038 only reset on an epoch change).
- Server side: every subscribe creates a new runtime item (9907). `initialize` delivers the cached engine snapshot at its existing generation (10685-10686). A fresh follower poll delivers the same generation again (10537-10539). Only a producer publication raises the generation.
- In the default `on-demand` mode (227 `background: "on-demand"`), `collectorDemand` (20362-20367) gives every non-Actions tab `active: false, background: false`. While a non-Actions tab is selected, no subscription has demand, the server does not poll (10476, 10480), and no newer generation is produced.

Reproduction: `/private/tmp/claude-501/-Users-juan-code-archy/bdf74263-0214-4fde-bf03-d21ba31a7a8e/scratchpad/glance-astra/repro-A/same-epoch.mjs` uses the exported `createSshCollectorClient`. First connection: gen 5 gives `ready: [true]`. After a same-epoch reconnect and a gen-5 replay: `ready: [true, false]`, the socket is still writable, and the snapshot is not delivered.

Existing test: `test/ssh-transport.test.mjs:133-188` (SSH-03/04) sends gens 4, 5, 6 after a same-epoch reconnect. Readiness returns only because gen 6 arrives. The test never covers the case where only equal generations arrive, so it does not contradict the claim.

Narrowing: user action recovers it. A manual refresh or a tab switch calls `handle.refresh` (20434-20439). The server passes `force: manual` to the engine, which raises `requestedGeneration` above the record (15552-15555) and so produces a new generation. With active demand, recovery waits until the snapshot's `nextDueAt` (quiet cadence or, for webhook-covered queries, `WEBHOOK_RECONCILE_MS = 300_000` at 7719). "Indefinite" is therefore accurate only while the user is idle on a dormant on-demand view. Realistic same-epoch disconnects include an SSH child or network drop while the remote collector keeps running, a handshake timeout, and the server disconnecting a stalled client (ADR 0005 lines 36-37).

ADR check: ADR 0005 lines 35-36 require monotonic generations within an epoch and lines 51-56 require that reconnects not make old observations younger. The code is right to keep the generation fence. Making readiness depend on generation advancement is not stated in the ADR, and README.md:609-611 describes the disconnect as transient ("retries after a bounded ... ladder").

Proposal: sound. Accept a validated equal-generation, same-epoch snapshot as a readiness acknowledgement. The acknowledgement path must still restore App's `receivedSnapshots`/`hasSnapshot` (20379-20381, 20398), because a readiness-only callback would leave tabs without a snapshot marker. Keep rejecting lower generations and other epochs. Do not reset the source-age tracker from it except through `observe`, which is already conservative for the same observation (7783: `Math.max(elapsed, candidate)`). There is no interaction with quotas or the governor, and no client-side GitHub requests.

## PC-07: Collector followers repeatedly hydrate and transmit unchanged snapshots

Verdict: CONFIRMED for the mechanism. It is an optimization only: local CPU, file I/O and wire bytes, with no GitHub request cost. Severity: low.

Evidence:
- Sleep is capped at the floor: 10504 `Math.max(1, Math.min(delay, item.demand.floorMs))`. For a fresh follower, `retryIn = nextDueAt - now()` (10545) is reduced to `floorMs` (default `REFRESH_MS = 5000`, line 77).
- Each wake runs `defaultResolve` (10531), then `engine.refresh`. For a follower with a snapshot, `refresh` hydrates unconditionally: 15600-15604 `const loadedSnapshot = loadRecordSnapshot(record); ... claimed.value.snapshot = loadedSnapshot.value;`. The file-backed engine (10122, no `storage` passed) uses `readAcquisitionSnapshot` (15019-15020), which reads, checks length, computes SHA-256, parses and normalizes (14768-14775).
- The engine's own `deliver` dedupes by generation (15033), but the runtime then calls `deliverCollectorSnapshot(item, ownership.value.snapshot, ...)` without a generation check (10537-10539 → 10447-10455 `item.onSnapshot(snapshot)`). The server sends it on every wake (9910-9911 `sender.sendSnapshot(...)`). The client drops it only after frame assembly (11004).
- Each client subscription has its own runtime item and poll loop (9907, 10709-10716), so N subscribers to one query repeat the work N times.
- ADR 0004 lines 186-190: "followers inspect only metadata until the generation changes". The refresh path does not follow this. The model's citation is accurate.

Magnitude check: about 6 wakes per 30-s quiet observation and about 60 per 300-s webhook reconciliation interval (9198-9203, 7719). These figures match the code; the actual per-wake byte and CPU cost was not measured.

Proposal: mostly sound. Per-item suppression of repeat deliveries does not conflict with the PC-06 fix, because every new connection creates a new runtime item and `initialize` delivers once per item (10685-10686). The suppression key must include `bindingRevision`, so a rebind (10520-10527) re-delivers. A decoded-snapshot cache must be keyed by artifact digest plus query and generation, and must be byte-bounded. Also skip hydration in `refresh` when the caller already holds that generation. Each wake also runs `defaultResolve` (coordinator `refresh()`), which this item does not mention. That cost was not traced here.

## RT-04: Collector display clocks freeze during idle disconnects and omit suspend time

Verdict: CONFIRMED for the frozen display clock and the suspend omission; the model understates the first part. PARTIAL for the suspend part as a contract violation (see below). Severity: medium.

Evidence (App clock):
- `setNow` call sites are listed exhaustively by `grep -n "setNow("`: 18628 (Attention mode only, unavailable with `--connect` per 21240), 21620, 21668, 21719, 21766 (standalone poll and control wakes) and 21983-21984 (the `cached` status tick).
- The collector branch is inside the same effect (starting at 19602, ending at 21853) and returns at 20440-20446, before the standalone wake machinery is armed. So in collector mode `now` advances only while `semanticStatus.kind === "cached"` (21980). That status is produced only for on-demand non-Actions tabs (17441, 21971-21975).
- Rows use that state: 22214-22216 `e(tab.Row, { item, now, ... })`. 13038-13039 `finished = item.status === "completed" ? new Date(item.updatedAt) : now`. 13046/13059 `formatAge(new Date(item.updatedAt), now)`.
- Consequence: on the Actions tab in collector mode (never `cached`), running-run TIME and UPDATED ages are computed against the last `setNow`, which can be App mount time. A negative difference renders as "just now" (347-350). This is a stronger defect than the model states. It affects connected sessions, not only disconnected ones.
- Age label while disconnected: `sourceAgeMs` is computed during render with `performance.now()` (18884-18887). Nothing re-renders while disconnected: `onReady(false)` fires once (11117), and a failed reconnect without readiness does not fire again. The `Disconnected` status is not animated (17434 `status("disconnected", ..., false, ...)`). If no running Actions row drives the spinner, the age label stays frozen. Statically traced, not run.

Evidence (suspend):
- 7776-7777 `measuredAt = monotonicNow(); current = () => lowerBound + Math.max(0, monotonicNow() - measuredAt)`. 18886 also uses `performance.now()`. The code's own comment at 7463-7465 says `performance.now()` does not advance across suspend. That platform behavior (libuv hrtime on macOS and Linux) is INFERRED, not tested here.
- Reproduction: `/private/tmp/claude-501/-Users-juan-code-archy/bdf74263-0214-4fde-bf03-d21ba31a7a8e/scratchpad/glance-astra/repro-A/age-suspend.mjs` uses the exported `createCollectorSourceAgeTracker`. With an age of 10 s, one hour asleep and 1 s awake, `current()` returns 11000 when the true age is 3611000. The next accepted frame for the same observation corrects it to 3611000 through the server wall clock (7781-7783).
- Interaction: after a same-epoch reconnect, PC-06 rejects equal-generation frames at 11004 before `item.sourceAge.observe` (11007). The correction is therefore also delayed until a new generation arrives.

Contract check: ADR 0005 lines 51-56 promise a monotonic source-age *lower bound*. An age that omits the sleep is still a lower bound, so the suspend part does not literally break the ADR. The age is less tight, and the observation looks younger than it is during the gap. Plan D6 (plan lines 74-80) requires the cached-data age to be shown. It does not say "after sleep" explicitly. The model's "stuck-state table" citation was not checked. Severity rests on the frozen `now` in rows, which is a visible correctness defect in every collector session.

Proposal: sound. A display-only clock (coarse while idle, 1 s while running rows are visible) has no acquisition or quota interaction. It must never feed `lastSuccessAt`. For suspend, `max(monotonic elapsed, positive wall elapsed)` since the last checkpoint stays nondecreasing and conservative. Guard against a forward wall-clock step overstating age; that is acceptable because it only overstates staleness.
