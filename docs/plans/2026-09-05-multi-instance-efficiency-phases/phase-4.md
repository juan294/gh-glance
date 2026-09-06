# Phase 4: recovering scheduler and resource-specific observers

Parent: [complete plan](../2026-09-05-multi-instance-efficiency.md)  
Depends on: 3. Batch eligibility: no.

## Objective and files

Translate low actual cost into useful refresh opportunities, recover stale external-use factors, and separate resource authority from shared transport throttles. Change scheduler/state/settlement/probe/status sections of `index.mjs` (`index.mjs:1523`, `:1720`, `:2766`, `:2998`, `:3073`, `:3169`, `:3247`, `:6282`, `:8146`). Extend governor workers and unit/PTY tests; add `test/scheduling-policy.test.mjs` and `test/pty/secondary-limit.test.mjs`.

## Changes and pseudocode

Future queue positions become advisory estimates; only startable work takes a quota reservation. Keep started and uncertain reservations immutable. Track primary pacing credit/debt from actual/uncertain costs and refill from conservative spendable capacity over remaining window. Bound accumulated pacing credit at the largest permitted atomic operation, preventing idle-time bursts.

```text
planQueue(now):
  prune unstarted dead/cancelled demand
  schedule priority + fair round-robin among distinct demand owners
  estimate nextAt from primary pacing, resource evidence, HTTP permit, cooldown

start(intent):
  atomically recheck identity, relevant resource evidence, reserve and permits
  reserve worstCost; debit pacing credit; record started request

settle(request):
  actual = provenCost or worstCost
  return unused primary pacing credit (capped); retain HTTP pacing
  record counter reconciliation exactly once; replan queue
```

Start validation, not the estimated wake time, authorizes work. Cancelled unstarted work removes provisional queue cost; a 304 removes its primary contribution but retains transport request accounting. Preserve independent resource queues; limit at most one outstanding request per query/owner before shared acquisition lands.

### External-use estimator

Keep sampling baseline and definite local accumulation until at least five local units form a reconciled sample. Two four-unit local-only samples must reduce factor seven to one. On an authoritative new epoch, reset the factor and sample to one without changing reserve semantics. Five minutes of valid unchanged counters, zero local cost and no uncertain work establish quiet recovery; failed samples and external-only spend do not. Periodically sampled actual counters still constrain primary capacity regardless of estimator value.

### Secondary and observer control

Parse throttle evidence from HTTP status, selected headers and GraphQL error envelopes. Permission-only 403 is not a throttle. Primary exhaustion holds only that resource until reset. Valid `Retry-After` seconds/date creates a shared cooldown; without it, confirmed secondary/abuse or generic 429 uses 60/120/240/480/900-second delays, capped at 900 only for the locally chosen delay. Persist attempt state; after five repeated failures stay paused until explicit manual retry or a later reset-triggered recovery opportunity, still respecting the deadline. A server-supplied longer deadline is never shortened.

Extend phase 2's transport primitives with complete error classification and recovery. Merge cooldown deadlines by maximum, preserving them across primary epoch changes. After expiry elect one recovery request; success releases ordinary scheduling, repeated throttle extends it. Manual refresh cannot bypass. Every HTTP request, including 304 and observers, acquires a shared permit: default concurrency one and minimum 250 ms between starts per host/quota coordination group. Account-wide secondary coordination spans core and GraphQL; unknown bootstrap uses a host-level guard until its principal is known. These conservative client limits do not promise immunity to GitHub's secondary limits.

Give core and GraphQL independent observer claims, readiness, and outcomes. Drain/reconcile only work charging the observed resource. A failed GraphQL observer cannot erase fresh core authority. Shared secondary holds still stop both. Resource independence does not bypass a shared HTTP permit currently occupied by an observer: once the permit is available, an unrelated fresh lane can start without waiting for the failed resource's publication/retry. Replace exact state validators/migration atomically; do not merely change the runtime fields.

## Automated acceptance

- `SCHED-01`: zero-cost settlement advances the next primary-limited request subject to the HTTP gap; cancelled work leaves no empty slot.
- `SCHED-02`: 12 processes cannot overspend primary reserve or share one HTTP permit concurrently; replan never refunds uncertain work.
- `SCHED-03`: factor recovery for 4+4 samples, five proven quiet minutes and epoch changes; missing/external-only samples cannot fake recovery.
- `SCHED-04`: retry 30 seconds is not an hourly wait; retry two hours is not capped; shorter concurrent errors never shorten a hold.
- `SCHED-05`: primary REST hold allows GraphQL; secondary holds both across epoch reset; permission 403 holds neither globally.
- `SCHED-06`: one retry owner, repeated failures bounded, block-publication failure denies starts, manual requests cannot bypass.
- `SCHED-07`: one slow/missing observer does not invalidate unrelated fresh readiness; that lane starts when the shared HTTP permit is available without waiting for the failed observer's retry/publication. 304/paid/timeout events reconcile exactly.
- `SCHED-08`: sustained manual/tab-switch pressure cannot permanently starve another active owner; enforce at most three consecutive manual grants before an eligible active turn, without bypassing safety.

Run all parent gates sequentially and update ADR 0003's guarantees to match tests.

## Manual success criteria

None. Injected time and concurrent fixture processes cover recovery and timing without waiting for a live hourly limit.

## Completion

- [ ] Scheduling, estimator, throttle and observer schemas implemented.
- [ ] SCHED scenarios and parent local gates passed.
- [ ] Independent compliance/quality review complete; integrated locally; stop.
