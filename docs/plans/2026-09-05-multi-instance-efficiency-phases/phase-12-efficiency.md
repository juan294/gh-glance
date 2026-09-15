# gh-glance efficiency measurement

- Workload: sustained-hour, 3600000 simulated ms
- Runtime: v24.19.0 (darwin/arm64)
- Oracle requests: 1619 (896 data, 723 observer)
- Actions REST data responses: 36 200, 854 304
- Oracle charged cost: 385 core, 350 GraphQL
- Acquisition proven/uncertain cost: 36/7 core, 0/0 GraphQL
- Observer calls/combined charged units: 723/699
- Source-to-display p50/p95: 3110/4720 ms
- Shared follower-delivery delay p50/p95: 100/464 ms
- Baseline comparison: incompatible
- Improvement: not claimed (workload, measurement-method)
- Compatible startup slice: compatible
- Compatible startup request improvement: 50%

The Phase 1 sample is an eight-second legacy Actions-only PTY capture; this is an accelerated sustained-hour production-policy run. No numeric improvement is claimed.
