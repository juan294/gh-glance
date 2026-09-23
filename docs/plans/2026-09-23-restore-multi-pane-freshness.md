# Plan: restore bounded freshness across concurrent panes

Date: 2026-09-23
Source: `develop` at `f3f604e` (installed 0.15.1)
Research: [root causes](../research/2026-09-23-multi-pane-staleness-root-causes.md) and [live evidence](../research/2026-09-23-live-staleness-evidence.md)
Status: review-ready; no unresolved questions

## Outcome

With a usable GitHub connection, verified identity, and spendable resource budget, every subscribed query must either advance its last successful source observation within its admitted cadence or show the precise condition holding it. An abandoned local lock, a live owner's unstarted claim, a lost wake, or a failed unrelated quota observer must not leave other eligible panes stale indefinitely. A genuine quota, authentication, transport, or filesystem hold remains fail-closed and visible. This extends the research finding that the current empty acquisition lock blocks all panes, while some unstarted claims predate that lock. [Research](../research/2026-09-23-multi-pane-staleness-root-causes.md:5)

## Current anchors

| Concern | Current code and evidence |
| --- | --- |
| Acquisition lock and shared transactions | `index.mjs:12182`, `index.mjs:12947-12992`, `index.mjs:13098-13103` |
| Governor lock recovery | `index.mjs:4119-4379`, `test/governor.test.mjs:2582-2625` |
| Claims, heartbeat, start receipt | `index.mjs:13163-13187`, `index.mjs:13486-13521`, `index.mjs:13550-13627` |
| Intent registration and pending handoff | `index.mjs:4904-4950`, `index.mjs:16849-17049` |
| Resource gates and wake scheduling | `index.mjs:13943-14009`, `index.mjs:14014-14072`, `index.mjs:17120-17231` |
| UI and doctor | `index.mjs:12370-12411`, `index.mjs:12832-12875`, `index.mjs:14630-14781`, `index.mjs:17383-17412` |
| Acceptance gaps | `scripts/measure-efficiency.mjs:650-671`, `test/efficiency.test.mjs:84-122`, `test/pty/pacing-credit.test.mjs:149-160` |

Line references describe the baseline; implementation must reread them after each phase.

## Options and selected design

| Option | Decision | Reason and tradeoff |
| --- | --- | --- |
| Delete an empty acquisition lock after ten seconds | Rejected | It leaves the current dead-owner rename race and can remove a successor's lock. The governor's marker/quarantine protocol already addresses this race. [Acquisition path](../../index.mjs:12971), [governor path](../../index.mjs:4238) |
| Use one raw file-lock primitive for governor and acquisition | Selected | It gives both stores creation cleanup, nonce ownership, bounded orphan recovery, and race-safe quarantine; extracting the governor path requires careful regression tests. [Governor protocol](../../index.mjs:4138) |
| Replace sharing with direct independent polling or require a collector | Rejected | Independent fallback duplicates GitHub work during coordination failure; the collector is opt-in and uses the same acquisition engine. [Shared-acquisition contract](../decisions/0004-quota-and-acquisition-identities.md:168) |
| Keep live unstarted claims as long as the PID exists | Rejected | The saved state contains such claims for hours. A claim with no started transport is fenced by nonce/generation, so bounded takeover can recover without authorizing an old request. [Live evidence](../research/2026-09-23-live-staleness-evidence.md:23), [start fence](../../index.mjs:13486) |
| Resource-specific admission with an independent liveness wake | Selected | Actions/Security spend core while Issues/PRs spend GraphQL; one failed observer need not stop an unrelated healthy lane. The shared HTTP permit and secondary hold still apply. [Cost table](../../index.mjs:2071), [current global gate](../../index.mjs:13970) |

## Safety and liveness contracts

