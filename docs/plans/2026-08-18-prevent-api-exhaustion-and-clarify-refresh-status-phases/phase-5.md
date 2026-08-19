# Phase 5: document and validate the complete architecture

> Parent: [`../2026-08-18-prevent-api-exhaustion-and-clarify-refresh-status.md`](../2026-08-18-prevent-api-exhaustion-and-clarify-refresh-status.md)
> Depends on: Phases 1 through 4
> Batch eligibility: no

## Objective

Record why the controller changed, update every current user/developer promise,
regenerate real terminal examples, and validate one complete candidate. Keep
released changelog entries as historical truth.

## Documentation changes

### New `docs/decisions/0003-file-backed-api-coordination.md`

Record:

- the live 5,000/5,000 exhaustion evidence and corrected 0.8 semantics;
- the hard per-resource reserve and exact enforceable guarantee;
- why token-counter inference alone is delayed feedback;
- why a private file protocol was selected over a daemon;
- host/account scope and privacy boundaries;
- atomic grants, reservations, probe ownership, crash recovery, and fail-closed
  behavior;
- separate REST/GraphQL control;
- why the 60-second clamp was removed;
- external-consumer and cross-machine limits;
- compatibility with ADR 0001's independent fetchers and ADR 0002's terminal
  lifecycle.

Do not rewrite ADR 0001 or ADR 0002. Add cross-links only if they help readers
find ADR 0003.

### `README.md`

Update these current sections:

- `README.md:12-18`: qualify the five-second default as a healthy single-pane
  floor, not an unconditional request frequency.
- `README.md:20-38`: regenerate the real terminal sample with final status copy;
  do not hand-edit captured output.
- `README.md:80-96`: explain Watching, Checking, Waiting, Paused, Failed, and
  Limited, including motion behavior.
- `README.md:313-332`: explain that `--refresh` is a floor and
  `GH_GLANCE_NO_ANIMATION=1` stops motion, not status reporting.
- `README.md:358-387`: distinguish last-good dashboard cache from private
  account governor state and list what neither stores.
- `README.md:389-420`: state effective host resolution and same-host routing.
- `README.md:422-455`: document governor health in `--doctor`.
- `README.md:457-507`: replace the “slows to fit, up to 60s” and “nothing is
  shared” claims with hard reserve, shared grants, separate resources, and the
  guarantee boundary.
- `README.md:577-600`: add troubleshooting for Waiting, Paused, stale cache,
  coordinator unavailable, and rate-limit blocks.

State plainly that `next HH:MM` is one current grant time, not a recurring
polling promise. State that manual refresh cannot bypass a held budget.

### `SECURITY.md:102-116`, `SECURITY.md:149-161`

Document private governor content, modes, scope hashes, credential boundaries,
and fail-closed behavior. Confirm no raw token/account/repository data is stored.

### `CONTRIBUTING.md:100-128`, `CONTRIBUTING.md:183-199`

Replace the process-local throttle invariant with:

- one authoritative cost table;
- every data call needs a grant;
- budget probe and data timers are independent;
- lock failures deny calls;
- started reservations are conservative;
- UI activity starts only after grant admission;
- 12-process and PTY fixtures are required for governor changes.

Keep the single `runGh` seam and no-build-step policy.

### `CHANGELOG.md:8-18`

Add an Unreleased fix/changed entry for hard reserve, coordinated panes,
resource isolation, startup/reset spreading, and truthful status. Fold the
existing unreleased manual-spinner item into the new status behavior if needed.
Do not edit released v0.7/v0.9 statements; they describe those releases.

## Final verification

Run the full sequence against one working tree and record the exact candidate
commit/tree in the validation handoff:

```bash
npm run lint
npm test
node --check index.mjs
npm run test:pty
git diff --check
```

Also run these focused checks and record their commands/results:

- 12-process governor suite;
- 12-pane PTY startup/exhaustion/reset suite;
- private-file mode and content scan;
- no-color/no-animation/screen-reader captures;
- 80/60/45/24-column geometry captures;
- `--doctor` governor-health output;
- real sample generation used by README.

Verification must be sequential. Do not combine evidence from replacement
candidates.

## Manual validation

With the candidate installed locally:

1. Start 12 panes on one account/host with a mix of Actions, Issues, pull
   requests, and Security.
2. Observe for at least 20 minutes and across one rate reset.
3. Compare governor reservations/completions with GitHub's resource counters.
4. Confirm gh-glance-attributed work does not enter the 1,000-call reserve.
5. Confirm unrelated external spend can reduce/pause grants and is not presented
   as a guarantee violation by gh-glance.
6. Confirm every pane makes fair active progress while capacity exists.
7. Confirm core exhaustion pauses only REST tabs while GraphQL tabs continue.
8. Press `r` in open, waiting, and paused states and verify prompt truthful
   feedback with no unsafe bypass.
9. Confirm there is no permanent footer animation or accumulated status line.
10. Repeat a pane with no color and no animation.

## Automated success criteria

- All required documents describe the implemented behavior and its limits.
- README terminal output is generated from the actual candidate.
- Historical research, plans, ADRs, and released changelog entries remain
  historical rather than being rewritten.
- The complete verification sequence passes on one exact candidate.

## Manual success criteria

- The 12-pane real-account run matches the executable policy and UI contracts.
- A reader can distinguish normal pacing, queued work, a protective pause, a
  live request, incomplete Security visibility, and a failure without relying
  on color.
- `--doctor` gives enough coordinator information to diagnose a stuck pane
  without exposing private account data.

## Stop condition

Stop with a final validation report. Do not push, publish, release, or modify
production state without a separate explicit authorization.
