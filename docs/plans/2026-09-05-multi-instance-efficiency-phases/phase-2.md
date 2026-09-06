# Phase 2: credential/quota identities and controlled migration

Parent: [complete plan](../2026-09-05-multi-instance-efficiency.md)  
Depends on: 1. Batch eligibility: no.

## Objective and files

Stop irrelevant configuration differences from splitting coordination while keeping private data authorization-specific. Change identity, scope/state, diagnostic identity and CLI startup sections of `index.mjs`; extend `test/governor.test.mjs`, `test/runtime-remediation.test.mjs`, `test/doctor.test.mjs`; add `test/identity.test.mjs` and `test/pty/identity-migration.test.mjs`. Update `SECURITY.md` and add `docs/decisions/0004-quota-and-acquisition-identities.md` as the design record.

Current fingerprint and scope attachment points: `index.mjs:5888`, `index.mjs:1905`, `index.mjs:1972`, `index.mjs:2211`. Existing diagnostic auth command is network-backed (`index.mjs:845`, `index.mjs:924`).

## Changes and pseudocode

```text
effectiveCredential(host):
  honor gh's host-specific env precedence
  otherwise obtain selected host's credential through local gh auth token
  digest it privately; never log/store/return bytes to UI or wire

identityRegistry[credentialKey] = {
  verified principal kind/id, authorizationGeneration, observedAt
}
quotaScope = hash(host, verified principal kind/id)
accessScope = hash(host, effectiveCredential, authorizationGeneration)

before identity proof:
  host-wide private bootstrap claim serializes one unknown identity request
  authenticated /user observation supplies user identity + core evidence
  installation-provider identities are established separately in phase 11
  opaque/unknown credentials remain isolated; never guess from token prefix

on effective credential change:
  cancel unstarted work; unsubscribe old access partition
  fence old data completion; keep its quota settlement in the original ledger
```

The local credential retrieval is a deliberate revision of the previous `SECURITY.md` statement that `gh auth token` is never invoked. It must have a dedicated non-logging seam: capture only in memory, digest immediately, discard references, never interpolate into command arguments/errors. Do not read keychain databases directly. Cache resolution per process until relevant host configuration/provider changes; unrelated host changes may re-resolve but cannot change equal effective identity. Do not mutate user `gh` login/config.

Introduce the minimal shared transport-control foundation in this phase: a private host-level bootstrap guard, one HTTP permit at a time, 250 ms minimum start gap, persisted cooldown deadline merged by maximum, and an admission adapter for the existing fetchers. Each actual HTTP call obtains the permit; do not hold one outer batch permit while waiting for nested endpoint permits. A porcelain subprocess remains conservatively one bounded legacy operation until phase 3 removes its hidden pagination. Full error classification, primary refunding and resource isolation belong to phase 4; phase 3 consumes these already available primitives.

Persist bootstrap allowance before subprocess start: at most three attempts per effective credential/resource in a rolling 15-minute window, and at most twelve unknown-principal attempts per host in that window. After identity proof, continue the same attempt/debit history under its quota principal; mapping is not a reset. An owner crash, malformed response, restart, manual refresh or lease expiry does not replenish allowance. Retain a one-unit worst-case charge per started REST/GraphQL control attempt until trustworthy reconciliation or the applicable window reset; unknown attempts carry debt forward until their principal/epoch is known. Retry no sooner than 60 seconds with exponential delay, and stop until the oldest attempt leaves the rolling window when allowance is exhausted. Known exhaustion waits for its actual reset before any recovery attempt; reset authorizes eligibility, not bypass of the rolling attempt cap or secondary hold.

Use a private coordination-root registry/lock to serialize identity mappings and migration; lock order is root registry before an individual quota ledger, with bounded waits and no network under lock. Pending bootstrap requests are recorded conservatively and transferred exactly once when identity is proven. Distinct tokens for the same verified user share quota, but never cached private payloads by account ID alone. Different installation/user principals remain separate.

### Migration behavior

Refuse activating the new namespace while discoverable legacy leases are live. Report a clear restart-required condition; do not kill panes or delete files. After leases stop, reconcile legacy started/uncertain costs and holds; if authoritative coverage cannot prove them accounted, wait through the affected reset. Preserve legacy files as evidence. Use one migration transaction/root marker so simultaneous new panes cannot independently bootstrap empty scopes.

Legacy schemas and unknown versions fail closed. Detect reappearing legacy leases during operation and pause affected migration/new admission. Document that arbitrary old binaries launched later, or old panes in other config roots, cannot be made participants by a sentinel they do not read. No mixed-version guarantee is claimed. Update ADR 0003 with this controlled restart boundary.

Replace free network-backed failure auth diagnosis with cached verified identity or an honest unavailable state. Full admitted repository diagnostics migrate in phase 3.

## Automated acceptance

- `ID-01`: same token under either applicable env variable yields one identity/ledger; an unused enterprise token changes neither github.com scope nor access identity.
- `ID-02`: two credentials verified as one user share quota but cannot hydrate each other's rows; user/installation and different hosts remain separate.
- `ID-03`: account switch cancels old unstarted work; delayed completion settles old charge without publishing new-account rows.
- `ID-04`: twelve new processes create one mapping/bootstrap claim; denied/malformed identity evidence authorizes no data.
- `ID-05`: live legacy pane blocks transition; after it exits, uncertain charges/cooldowns survive migration; corrupt state is never reset to empty.
- `ID-06`: seeded tokens are absent from logs, argv, error text, disk JSON, snapshots and doctor output; failure diagnostics start zero unadmitted API requests.
- `ID-07`: malformed observer responses and repeated owner death cannot exceed persisted credential/host bootstrap allowance; restart/manual refresh cannot clear allowance or uncertain debt.
- `ID-08`: every current acquisition/control operation uses the new permit seam without nested-permit deadlock; concurrent panes share the start gap and existing cooldown.

Run all parent gates sequentially. Exercise old/new protocol handoff with a pinned test fixture of the legacy protocol, not network-installed old packages.

## Manual success criteria

None for implementation. Restarting real user panes is a documented upgrade action, not an action this phase performs automatically.

## Completion

- [x] Identity, privacy boundary and migration protocol implemented and documented.
- [x] ID scenarios and parent local gates passed.
- [x] Independent compliance/quality review complete; integrated locally; stop.

Two independent reviews ran against the finished worktree: a plan-compliance
review (APPROVE WITH FIXES, 8 defects) and a quality/correctness review (BLOCK,
14 defects). Every defect was fixed before integration. Neither review found a
violation of a non-negotiable invariant, a credential leak, a lock-order
inversion or a nested-permit deadlock.

Three reviewer recommendations were deliberately not taken, each because it
conflicted with something the spec requires:

- Short-circuiting `inspectLegacyMigration` on `migration.activated` would be
  faster but would stop legacy leases that reappear *during* operation from
  pausing admission, which this phase requires. The unconditional registry
  rewrite was removed instead; that, not the directory scan, was the cost.
- Retiring aged-out bootstrap attempts on window age alone would discard an
  exhaustion hold, because settlement pushes `retryAt` out to reset plus grace,
  past the rolling window. Retirement additionally requires `retryAt` to have
  passed.
- Memoizing `credentialConfigurationRevision` would defeat the before/after
  comparison that brackets the `gh auth token` subprocess, so a credential
  swapped during a sub-millisecond local resolution could bind to the wrong
  identity. The per-request call count was reduced instead.