1. A store transaction enters only after the caller proves ownership of the current lock record. Young unreadable records, live owners, unknown PID status, and active recovery markers remain protected. An old unreadable record or confirmed dead owner is quarantined by the existing double-check protocol; the acquisition engine clock cannot change filesystem orphan age. No `gh` call runs under a file lock. [Lock precedent](../../index.mjs:4119), [acquisition seam](../../index.mjs:13098)
2. A query has one current claim generation. A producer must first obtain a valid governor reservation and then persist `started` with that exact claim nonce/generation and reservation receipt before starting any data transport. Every nested operation rechecks the claim fence before its own admission. A delayed old owner cannot commit shared publication, local rows, cache, or freshness after takeover. A request already in flight, or racing immediately past its last fence check, may finish; its own reservation stays conservatively charged and its rows are rejected. [Start receipt](../../index.mjs:13486), [current local commit order](../../index.mjs:16011), [transport ordering](../../index.mjs:16435)
3. An unstarted claim has a fixed 180-second maximum lifetime from `claimedAt`; heartbeat may report liveness but cannot extend that absolute deadline. A started claim has a bounded deadline derived from the declared maximum request sequence and the 30-second per-`gh` timeout. At that deadline, a successor can fence the old generation without waiting for its process to exit; the old owner attempts abort when it resumes, and all old uncertain cost remains charged until authoritative reconciliation/reset. A legitimate future safe slot may defer **requests**, but never make an unstarted owner immortal. [Current 45-second renewable lease](../../index.mjs:12172), [heartbeat](../../index.mjs:13177), [request timeout](../../index.mjs:174)
4. Intent and acquisition cleanup are idempotent across their two stores. A coalesced governor intent may be adopted only when its existing process-local acquisition claim and access scope match the new request; otherwise the old unstarted intent is cancelled before re-registration. The pane tracks the returned intent ID, never a newly generated ID that was not persisted. If cancellation cannot prove that a reservation never started, it does not refund quota or pacing. A recurring liveness wake checks pending admission, claim age, and observer retry without relying on a previous one-shot callback. [Intent coalescing](../../index.mjs:4921), [wrong local ID](../../index.mjs:16915), [wake helper](../../index.mjs:14014)
5. Each tab's data gate checks only resources in its declared cost vector. Poll deadlines and wakeups are per eligible query, so an unhealthy active GraphQL tab or an unpublished GraphQL primary block cannot stop a healthy core-only background tab through the current global `liveScheduling` or block gate. Identity proof, account-wide secondary cooldown, shared HTTP permit, response authorization, and the 20% resource reserve remain separate mandatory checks. [Tab costs](../../index.mjs:2071), [current readiness](../../index.mjs:13998), [global wake gate](../../index.mjs:16745), [global block gate](../../index.mjs:16758), [reserve](../../index.mjs:2117)
6. UI freshness remains tied to a validated source observation, including 304. A cache read, follower inspection, retry, or recovered lock does not reset age. Doctor reports metadata health and known lock-path blockers separately; an unobstructed read-only inspection is not proof that a later write will succeed. [Current freshness](../../index.mjs:17383), [doctor metadata-only path](../../index.mjs:12832)

## Phase order

All phases are sequential. None is `[batch-eligible]`: each changes `index.mjs` or depends on the preceding acquisition/scheduling contract. Review and stop after each phase, unless the user explicitly authorizes continuation. [RPI rule](../../.claude/rules/rpi-details.md:45)

| Phase | Delivery | Depends on |
| --- | --- | --- |
| [1](2026-09-23-restore-multi-pane-freshness-phases/phase-1.md) | Crash-safe shared lock protocol and orphan recovery | Research |
| [2](2026-09-23-restore-multi-pane-freshness-phases/phase-2.md) | Bounded claim/intent lifecycle and fenced takeover | 1 |
| [3](2026-09-23-restore-multi-pane-freshness-phases/phase-3.md) | Resource-specific admission and self-rearming wakes | 2 |
| [4](2026-09-23-restore-multi-pane-freshness-phases/phase-4.md) | Truthful doctor and actionable stale status | 3 |
| [5](2026-09-23-restore-multi-pane-freshness-phases/phase-5.md) | Mixed-pane sustained acceptance and activation evidence | 4 |

## Acceptance contract

