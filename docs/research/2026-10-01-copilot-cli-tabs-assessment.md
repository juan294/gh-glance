# Copilot CLI tabs and gh-glance request demand

Date: 2026-10-01. Status: assessment complete; internal Copilot polling behavior unverified.

## Question and scope

Can the Current, Sessions, Issues, Pull requests, and Gists bar shown in Copilot CLI 1.0.90 provide a simpler, reliable approach for gh-glance, especially across several terminal panes?

This assessment covers public documentation, the official changelog, published package contents, and current gh-glance source. It does not run Copilot, inspect personal credentials, send authenticated GitHub requests, install dependencies, or change the product. The screenshot establishes the interface and version, not request frequency or shared caching.

## Baseline and criteria

- Integration: `/Users/juan/code/gh-glance`, `develop`, commit `24253cf8315623e510b54bf849ec7e66dab1c8f4`.
- Existing repair: `/Users/juan/code/gh-glance-transport-queue`, branch `fix/transport-queue-deadline`, same base, with uncommitted implementation and tests. Current `index.mjs` SHA-256: `8d61bbf06022a282aa7fa337141a04f1f071c3b9de9a9e24f679c409e5942558`.
- Criteria: unattended freshness of visible Actions; bounded aggregate API demand; isolation between accounts/hosts; recovery without restarting; ordinary standalone `gh` authentication; limited release scope and migration risk.
- The root's own `graphify-out/graph.json` was queried for `pollPolicyInterval`, `runDataWake`, and `requestTab`, then source was read. No callable local Graphify service was exposed. The graph describes integration, not uncommitted repair changes.

## External evidence

### C1: The tab bar does not establish a continuous monitoring contract

