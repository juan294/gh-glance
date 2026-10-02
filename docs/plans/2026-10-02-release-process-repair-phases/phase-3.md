# Phase 3: candidate artifact and workflow repair

Parent: [release process repair](../2026-10-02-release-process-repair.md). Entry: accepted Phase 2 selectors/helpers. Status: **locally complete** -- see [validation](phase-3-validation.md).

## Outcome and scope

Resolve A01/A02/A08 and G01/G02/G03/G09. One successful release-PR selection produces the tarball that publication consumes after protected tree-equal promotion. Missing proof prevents publication with a visible recovery action. All changes and fixture verification stay local in this phase.

Current sources: [ci.yml:3](../../../.github/workflows/ci.yml:3), [:34](../../../.github/workflows/ci.yml:34), [:114](../../../.github/workflows/ci.yml:114), [release.yml:27](../../../.github/workflows/release.yml:27), [:94](../../../.github/workflows/release.yml:94), [:111](../../../.github/workflows/release.yml:111), [coverage.yml:3](../../../.github/workflows/coverage.yml:3). Read deployment-safety and testing rules before editing.

## Changes

1. Introduce small importable Node release helpers under `scripts/`, tested under `test/`, for candidate manifest validation, trusted run/artifact selection, tree identity, registry outcomes and installed delivery proof. Keep CLI side effects separate from pure decisions so tests exercise the real decision code. Do not add a release database, policy compiler or product dependency.
2. Define two explicitly distinct inputs to the final receipt. The immutable uploaded manifest contains repository ID/full name; PR number/head/base; tested checkout commit/tree; workflow path/ref/run/attempt/event; profile and expected selections; package version/allowlist; Node/npm/platform/dependency-lock identity; and tarball SHA256/SHA512 integrity. It contains no self-referential upload ID/archive digest/expiry or future test outcomes. Trusted upload/job/API outputs supply artifact ID/name/archive digest/expiry and actual job results as an external identity envelope. After the run completes, the verifier joins these into the final receipt and rejects any envelope/run/manifest mismatch. Validate field types/limits and reject unknown schemas. Recompute tree/digests; do not trust success booleans in downloaded JSON.
3. Route CI as parent D4 specifies. Preserve the old eight context names for the first rollout while adding `Release candidate`; they report real selected work, not fabricated green placeholders. The aggregate runs under `always()`, requires all selected jobs and artifact proof, and rejects missing/skipped/canceled work. Nonrelease PRs remain read-only and cannot produce publishable candidates. No pull_request_target execution of candidate code.
4. The pack job uses pinned Node/npm, locked `npm ci`, and one `npm pack --ignore-scripts --json`. Upload this provisional immutable tarball plus input manifest once, retained for 30 days. Pass the resulting artifact ID to Node/platform test jobs; they download and hard-check that same artifact before using Phase 2's exact-tarball helper. Never overwrite or repack it. The aggregate checks all selected test outcomes; only its success and the completed successful run make this artifact publish-eligible. Record the installation basis: source behavior uses locked dependencies, while an isolated consumer installation resolves the package's published ranges and records its actual dependency tree. Node 22/24 and fixture-backed installed CLI smoke validate both. Keep product scripts/tests out of the five-file tarball; failure diagnostics are separate seven-day artifacts.
5. Run fast behavioral compatibility on Node 22/24. Run required sustained/efficiency/full Linux terminal selections once on the designated Node 22 runner, adding Node 24 extended checks only for a documented runtime/dependency risk. Jobs on separate hosted runners may run in parallel; each runner's gates and PTY files stay sequential. The aggregate records expected matrix members and never infers completion from one green member.
6. Remove push-triggered full coverage. Keep scheduled/manual coverage, actual counts, source SHA and denominator in Portfolio reporting. The release driver does not wait for this observer. Keep CodeQL and dependency review required; inspect any routing change against their security coverage. Do not change Sutura infrastructure or enable auto-merge of its repairs.
7. Replace publisher rebuild/retest with trusted receipt/tree/artifact verification. A read-only bootstrap uses trusted workflow/API logic to establish the tag's protected-main merge association before executing any tagged script; use an independently validated protected-main verifier revision and treat the tag/artifact as input until that proof passes. Resolve exactly one successful eligible run/attempt for the approved merged release PR. Download by ID using read permissions; compare archive digest and inner tarball SHA/integrity as hard failures, and reject traversal, unsafe links, duplicate/extra packaged paths and oversize input. Never run candidate artifact code in the id-token-enabled job. Retain environment `npm` and the sole published-release trigger.
8. Prove protected merge tree equality, exact tag/package/changelog/version, expected main merge ancestry and approved PR association. Main push performs this identity check without repeating full suites. If a base update or tag changes tested inputs, no repack fallback is permitted; return to a new approved candidate gate. The comparison includes harness/workflow/lock files, not only packaged files.
9. Pin initial publication Node 22.22.2/npm 11.21.0; pin compatibility Node 24.21.0. Publish explicit tarball using `--ignore-scripts --provenance --access public` with OIDC only. `release.yml` and environment `npm` remain unchanged. Use package-level concurrency with cancel-in-progress false. Query exact registry version after acquiring the publish slot: verified absence permits publication, exact digest match skips mutation and verifies delivery, mismatch fails, auth/network errors remain unknown. Refuse unexpected dist-tag regression.
10. Delivery job has no publish credential. Poll metadata/provenance/tarball with capped backoff and a five-minute deadline, check integrity and expected latest, install into an empty owned directory, verify bin plus exact version/help on both majors, then emit the current receipt. Do not use repository npx or global installed package resolution. Record candidate `gitHead` separately from protected publication provenance; no tarball rewriting.