Automated checks use independent fixtures with 100 ms response latency, sufficient quota, and a 5-second configured floor unless a scenario explicitly injects a hold. A newly eligible query must obtain its first validated source success within `max(2 × effective policy interval, 15 seconds)` of subscription or hold clearance; zero successes fail. After that, measure the largest gap between validated `lastSuccessAt` observations and require the next success by `nextDueAt + max(2 × effective policy interval, 15 seconds)`. Record both the maximum and the query that reached it; aggregate p95 or a nonzero success count cannot pass a starved pane. A 200 and a valid 304 both count; an unchanged row body alone does not. Only legitimate quota, authentication, or transport holds are excluded from normal cadence. Internal lock/claim/wake faults have separate recovery deadlines: 30 seconds after an orphan lock becomes reclaimable, or the 180-second unstarted-claim boundary plus 30 seconds after capacity returns. Running Actions changed-row display retains the existing 7-second fixture target. [Cadence](../../index.mjs:13757), [snapshot success](../../index.mjs:16386), [existing changed-row target](../../test/fixtures/workloads/multi-instance-v1.json:49)

Automated safety checks assert at most one published producer per generation, a delayed old owner rejected before a new call, no duplicate current-generation data request under ordinary contention, conservative charge for any takeover race, no data work below the 20% reserve, credential/target isolation, and correct waiting status during real holds. Run a mixed Actions/Issues/PRs/Security simulated hour across duplicate and distinct targets, plus real-process tests for lock crashes and multiple panes. [Existing oracle](../../scripts/measure-efficiency.mjs:650), [shared-process test](../../test/pty/shared-acquisition.test.mjs:57)

Manual or live checks are separate from offline acceptance: inspect the narrow 24-column and normal-width status, then observe several restarted panes on actual projects for an initial 30-minute smoke and a 24-hour sustained window after an authorized installation/release. Record an expected pane/query manifest independently of the acquisition store at launch. Capture a redacted per-query freshness trace, exact package version/PIDs, maximum eligible gaps, explicit hold intervals, and governor reserve. A missing or expired store subscription for an expected live pane fails measurement rather than removing that pane from the denominator. A legitimate GitHub outage is recorded as a hold rather than silently excluded. Live GitHub checks cannot promise GitHub network latency and do not replace deterministic gates. [Terminal width contract](../../index.mjs:14740), [release workflow](../../CLAUDE.md:53)

## Verification and activation boundary

Use red-green-refactor for each behavioral change. Targeted regressions run first. Then run, sequentially, `npm run lint`, `node --check index.mjs`, `npm test`, `npm run test:efficiency`, `npm run test:pty`, and `git diff --check`. The full PTY and efficiency commands are necessary because this changes acquisition, scheduling, rendering, and terminal lifecycle. Do not add a typecheck or test framework. Preserve the unrelated untracked `.agents/skills/macos-rules/` directory. [Required commands](../../CLAUDE.md:29), [test sequencing](../../.claude/rules/testing.md:17)

Implementation uses an isolated worktree/temporary branch and integrates verified work on `develop` only within an authorized implementation phase. A local source fix does not update the globally installed 0.15.1 binary or running panes. Old 0.15.1 processes lack the new lock recovery-marker checks, so mixed old/new operation is outside the safety claim. Do not clear the live lock or quota files as a shortcut. Push, `develop`→`main`, npm publication, and live activation remain separate authorization gates. [Old acquisition protocol](../../index.mjs:12952), [governor recovery fence](../../index.mjs:4334), [release topology](../../CLAUDE.md:53)

After those gates are separately authorized, activation is: (1) bind local tests, packed artifact, and hosted CI to the exact candidate SHA; (2) complete the protected `develop`→`main` release and verify the OIDC-published npm version; (3) preserve the quota ledger and acquisition artifacts, then stop all 0.15.1 panes before starting any upgraded pane; (4) install that exact package version and start one pane so the new protocol reclaims the orphaned acquisition lock; (5) start the remaining project panes and run the 30-minute/24-hour redacted freshness monitor. If a gate fails, stop new producers and retain ledgers/receipts; do not restart the old binary against new live state without compatibility/accounting review. The agent performs CLI/browser operations available at each authorized gate and asks the user only for a session action it cannot perform safely. [Release topology](../../CLAUDE.md:71), [mixed-version boundary](../../index.mjs:12952)
