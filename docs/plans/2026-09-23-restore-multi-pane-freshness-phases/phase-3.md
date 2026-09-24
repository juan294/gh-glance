# Phase 3: independent resource gates and self-rearming wakes

Depends on: Phase 2. Stops after local verification and review.

## Deliverable

Replace the all-resource `governorProtocolReady` gate with a readiness check over the tab's declared cost vector. Remove the global `liveScheduling` dependency from data wake arming and opening poll deadlines: each eligible tab must keep its own due/retry path even when the visible active tab uses an unavailable resource. Actions and Security need fresh core authority; Issues and PRs need fresh GraphQL authority. Preserve verified account identity, host, account-wide secondary holds, HTTP permit, and each resource's primary reserve. Scope unpublished primary rate-limit blocks and `failClosedRateLimit` deadline changes to tabs that spend the affected resource; an unpublished account-wide secondary block still holds both resources. The governor scheduler currently defers every background intent when the GraphQL observer fails; limit that deferral to intents that actually spend GraphQL. Do not infer budget from the non-authoritative `rate_limit` display. [Costs](../../../index.mjs:2071), [current all-resource gate](../../../index.mjs:13970), [global wake gate](../../../index.mjs:16745), [background deferral](../../../index.mjs:4455), [global block gate](../../../index.mjs:16758), [rate-limit failure](../../../index.mjs:16519), [rate-limit role](../../../index.mjs:9910)

```text
requiredResources(tab) = keys(tabRequestCost(tab) where cost > 0)
resourceReady(tab, snapshot):
  for each required resource:
    observer healthy; no active probe claim; budget fresh
    primary block clear; sufficient spend above reserve
  AND identity valid; shared secondary hold clear
schedule background intent only against its required resources
```

Add one finite liveness wake active from pane bootstrap through teardown. It reconciles pending governor intent/reservation IDs, acquisition claim deadlines, observer retry deadlines, and overdue data polls. Control and data wakes must catch/reclassify failures and rearm in `finally`, including identity refresh rejection and failed governor inspection. Retries are bounded to at least one second or a named safe slot, not a tight loop. A terminal failure stays visible rather than silently dropping the timer. Keep the existing single-flight data wake and no duplicate per-tab request property. [Current one-shot scheduler](../../../index.mjs:14014), [data early return](../../../index.mjs:17053), [control/bootstrap awaits](../../../index.mjs:17124)

## Tests first

In governor/runtime tests, hold GraphQL observer failed for several retry windows while core remains fresh and spendable: Actions/Security active and background queries must continue, while Issues/PRs remain held. Make a GraphQL tab the visible active tab and assert the core-only background tabs still progress. Reverse the resources and assert GraphQL-only tabs progress while core-only tabs do not. Repeat with an unpublished primary rate-limit block in one resource and assert the other continues. In both directions, an account-wide secondary hold stops both. Assert no data request is admitted below either resource's reserve. [Existing readiness](../../../index.mjs:13998), [scheduler](../../../index.mjs:4444)

Inject rejected identity refresh, a failed `inspectGovernor`, an observer timeout, and a wake callback that throws. Assert a later healthy observation resumes the exact pending query without a key press or restart; bound the retry count and elapsed time. Include a lost/expired governor intent and a stale acquisition claim so the independent liveness wake performs cleanup and re-admission. [Wake tests and helper](../../../index.mjs:14050), [pending replay](../../../index.mjs:16993)

## Automated success

- One failed quota resource no longer silences a healthy unrelated resource, including its background work.
- Every failed one-shot wake has a finite next attempt or an explicit hold deadline; no busy spin and no lost pending intent.
- Shared secondary throttling, identity fencing, request start accounting, and reserve tests remain green.
- Run the plan's sequential local verification gate.

## Manual success and limits

Inspect the fixture's redacted wake/admission trace for each injected fault. Under a real outage the interface must state the hold, while no timing promise is made about GitHub's recovery. [Current notice mapping](../../../index.mjs:14154)
