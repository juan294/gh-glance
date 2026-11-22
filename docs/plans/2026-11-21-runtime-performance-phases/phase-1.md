# Phase 1 · Interactive startup

Entry point, ownership and baseline are in the [main plan](../2026-11-21-runtime-performance.md). The two changes cover different users. Explicit repository selection can avoid Git entirely. A launch from a checkout still needs Git, and can use that time to load React and Ink.

## Changes

1. Use the actual resolved repository and host with an empty remote list to detect a complete explicit target. Only a validated flag or valid `GH_REPO` qualifies. Keep the current precedence for `--repo`, `GH_HOST`, enterprise hosts and malformed inputs. Apply the condition only at the three remote-discovery calls in connected preflight, standalone discovery and mounted bootstrap. Preserve the independent truthiness check at `index.mjs:7801` so a malformed GH_REPO outside a checkout still reaches the existing target diagnostic. Keep the inferred-target recheck after an empty discovery and the doctor's independent inventory. See `index.mjs:1259`, `index.mjs:1329`, `index.mjs:7788`, `index.mjs:11544`, `index.mjs:11948`, `index.mjs:12686`, `index.mjs:12728`, `index.mjs:22879`.
2. Start the existing React/Ink dynamic imports once, after the interactive TTY and argument checks, before the standalone gh/Git preflight. Leave the connected-client target check in its present error-precedence order. Connected mode can load at its existing point if there is no independent work left. Keep the first-statement production default, import-as-module semantics, and headless stubs. Attach a rejection handler immediately to the import promise, retain its outcome and surface failure at the current consumption point after successful preflight. This prevents an unhandled rejection or eager alternate-screen entry while preserving the actionable preflight diagnostic. See `index.mjs:23`, `index.mjs:12668`, `index.mjs:12712`, `index.mjs:12723`, `index.mjs:12750`, `index.mjs:23522`.

```
@ interactive startup -> mounted UI or existing diagnostic
pre: validated interactive arguments and production-mode default
do:
  1. lookup the explicit target using the existing resolvers
  2. compute the UI import outcome concurrently with applicable local preflight
  3. lookup inferred remotes only when discovery is needed
  4. emit the first frame after preflight and bounded warm identity lookup
fail: local preflight failure -> existing exit status and message on the normal screen
```

## Consumer sweep

`rg -n 'runtimeRemoteUrls|gitRemoteUrls\(|readGitRemotes\(|headlessEntry' index.mjs test scripts`. The helper at `index.mjs:11562` remains callable for the real checkout tests at `test/repository-target.test.mjs:134`. Cover the three interactive calls above. Preserve the independent doctor read/write at `index.mjs:11948` and `index.mjs:11953`. All existing array readers continue to receive an array: no-repository and ambiguity at `index.mjs:1297` and `index.mjs:1355`, target and host at `index.mjs:1385` and `index.mjs:1398`, initial/retargeted cache at `index.mjs:19524` and `index.mjs:21963`, local/SSH target at `index.mjs:21448`, ambiguity display at `index.mjs:23309`. Keep the test-import and headless branches at `index.mjs:12750`. Existing syntax and help entry points come from `package.json:7` and `index.mjs:12668`.

## Automated acceptance and recovery

- Use a synthetic gh with a counting Git shim delegating to real Git for a one-remote checkout. Count calls from app startup through mounted bootstrap. Require zero discovery invocations with explicit flag and valid environment target, including outside a checkout. For an inferred one-remote checkout expect the existing checkout check and three discovery children. Check the selected host and slug, default-remote resolution, ambiguous/no-remote guidance, and the warm cache row. Exercise standalone plus local/SSH connected selection with the existing fixtures. See `test/repository-target.test.mjs:65`, `test/repository-target.test.mjs:169`, `test/args.test.mjs:186`, `test/pty/collector.test.mjs:73`.
- Use a test-only module hook and delayed local preflight to show import start before preflight completion and a single load per dependency. CLI help/version, doctor, serve and stdio should perform zero UI imports. A non-main test import must still work. Check invalid CLI/TTY handling, missing gh, UI import failure, and simultaneous import/preflight failure. No case may strand the cursor or enter the alternate screen on a preflight error. Correct the fixture dependency/target and verify that relaunch reaches the dashboard. Retain the 1,000 ms warm-identity bound at `index.mjs:3416`. Existing hook and offline harness patterns are at `test/pty/fixtures/jev-child-guard.mjs:6` and `test/pty/capture.mjs:463`.
- Compare baseline/candidate first frame and first useful row using 12 alternating matched pairs on one host, identical Node/dependencies, inferred checkout, pane size and gh fixture. Use separate private roots with equivalent warm state or equivalent cold state. Separate cached and freshly acquired rows. Record paired medians and variation. Keep overlap if the median first-frame improvement exceeds same-build repeat noise and lifecycle checks pass. If the timing is inconclusive, keep the independently verified Git saving and record the overlap result. This is a local experiment.
- Run focused tests, then the main plan's sequential lint, syntax, unit, efficiency and PTY commands.

**Manual acceptance.** No manual operation required. Capture exit codes, screen state, process counts and paired timings in the phase handoff.

## Completion

- [x] Skip interactive Git discovery for a complete explicit target.
- [x] Overlap UI imports with standalone preflight and preserve early-exit diagnostics.
- [x] Complete independent review, the timing comparison and all five local verification commands. See 2026-11-21-runtime-performance-notes.md for the results and the limits of the first-row measurement.
