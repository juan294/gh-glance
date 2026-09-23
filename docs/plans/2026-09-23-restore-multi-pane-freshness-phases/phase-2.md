# Phase 2: bounded claim and intent lifecycle

Depends on: Phase 1. Stops after local verification and review.

## Deliverable

Make an unstarted acquisition claim a bounded admission lease rather than a live-PID possession. Preserve the current nonce/generation/start-receipt boundary: no fetch begins before a governor reservation and successful `markStarted`. The fixed 180-second unstarted deadline derives from two 90-second governor lease windows and never advances with heartbeat. After it, one contender may atomically replace the unstarted claim; a delayed old owner fails the start fence. For started claims, derive a finite deadline from the bounded declared request sequence and per-`gh` timeout. After that deadline a successor fences the old generation while preserving every uncertain charge; the old owner attempts abort when it resumes. Check claim ownership before every nested data subprocess. Commit local rows, cache, and `lastOk` only after the generation fence accepts publication; the current path updates them before checking the shared result. A request already in flight, or racing immediately past its check, may finish and remains conservatively charged; its old rows cannot reach the shared store or its own pane. A real future budget reset delays requests and remains visible; it does not grant an immortal unstarted claim. [Claim and heartbeat](../../../index.mjs:13163), [takeover condition](../../../index.mjs:13568), [start receipt](../../../index.mjs:13486), [current local commit order](../../../index.mjs:16011), [governor TTL](../../../index.mjs:2131)

```text
on claim/heartbeat:
  preserve original claimedAt; never extend absolute unstarted deadline
on follower refresh:
  if claim.started == false and deadline passed: atomically fence old nonce,
    create next generation claim; otherwise follow current owner
on owner watchdog:
  reconcile exact governor intent/reservation and acquisition claim
  cancel a stale or lost unstarted pair; retain/retry cleanup until terminal
  if started transport exceeds declared bound: fence old generation,
    retain uncertain debt, abort old transport when owner resumes,
    then allow a separately admitted generation
before gh:
  recheck current claim; start governor reservation;
  persist markStarted under current claim nonce
  if either fails, do not dispatch; cancel only provably unstarted slots
```

Use the **returned** `decision.intentId` when `registerIntent` coalesces an existing pending intent; the current pane stores the newly generated ID instead. Adopt that intent only if its process-local claim generation and access scope match. If they do not match or are missing, cancel the old unstarted intent and register a new one; never bind a different query to its grant. `markStarted` must bind one claim to one exact reservation receipt and return an idempotent already-started outcome without authorizing another dispatch; it currently returns success before checking a repeated receipt. Process-local pending state must match the persisted intent/reservation exactly. Cancellation is idempotent across stores, and a failed cleanup is retried rather than forgotten. A reservation already `started` stays charged unless no-dispatch is proved at the existing start boundary; never refund because a claim was superseded. Update ADR 0004's claim/takeover amendment to describe the new bounded liveness and conservative accounting. [Coalesced ID](../../../index.mjs:4921), [local ID](../../../index.mjs:16915), [repeated start](../../../index.mjs:13491), [cancel paths](../../../index.mjs:13404), [ADR](../../decisions/0004-quota-and-acquisition-identities.md:168)

## Tests first

Add deterministic acquisition tests that advance past many 10-second heartbeats with a live PID and show an unstarted claim can be taken over at 180 seconds; one at 179 seconds remains protected. Suspend owner A after claim, let B take over, then resume A and assert `markStarted` rejects and A starts zero `gh` calls. Repeat for a started claim with a delayed multi-call fetch: one old request may finish but no later old subprocess starts, the old receipt remains charged, the old publication is fenced, and the new generation requires a fresh grant. Resume A after B's takeover and completion; assert A's local rows, cache, and `lastOk` do not change. [Heartbeat fixture](../../../test/acquisition.test.mjs:1217)

At the pane/governor seam, inject duplicate/coalesced intents for both the same claim and a different query, expired intents, scheduled slots, a failed cancellation, and a `startReservation`/`markStarted` race. Repeat `markStarted` with the same and a different reservation receipt; assert only the original receipt can own one dispatch. Assert the tracked ID always resolves to the matching claim, every terminal path releases or conservatively records its reservation, and repeated followers never start duplicate work. A known reset or secondary hold must show waiting and make no early request. Use existing governor and PTY fixtures rather than a new framework. [Intent API](../../../index.mjs:4904), [pending replay](../../../index.mjs:16993), [current handoff](../../../index.mjs:16435)

## Automated success

- No live-PID unstarted claim remains beyond its fixed deadline; an owner that lost the nonce cannot launch or publish.
- A valid long future quota slot does not launch early, does not refund uncertain work, and recovers when capacity returns.
- Coalesced intent IDs, cleanup failures, and started-claim timeout follow one tested terminal state; one producer publication and the 20% reserve remain intact.
- Run the plan's sequential local verification gate.

## Manual success and limits

Read back a redacted claim/admission trace from the fixture and confirm it names the exact blocked stage and next retry. The historical Archy/Sutura admission trigger remains unproven; this phase closes the persistence mechanism that let such a trigger last for hours. [Saved claims](../../research/2026-09-23-live-staleness-evidence.md:23)