GitHub documents Issues and PR tabs as lists of open repository items, initially filtered to items involving the user. Users can change the filter, search, page through results, open details, and bring references into chat. Gists are account scoped. The documentation gives no freshness deadline, polling interval, request count, or multi-process deduplication guarantee. [GitHub browsing documentation](https://docs.github.com/en/copilot/how-tos/copilot-cli/use-copilot-cli/browse-issues-prs-gists).

The screenshot's Current and Sessions tabs are also documented in the command reference. Their presence does not mean each tab performs repository API polling. [CLI command reference](https://docs.github.com/en/copilot/reference/copilot-cli-reference/cli-command-reference).

### C2: Cached PR status with an explicit refresh is confirmed

The official 1.0.66 changelog, dated 2026-06-30, introduced PR merge status with cached results refreshed by pressing `r`. It also records retaining the last issue/PR/gist view when switching tabs. These are useful product patterns. They do not prove that every list is manual-only, that cached data is shared between processes, or that 1.0.90 has no additional refresh triggers. [Official changelog, 1.0.66](https://github.com/github/copilot-cli/blob/main/changelog.md#1066---2026-06-30).

### C3: Copilot authentication is not evidence of an independent quota

Copilot supports OAuth, environment tokens, and fallback to an existing `gh` login. Its actual credential on the screenshot machine was not inspected. [Authentication documentation](https://docs.github.com/en/copilot/how-tos/copilot-cli/set-up-copilot-cli/authenticate-copilot-cli).

GitHub documents a personal REST allowance shared by PAT, OAuth, and GitHub App user-token requests. Enterprise arrangements can change limits; installation tokens have a different allowance. Therefore changing the CLI or OAuth app alone does not establish quota isolation. Search has separate restrictions and GraphQL has its own primary budget. [REST rate limits](https://docs.github.com/en/rest/using-the-rest-api/rate-limits-for-the-rest-api).

The official 1.0.57 changelog records improved reporting of GitHub API limits during update and authentication validation. This is historical counterevidence to blanket immunity, not evidence of a present tab-specific defect. [Official changelog, 1.0.57](https://github.com/github/copilot-cli/blob/main/changelog.md#1057---2026-06-01).

### C4: Exact implementation is not available from the inspected distribution

No `copilot` executable was found on PATH or at the checked local/npm/Homebrew executable locations. The public repository lists documentation, changelog, license, installation script, and GitHub configuration, without tab implementation source. [Official repository](https://github.com/github/copilot-cli).

The exact npm version was downloaded into `/tmp/copilot-tabs-assessment-1.0.90` for static inspection, without installation or execution. Both tarballs passed SHA-512 integrity comparison with registry metadata:

| Package | Contents relevant to this assessment | Tarball SHA-256 |
| --- | --- | --- |
| `@github/copilot@1.0.90` | npm loader, metadata, README, license | `46b5c0031ca632e04765b5721308613a21d2936fb6ded0875065f3d1da5e34bc` |
| `@github/copilot-darwin-arm64@1.0.90` | compiled Mach-O executable, metadata, README, license | `e8919d150b588b31175f67a15dd947fe36f1a401dadc47b992955afb6004897c` |

Sources: [loader package metadata](https://registry.npmjs.org/@github/copilot/1.0.90), [platform package metadata](https://registry.npmjs.org/@github/copilot-darwin-arm64/1.0.90). Retrieved 2026-10-01. No readable tab implementation was obtained. Exact endpoints, timer cadence, focus gating, cross-process cache scope, and backoff remain unknown.

## Current gh-glance behavior

These locations refer to the integration commit above:

- Conditional REST requests already use `If-None-Match`: `index.mjs:998`.
- Active running Actions have a 5-second policy minimum, quiet tabs slow after two unchanged observations, and inactive tabs have 120-second minimums or 300 seconds for Security: `index.mjs:145`, `index.mjs:150`, `index.mjs:159`.
- `--refresh` remains a floor. `--background off` makes inactive-tab demand ineligible: `index.mjs:15021`.
- Cache identities include account, host, and repository context: `index.mjs:13002`, `index.mjs:13044`.
- The existing scheduler awaits the acquisition batch, allowing a slow request to delay its next wake: `index.mjs:19097`.

The existing local repair addresses transport queueing and that scheduler coupling. Its three-permit bound is at worktree `index.mjs:2843`; scheduled requests detach their network completion at `index.mjs:18841`, `index.mjs:19049`, and `index.mjs:19211`. This is not a Copilot-derived architectural change.

## Options and trade-offs

| Option | Freshness and demand | Compatibility and risk | Assessment |
| --- | --- | --- | --- |
| Finish current shared quota/transport/scheduler repair | Preserves automatic monitoring and bounds our aggregate work | Existing standalone login and architecture; verification still required | Recommended release direction |
| Offer explicit on-demand behavior for secondary tabs | Removes periodic requests for tabs the user never opens; cached values must show age | Existing `--background off` already supplies much of this behavior; changing the default alters count freshness | Useful product option, not an unapproved default change |
| Replace automatic monitoring with manual refresh everywhere | Low idle traffic, but a completed or failing run can remain unseen indefinitely | Changes the core unattended dashboard contract | Not recommended for the current goal |
| Assume Copilot uses a special quota or shared service and copy it | No measured benefit established | Unknown implementation, authentication and migration requirements | Unsupported by evidence |

Illustrative arithmetic, not a measurement of either application: ten panes each sending one request per minute produce 600 requests/hour. Four such requests per pane per minute produce 2,400/hour, before pagination, retries, observers, or other tools. Keeping secondary data on demand can materially reduce that load. A list filter alone need not reduce the number of API requests.

## Recommendation and unresolved evidence

Borrow the confirmed interaction pattern: retain cached secondary views, expose their age, and provide explicit refresh. Preserve automatic updates for the active monitoring surface. gh-glance already implements several relevant mechanisms; verify their behavior and finish the approved queue/scheduler repair before considering a larger redesign.

Do not infer that an inactive Copilot tab polls, that it never polls, or that multiple terminals share its responses. Establishing those facts would require readable implementation or an isolated, credential-safe runtime trace that counts requests while switching tabs and leaving them idle. No such trace was collected, and it is not a prerequisite for finishing the current repair.

A verified Copilot cross-process cache or event subscription mechanism compatible with ordinary `gh` login could change this recommendation. Public docs and package inspection did not establish one.

## Handoff

- Completed: bounded comparative assessment and public package integrity checks. No product edits, live GitHub qualification, push, installation, or publication in this assessment.
- Findings C1-C4 are resolved as evidence statements; exact Copilot transport behavior remains explicitly unknown.
- Existing repair remains uncommitted in its worktree. The latest isolated slow-background PTY test passed once in `docs/agents/recovery-combined-2026-09-29/offline-multi-pane-diagnosis-2026-10-01/background-progress-detail.log`. Earlier attempts include failures; this pass does not establish final verification or a stable regression oracle.
- Next authorized implementation work: resolve the regression fixture's sensitivity to quiet cadence, rerun the final offline comparison and required sequential gates, preserve evidence, integrate locally, and clean the task worktree when safe. Existing live qualification and publication boundaries remain unchanged.
- No new architectural decision is needed to continue that approved repair. Making on-demand secondary tabs the default would require an explicit product decision.


## Subsequent owner decision

On 2026-10-01 the user approved keeping active Actions automatic and making secondary views cached and refreshed on demand. This supersedes the pending-default decision above. Implementation and its exact verification belong to the durable-freshness plan notes; this assessment remains a record of the evidence available before that decision.
