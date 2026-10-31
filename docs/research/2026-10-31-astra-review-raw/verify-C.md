# Verify-C: adversarial verification of GPT-6 Astra items (gh-glance 2b21de9)

Repository: /Users/juan/code/gh-glance, HEAD 2b21de9e2e228a07765e55d2f99801f448fed9ce (checked with `git rev-parse HEAD`). All line numbers refer to index.mjs at that commit unless stated. Reproduction scripts (pure-function calls only, no network, no state files): /private/tmp/claude-501/-Users-juan-code-archy/bdf74263-0214-4fde-bf03-d21ba31a7a8e/scratchpad/glance-astra/repro-C/pc02.mjs and /private/tmp/claude-501/-Users-juan-code-archy/bdf74263-0214-4fde-bf03-d21ba31a7a8e/scratchpad/glance-astra/repro-C/rt01.mjs. No test suite was run.

Grouping: PC-03 is the union of RT-01 and RT-06. Its first half ("GraphQL envelope compared against a row-array string") is RT-01; its second half ("standalone snapshot adoption replaces rows without updating rawRef") is RT-06. They share one root (two incompatible comparison representations for "unchanged") but have distinct consequences: RT-01 is a cadence/budget defect in the collector, RT-06 is a correctness defect (wrong rows) in the standalone App. They are verified once below, under RT-01 and RT-06; PC-03 inherits both verdicts.

---

## PC-02: Security negative caching is not repository-scoped

Verdict: CONFIRMED (collector with 2+ targets on one provider). The snapshot-restoration sub-claim is PARTIAL.

Severity: high (security surface; wrong "not enabled" note and dropped real alerts for another repository).

Evidence:
- index.mjs:7243-7246 `function backoffStorageKey(key) { const access = requestIdentityStorage.getStore()?.accessKey ?? ...; return access ? \`${access}\0${key}\` : key; }`. No repository or host component.
- index.mjs:3793 user access key is `privateIdentityDigest("access-v2", credentialKey, generation)`: credential-scoped, not repository-scoped. index.mjs:8112-8113 installation access key binds `repositoryIds` (the whole installation set), so it is also shared by every repository of that installation.
- index.mjs:10152-10153 `let context = providerContexts.get(target.provider)`: one provider context per provider name, shared by all targets using it. index.mjs:10203-10210 `context.scope = { ...createQuotaScope(identity, ...), repository: target.repo, ... }`: the repository lives in the bound scope, but backoffStorageKey never reads it.
- index.mjs:1361-1363 `apiPath` substitutes the bound repository into `{owner}/{repo}`, so the request is per repository while the backoff key is not.
- index.mjs:7292-7310 replay path: `if (!force && backoffActive(source.key, now))` returns `raw: \`backoff:${note}\``, `httpRequests: 0`, `parse: () => ({ alerts: [], note, verdict, ... })`.
- index.mjs:7363 `clearBackoff(source.key)` on any success; index.mjs:7416-7421 `recordFailure` plus note/verdict on failure. Both use the same repository-free key.
- index.mjs:7527 `blind` excludes `"unavailable"`, so the replay is accepted as an answer, not as blindness.
- index.mjs:14115 / 7972 the collector accepts up to 32 targets.
- Repro pc02.mjs: after `fetchAlertSource` for "repo A" throws `HTTP 403`, a second call for "repo B" whose injected request would return one open alert made 0 requests and returned `verdict unavailable raw backoff:... alerts []`.

Concrete trigger: one collector, provider `gh` (or one GitHub App installation), targets A (Dependabot disabled, 403) and B (Dependabot enabled, open alerts). A's Security poll records `access\0dependabot` backoff (60 s first step). B's next Security poll within that window replays A's note: B's Dependabot rows disappear and B shows "not enabled". Two compounding effects follow from the shared key: (1) when B later succeeds, `clearBackoff` erases A's ladder, so A never climbs past the 60 s step and re-probes roughly once per minute instead of reaching the 1 h step; (2) if A's re-probe lands first, the step advances (5 min, 30 min, 1 h) and B is wrong for that whole step. B's published snapshot also carries A's capability entry (index.mjs:7471-7480 copies backoff state into `capabilities`).

