# Release process repair

Date: 2026-10-02. Status: independently reviewed planning specification; Option A confirmed by owner; implementation and external activation have not started.

## Objective and scope

Make a routine gh-glance release predictable: quick development feedback, one authoritative hosted candidate selection, protected promotion, publication of the exact tested tarball, bounded delivery verification, and one accurate completion receipt. Fix all eight categories in the [postmortem](../research/2026-10-02-v0.16.0-release-postmortem-assessment.md:87), retain its useful regressions, and include the additional gaps verified below.

The owner confirmed Option A during planning: retain `develop`/`main`, Node ESM, the single product file, node:test, and npm OIDC. Add small repository scripts and tests, not a release service or a generic framework. Product polling/accounting changes, credential migration, other applications, and new live fleet experiments are outside this implementation. A new product defect gets a separately stated disposition and regression rather than being hidden by a fixture change.

The user authorized review and planning, including verified missing opportunities. This does not authorize implementation, pushes, PR creation, branch protection changes, installation into existing sessions, live qualification, merge, tag, or publication. Phase acceptance remains sequential unless the owner explicitly authorizes continuation. The proposed release authority below is a future contract, not authority supplied by this document.

## Verified baseline and evidence limits

- Checkout: `/Users/juan/code/gh-glance`, `develop` at `140c77f2bad6863481dfc941725b9567bb08b7c6`. Local `main` and `origin/main` are `e53fb14d5ddd8c4995e8edd744be17f50104ad0b`; the two trees are identical. Local `origin/develop` matches develop. These refs were inspected, not fetched during planning.
- Pre-existing untracked inputs: the postmortem and `.agents/skills/macos-rules/`. Preserve both; the latter is unrelated. Planning adds only this plan and its phase files.
- Read-only GitHub API inspection on October 2 confirmed strict up-to-date protection and admin enforcement on `main`, with eight contexts: `Lint`, `Test (Node 22)`, `Test (Node 24)`, `Smoke (Node 22)`, `Smoke (Node 24)`, `PTY`, `analyze (javascript-typescript)`, and `dependency-review`. The first five and CodeQL/dependency review bind GitHub Actions app ID 15368; PTY currently has no app binding. Default branch is develop; merge commits are enabled, rebase merges disabled, squash merges enabled. The procedure must explicitly select merge commits.
- Graphify was queried through this repository root and its own `graphify-out` symlink. It provided orientation, including unrelated baseline copies; all findings below use current source reads.
- Existing completion evidence records v0.16.0 as delivered, with identical accepted/registry tarball SHA256 `6706517fc2c8828be00b4911a3d6a4c8b608c590bc5ac2d47fb6bff4de163d74`, publisher run [36977942591](https://github.com/juan294/gh-glance/actions/runs/36977942591), and Node 22/24 installed smoke. This is preserved completion evidence, not a new registry verification. See [completion receipt:2](../agents/release-0.16.0-2026-10-02/completion.json:2) and [package receipt:2](../agents/release-0.16.0-2026-10-02/published-package/verification.json:2). These ignored files are available here but not portable; Phase 1 preserves their compact facts in tracked history.
- F12 personal/work EMU qualification and incident acceptance remain **OPEN**. The release exception in [original Phase 4:38](2026-09-28-durable-freshness-and-recovery-phases/phase-4.md:38) did not waive them. Default demand changed to active Actions plus requested secondary views; continuous forty-subscription expectations apply to explicit `--background all`, not the default ([accepted notes:6](2026-09-28-durable-freshness-and-recovery-notes.md:6)).
- Installation diagnostics returned exit 0 with no missing resources. Four existing managed files differ from upstream baselines: the Claude and `.rpi` testing/deployment-safety rules. Upstream freshness and native discovery remain unverified. Do not convert expected project customization into a false clean-install claim.
- No application suites, live qualification, release dispatch, or external mutation ran during planning. Proposed time targets below remain unmeasured.

## Findings and complete disposition

`A` identifiers map to the eight assessment sections. `G` identifiers are additional verified gaps or concrete safety requirements needed to implement the recommendation.

| ID | Finding and current evidence | Planned disposition |
| --- | --- | --- |
| A01 | Full checks repeat on push/PR/main, then twice in publication; smoke-tested tarball is not the publish input ([ci.yml:3](../../.github/workflows/ci.yml:3), [release.yml:60](../../.github/workflows/release.yml:60), [release.yml:94](../../.github/workflows/release.yml:94), [release.yml:127](../../.github/workflows/release.yml:127), [package.json:19](../../package.json:19)). | Phases 2–3: explicit selections, one hosted candidate gate, exact tarball handoff, no publisher full suites. |
| A02 | Full unit command includes sustained recovery; coverage repeats it; names/budgets obscure this ([package.json:21](../../package.json:21), [sustained-recovery.test.mjs:6](../../test/sustained-recovery.test.mjs:6), [coverage.yml:31](../../.github/workflows/coverage.yml:31)). | Phase 2: fast/recovery/package/terminal commands, duration receipts and nested deadlines. Phase 3: coverage off the push critical path. |
| A03 | Six corrected fixture mechanisms must remain covered; Linux/BSD behavior differs ([assessment:105](../research/2026-10-02-v0.16.0-release-postmortem-assessment.md:105), [ci.yml:138](../../.github/workflows/ci.yml:138)). | Phase 2: preserve six regressions, repair remaining deadline/cleanup gaps, retain diagnostics and exercise both platforms. |
| A04 | Incident qualification became a moving publication gate ([original Phase 4:16](2026-09-28-durable-freshness-and-recovery-phases/phase-4.md:16)). | Phases 1/4: separate release, canary and incident outcomes; preserve F12. |
| A05 | Live experiments lacked a shared-account budget and valid setup proof ([assessment:132](../research/2026-10-02-v0.16.0-release-postmortem-assessment.md:132)). | Phases 2/4: fixture-first preparation; no automatic live window; finite canary budget when explicitly justified. |
| A06 | Native, retained and managed instructions disagree about retries, approval and release steps ([.claude/rules/push-accountability.md:19](../../.claude/rules/push-accountability.md:19), [.rpi/rules/push-accountability.md:18](../../.rpi/rules/push-accountability.md:18)). | Phase 1: short project playbook and complete adapter sweep with honest local drift. |
| A07 | Ancestry, required-check discovery, observer identity, lint scope and status communication added avoidable work ([assessment:161](../research/2026-10-02-v0.16.0-release-postmortem-assessment.md:161), [eslint.config.js:5](../../eslint.config.js:5)). | Phases 1/3/4: preflight once, correct run correlation, explicit lint inputs, one stage/blocker/next action. |
| A08 | Floating npm, late tool-route discovery, registry lag and stale tracked status ([release.yml:51](../../.github/workflows/release.yml:51), [release report:3](../release/2026-10-01-v0.16.0.md:3)). | Phases 1/3/4: pinned npm, early CLI/browser readiness, bounded readback, portable current receipt. |
| G01 | Existing registry version is accepted without artifact equality; network errors look like absence ([release.yml:111](../../.github/workflows/release.yml:111)). | Phase 3: distinguish absence, transient failure, exact match and collision; verify integrity before idempotent success. |
| G02 | Candidate artifacts need origin/run/attempt/tree binding, expiry handling and a hard digest check; built-in download mismatch only warns. | Phase 3: explicit receipt and negative tests; never consume latest-by-name or arbitrary PR artifacts. See GitHub artifact source below. |
| G03 | Strict protection currently names jobs that selection changes can remove; a successful skipped job can conceal missing work ([ci.yml:150](../../.github/workflows/ci.yml:150) and live protection readback). | Phase 3: always-running aggregate and compatible legacy contexts. Phase 4: add required aggregate before retiring old contexts; never temporarily disable protection. |
| G04 | PTY captures/call logs are deleted before outer assertions can fail ([capture.mjs:536](../../test/pty/capture.mjs:536), [capture.mjs:573](../../test/pty/capture.mjs:573)). | Phase 2: bounded failure evidence survives both child errors and assertion failures; private temporary state still gets cleaned. |
| G05 | Identity fixture uses Promise.all with early teardown; a 20-second case contains a 30-second child ([identity-process.test.mjs:48](../../test/identity-process.test.mjs:48), [:56](../../test/identity-process.test.mjs:56), [:67](../../test/identity-process.test.mjs:67), [:98](../../test/identity-process.test.mjs:98)). | Phase 2: bounded shared deadlines, wait/terminate all children, then remove owned state; retain first failure. |
| G06 | Name filtering cannot avoid PTY module-level captures ([e2e.test.mjs:27](../../test/pty/e2e.test.mjs:27), [keys.test.mjs:33](../../test/pty/keys.test.mjs:33)). | Phase 2: lazy per-test setup and explicit file selection; test excluded suites cause no processes. |
| G07 | Legacy fix-ci says source-only/no tests and auto-pushes; contributing guide says delete flaky assertions ([fix-ci.md:23](../../.claude/commands/fix-ci.md:23), [source-command-fix-ci:34](../../.agents/skills/source-command-fix-ci/SKILL.md:34), [CONTRIBUTING.md:73](../../CONTRIBUTING.md:73)). | Phase 1: thin repair adapters; preserve assertions, permit proven fixture fixes, local gates before any separately covered remote action. |
| G08 | Monitor schema assumes continuous cadence for every declared subscription, while default secondary views intentionally stop ([freshness-monitor.mjs:26](../../scripts/freshness-monitor.mjs:26), [:375](../../scripts/freshness-monitor.mjs:375), [:420](../../scripts/freshness-monitor.mjs:420)). | Phases 1/4: declare only continuously active Actions in routine passive windows; test secondary request/cached behavior separately. Do not reinterpret schema 2 or claim secondary continuous qualification. |
| G09 | Package tests independently pack/install with floating consumer dependencies ([package-boundary.test.mjs:61](../../test/package-boundary.test.mjs:61)); unchanged five files do not identify harness or dependency inputs. | Phases 2–3: reusable exact-tarball exercise, separate locked candidate dependencies from fresh consumer install, bind test/runtime inputs in receipts. |
| G10 | Sutura is an optional privileged repair workflow, not a release check; wrapper success cannot establish repair ([sutura.yml:4](../../.github/workflows/sutura.yml:4), [:29](../../.github/workflows/sutura.yml:29)). | Phases 1/4: exclude it from release waits and approval; correlate trigger run ID, report actual repair result, never merge its output automatically. No Sutura infrastructure changes. |

## Selected design and trade-offs

Option A keeps the established topology and limits change to policy, fixtures and repository workflows. A single protected integration branch would remove ancestry steps but changes the branch contract. An owner-dispatched publisher would introduce a new publication trigger and npm trust migration risk. Neither is needed for this repair.

### D1. One procedural authority and bounded future release authority

Create `docs/release/release-playbook.md` as the short project procedure. Retained commands, both native adapters, root instructions, relevant rules and repair adapters point to it. Keep phase gates for implementation. A routine release does not automatically start a new broad pre-launch audit or exploratory charter; use independent review for substantial changes and preserve useful charter scenarios as regressions.

The future owner decision names version, reviewed scope/candidate, accepted limits, publication destination and any corrective allowance. It can authorize the ordinary integration push, release PR, protected merge, tag, GitHub release/OIDC publication, delivery verification and owned cleanup as one sequence. No repeated prompt for a step already included. Proposed optional allowance: **one** corrective push after an independently reviewed, fully locally verified fixture/workflow-only repair that leaves packaged behavior and dependencies unchanged. Zero blind hosted reruns. Exhaustion, product/dependency changes, new paid/live scope, or a materially different candidate require a new decision. Existing session authority always controls; a playbook/JSON field cannot create it.

Keep managed upstream baselines intact. Document small project overrides as expected local drift; the existing lifecycle engine already retains local edits and three-way merges upstream changes ([rpi-lifecycle.py:573](../../.rpi/scripts/rpi-lifecycle.py:573)). Do not edit global skills, cc-rpi upstream, or baseline hashes to make diagnostics green.

### D2. Explicit selections without weakening the existing full command

Keep `npm test` as the complete existing non-efficiency unit contract. Add `test:fast`, `test:recovery`, `test:package`, and `test:pty:smoke`; retain `test:efficiency`, `test:pty`, and honest coverage commands. A small Node selector shares file lists with CI and prints command, files, runtime, actual result and duration. No new framework/build step. Move short independent sustained-oracle tests into fast coverage while keeping the 72-hour run in recovery. Fast excludes package-install integration and sustained execution, with explicit ownership elsewhere.

| Profile | Hosted candidate selection | Selection rule |
| --- | --- | --- |
| Docs | Lint/syntax, Node 22/24 version/help and exact packed-file/install checks | Only a narrow non-executable documentation allowlist; README/CHANGELOG/LICENSE still change package bytes. |
| Ordinary | Above plus fast behavior on Node 22/24 and real terminal smoke | Reviewed diff demonstrates no coordination/recovery effect. Rendering adds affected terminal cases. |
| Coordination/recovery | Ordinary plus sustained recovery once on Node 22, efficiency once, and full Linux PTY selection once | Any change to accounting, scheduling, acquisition, identity, persistence, collectors/providers, monitor/oracles, or uncertainty. |

Unknown/new paths, missing diff base, selector/fixture/workflow changes, package scripts/lock/runtime changes, or ambiguous `index.mjs` edits select the broad profile. Since the product is one file, no regex claims to understand a function-level diff. An explicit ordinary classification of a narrow `index.mjs` edit requires recorded independent review of the diff and impacted cases; no silent downgrade. The first release of this repair uses the broad profile. Runtime/dependency/platform changes add supported-platform affected cases and extended Node 24 behavior where required. Fast test Node compatibility remains on both majors for behavioral releases; full recovery is not duplicated merely to label both jobs green.

The full local gate remains required at each implementation phase under current instructions. Local evidence may be reused only for unchanged inputs; publishing introduces no extra full local rerun by itself. The single-authoritative-selection promise concerns the hosted candidate selection and downstream reuse, not eliminating development testing or independent Node compatibility checks.

### D3. One tested artifact across candidate, merge and publication

Candidate CI uses the PR merge tree, records PR head/base and checked-out commit separately, and packs once. Upload that tarball and an immutable input manifest before the cross-job tests; all candidate package jobs download the same artifact by ID, without overwrite or repack. Read-only jobs validate it on Node 22/24; terminal smoke runs its installed binary with fixture gh and a private config root. The uploaded manifest records product/harness/lock/workflow/runtime identities, full Git tree, profile, expected selections and tarball SHA256/SHA512 integrity. Server-assigned artifact ID/archive digest/expiry and actual job results remain outside that immutable payload, joined from trusted job/API readback into the final receipt. The provisional artifact becomes publish-eligible only after the aggregate and entire candidate run/attempt succeed. A self-reported JSON `success` is insufficient.

After normal protected merge, prove the actual main merge tree equals the tested tree, the merged PR head equals the approved candidate, and the tag names that merge. Full-tree equality intentionally invalidates even harness-only or documentation changes after freezing; no broad ignore list. Pack metadata/version and changelog must agree. Do not require PR merge SHA to equal the production merge SHA. GitHub documents this distinction in its [pull_request event semantics](https://docs.github.com/en/actions/reference/workflows-and-actions/events-that-trigger-workflows#pull_request).

The publisher discovers the exact successful same-repository release-PR run, validates run attempt, workflow path, PR identity, artifact ID/name/expiry, tree and cryptographic digests, and downloads its tarball. Fail if missing, ambiguous, canceled, expired, tampered, or from a fork/wrong branch. Never fall back to repacking current main or choosing the newest artifact. Artifacts expire after 30 days; a later release needs a newly authorized candidate gate. The compact receipt persists in tracked release history independently of artifact retention.

Keep `.github/workflows/release.yml`, `release: published`, and environment `npm`. Pin npm **11.21.0** for candidate pack/publish, subject to its offline contract test; registry metadata verified its Node engine range during planning. Use Node 22.22.2 for the initial publisher pin and Node 22.22.2/24.21.0 for initial candidate compatibility pins, matching retained delivery evidence. Pin updates are reviewed changes. npm requires Node >=22.14.0 and npm >=11.5.1 for [trusted publishing](https://docs.npmjs.com/trusted-publishers/).

Publish the explicit `./artifact.tgz` with `--ignore-scripts --provenance --access public`; no directory publish and no publisher `npm test`/`npm ci` of the product. Keep `prepublishOnly` as a directory-publish defense if useful; it is not the release verification path. npm supports a [tarball package spec](https://docs.npmjs.com/cli/v11/commands/npm-publish/). A local loopback registry fixture must verify actual pinned npm behavior before adoption. Do not claim a dry run proves OIDC or registry provenance. A read-only bootstrap establishes the release tag's protected-main merge association through trusted workflow/API logic before importing or executing any tagged checkout code. Candidate/package execution has no publishing token; the privileged publish job executes independently validated protected-main verifier code and pinned npm only. Fresh installed-package execution belongs in a separate unprivileged delivery job.

Provenance binds the protected publication workflow/production commit and the unchanged artifact digest; the receipt links that commit to the candidate tree/run. A package's `gitHead` may identify packing context or be absent. Record its actual semantics, never modify the tested tarball to manufacture a production gitHead. Verify provenance and tree/digest correspondence as separate claims.

### D4. Workflow routing and safe protection migration

Develop pushes run quick integration checks. Release PRs from same-repository develop to main own the candidate selection. Other PRs get appropriate read-only CI but cannot provide publish artifacts. Main pushes run identity/delivery-relevant checks only, not full suites. Coverage remains scheduled/manual and keeps its actual selection/denominator; no release wait or push-triggered full coverage copy. Retain CodeQL and dependency review as required security checks; their short analyses are not substitutes for behavior tests.

Add an always-running `Release candidate` aggregate that validates the selected jobs and exact artifact. Expected required work that is missing, skipped, canceled or failed makes the aggregate fail. An intentionally unselected suite has an explicit profile reason; a skipped required job never becomes evidence. Reuse existing legacy context names during transition. Phase 4 first makes the observed successful aggregate required alongside all existing contexts, verifies protection readback, then retires superseded contexts while retaining `analyze (javascript-typescript)` and `dependency-review`, strict update checks, admin enforcement and PR-only merges. Do not disable rules to get a green release. All settings mutations wait for explicit activation authority.

Concurrency cancels superseded candidate runs for the same PR, but not publication in progress. Serialize publication for the package and recheck existing version/integrity after entering the publish slot. Refuse unexpected versions/dist-tag regression. An already-published matching artifact resumes delivery verification; a collision blocks. Registry auth/network failures are not evidence of absence. Readback retries are bounded to five minutes with capped backoff and Retry-After; after that report `published; delivery unverified`, never republish blindly.

### D5. Small release driver and bounded operational work

Add one CLI entry point under `scripts/` with `prepare`, `status`, `resume` and fixture-backed `--dry-run` behavior. Reuse small candidate/artifact helpers. Default to read-only planning/status; external actions require the actual owner authorization for the named release, not an unvalidated receipt flag. The receipt records stage, blocker, next authorized action, approved scope, retries consumed, candidate/tree, required runs, artifact/integrity, publication, delivery, timestamps, owned paths and accepted limits. Write atomically and revalidate GitHub/registry facts on resume. Do not store tokens or private account state.

Preflight ancestry before candidate freeze, exact version/changelog/lock, clean owned workspace, effective Node/npm paths, triggers, required checks and CLI publication capability. CLI is first; permitted browser automation is the fallback for a genuine tool-route failure. Do not retry a denied operation through another route to evade an automatic safety rejection; disclose the actual reason and use only an allowed path. Browser publication must finish the same tag/release readback contract.

Polling uses workflow ID, run ID/attempt, event and PR head/tested merge identity. Optional `workflow_run` observers link through the triggering run ID; never filter them by their own default-branch SHA or infer repair from wrapper success. Monitor existing runs, report terminal failures promptly, and use a finite deadline. One status update states current stage, real blocker and next action; timing estimates include all remaining stages and distinguish measured durations from targets.

Routine release has **no automatic live soak**. If a changed behavior justifies live evidence, declare the specific risk and exact environment first. Prefer passive observation of one existing Actions pane held on Actions, maximum five minutes, no spawned cohort or session restart, and at most 20 additional verification admissions/charged units per resource with a remaining floor of max(40% of the observed limit, the product reserve). Count setup and readback too; unknown charge or unavailable budget stops added requests. Other clients' traffic remains unmeasured unless independently captured. Test the manifest/setup/parser offline before activation; preserve sleep/gap/candidate invalidation.

Current monitor schema 2 can describe that continuously active Actions cohort and prove source freshness only. Actual rendered rows/notices require separate bounded terminal capture and comparison; unavailable capture remains unverified. On-demand refresh, cached-age advance, disabled-endpoint disclosure and absence of unsolicited secondary calls use separate bounded scenarios, including the existing regressions. Do not feed intentionally idle secondary subscriptions into a perpetual cadence oracle. The original F12 duration/environment requirements remain open, with its demand inventory corrected explicitly before future authorized qualification. This project does not need a new monitor schema merely to release the process repair.

## Stuck states and recovery

The release operator sees these in CLI output and the current receipt. Each phase test must prove the recovery/disclosure, not just refusal.

| State | Visible result and exit | How it ends | Test |
| --- | --- | --- | --- |
| Dirty/unowned checkout, divergent ancestry or moved candidate | `prepare blocked`, exact path/ref and required local action | Preserve edits, reconcile in owned worktree, freeze a new candidate | R01/R05 |
| Missing/conflicting authority or exhausted corrective allowance | Named uncovered action; no mutation | Owner supplies the specific missing decision; retain existing covered steps | R01/R09 |
| Unknown profile or changed test inputs | Broad selection, or candidate invalidated | Run applicable local/candidate gates against new inputs | R02/R05 |
| Child timeout, lock contention or PTY assertion failure | Real first failure plus bounded evidence path | Await/terminate all owned children; fix cause locally; verify repaired inputs | R03/R04 |
| Missing/skipped/canceled/failed required check | Blocker lists expected context and actual run/event | Local repair and next authorized candidate; no automatic hosted rerun | R05/R09 |
| Protection transition incomplete | `activation incomplete`, current required contexts | Resume idempotent add-before-remove transition, preserving strict protection | R06 |
| Artifact missing, expired, mismatched or untrusted | Exact identity failure; no publish | Recover the same retained artifact by ID or authorize a new candidate gate | R05/R07 |
| Merge/tag/tree differs | Candidate proof invalid; no publication | Reconcile candidate and reverify affected inputs, then normal promotion | R05/R07 |
| Publisher tool/OIDC route unavailable | Actual tool/auth reason and available allowed fallback | Repair authorized route/trust; verify existing external state before retry | R07/R09 |
| Publish returns ambiguously or process stops | `publication unknown`, version/run/attempt retained | Read registry/workflow first; matching artifact advances, absence still needs covered action | R07/R09 |
| Version exists with different bytes or wrong tag target | Collision; no overwrite or green skip | Preserve evidence; owner selects corrected version/scope through normal preparation | R07 |
| Registry lag/outage/provenance or install failure | `published; delivery unverified` at deadline | Later read-only resume verifies exact bytes/provenance/install; no new publish | R08/R09 |
| Live budget/host/capability unavailable, sleep or coverage gap | Canary incomplete with reason; F12 still OPEN | Stop added requests; repair setup offline or await separately authorized valid window | R10 |
| Receipt stale/corrupt or cleanup ownership uncertain | Status unavailable or cleanup retained with path | Reconstruct from authoritative readback; delete only verifiably owned paths | R09/R11 |

## Behavioral oracles and acceptance

These are required implementation tests, not tests run during planning. Use Node's runner with real local Git repositories, subprocesses, tarballs and private temporary directories; mock GitHub/registry/network/clock boundaries, not the release logic itself.

| ID | Checkable acceptance |
| --- | --- |
| R01 | Adapter scenarios: supplied version and full release authority do not reprompt; absent publication authority performs no mutation; one allowed fixture correction is honored and a second/product change stops; unrelated triage retains its boundaries. |
| R02 | Selector lists all selected files/cases, executes no excluded module setup, preserves the full union of existing coverage, defaults broad on unknown input, and never hides a nonzero command with a later success. |
| R03 | Six original fixture mechanisms remain asserted. New child-failure, outer-deadline and sibling-cleanup cases fail before repair and pass after; semantic assertions are retained. |
| R04 | Child error and later assertion error both produce useful bounded redacted capture/call/timing evidence; successful cases clean up; Linux GNU and macOS BSD terminal branches run actual relevant smoke. |
| R05 | Local fake-GitHub trace has one authoritative selection and one packed candidate, with zero full selections on identical main/publisher paths. Reject stale base/head, changed harness/lock/tree, wrong run/attempt/repo/event, skipped jobs and corrupt/missing artifacts. |
| R06 | Protection transition simulation and later API readback never expose unprotected merge: aggregate is added before legacy contexts are removed; all unrelated protection fields preserved; interrupted transition resumes safely. |
| R07 | Real pinned npm against a loopback registry captures exact verified tarball bytes, zero lifecycle suite executions and explicit arguments. Identity verifier rejects malicious archive paths/symlinks, tampering, wrong provenance subject and wrong source. Same-version exact match is idempotent; different bytes/auth failure/ambiguous publish are not success. Hosted OIDC remains separately unverified until real release. |
| R08 | Registry 404 lag, Retry-After, network error, wrong integrity, missing provenance, wrong latest and failed installed bin each have bounded failure and successful later read-only recovery. Fresh install outside the checkout verifies manifest, exact version/help and bin on Node 22/24. |
| R09 | Kill/restart after each external side effect; resume reads back before acting and never duplicates push/merge/tag/release/publish. Lock collision and stale receipt are disclosed; finite polling handles absent and terminal checks. |
| R10 | Offline canary setup proves readiness, correct Actions-only schema, independent one-shot secondary assertions, exact source/candidate and finite quota/time bounds. No capability refusal or absent EMU evidence becomes complete coverage. |
| R11 | Tracked current receipt agrees with readback evidence, retains accepted limitations and original failures, redacts secrets, and cleanup cannot remove unrelated files/worktrees/processes. |

Local acceptance: applicable sequential gates in each phase, independent review, repair, simplify, and exact tested identities. Manual review is limited to playbook clarity, authorization scope, and visual judgment not measurable by terminal assertions. No request for the owner to run operational commands. Platform-only or hosted claims stay `UNVERIFIED` until native evidence exists.

Operational targets, measured on the next two separately authorized releases: fast feedback <=2 minutes; routine accepted-candidate-to-delivery <=15 minutes; coordination/recovery automated gates <=30 minutes. Record actual duration, queue/provider time, repeated selection count and owner decision count. A miss triggers diagnosis of that stage, not removal of required evidence or a new metrics subsystem. Any live window has separate timing. Local fixture simulations cannot establish these performance claims.

## Consumer sweep

Searches used, supplemented by the two bounded read-only reviews:

```sh
rg -n 'npm test|test:coverage|test:pty|test:efficiency|npm publish|release-playbook|STOP|repush|re-push' package.json CLAUDE.md AGENTS.md CONTRIBUTING.md README.md .github .husky .claude .agents/skills .rpi/rules
rg -n 'capture\(|captureStreaming\(|from.*capture|node --test|prepublishOnly' test scripts package.json .github
rg -n 'schema|cadenceMs|requestedDurationMs|freshness-monitor|forty|40 subscriptions' scripts/freshness-monitor.mjs test/freshness-monitor.test.mjs README.md docs/plans/2026-09-28-durable-freshness-and-recovery*
rg -n 'rpi-release|push-accountability|rpi-details|ci-workflow' .rpi/manifest.json
```

| Consumer/writer | Coverage or exclusion |
| --- | --- |
| `AGENTS.md`, `CLAUDE.md`, `.claude/rules/{rpi-details,push-accountability,testing,deployment-safety}.md`, `.rpi/rules/{rpi-details,push-accountability,testing,deployment-safety}.md` | Phase 1: project authority and verification alignment; Phase 2 updates exact commands. Preserve unrelated rule constraints. |
| `.agents/skills/rpi-release/SKILL.md`, `.claude/skills/rpi-release/SKILL.md`, `.claude/commands/release.md`, `.agents/skills/source-command-release/SKILL.md` | Phase 1: thin project-specific release routing. Generic reference playbooks remain historical/general references, not copied or globally rewritten. |
| `.claude/commands/fix-ci.md`, `.agents/skills/source-command-fix-ci/SKILL.md`, both `rpi-fix-ci` and `ci-workflow` skill copies | Phase 1: repair/authority consistency, preserve correct native behavior. |
| `.rpi/manifest.json`, `.rpi/baselines/`, lifecycle/diagnostic scripts | Read-only ownership evidence; do not rewrite baseline hashes. Record expected local customization. No installer implementation. |
| `package.json`, `test/sustained-recovery.test.mjs`, `test/package-boundary.test.mjs`, new selection/helper tests | Phase 2: command/file ownership and exact-artifact reusable exercise. Keep package manifest allowlist at five files. |
| `test/pty/capture.mjs`, `run.sh`, every `test/pty/*.test.mjs`, `test/pty/readme-sample.mjs`, `test/runtime-coverage.mjs` | Phase 2: all capture callers receive unchanged normal results and explicit diagnostic ownership; adapt only affected consumers. README sample generator does not require failed-test retention. |
| `test/{identity-process,identity,webhooks}.test.mjs`, `test/pty/{governor,adaptive-polling,e2e,keys,collector}.test.mjs` and their fixtures | Phase 2: six regressions, deadlines, teardown, cached-age and selective execution. No product assertions removed. |
| `scripts/sustained-recovery.mjs`, `scripts/measure-efficiency.mjs`, `test/efficiency.test.mjs`, `test/fixtures/request-oracle.mjs` | Phase 2 selection/input accounting only; retain existing oracle behavior. No performance-driven weakening. |
| `scripts/freshness-monitor.mjs`, `test/freshness-monitor.test.mjs`, README monitor section and old Phase 4 contract/notes | Phases 1/4: explicit continuous Actions usage and separate on-demand cases; schema 1/2 unchanged. Original historical manifests/results retained. |
| `.github/workflows/{ci,release,coverage,codeql,dependency-review,sutura}.yml` | Phase 3 changes CI/release/coverage routing. Preserve security semantics; Sutura inspected for observation only. Phase 4 handles protection readback. |
| `scripts/{extract-coverage-metrics.mjs,report-coverage.sh}`, `test/{coverage-reporting,runtime-coverage}.test.mjs` | Phase 3 verify coverage meaning/commit binding remains accurate; do not rewrite old percentages. Runtime coverage stays informational. |
| `CONTRIBUTING.md`, `.github/PULL_REQUEST_TEMPLATE.md`, `.husky/pre-commit`, `eslint.config.js`, package lint script | Phases 1–2: remove stale test advice/live-default requirements, align commands and explicitly scoped lint. Keep tracked source/tests/scripts linted. |
| Existing release report, old Phase 4 validation, new current receipt and driver | Phases 1/4: current status supersedes historical headings without deleting failure evidence. New driver is the sole current-receipt writer. |
| `index.mjs`, product schemas, application credentials and other repositories | Excluded from process-repair implementation. Read for oracle semantics only. A demonstrated product defect needs a recorded plan deviation before code changes. |

Implementation repeats narrow consumer searches after edits, names new callers and preserves this disposition table. No phase is batch-eligible as a whole; shared package/test/workflow inputs require sequential acceptance. Phase files identify only disjoint within-phase assignments.

## Phases and durable handoff

1. [Phase 1: one release procedure and accurate status](2026-10-02-release-process-repair-phases/phase-1.md).
2. [Phase 2: explicit test selections and reliable evidence](2026-10-02-release-process-repair-phases/phase-2.md).
3. [Phase 3: candidate artifact and workflow repair](2026-10-02-release-process-repair-phases/phase-3.md).
4. [Phase 4: resumable release driver and authorized activation](2026-10-02-release-process-repair-phases/phase-4.md).

Each phase uses an isolated local worktree/temporary branch, one integration owner, no working-branch push/PR, and implement → independent review → repair → simplify → sequential verification. Integrate accepted work locally into develop. Preserve exact base/current commits, worktree, candidate/input hashes, commands with actual exits, failed results, finding dispositions, deviations and remaining authority in the phase validation note before cleanup. Phase 4 distinguishes completed local implementation from authorized rollout and later two-release measurement.

Resume by inspecting actual refs/status and reading this plan and the next phase completely. Evidence from October 2 describes the baseline; it cannot authorize later work or substitute for changed-input testing. Next action after plan acceptance is local Phase 1 implementation. All A/G items are assigned; no architectural decision is deferred. External activation, native OIDC proof, performance measurement and F12 remain explicit future evidence boundaries.

## Planning review and verification

Two bounded read-only assignments reviewed current policy/acceptance and fixtures/selection, then independently reviewed this plan. The authority/artifact reviewer found an immutable-upload identity cycle and a verifier trust-bootstrap ambiguity. The fixture reviewer independently found the identity cycle, clarified source versus rendered evidence, and required cheap non-E2E efficiency checks to remain fast. All were corrected in the specification and re-reviewed. Both reviewers approved their assigned scopes with no remaining material gaps. This is plan review, not implementation verification or owner acceptance of future release actions.

Planning-only verification checked all five documents, local link targets and line bounds, pseudocode notation/lengths, unresolved markers and whitespace. Product code, workflows, policy files and remote settings are unchanged. No product test pass, native platform result, OIDC proof or speed improvement is claimed. Preserve the pre-existing assessment and unrelated macos-rules directory. The next decision is acceptance of this concrete plan and its first local implementation phase; Option A itself is already confirmed.

## Primary external references

- [npm publish](https://docs.npmjs.com/cli/v11/commands/npm-publish/): explicit tarball package specification and immutable name/version behavior.
- [npm lifecycle scripts](https://docs.npmjs.com/cli/v11/using-npm/scripts/): publication lifecycle behavior; removing duplicated runs requires explicit script control.
- [npm trusted publishing](https://docs.npmjs.com/trusted-publishers/): Node/npm floor, authorized workflow and hosted OIDC requirements.
- [GitHub workflow artifacts](https://docs.github.com/en/actions/tutorials/store-and-share-data): cross-job artifacts and digest mismatch warning. The plan adds hard verification because a warning is insufficient.
- [GitHub event semantics](https://docs.github.com/en/actions/reference/workflows-and-actions/events-that-trigger-workflows): PR merge-tree identity and workflow_run triggering context.
