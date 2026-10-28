# Phase 5 — personal attention with optional semantic badges

Parent: [implementation plan](../2026-10-28-jev-developer-workflows.md). Entry: prior phases accepted sequentially; version8 `attention:details` operation available. Outcome: a useful deterministic queue of direct review requests, assignments and authored work from the current repository's loaded rows. Jev annotates descriptions; it does not decide responsibility or priority.

## User action, identity and acquisition

`a` opens attention for a verified standalone human user. A connected view or GitHub App installation identity gets an explicit unsupported explanation and ordinary navigation, with zero local GitHub/Jev fallback. Bind the verified `/user` identity (`index.mjs:3344`, `:3347`), not git author or an environment username.

Freeze loaded Issues and PRs into a deduplicated manifest keyed by kind/number, ordered updatedAt descending then kind/number. Existing caps permit at most 300 loaded candidates (`index.mjs:119`). Opening with candidates explicitly requests only the first 25 details. `m` requests the next 25, at most 12 batches over that manifest, with no automatic drain. Empty/unloaded sources instead show `r Load lists` and perform no acquisition until requested. `r Refresh lists/details` uses the existing admitted first-page source refresh paths, rebuilds the manifest and requests one detail batch. Preserve each source's age/missing/truncated state and every batch's own fetchedAt; this is not an atomic full-repository snapshot.

Add one static query declaration to the GraphQL registry (`index.mjs:1116`). It contains `viewer { id databaseId login }`, repository identity, rateLimit meter, and exactly 25 trusted aliases c0…c24 of `issueOrPullRequest(number:$nN) @include(if:$useN)`, selecting `__typename` at each union slot. Every number is an Int variable and every use flag a Boolean; unused aliases reuse a valid number with false, never interpolate source text. Both concrete Issue and PullRequest branches select id, number, closed, updatedAt, viewerDidAuthor, and `assignees(first:50) { totalCount pageInfo { hasNextPage } nodes { id login } }`. PR also selects isDraft, reviewDecision and `reviewRequests(first:50) { totalCount pageInfo { hasNextPage } nodes { requestedReviewer { __typename ... on User { id login } } } }`. Use closed rather than conflicting IssueState/PullRequestState fields. No bodies, comments, checks or organization/team membership query.

Validate viewer.databaseId equals captured verified user.id, repository identity, and each returned slot's __typename/number against its candidate. Record a valid node ID on first observation because ordinary source rows have no node ID (`index.mjs:1941`, `:1950`); require it to remain stable in subsequent observations of that candidate within the same manifest. Missing/null/malformed slots remain unknown; a GraphQL error+data batch is unavailable following existing policy while retaining valid rate observations (`index.mjs:1892`). This operation explicitly attaches `graphqlPageRequestMetrics`; its non-page name would otherwise default to REST in `measuredNestedOperationCost` (`index.mjs:16390`). Declare `{core:0,graphql:2}`, reconcile actual meter/overrun, and never count a point estimate as guaranteed actual cost. The 12-batch manifest has a declared reservation ceiling of 24 GraphQL points, excluding explicit source refreshes/retries; it is not a measured account bill.

Bound each attention response to 2 MiB before parsing, with a 30-second whole-batch deadline and existing two-second admission wait. Keep one detail flight; cancel/settle it on scope or manifest retirement. Retain only normalized candidate identity, tri-state relations, exact reason fields and timestamps, at most 300 records and 2 MiB aggregate, discarding full assignee/reviewer lists after normalization. Oversize, deadline or aggregate-limit failure leaves prior same-scope results explicitly partial and offers Retry/Open GitHub; it never starts an automatic smaller query. Tests prove bounds and recovery alongside semantic-cache bounds.