Sub-claim on snapshot restoration (index.mjs:20311-20317, `alertBackoff.set(\`${accessKey}\0${sourceKey}\`, ...)`): the key is indeed repository-free, but this code runs in the App, which serves one repository per process (index.mjs:12440 `runtime.repo = opts.repo`). On its own it cannot mix repositories; it only imports contamination that the collector already wrote into B's snapshot. PARTIAL for that sub-claim.

Docs: ADR 0004 amendment (docs/decisions/0004-quota-and-acquisition-identities.md:159-164) says query identity includes host and admitted repository. README.md:675-680 says the cache is scoped to the repository. Neither documents a credential-wide capability backoff. The comment at index.mjs:7237-7239 only says "Keyed by source so one unavailable endpoint cannot slow the other two"; it does not address repositories. No test references `backoffStorageKey` or `alertBackoff` (grep of test/*.mjs is empty), so nothing contradicts the claim.

Proposal soundness: sound and safe. Adding the bound host and repository (`requestIdentityStorage.getStore()?.repository`, falling back to `effectiveRuntimeRepository()`) to the key should normally reduce requests, not increase them: A's ladder stops being reset by B's successes, and B's checks are ones the design already intends. The note that this "will restore requests" is only true for B. Snapshot restoration at 20315 must use the same builder. The `tab:${key}` keys (index.mjs:20146-20148) share the builder and would also gain repository scope, which is correct for the collector. Related but separate: `context.scope` is shared by all targets of a provider and rewritten on each `defaultResolve` (10203), so the referenced PC-01 immutable binding is a prerequisite for a reliable repository component (INFERRED; not traced here).

---

## RT-01 (and PC-03 part 1): Collector GraphQL snapshots cannot accumulate unchanged observations

Verdict: CONFIRMED for collector Issues/PRs. The quantitative gain is conditional and partly UNVERIFIED (see below).

Severity: medium (budget/cadence; no wrong data shown).

Evidence:
- index.mjs:2559-2567 fetchGraphqlList `raw = JSON.stringify({ v: GRAPHQL_QUERY_VERSION, totalCount, incomplete, hasNextPage, rows })`; `raw: raw === previousRaw ? previousRaw : raw`.
- index.mjs:14558, 14568 normalizeAcquisitionSnapshot `const content = JSON.stringify(rows); ... raw: content`. Every publication passes through it (index.mjs:15331 on publish; 14710 and 14774 on read).
- index.mjs:15594-15602 the producer claim returns `record.snapshot` after `loadRecordSnapshot`, which is the normalized object. index.mjs:10566 passes it as `snapshot`; index.mjs:10295 `previousRaw: force ? null : snapshot?.raw`; index.mjs:10320-10321 `collectorPublicationFromResult(resource, result, snapshot, ...)`.
- index.mjs:10047-10052 collectorPublicationFromResult calls `pollResultTransition({ previousRaw: previous?.raw ?? null, raw: result.raw, ...})`; index.mjs:17180 `if (previousRaw === raw) return { kind: "unchanged" }`. Envelope never equals row array, so the result is always `changed`.
- index.mjs:10068 `state.unchangedCount = advanceUnchangedCount(...)`; index.mjs:15853-15857 returns 0 on `changed`.
- index.mjs:152 `POLL_QUIET_AFTER = 2`, 153-159 quiet issues/prs 30 s; pollPolicyInterval returns `floorMs` below the quiet threshold. index.mjs:9198-9202 `webhookReconciliationInterval` returns null when `unchangedCount < POLL_QUIET_AFTER`, and index.mjs:7719 `WEBHOOK_RECONCILE_MS = 300_000`.
- Repro rt01.mjs: three identical Issues responses through collectorPublicationFromResult with a normalized `previous` (raw = rows JSON) gave `unchangedCount=0 interval=5000ms` each time. The control with the envelope preserved reached `unchangedCount=2 interval=30000ms` on the second poll.

Scope limits I found: REST resources (Actions, Security) escape this when GitHub answers 304 for every request, because the fetcher returns `previousRaw` (index.mjs:7488 `raw: allNotModified ? previousRaw : ...`), as the model said. Display "changed at" is not corrupted: index.mjs:15337 keeps `lastChangedAt` when the row digest matches. The standalone App is not affected for its own polls, because it compares against its own `rawRef` envelope (index.mjs:20601, 20106).

Tests: test/collector.test.mjs:810-828 (COL-01) checks quiet cadence only for a 304 REST case with `raw: previous.raw`; it does not cover a 200 GraphQL envelope against a normalized snapshot, so it does not contradict the claim.

Docs: ADR 0003 amendment (docs/decisions/0003-file-backed-api-coordination.md:308-317) requires two unchanged observations before quiet cadence; ADR 0005:74-78 requires quiet webhook reconciliation at max(floor, 300 s). The code cannot meet either for collector Issues/PRs. This is a codec mismatch, not a policy choice.

Quantities: 720 to 120 requests/hour at a 5 s floor and 720 to 12 with webhook coverage are correct arithmetic, but they assume a 5 s collector floor (the minimum is 2 s, index.mjs:12073; I did not check the default floor or the floor collector subscribers usually send). The "two-point GraphQL reservation" figure was not traced (GRAPHQL_PER_FETCH not read): UNVERIFIED.

Proposal soundness: sound. Safest form is to make `collectorPublicationFromResult` compare on the same representation that is persisted, for example derive the comparison from parsed rows plus completeness fields (totalCount, incomplete, hasNextPage, security notes/blind), or persist the fetcher envelope digest beside `contentDigest`. Any persisted-shape change needs a schema bump with acquisition-store version fencing. It reduces quota use; no new requests.

---

## RT-06 (and PC-03 part 2): Shared adoption changes rows without changing the local unchanged sentinel

Verdict: CONFIRMED (mechanism traced to wrong rows). Trigger is narrow.

Severity: medium (wrong rows shown and republished with fresh success time, but needs a byte-identical revert).

Evidence:
- index.mjs:20269-20329 adoptAcquisitionSnapshot sets `lastOkRef`, `entityRef` (20303-20305), data (20306-20307), meta and Security notes. It never writes `rawRef`. The only `rawRef` writes are index.mjs:20036, 20051, 20106 (own fetch results) and 20782 (scope reset).
- index.mjs:20601 the App's own fetch uses `previousRaw: rawRef.current[key] ?? null`; index.mjs:2567 fetchGraphqlList returns `previousRaw` when equal; index.mjs:17180 then returns `unchanged` without parsing.
- index.mjs:20081-20082 on `unchanged`: `lastOkRef.current[key] = completedAt` and rows stay as displayed. index.mjs:20491-20492 acquisitionPublication publishes `dataRef.current[key]` (the adopted rows) with `lastSuccessAt: completedAt`.
- index.mjs:20080 `publishStagedEntities(entityRef.current, stagedEntities, transition.kind)` accepts `unchanged` (publishStagedEntities allows both kinds), so on REST tabs a fresh 200 validator for representation A is stored next to adopted rows B. Later 304s make `allNotModified` true and the fetcher returns `previousRaw` (index.mjs:7488 for Security), so B persists.
- Repro rt01.mjs: `pollResultTransition` with previousRaw = A and raw = A returns `unchanged` without calling parse.

Concrete trigger: pane P produced A (rawRef = A). Peer Q produces B; P adopts B (display B, rawRef still A). P next produces and GitHub returns exactly A again. P shows B, stamps success now and publishes B to all followers. It stays wrong until a producer whose own rawRef differs from A observes the repository (Q would see A as changed), or the representation moves to something other than A. With only P left producing, it persists for as long as the repository stays at A.

Trigger frequency (my addition): Issue and PR rows include `updatedAt` (index.mjs:1084, 1099) and Actions rows include `updatedAt` (index.mjs:1519), so a natural A to B to A revert with identical bytes is uncommon for those tabs. Security rows map `created_at` but no update time (index.mjs:2627-2661), so an alert that leaves and re-enters the open list (dismiss then reopen, fixed then reintroduced) is a plausible exact revert. Read-replica lag returning an older A after B is another plausible path (INFERRED, not tested).

Docs: ADR 0004 amendment (docs/decisions/0004-quota-and-acquisition-identities.md:180-192) distinguishes successful observations from changed representations and requires validated snapshots. Adoption silently breaks the premise that the sentinel identifies the displayed data. I did not read the conditional-polling plan lines 98-104.

Proposal soundness: sound. The minimal safe fix is to clear `rawRef.current[key]` (set it to null) in adoptAcquisitionSnapshot when the adopted rows differ from the current rows. The next own fetch then parses and compares correctly, at zero extra API cost. Copying `snapshot.raw` would be wrong until RT-01's representation is unified, as the model warned. Validators from adoption are paired with the adopted rows' bodies, so they stay consistent once the sentinel is cleared.

## PC-03: Shared snapshots discard the fingerprint used to detect unchanged data

Verdict: CONFIRMED as the union of RT-01 and RT-06 (see both above). One sub-claim needs a correction: "Identical REST 200s have the same mismatch" is true for the collector only (fetcher raw is the joined payload bodies, not rows JSON), and it matters little in practice because quiet REST endpoints normally return 304, which takes the `previousRaw` path.

Severity: medium (the two halves, not additive).

Proposal soundness: one shared representation fingerprint, versioned, plus updating the App's sentinel on adoption is the right shape. Keep quota evidence separate from the content digest, as the model says.

---

## PC-04: Inferred display-cache keys survive a repository change in the same directory

Verdict: CONFIRMED.

Severity: low to medium (wrong-repository rows in a cold start; normally replaced within seconds for the active tab, unbounded only while offline, unauthenticated or for unopened on-demand tabs).

Evidence:
- index.mjs:13835-13850 dashboardCacheTarget: with no `repo` or `ghRepo`, the key is `{ kind: "cwd", host, cwd, account }`, with no repository. The comment at 13835-13837 says the directory is the only repository identity available without a GitHub call.
- index.mjs:12440 `runtime.repo = opts.repo` (flag only), so inferred mode passes `repo: null`.
- index.mjs:12511 `if (opts.connect === null) runtimeRemoteUrls = await gitRemoteUrls();` runs before mount, and index.mjs:1312-1318 resolveEffectiveRepository derives the slug offline from those URLs. The rationale in the comment no longer holds for the single-remote case.
- index.mjs:18521-18530 the App mount computes the target with `repo: runtime.repo` and `cwd: process.cwd()`; index.mjs:20866 ensureScope recomputes it the same way (cwd defaults to process.cwd()). index.mjs:20871-20881 hydrate from the warm entry if nothing is published yet.
- loadDashboardCache (`pick(decoded.cache, target, null)`) does no repository check.
- README.md:675-677: "The cache is scoped to the repository, host, provider, and effective access partition. In inferred standalone mode, the host and current working directory also form the identity". "Also" implies the repository is still part of the identity; code omits it. This is a divergence from the README.
- test/cache.test.mjs:262-300 checks that explicit and inferred keys, different directories and different hosts stay isolated. It has no case for a remote change under one directory, so it does not contradict the claim; it does encode cwd identity as intended.

Concrete trigger: run gh-glance in ~/src/work (origin = acme/one), quit, then `git remote set-url origin acme/two` (or delete and re-clone another repository into the same path), restart with the same host and credential. The first frame shows acme/one's cached rows (up to 60 per tab) for acme/two. The active tab corrects on its first successful fetch; inactive tabs at their background cadence; on-demand tabs only when opened; all tabs stay wrong while GitHub is unreachable or auth fails.

Proposal soundness: sound and safe, no GitHub I/O. Add the offline-resolved slug to the cwd key (keep cwd). When the slug is null (no remote, or several remotes with different slugs, index.mjs:1317), key on an explicit "unresolved" marker rather than reusing a cwd-only entry. Existing cwd-only entries become unreachable once, which costs one cold start per checkout. The model's figure "up to 240 rows" assumes four tabs times the 60-row cap; I did not check which tabs are cached, so treat that number as INFERRED.

---

## RT-07: Security capability-backoff replays are stamped as new source observations

Verdict: CONFIRMED.

Severity: medium (false freshness for up to 1 h on a common configuration; premature webhook completion in exactly the case where the capability has changed).

Evidence:
- index.mjs:7292-7310 an in-backoff source returns `httpRequests: 0`, `verdict` = cached verdict, `raw: \`backoff:${note}\``.
- index.mjs:7501 `measuredSuccess: parts.every((part) => part.verdict === "ok")` is false, but it is used only for governor settlement: index.mjs:19959 (App) and 10304 (collector) choose `outcome: "rejected"`. Processing continues.
- index.mjs:7527 `blind` excludes `unavailable`, so pollResultTransition returns `changed` or `unchanged`, not `blind` (index.mjs:17188-17195).
- App: index.mjs:20081-20082 `if (transition.kind === "unchanged") { lastOkRef.current[key] = completedAt; ...` and index.mjs:20099-20106 for `changed`. After the first replay, `rawRef` equals the joined `backoff:` string (index.mjs:14081-14084 nextSecurityRaw keeps equal raws), so every later replay is `unchanged` and advances freshness.
- Collector: index.mjs:10047-10077 collectorPublicationFromResult sets `lastSuccessAt: completedAt` (10077) for both kinds; the publication advances the generation. index.mjs:10452-10460 resolves invalidation waiters when `snapshot.generation >= waiter.requiredGeneration`, with no check that HTTP occurred.
- index.mjs:8600-8603 webhook events `dependabot_alert`, `code_scanning_alert`, `secret_scanning_alert` map to the `security` resource. index.mjs:10469-10475 a webhook-triggered poll is `manual` without `force`, and index.mjs:10571 passes that `force` to the producer, so fetchAlertSource honors backoff.
- index.mjs:15874-15881 lowercase `r` is `force: false, clearCapabilityBackoff: false`; only `R` forces and clears. So the model's "manual r during backoff" point is accurate.
- index.mjs:194 ladder ends at 3,600,000 ms.

Concrete trigger: a repository with Dependabot, code scanning and secret scanning all unavailable (the comment at index.mjs:7521-7526 says most repositories have Advanced Security off). After the first 403s, every Security poll for up to an hour makes zero HTTP requests yet advances `lastSuccessAt`. Worse case: the owner enables Dependabot, GitHub sends `dependabot_alert`, the collector marks the query dirty, the follow-up poll replays the cached "not enabled" notes with zero HTTP, publishes a newer generation, and resolves the webhook waiter. The new alerts stay hidden until the backoff step expires.

Docs: the durable-freshness plan D6 (docs/plans/2026-09-28-durable-freshness-and-recovery.md:74-78) says only a validated successful source observation advances freshness, and the Phase 4 clarification says the accessible-subset qualification "is ... not permission to synthesize a timestamp". With all three sources in backoff there is no accessible subset and no observation. ADR 0005 (docs/decisions/0005-local-collector-and-provider-boundary.md:74-76) says durable webhook work completes only after a newer API-validated generation. The code diverges from both. The one-hour ladder delay itself is a documented choice (index.mjs:188-194), so the delay is not the defect; the false timestamp and the waiter resolution are.

Proposal soundness: sound. Use `httpRequests > 0` with at least one `ok` part (or a new explicit `observed` flag) to gate `lastSuccessAt`/`lastOkRef` and waiter resolution, while still letting capability notes update. One interaction to keep: a webhook for a security event is direct evidence that a capability may have changed, so the safest version also clears the capability backoff for that query on a security webhook (this spends at most three REST requests per delivery and stays under normal governor admission). That last point is my suggestion, not the model's. Combined with PC-02, a webhook for repository B can currently be resolved by a replay of repository A's note; fixing PC-02 first removes that cross-repository case.
