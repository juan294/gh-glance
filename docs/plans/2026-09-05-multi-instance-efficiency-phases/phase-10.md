# Phase 10: webhook-assisted invalidation

Parent: [complete plan](../2026-09-05-multi-instance-efficiency.md)  
Depends on: 9. Batch eligibility: no.

## Objective and files

Allow an explicitly configured collector to react to GitHub events and reduce quiet polling, retaining reconciliation for missed events. Add webhook ingress/queue configuration and handlers in `index.mjs`; add `test/webhooks.test.mjs`, `test/fixtures/webhook-events.json`, and collector integration cases. Update README/SECURITY and ADR 0005. No webhook registration, proxy deployment or public listener is performed during implementation.

## Ingress and event semantics

Add an optional `webhook` object to collector config: enabled flag, loopback address/port, secret-file path, allowed host/provider/repository mapping, and explicitly configured covered resource families. Use Node HTTP on loopback only, designed for a user-controlled HTTPS reverse proxy; reject non-loopback binding. No public dashboard/client HTTP API is introduced. Non-POST/mismatched route requests do not enqueue work.

Validate `X-Hub-Signature-256` against the exact raw bytes using HMAC SHA-256 and constant-time comparison, before JSON parsing/action. Enforce 25 MiB request-body maximum, ten-second read timeout, bounded connection count, strict content type and event/delivery ID validation. A valid request is acknowledged within two seconds in the local fixture after its bounded invalidation record is durably accepted. Oversized bodies return 413; full/unwritable queues return a failure response rather than claiming acceptance.

```text
onWebhook(rawBody, headers):
  verify size/deadline/signature/event/provider/repository allowlist
  if delivery ID already accepted: acknowledge without new work
  transaction: persist delivery ID + compact invalidation (not raw payload)
  respond 202

worker:
  coalesce invalidations for each repository/resource for one second
  mark query dirty and request ordinary governed acquisition
  publish only API-validated results; event receipt is not source freshness
```

Persist up to 10,000 delivery IDs for 24 hours with oldest-first expiry; bound invalidation queue to 512 unique repository/resource entries. At capacity, an existing key can coalesce; a new key is rejected for retry/reconciliation. A collector restart restores accepted pending invalidations. Duplicate or out-of-order delivery cannot roll data backward, because events invalidate rather than overwrite rows.

Mapping: `workflow_run` and `workflow_job` → Actions; `issues` → Issues; `pull_request`, `pull_request_review`, `pull_request_review_comment`, `pull_request_review_thread` → PRs; `issue_comment` → Issues or PRs according to its payload; Dependabot/code-scanning/secret-scanning alert events → corresponding Security source. Installation/repository-access changes invalidate provider permission evidence and relevant subscriptions. Support event names/availability documented for the target host; unsupported events are acknowledged without data work after signature validation.

Keep ordinary polling until webhook coverage is explicitly configured for a resource. Covered quiet resources reconcile every `max(floor,300s)`; running CI still follows fast polling, and manual refresh remains available. Event invalidation bypasses quiet delay but never quota/secondary admission. Losing webhooks therefore delays quiet detection to reconciliation, not forever. Do not infer delivery health merely from absence of events.

## Automated acceptance

- `HOOK-01`: valid signature accepted; invalid/missing signature, changed bytes, malformed/oversized/slow body and wrong repo cause zero data acquisition.
- `HOOK-02`: 100 duplicate deliveries cause one persisted invalidation; bursts for one resource coalesce; unrelated resources remain independent.
- `HOOK-03`: acknowledge only after durable enqueue; crash/restart processes pending invalidation; backpressure is bounded and observable.
- `HOOK-04`: out-of-order events cannot overwrite newer rows or freshness; queued fetch obeys reserve and shared secondary cooldown.
- `HOOK-05`: a single invalidation with no preceding queue/backlog, a free HTTP permit, sufficient primary capacity and 100 ms fixture latency reaches display within three seconds. Missed events are caught within `max(floor,300s)` plus measured admission/response/publication delay; test default floor and a floor longer than five minutes. Held-capacity cases assert honest staleness and eventual recovery instead of an impossible fixed deadline.
- `HOOK-06`: unsupported/unsubscribed resource coverage does not accidentally stop ordinary polling; App access-removal event fences old results.
- `HOOK-07`: secrets and event bodies never appear in logs, metrics, persisted queue or client protocol.

Run parent gates sequentially; generate/sign fixture payloads locally. GitHub contract sources: [delivery validation](https://docs.github.com/en/webhooks/using-webhooks/validating-webhook-deliveries), [events and permissions](https://docs.github.com/en/webhooks/webhook-events-and-payloads), [webhook operational guidance](https://docs.github.com/en/webhooks/using-webhooks/best-practices-for-using-webhooks).

## Manual success criteria

None required for local implementation acceptance. Creating real webhook subscriptions and configuring HTTPS forwarding require user-owned external setup and remain disabled by default. Document permissions, secret placement and a local signed-delivery self-check; do not silently register hooks with the user's repositories.

## Completion

- [ ] Optional ingress, durable invalidation and reconciliation policy implemented.
- [ ] HOOK scenarios and parent local gates passed.
- [ ] Independent compliance/quality review complete; integrated locally; stop.
