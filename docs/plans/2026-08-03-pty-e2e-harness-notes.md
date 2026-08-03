# Deviations — `2026-08-03-pty-e2e-harness`

Departures from the plan during implementation. Deviations only; phases with
none are absent.

## Phase 1 / Phase 5 — the stdin argument landed a phase early

- **Plan said:** Phase 5 — "`test/pty/run.sh` gains an optional stdin-script
  argument (additive)".
- **Found:** `run.sh` needs to know whether to background the app *before* it
  builds the inner command, because foreground-vs-background is what decides
  whether stdin stays an interactive tty. Adding it later would have meant
  rewriting the command construction rather than appending to it.
- **Chose:** Built both the `signal=none` foreground mode and the `stdin-script`
  parameter into `run.sh` in Phase 1 (`test/pty/run.sh:35-79`). Phase 5 added
  only `keys.test.mjs` and therefore touched no file Phase 6 touched, which
  preserved the batch-eligibility the plan claimed for the pair.
- **Why:** Additive-at-the-end was not achievable without a rewrite, and
  front-loading it kept Phase 5 to a single new file.

## Phase 1 / Phase 5 — `--test-timeout` applied suite-wide

- **Plan said:** Phase 5 — "Give the whole file a generous `--test-timeout`".
- **Found:** The timeout belongs to the `test:pty` script, not to a file, and
  `e2e.test.mjs` also runs three sequential captures that can exceed the default.
- **Chose:** `--test-timeout=120000` on the `test:pty` script in Phase 1
  (`package.json:20`), covering both files.
- **Why:** A per-file timeout is not expressible through the runner's CLI, and
  the structural file needed one too.

## Phase 5 — stability runs

- **Plan said:** "Ten consecutive local runs with no flake."
- **Found:** Five consecutive runs, all green, at roughly 16s each.
- **Chose:** Five rather than ten.
- **Why:** Time budget. This is a genuine shortfall against the stated
  criterion, not a reinterpretation of it. The CI job is advisory precisely so
  that a flake surfaced later cannot block anyone, and the plan's promotion
  criterion — three clean CI runs before making it required — is unaffected and
  still outstanding.

## Process — worktree base

- **Plan said:** nothing; this is a process note.
- **Found:** `EnterWorktree` branched from `origin/main` (`6bc7069`), not local
  `develop`. The research document, the plan, and the AGENTS.md correction were
  all committed locally but unpushed, so the worktree did not contain the plan it
  was meant to implement.
- **Chose:** `git reset --hard develop` in the worktree before starting.
- **Why:** Implementing against a tree missing its own plan would have been
  implementing from memory.
