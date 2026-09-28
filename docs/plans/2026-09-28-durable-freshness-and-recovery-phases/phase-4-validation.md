# Phase 4 validation: installed personal and EMU qualification

Status: locally verified candidate prepared; Phase 4 activation awaits a concrete operational decision. F12 remains unmeasured. No live installation, migration, session restart, workflow dispatch, push, release, or employer change has occurred.

## Candidate prepared for activation review

The accepted Phase 3 commit is `301c9ec67f8407b489b2eb7b950ead1a0751592b` (tree `2f16930ff33fe99b7230a1bb3d917ec514851bc4`). Its private read-only candidate is `/Users/juan/Library/Application Support/gh-glance/candidates/sha256-bd23a891011902014aed4d86e44290c9add13ab9d4115e8238b2049992f06c35/gh-glance-0.15.2.tgz`, SHA-256 `bd23a891011902014aed4d86e44290c9add13ab9d4115e8238b2049992f06c35`. The extracted executable SHA-256 is `b92d6265c8222498f15d6a384da71b6c55ed2221af5eab18ad3a5d97b817f684`, matching the accepted tree. A private `provenance.json` beside the tarball records the commit, patch, oracle, package and executable hashes, fixture seed, and local gates.

The extracted-package PTY test passed against aged v6 state and rendered queued, running, and completed Actions rows. A separate empty-working-directory smoke installed this retained tarball into an isolated prefix, used an isolated config root, and reported version 0.15.2 with the same executable hash; it resolved `ink` 7.1.1 and `react` 19.3.0. The standalone package includes its manifest, executable, README, changelog, and license. This is local evidence only.

## Read-only inventory, 2026-09-28

| Environment | Observed identity and executable | Source and cohort evidence | Disposition |
| --- | --- | --- | --- |
| Personal GitHub | `gh auth status --json hosts` reports one active `github.com` login through the existing keyring. `command -v gh-glance` resolves to the global Node v24.21.0 installation; `gh-glance --version` reports 0.15.2. Installed `index.mjs` SHA-256 is `a05d47418387e9ce30eec2e9c8cf5310f240ccb7bcbe523bfb7d392350a68f5a`. | Read-only `gh-glance --doctor` without `--probe` reported healthy acquisition metadata and unobstructed lock, 44 active queries and 44 subscribers, with old source successes. Its non-probe governor section is explicitly unavailable, so it cannot establish present capacity or v7 recovery. | Existing installation is stale; candidate recovery and live windows unmeasured. |
| Work EMU | Current `gh auth status --json hosts` exposes no verified work login or enterprise host. The connected Chrome inventory exposes a personal profile only. | The work screenshot in the research establishes staleness on 0.15.2, but gives no current host, authenticated class, ledger, pane cohort, or causal state. | Host, access, cause, candidate recovery, and live windows unmeasured. |

The personal doctor output is retained privately at `/tmp/gh-glance-phase4-preinventory-doctor.txt`. It did not use `--probe` and did not mutate the ledger. Source success ages and acquisition counters in that output are historical telemetry, not a current freshness qualification.

A second read-only file inventory at 2026-09-28 22:48 UTC found one `github.com` user identity in registry v1, acquisition v1 with 76 query records and 44 subscriptions, and one quota ledger v6. The respective file SHA-256 values at that instant were `02b5a04678a68e66e5d5306c87cc155950fd79758f378a623d2b6898873be91c`, `1d85ae3570c63ca102c37db20bea96c468b028638ab90683a1ae3bc6f31756af`, and `cf45fa07b38aa9a8d2a467280df3b31c250c2704616f8cf728abbb1ae7d757ae`. Existing panes continue writing these files. Capture a fresh private byte snapshot immediately before any authorized migration; these inventory hashes do not substitute for that snapshot.

A later read-only subscription check found all 44 records unexpired across 11 live process IDs, covering Actions, Issues, Pull Requests, and Security. This is the current personal restart scope to reconcile before activation; the exact process/cohort inventory must be recaptured at cutover. Starting a v7 candidate against the shared ledger would fence the old v6 writers, so an uncoordinated launch could leave those old panes stale.

A private per-file preactivation snapshot was captured at 2026-09-28 23:38 UTC under `/Users/juan/Library/Application Support/gh-glance/snapshots/preactivation-2026-09-28T23-38-32-694Z`. Its private manifest records registry v1, acquisition v1, and quota v6 with each copied byte hash; the copied files are read-only. Existing panes remained active, so this is a non-atomic reference snapshot. A fresh snapshot after an agreed stop and before migration is required at cutover.

The 11 live processes descend from Ghostty terminal sessions. The installed Ghostty CLI reports `+new-window` unsupported on macOS, and the connected desktop inventory exposes no Ghostty windows for direct control. The computer-use app binding explicitly refuses `com.mitchellh.ghostty` for safety reasons. A disposable `open -na Ghostty.app --args -e /bin/sleep 15` probe started a separate Ghostty process but exposed no window or command child; that disposable process was stopped. This does not establish a reliable session restart path. Preserve each pane's current target/arguments in a private cutover manifest and recheck executable resolution before any restart. Existing sessions must not be silently left on the fenced 0.15.2 binary.

## Activation gate

The [Phase 4 plan](phase-4.md) explicitly requires authorization for live migration, installation, and session restarts. The concrete personal proposal is to stop the currently 11 active old panes as an agreed group, capture a fresh private snapshot of the now-quiet v6 state, install the exact tarball into an isolated prefix, verify the executable hash in each launched session, and restart the declared cohort with the existing `gh` user credential. Normal startup performs the v6-to-v7 migration; no repair script or fabricated workflow dispatch is planned. The exact process list, repository/tab cohort, cadence, quota scope and API host must be recaptured and fixed in the private monitor manifest at cutover. Because Ghostty's current session windows are not available to desktop automation, a restart mechanism for those existing windows remains unresolved; this must be solved before ending the old panes.

Rollback must retain any v7 activity: stop the candidate, keep the v7 ledger and the separate pre-migration snapshot, and use only a compatible repaired candidate after local gates. Do not restore a v6 ledger over v7 accounting or restart 0.15.2 writers against v7. If session replacement cannot be completed, do not begin migration.

Work EMU lacks a verified host, credential, installed path, live pane cohort, and state root from the available CLI and browser context. Its manifest and causal diagnosis cannot be populated from the prior screenshot. Any work installation, restart, or employer change needs its own concrete scope and authorization. Separate 30-minute and uninterrupted 24-hour strict windows are required for personal and work. Natural workflow transitions, rendered rows, direct API readback, and reset boundaries remain unmeasured.

## Verification status

| Requirement | Personal | Work EMU |
| --- | --- | --- |
| Installed candidate recovery from retained state | Unmeasured | Unmeasured |
| Initial 30-minute strict window | Unmeasured | Unmeasured |
| Uninterrupted 24-hour strict window | Unmeasured | Unmeasured |
| Quota reset and observed natural workflow transition | Unmeasured | Unmeasured |
| Displayed Actions rows compared with bounded direct API checks | Unmeasured | Unmeasured |

F12 and incident acceptance remain open until both environments pass. Local Phase 1–3 evidence is recorded in their separate validation files.