## Nontrivial behavior

```text
@ acceptCandidate(run, artifact, merge) -> verifiedTarball
ctx: GitHub run/artifact/PR readback, trusted Git objects
do:
  1. validate repo, workflow, event, head/base and successful attempt
  2. validate every selected result and expected artifact identity
  3. compute tested and production trees plus archive/tarball digests
  4. validate tag, version, changelog and protected PR association
  5. emit verified path and immutable receipt
fail: missing, ambiguous, expired or unequal evidence -> block publication
```

```text
@ publishVerified(receipt, registryState) -> publicationState
ctx: serialized OIDC workflow, exact tarball, pinned npm
pre: actual release authority and verified protected candidate
do:
  1. validate current registry response class and dist-tag intent
  2. compute exact-version integrity equality when present
  3. emit publish-once action only for proven absent version
  4. write observed result before bounded delivery verification
br: matching version -> verify delivery; uncertain response -> read back
fail: collision or unavailable identity proof -> block with recovery action
```

## Test-first proof and verification

Implement R05/R06/R07/R08 with fake GitHub/registry boundary responses and real temporary Git histories, archives and installed executables. Cases include PR head vs merge SHA, same tree/different commit, changed test-only file, changed lockfile, branch advance after approval, wrong repo/event/workflow/attempt, forged receipt success, failed/skipped matrix job, artifact expiry, replacement ID, envelope/manifest mismatch, digest mismatch, traversal/symlink payload, same version/wrong bytes, unknown HTTP response, registry lag and missing provenance. An unprotected tag containing a modified verifier must execute neither tag code nor publication. A failed candidate's provisional artifact remains ineligible even if its manifest claims success.

Use the actual pinned npm CLI with a loopback test registry and a disposable fake package to capture publication bytes/arguments and prove lifecycle suppression. No public registry write or real credentials. This proves the tarball path; it does not prove OIDC, trust configuration or real registry provenance. Record native publisher proof as outstanding until Phase 4's authorized release. A dry-run command that bypasses lifecycle behavior is insufficient as the sole oracle.

Simulate all workflow events and required-check inventory with the checked-in workflow files as inputs: develop push gets quick checks, release PR gets one authoritative selection, main and publisher get zero full-suite invocations, coverage has no push event, and foreign PR artifacts cannot publish. Test interruption in the planned protection transition without calling GitHub settings APIs.

After focused red/green tests, independent review, repair and simplify, run sequentially: `npm run lint`, `node --check index.mjs`, `npm test`, `npm run test:efficiency`, and `npm run test:pty` because this phase changes their CI selection/entry paths. Validate YAML with an available pinned/local validator or focused structural parser; do not download an arbitrary executable during release. Validate the exact package once and retain its result. Coverage reporting tests must pass; run full coverage only if its measured selection actually changed. No invented typecheck/build command.

Acceptance: all negative cases fail closed and expose recovery; all matching positive cases publish exactly the tested bytes to the local fixture; workflow inventory has no hidden full-suite copies. Package/runtime platform limits and OIDC remain explicitly unverified if no native run exists. No claimed reduction in hosted minutes yet.

## Transition and handoff

No batch-eligible implementation split: workflows, candidate receipt and artifact helpers depend on each other. Independent security/identity review is useful and read-only. Save old/new expected contexts and an exact add-before-remove settings payload for Phase 4, preserving all unrelated protection fields. Do not apply it here.

Local acceptance permits integration into develop; it does not permit push. Next entry: Phase 4 builds the driver and activation dossier around the completed tested implementation. First remote activation must keep the legacy context bridge until the new aggregate is observed and required.
