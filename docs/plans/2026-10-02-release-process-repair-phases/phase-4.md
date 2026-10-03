# Phase 4: resumable release driver and authorized activation

Parent: [release process repair](../2026-10-02-release-process-repair.md). Entry: accepted Phases 1–3. Status: **local implementation complete** -- see [validation](phase-4-validation.md); external activation separately gated.

## Outcome and scope

Resolve A04/A05/A07/A08 and G03/G08/G10 operationally: one small command exposes the actual release stage and carries existing authority through ordinary steps. Interruption, tool restriction or registry lag has a finite, visible recovery path. Local implementation ends with a reviewable activation dossier. Production rollout and the next two release measurements occur only under their explicit authority.

Reuse Phase 3 helpers and [existing branch topology](../../../CLAUDE.md:49). Preserve [F12 and the publication exception](../2026-09-28-durable-freshness-and-recovery-phases/phase-4.md:38). Optional observer identity comes from [sutura.yml:4](../../../.github/workflows/sutura.yml:4), not its own SHA.

## Local implementation

1. Add `scripts/release.mjs` with `prepare`, `status`, `resume` and `--dry-run`. Keep automation limited to this repository's existing gh/git/npm-publication sequence. No new persistent service, credentials or arbitrary workflow dispatch. `prepare/status` are read-only externally. Dry run uses fixture API/command adapters and cannot execute mutations.
2. Preflight once: correct clean owned worktree, effective executable paths/runtime, package/lock/changelog version, main ancestry and PR topology, existing release PR, required contexts, workflow triggers, artifact availability and permitted publication route. Prepare ancestry locally before the candidate gate; never use an empty-tree claim without proving the resulting tree. Do not pull through a dirty shared checkout.
3. Use an atomic private receipt plus one tracked redacted current release report. Fields include approved version/scope/limits and authorization reference, exact candidate/run/artifact, stage/blocker/next action, retry allowance consumed, timings and owned cleanup paths. Record intent before an external operation and readback after it. A local file or command flag is not owner approval. Unknown/corrupt schema yields actionable status, not guessed continuation.
4. Serialize one release driver for the same workspace/release using an exclusive lock with recorded process identity. Do not steal a live lock; a stale owner requires verified process death and state readback before reclamation. An interrupted operation is reconciled against GitHub/registry before any repeat. Tag, release and version are immutable identities for this workflow; wrong targets block.
5. Run observation uses the exact required workflow/PR/run/attempt inventory. Check terminal failures immediately; cap each hosted wait at 40 minutes with elapsed/remaining status and a resumable result. No automatic reruns or fix-and-repush outside explicitly supplied corrective allowance. Sutura/coverage are visible optional observers and never block publication; correlate Sutura by its source workflow run ID and report actual outcome if available.
6. Before publishing the GitHub release, verify the permitted CLI path. Fall back to allowed browser automation only after genuine CLI failure; preserve tag/version/notes and verify resulting release ID/readback. Automatic policy denial is explicitly disclosed and never treated as solvable by another routine “go ahead.” A tool route that is unavailable cannot be represented as success.
7. Delivery uses Phase 3's bounded verifier. If publication succeeded but registry/provenance/install remains incomplete, report that exact split, persist it, and allow a read-only later resume. Verify effective Node/npm/global executable resolution only when an explicitly authorized global installation is part of this release; ordinary delivery uses disposable installs.
8. Cleanup removes only receipt-owned temporary directories/worktrees/branches/processes after durable evidence is preserved and Git refs/status prove ownership. Keep unrelated macos-rules, the assessment, other worktrees and existing sessions untouched. If ownership cannot be proven, disclose retained state and stop that cleanup action while preserving delivery truth.

## Operational evidence and incident boundary

No live canary is required for this process-only change. For a later change with a named live risk, the playbook prepares a finite manifest offline first. Default budget: one already running Actions pane kept on Actions, five minutes maximum, zero new panes/restarts, at most 20 extra admitted calls and conservatively charged units per resource, and the floor in parent D5. Include setup, quota reads and final comparisons in the same budget; unknown charge stops new requests. Never pause Cirujano/Upptime or migrate credentials as an implicit prerequisite.

Use current schema 2 for continuously active Actions only. Keep a complete immutable cohort/candidate; the existing monitor validates clock, PID/scope, elapsed duration and source advancement, not rendered output. Obtain separate bounded terminal captures for actual row/payload comparison and visible capability notices. If the existing session has no supported passive capture route, record rendered evidence as unavailable; do not substitute store flags, launch extra panes or ask the owner to operate the terminal. Before measurement, establish readiness and endpoint capability without changing repository settings. A feature-disabled response requires endpoint-specific provider evidence plus the actual visible notice; generic 403/404 is insufficient.

