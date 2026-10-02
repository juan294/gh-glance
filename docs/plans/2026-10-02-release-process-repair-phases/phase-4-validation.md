# Phase 4 validation: resumable release driver and activation dossier

Status: **local implementation complete after independent review (three rounds), repair and simplify. Activation not performed.** Nothing was pushed; no protection setting, release, tag or publication changed. The [activation dossier](../../release/release-process-activation.md) is the reviewable package for the owner's separate decision.

- Worktree `/Users/juan/code/gh-glance-release-repair`, branch `release-process-repair`, on top of the Phase 3 commit `c1442b6`. Tested tree: `427df5377a6f9137c2149915da44244f6f0a9a38`.

## Local items

| Item | Result |
| --- | --- |
| 1 Driver | `scripts/release.mjs` `prepare`, `status`, `resume`, `protection`, `--dry-run <fixture>` (strict argument parsing; a `--dry-run` without a readable fixture is refused before any world exists). |
| 2 Preflight | Clean tree, versions, changelog, `origin/main` and `origin/develop` ancestors of HEAD, notes file, registry and tag absence, open release PR, required contexts, `gh` auth, runtimes. `resume` re-runs the local gates before its first mutation. |
| 3 Receipt | Atomic private receipt under `.git/gh-glance-release/vX/`, schema 2: approved authority kept as recorded (later records appended), candidate, stage, current blocker and append-only history, intents, observed run/merge/integrity, timings, owned paths. Tracked report via `status --report` replaces only a marked block. |
| 4 Lock | Exclusive lock with pid, host and process start time; receipt read only while holding it; a dead or pid-reused owner's lock reclaimed by rename-aside and recheck, restored with a no-replace link otherwise. |
| 5 Observation | Required checks merged per name (fail > pending > pass), required contexts from protection; 40-minute bound for checks and publisher, 5-minute for delivery, elapsed/bound shown. Sutura and coverage are never waited for; Sutura correlation by triggering run ID is **PARTIAL** (shown as not correlated). |
| 6 Routes | `gh` first; the documented fallback for the release step is the web form for the same tag and notes, then readback. Tool failures are reported as such, never retried through another route. |
| 7 Delivery | Publication and delivery are separate: a successful publish job advances; a failed or missing Delivery job stays "published; delivery unverified" until a read-only `deliver` receipt that matches this version, merge commit, passed provenance and the served integrity is supplied. |
| 8 Cleanup | `--own <path>` registers paths; only one holding a `.gh-glance-release-owned` marker naming this release, never the checkout or an ancestor, is removed (`git worktree remove` for worktrees). |

Plan conformance: R01 (with the recorded deviation: merge needs publication authority), R06 (protection planner; PTY `app_id: null` sent as `-1`, INFERRED until readback), R09 (simulated crash after every side effect; lock with injected liveness; no real process kills), R10 PARTIAL (offline canary planner and stop rule validated by the monitor's own `validManifest`; no live runner), R11 (report keeps every blocker; authority text is the owner's free-text reference, not redacted).

## Review

1. CHANGES REQUIRED: two blockers (a bare `--dry-run` fell through to the real world; push used local `develop` and could repeat without limit) and nine majors (unpinned merge, lost publish/delivery split, too-wide correction scope, authority not bound to a candidate, receipt read before the lock and a reclaim race, R01 conflict, untested real adapter, no failure history, incomplete preflight), plus minors. All fixed: DRV-04, -06, -07, -09, -14, -16 and others pin them.
2. CHANGES REQUIRED: two majors (the driver could report complete with a failed Delivery job; a correction forced rewriting the owner's authority file). Fixed with DRV-07 and a full correction flow through the CLI (DRV-17).
3. APPROVE, with two minors (cross-check a supplied delivery receipt; spell out the read-only recovery command), both applied.

Simplify (two combined angles): lazy local facts (`status` reads only the receipt, `resume` skips tool probes), one protection read per process, the aggregate observation as one check-runs query bound to the open release PR head, publisher reads by known run id, fetch only for unknown objects, the registry read shared with `release-candidate.mjs`, a pure tested `reconcileReceipt` (DRV-18), one stop path in the resume loop, dead fields removed. Kept deliberately: the local `writeAtomic` (creates the directory and private file modes), `PUBLICATION_STAGES` including observe-only stages (clarity), the fault-injection knobs in the dry-run world (they also serve `--dry-run` fixtures).

## Evidence

- Mutation checks: no-publication coverage, act-once guard, readback-before-act, head pin, candidate push, history, publish/delivery split, live-lock protection, protection add-before-remove, unknown canary charge, failed-check detection: each caught. The `--dry-run` existence guard has an equivalent fallback (a missing fixture throws before any world is built).
- Real read-only use on 2026-10-02: `prepare 0.16.2` (lists the expected blockers, including the v0.16.1 merge-back and the newer `origin/develop`), `protection` (wait), `status`, registry reads of 0.16.1/0.16.9, the v0.16.1 release run's jobs, and the check-runs lookup. No mutating real call was made.
- Local fixture trace (CLI dry run, final code): full authority completes with 17 reads and 5 mutations (push, pull-request, merge, tag, release), each once, in 0.18 s; without publication it stops at the merge after 8 reads and 2 mutations (push, pull-request) with the exact missing decision.

## Checks (sequential, exits retained)

| Check | Result |
| --- | --- |
| `npm run lint` | 0 |
| `node --check index.mjs` | 0 |
| `actionlint .github/workflows/*.yml` | 0 |
| `npm test` | 0; 808 passed, 0 failed, 252 s (Node 24.21.0) |
| Targeted | release-driver 18/18 and release-policy 6/6 cases (24 tests) after the last change |
| `npm run test:efficiency`, `npm run test:pty` | Not rerun: Phase 4 changes no terminal, fixture, selector, acquisition or efficiency input (its only edit outside new files is exporting `readRegistry` from `scripts/release-candidate.mjs`). Phase 3's final-tree results stand: PTY 159 passed, 1 known skip, 0 failed; efficiency 9/9. |

## Handoff

Activation (integration push, release PR, protection migration, merge, tag, publication) waits for the owner's decision described in the dossier. After that release, record the operational measurements against the plan targets; F12 stays OPEN.