Official contracts: [Repository](https://docs.github.com/en/graphql/reference/objects#repository), [Issue](https://docs.github.com/en/graphql/reference/objects#issue), [PullRequest](https://docs.github.com/en/graphql/reference/objects#pullrequest), [RequestedReviewer](https://docs.github.com/en/graphql/reference/unions#requestedreviewer), [rate limits](https://docs.github.com/en/graphql/overview/rate-limits-and-query-limits-for-the-graphql-api).

## Facts and deterministic order

Use tri-state relationship facts. Viewer ID present in validated nodes means true even when paginated. False requires all nodes valid, complete page, and consistent total count. Otherwise unknown. Only direct User review requests establish personal review responsibility. Team/EnterpriseTeam entries show “Team review requests are not resolved here”; other known non-user kinds cannot become this human user; null/unrecognized values make an absent-user answer unknown. Never infer organization membership.

Closed items leave attention but do not mutate ordinary list caches. Keep all true reasons and choose the first applicable lead tier:

| Tier | Exact condition and display |
| --- | --- |
| 1 | Direct review request to viewer — “Your review requested”; preserve draft badge |
| 2 | Issue assigned to viewer — “Assigned to you” |
| 3 | Viewer-authored non-draft PR with CHANGES_REQUESTED — “Changes requested on your PR” |
| 4 | PR assigned to viewer — “Assigned to you”; preserve draft badge |
| Following | Other viewer-authored PRs — factual draft/review tracking, no urgency claim |

Within a tier, order updatedAt ascending, then kind/number. Label this as item update time, not request age or overdue time. Show unknown/unqueried counts and an inspectable unknown section. Zero matching checked rows says “No direct attention items among N checked”; missing source pages/relationships remain visible. Use a local composite selection key without changing global number-only itemKey (`index.mjs:7050`). Enter uses the original row kind and same-host URL.

If detail updatedAt differs from the loaded row, retain fresh exact relationship facts and show “Source metadata changed; r Refresh.” Suppress semantic annotations for that row until its metadata is refreshed. Do not reject all changed details forever waiting for equality. Wrong identity/scope is always rejected. A change to the frozen source manifest marks the session stale and offers Restart; late old batches cannot publish. Memory-only details expire after five minutes; show age and require explicit refresh, with no automatic network.

```text
@ buildAttention(manifest, detailBatch, viewer) -> queue
pre: source scope and verified viewer identity match
do:
  1. validate each slot and compute true, false or unknown relationships
  2. compute exact reasons, excluding closed items
  3. compute fixed tier and stable item-update ordering
  4. emit queue with checked, unknown, stale and source coverage
br: changed metadata -> retain facts and disable semantic badge until refresh
fx: ephemeral detail overlay; ordinary source rows are unchanged
fail: bad viewer or obsolete scope -> discard batch and expose reload action
```

## Optional Jev badges

`J` adds two independent `attention-v1` Noul badges over permitted title/label/branch metadata only: **reported_regression**, explicit report of previously working behavior now failing; **user_visible_impact**, described effect experienced by a product user. False criteria exclude hypothetical risk, planned work and purely internal detail. The parent input, consent, batch, cache and deadline limits apply. For more than 60 eligible rows, repeated `J` explicitly advances the next annotation batch; `m` remains GitHub detail pagination. Display separate detail and semantic coverage counts.

Positive answers show “Reports regression” or “Describes user impact,” with metadata-only context; uncertain means no asserted badge. No score changes membership, lead reason, tier, ordering, freshness or navigation. Do not ask Jev whether a user is an assignee/reviewer or whether a check passed. This conservative first version makes the exact queue independently valuable while the badge evaluation tests added descriptive usefulness.

## Tests and consumer changes

Create proposed `test/attention.test.mjs`, `test/pty/attention.test.mjs`, `test/fixtures/jev/attention.json`. Extend the strict external request oracle (`test/fixtures/request-oracle.mjs:79`, `:114`, `:124`, `:139`, `:146`) for aliases, concrete fragments and Boolean directives with bounded known fields/variables. Do not bypass parsing with a raw query substring. Update GraphQL registry enumeration (`test/graphql.test.mjs:42`), fixture GraphQL dispatch (`test/pty/fixtures/graphql-response.mjs:31`, `:71`), fixture state writers and efficiency oracle. Existing row projectors and exact collector schemas remain unchanged.

Required oracles: verified viewer mismatch; alias/slot swap; Issue/PR same number; false only on complete connection; viewer at node50; hasNextPage unknown; Team/Bot/null distinctions; direct-review and assigned reasons coexist; draft tier labels; closed detail; changed metadata accepted with annotation suppressed; GraphQL error+data; permissions/admission failure then retry; 25/25/remainder progression; zero candidates; no automatic refresh/inference; measured GraphQL settlement; source digest cancellation; stable selection after merges/removal; correct URL from mixed row types; semantic scores cannot reorder even at 0/1 extremes. Fixture counts must separate source requests, attention requests and Jev calls.

One runtime/fixture integration owner. `[batch-eligible]` corpus author owns only `test/fixtures/jev/attention.json` using labeled public/synthetic metadata, badge truth and evidence rationale; no runtime, query, oracle or metric edits. All shared-contract work remains sequential.

## Recovery and acceptance

No user identity/unsupported topology shows how to use verified standalone mode. Empty data offers Load lists. Partial/unknown relations offer GitHub; `m` advances unqueried candidates, never promises to resolve truncated nested relations. Expired/changed snapshot offers r Refresh/Restart. Permission/schema/admission error retains same-scope prior results labeled as-of and permits one explicit retry; switching accounts clears them. Jev failure/declined consent leaves exact queue intact. Tests assert disclosures and the successful correction path, including changed-detail refresh without an endless stale loop.

Sequential automated gates: lint, syntax, npm test, efficiency, full PTY. Include no-idle-detail-request evidence and the parent's interaction/performance limits. Reuse unchanged Phase 3 protocol compatibility evidence; re-run if its inputs change. Manual: inspect tiers, draft/unknown/source coverage and retry controls at narrow/wide widths. Complete independent review, repairs and simplify.

Record candidate, query/corpus hashes, endpoint/meter evidence, gate results and optional badge live status. Deterministic queue acceptance does not establish semantic accuracy. Live badge qualification uses the parent's 80-case precision/recall gates with separate authorization. Stop for Phase 5 acceptance; release, hosted CI and provider/account changes remain separate workflows.