Use existing deterministic terminal regressions for opening/manual-refresh/cached secondary views and no unsolicited requests. If a real secondary interaction is part of a later authorized canary, put it in a separately bounded scenario with explicit request/completion proof; it is not a perpetual cadence window. Missing live secondary evidence is disclosed, not inferred from an Actions-only monitor. No schema weakening or new generic qualification framework is introduced.

Sleep, sampling gaps, unexpected holds, candidate changes or budget stops invalidate affected live evidence. Personal/work EMU 30-minute and uninterrupted 24-hour F12 requirements still belong to the incident. This phase cannot close them with a five-minute window, successful publication or an unavailable work environment.

## Nontrivial behavior

```text
@ resumeRelease(receipt, authority, observedState) -> nextStage
ctx: Git, GitHub and npm readback, owned workspace lock
do:
  1. validate receipt identity, actual scope authority and lock ownership
  2. lookup prior intended action in authoritative external state
  3. compute next necessary covered action or exact blocker
  4. write current stage before action and observed outcome afterward
  5. emit status with remaining pipeline and evidence limitations
br: already complete -> verify delivery and cleanup; ambiguous -> read only
fail: scope change or exhausted allowance -> disclose required decision
```

## Local verification and acceptance

R01/R09/R10/R11 are executable against real local repositories/processes with GitHub/registry/clock boundaries simulated. Inject interruption before and after push, PR creation, merge, tag, release creation and publish acknowledgement. Verify readback prevents duplicate mutation. Simulate conflicting locks, malformed receipts, stale candidate, wrong event SHA, missing runs, canceled checks, exhausted allowance, CLI failure, forbidden browser route, delayed registry, absent EMU, bad capability evidence, quota-floor stop and unsafe cleanup path. No public side effects are needed.

Test the proposed protection migration from the captured eight-context shape: first update adds `Release candidate` while preserving all old contexts; readback confirms it; second update removes only superseded contexts and retains CodeQL/dependency review, strict up-to-date checks, admin enforcement and all unrelated policy. Unknown settings drift stops mutation. Repeated resume converges without bypassing protection.

After red/green, independent review, repair and simplify, run sequentially `npm run lint`, `node --check index.mjs`, `npm test`. Run `npm run test:efficiency` and `npm run test:pty` only if this phase changes their selectors, fixtures, monitor semantics or terminal execution; otherwise reuse Phase 3 exact-input results and record why they remain valid. Run one complete local fixture release trace and inspect its actual command counts, timing and cleanup. A trace is not hosted acceptance.

Manual acceptance is the concrete driver/status output and activation dossier. Do not ask the owner to execute commands. The dossier contains the final local commit/tree, verification results, expected workflows, exact protection changes/readback checks, proposed version, accepted limitations, optional single-correction allowance, allowed publication route and fallback. Finish all authorized local work before seeking any missing external authority.

## Separately authorized activation

1. Revalidate remote refs/settings and the accepted local candidate. Obtain the one explicit release/activation decision only if absent, including settings migration and publication. A planning or implementation approval alone does not cover this step.
2. Perform the single authorized integration push and normal develop-to-main release PR. Observe the exact expected workflows. The first candidate uses broad coverage and the old required contexts plus the new aggregate. Diagnose a failure locally; use at most the specifically authorized correction, otherwise present the concrete repaired candidate for the missing decision.
3. When the new aggregate is observed successful, add it to required protection alongside the old contexts; verify readback; retire only the superseded contexts. If the transition stops halfway, the stricter set remains and resume explains the exact next step. Never remove a requirement before its replacement is observed and active.
4. Merge with a normal merge commit after all current required checks pass. Verify actual merge tree, candidate association and main identity result. Create the exact tag and publish its GitHub release using the authorized route. Observe OIDC publication and exact registry/provenance/install proof. This is the first native acceptance of the new tarball path, not a preclaimed result.
5. Save the compact tracked current receipt after delivery. A receipt-only follow-up commit must not be folded into the already frozen/released candidate; leave it local unless its publication is explicitly covered, or include it in the next ordinary integration. No extra push just for reporting. Preserve historical failed runs and accepted F12 limitations.
6. Keep the legacy job-name bridge until the protection migration is verified. Remove obsolete compatibility contexts in the next normally authorized change if needed; never trigger a separate experiment merely to tidy names. If new publication validation fails, leave the existing npm release available and repair locally; no workaround directory publish or token fallback.

Measure actual timestamps/counts on this and the next authorized release against the parent targets. Do not create two artificial releases to obtain measurements. Report each target as met/missed/unmeasured with the stage responsible. Local implementation acceptance and first hosted rollout acceptance are separate from completion of the two-release observation and from F12 incident closure.

## Handoff

One implementation owner; no batch-eligible units because the driver, receipts and transition tests share contracts. Save a local completion note with exact candidate, checks, dry trace, unresolved native evidence and the complete reviewable activation dossier. On resume, revalidate everything that can drift before using authority or evidence. Cleanup follows durable handoff, never precedes it.
