# November 22 CI repair

Local repair of the failed integration and scheduled coverage runs for `juan294/gh-glance`. The repair started from `develop` at `77e6f4bd8781d153ad9e1259329ef000b7b09ed7` in the disposable worktree `/Users/juan/code/gh-glance-ci-pty` on `fix/coverage-pty`. The `rpi-fix-ci` project overlay at `.rpi/project/rpi-fix-ci.md` applies the standard local repair loop and the release playbook's failure handling. It declares no overrides.

## Hosted failures

| Run and tested commit | Command and evidence | Disposition |
| --- | --- | --- |
| [CI #401](https://github.com/juan294/gh-glance/actions/runs/44993718260), `77e6f4b` | The Node 22.23.5 fast suite canceled the delayed workflow-catalog case and its five remaining sibling tests when the event loop became empty. The aggregate correctly reported that failure. The Node 24 suite, terminal smoke, package smokes and lint passed. | Repair the collector test's asynchronous wait. The aggregate needs no source change. |
| [Scheduled Coverage](https://github.com/juan294/gh-glance/actions/runs/44980775254), `d1df339` | The unit coverage step passed. The instrumented terminal suite failed in the populated authorization notice and cached automatic polling cases. The former counted 10 lines in a nine-line frame. The latter quit while the second request still displayed Checking. | Repair the two terminal drivers and exercise their original behavioral assertions. |
| [Sutura monitor for CI #401](https://github.com/juan294/gh-glance/actions/runs/44993893717), `77e6f4b` | Sutura reported `gave-up` at failure identification before starting a repair search. | The local collector repair addresses the underlying test cancellation. The monitor outcome is recorded for Sutura coordination. |

[CodeQL on the integration commit](https://github.com/juan294/gh-glance/actions/runs/44993717988) passed. The earlier v0.19.4 release post-install 404 is recorded separately with the successful delivery receipt in the [release record](../release/2026-11-20-v0.19.4.md#events-during-the-release-preserved).

## Reproduction and repair

**Collector cancellation.** With the hosted Node patch version on macOS arm64, the unmodified collector file reproduced two passes followed by six cancellations. The initial poll awaited a promise during a one-second governor admission delay. Production intentionally unrefs that timer, and the test owned no other referenced handle. The fixture already provides a bounded wait with diagnostics, used by its other subscription tests. The repaired case uses it during initial settlement and when awaiting the obsolete request. The synthetic child captures the old response synchronously and delivers it on the next timer. The waiting test starts invalidation, including the synchronous binding revision increment, in the intervening microtask. This removes the 200 ms timing assumption. The test still checks that the obsolete name is never published, the final name belongs to the new access context and the transports made three catalog reads. The complete collector file then passed all eight cases with zero cancellations on v22.23.5.

**Authorization notice.** The hosted run did not upload its raw terminal capture. On the exact failed release executable, delaying the transition to raw terminal input by 1.3 s reproduced the same 10-versus-9 assertion under V8 coverage. The cached frame appeared before raw input was enabled. The driver's uppercase refresh key echoed into the guard row. The dashboard content occupied nine lines. This layout case now lets the five-second foreground poll trigger the persistent HTTP 401. It still requires failed source requests, the cached row, the recovery instruction, the Failed footer, exactly nine lines and a clean exit. The delayed-input replay passed with the new driver, as did the focused case under GNU script on Linux.

**Automatic poll settlement.** The previous driver watched the synthetic gh invocation log for the second request and the independent terminal transcript for a Watching footer. The log records a request start. A Watching frame from the first response could satisfy the predicate while the second response was still pending. A 750 ms local response delay and a 350 ms delay in the driver's view of terminal output reproduced the hosted Watching → Checking ending. The repair uses the existing sequence fixture to make the second response visibly distinct. It waits for that response's row and the Watching status in the same terminal screen before sending quit.

Independent review found that the old assertion looked for a further Checking after the last Checking, and the original title also existed in the second response. The revised test verifies a cached title in the first completed synchronized draw and a distinct updated row plus the current Watching footer in the final screen. With animation enabled it checks that any visible Checking marker stays static. A floor-rate poll can remain silent. The revised assertions passed the induced race under V8 coverage. A second review confirmed the predicates and the collector's invalidation ordering. The simplify pass retained the existing fixture response sequence, terminal parser, status-line classifier and bounded collector wait, and removed the separate polling of the gh calls file from the terminal driver.

## Final local verification

The tested three-file patch against `77e6f4b` has SHA-256 `f92989bb8ccf1f94871af6237dc1d9566eff72e8e31d57a4164c248b56ea8d9d` (output of `git diff HEAD --binary` before staging). The checks ran sequentially on macOS arm64 on November 22.

| Check | Result |
| --- | --- |
| ESLint and Node syntax | Both passed on Node 24.22.3. |
| Fast unit selection, Node 22.23.5 | 1,143 passed, zero canceled. |
| Exact-tarball package selection, Node 22.23.5 | Passed. |
| Full unit suite, Node 24.22.3 | 1,145 passed, zero canceled. |
| Authoritative unit coverage and metrics extraction | 1,145 passed. Reported line coverage was 78.77%. |
| Full PTY suite under V8 coverage | 271 passed, zero failures, one optional 0.15.2 reproduction skipped because the historical executable was unavailable. The child processes exercised 1,790 of 2,105 functions (85.04%) across 488 V8 reports. |

The complete covered terminal run included both repaired tests. The focused layout case also passed on Linux. The local repair covers the three test drivers. The application executable, workflows and Sutura routing are unchanged. All task-owned terminal fixtures and Linux containers were disposed of. The integration is local; the existing hosted results remain the record for their original commits.
