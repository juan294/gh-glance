# Research: concurrent-pane refresh feedback and GitHub API coordination

> 2026-08-18 | Branch `develop` @ `975a527b`
> Branch note: `develop` advanced from `a34c5db5` to `975a527b` while this
> research was running. The final document uses the newer source. No source code
> was changed during this research.

## Scope

This research answers four questions raised by the 12-pane observation:

1. Whether a pane that says `throttled 54s` still checks GitHub.
2. Why the footer no longer gives visible blue feedback during automatic checks.
3. How the current multi-process rate protection works and what it does not share.
4. Which established architecture and status-feedback patterns exist for a later
   `/plan` to evaluate.

This is a documentarian pass. It records the current system, external platform
constraints, and available architecture patterns. It does not select or implement
a change.

## Summary answer

The pane is still checking GitHub. `throttled 54s` is the applied interval, not a
54-second lockout and not a countdown. The active tab is scheduled about once
every 54 seconds. The three inactive tabs are scheduled every twelfth tick, or
about every 648 seconds at that interval. Switching tabs asks the newly visible
tab to refresh immediately, and `r` force-refreshes the active tab
(`index.mjs:116-122`, `index.mjs:3689-3693`, `index.mjs:4570-4577`,
`index.mjs:4839-4860`, `index.mjs:4943-4949`).

The UI does not expose this clearly. The footer always prints the word `Fetching`,
but it is cyan only when the `loading` state is true and dim otherwise. After a
tab has data, automatic polls deliberately do not set `loading`; only first load
and forced/manual refresh do. A settled automatic request can therefore be in
flight while the footer stays dim and static (`index.mjs:3685-3687`,
`index.mjs:3941-3969`, `index.mjs:4670-4684`). The unit and PTY suites explicitly
lock this behavior: automatic `run list` calls continue after data appears without
`Fetching` becoming cyan again (`test/runtime-remediation.test.mjs:219-223`,
`test/pty/runtime-remediation.test.mjs:212-221`).

The current protection is a distributed feedback controller. Each process meters
its own REST and GraphQL spend, reads the token-wide counters, infers how many
equivalent consumers share the token, and widens its own timer. GitHub's counter
is the shared signal; there is no request broker, IPC channel, or shared throttle
registry (`index.mjs:1048-1097`, `index.mjs:1197-1212`,
`index.mjs:1695-1711`). This design protects the budget, but it does not tell the
user when the last successful check occurred or when the next one will start.

## 1. Exact meaning of the screenshot

### `throttled 54s` is a cadence

The adaptive controller retains `runtime.refreshMs` as a floor and can widen the
timer up to 60 seconds. It targets 80% of the affordable remaining budget and
uses a 25% hysteresis before it changes an applied interval
(`index.mjs:1013-1038`, `index.mjs:1110-1128`). REST and GraphQL targets are
computed independently; the larger interval wins (`index.mjs:1145-1163`).

When a target is accepted, `rearm(target)` replaces the process timer and
`setThrottleMs` stores the same target for the footer. The rendered number is
`Math.round(throttleMs / 1000)`. It does not decrease between polls
(`index.mjs:4870-4890`, `index.mjs:4909-4923`, `index.mjs:5355-5361`).

At the displayed 54-second interval:

| Work | Current scheduler rule | Approximate cadence |
|---|---|---:|
| Active tab | every tick | 54 seconds |
| Each inactive tab | every 12th tick | 648 seconds, or 10m48s |
| Budget probe | checked when a tick finds at least 60s elapsed | about 108 seconds after the immediate first probe |
| Manual `r` | immediate force request after the in-flight guard admits it | on demand |

The rules come from `BACKGROUND_EVERY`, `pollTickKeys`, the tick's budget-probe
condition, and the manual refresh path (`index.mjs:116-122`,
`index.mjs:3689-3693`, `index.mjs:4570-4577`, `index.mjs:4845-4860`). Per-tab
in-flight and failure backoff can still absorb a due attempt
(`index.mjs:4670-4675`, `index.mjs:4818-4835`).

### The word `Fetching` represents two different states through color alone

The footer reserves 12 cells and always renders a spinner glyph plus `Fetching`.
When `fetching` is false, it pins the glyph to its resting frame and dims the
text. When true, it uses cyan and an animated frame (`index.mjs:3858-3860`,
`index.mjs:3941-3955`). The throttle badge is a second dim label because the code
treats adaptive widening as a working protection state, not an error
(`index.mjs:3964-3969`).

The current render input has `fetching`, `stale`, and `throttle`, but it has no
last-check time, next-check deadline, countdown, scheduler state, or reason for
the widened interval (`index.mjs:3898-3912`, `index.mjs:5355-5368`). The
`stale` label appears only after the active tab has gone longer than
`max(30 seconds, configured floor x 6)` without a successful poll
(`index.mjs:5047-5061`). It uses the configured floor, not the current adaptive
interval.

The quiet automatic-poll behavior is an explicit v0.9.0 product contract. README
says that settled automatic polls do not flash `Fetching`, and the changelog says
`Fetching` is reserved for startup/manual work (`README.md:82-84`,
`CHANGELOG.md:58-60`). Before commit `2ccbfc0`, every poll set loading true. That
commit introduced `shouldShowFetchLoading`, which made settled automatic checks
visually quiet (`index.mjs:3685-3687`, `index.mjs:4679-4684`).

### Unreleased manual-refresh spinner fix

Commit `975a527b`, which landed on `develop` during this research, changes
`showSpinner` to include `anyLoading` and passes the same value to `StatusBar`
(`index.mjs:4970-4990`, `index.mjs:5355-5360`). It makes a manual `r` refresh
animate instead of only turning cyan. It does not make settled automatic polls
visible, because those polls still do not enter `loading`
(`index.mjs:3685-3687`, `index.mjs:4679-4684`). The change is recorded under
Unreleased (`CHANGELOG.md:8-18`). The installed CLI and repository package still
report v0.9.1 (`package.json:1-4`).

## 2. Current API protection architecture

### Per-fetch cost model

One Actions fetch is billed as two REST requests. Issues and Pull Requests each
cost two GraphQL requests. A Security fetch costs up to six REST requests when
all bounded priority lanes run (`index.mjs:995-1011`). At the five-second floor,
the conservative projections are:

| Active tab | REST/hour | GraphQL/hour |
|---|---:|---:|
| Actions | up to 1,800 | 240 |
| Issues or Pull Requests | up to 480 | 1,560 |
| Security | 2,280 normally; up to 4,440 | 240 |

These are the current documented and tested figures (`README.md:457-480`,
`test/unit.test.mjs:2093-2105`). They explain why 12 independent five-second
Actions panes cannot all keep the floor while sharing one personal token.

### Closed-loop behavior across processes

Each process runs an immediate budget probe, then considers another probe when a
poll tick sees that at least 60 seconds elapsed. The probe is host-routed and
reads the `core` and `graphql` resources separately (`index.mjs:1023-1027`,
`index.mjs:1695-1711`, `index.mjs:4845-4848`, `index.mjs:4874-4878`).

Each process also counts its own periodic calls. Over a usable probe window, the
controller divides the token-wide `used` delta by its own call count. That ratio
is its estimate of equivalent consumers. It holds the prior estimate when a
throttled pane has too few calls to make a new sample, and it restarts the sample
window when GitHub's hourly counter resets (`index.mjs:1029-1085`).

The controller then calculates how often this process can poll within 80% of the
remaining budget. It never goes below the configured floor, and an exhausted
budget goes directly to the 60-second adaptive ceiling
(`index.mjs:1013-1021`, `index.mjs:1088-1120`). Unit tests model 1, 3, 7, 10,
and 20 consumers and assert that their aggregate modeled spend stays within the
80% target (`test/unit.test.mjs:2132-2158`). A separate test holds the inferred
share across small samples so a heavily throttled pane does not alternate between
the floor and a wide interval (`test/unit.test.mjs:2226-2262`).

### What is and is not shared

The rate controller is process-local: its meter, open sample window, inferred
share, timer, and failure backoff live in memory (`index.mjs:1197-1237`,
`index.mjs:4870-4889`). GitHub's token counter is the only shared feedback
channel (`index.mjs:1088-1097`). This also makes the controller yield to unrelated
consumers such as another `gh` command.

The on-disk dashboard cache is shared safely across panes, but it is recovery
state, not scheduling state. Its key includes the repository or working
directory, host, and effective account identity. It uses a bounded lock, atomic
replacement, and per-target/per-tab merging (`index.mjs:3076-3177`,
`index.mjs:3393-3464`, `index.mjs:3589-3666`). A successful unchanged response
advances the in-memory last-success time and checkpoints the cache on a bounded
cadence without replacing React state (`index.mjs:3673-3677`,
`index.mjs:4693-4755`).

### Backoff is a separate mechanism

Adaptive throttling widens successful polling. Error backoff suppresses requests
after recognized failures. Unavailable or no-remote failures use a ladder from
one minute to one hour, authentication failures retry every 30 seconds, and rate
limit failures retry every 60 seconds (`index.mjs:143-166`,
`index.mjs:1219-1237`). The live rate-limit error is separate from the dim
`throttled Ns` cadence badge (`index.mjs:437-455`, `index.mjs:4794-4808`).

## 3. What the LazyGit comparison establishes

LazyGit separates three jobs:

- local file/submodule refresh, default 10 seconds;
- remote `git fetch`, default 60 seconds;
- external-ref change detection, default 2 seconds.

Those intervals and their separate enable switches are public configuration
([LazyGit configuration at commit `c199ac6`](https://github.com/jesseduffield/lazygit/blob/c199ac69f5bb26d5b4a5094301f1918d9aec89ac/docs/Config.md#L425-L441),
[refresh intervals](https://github.com/jesseduffield/lazygit/blob/c199ac69f5bb26d5b4a5094301f1918d9aec89ac/docs/Config.md#L553-L566)).

Its periodic runner waits for one callback to finish before it accepts the next
tick, so slow work does not pile up. It also supports a coalesced immediate-fetch
trigger when the repository changes
([`background.go:221-257`](https://github.com/jesseduffield/lazygit/blob/c199ac69f5bb26d5b4a5094301f1918d9aec89ac/pkg/gui/background.go#L221-L257),
[`background.go:269-281`](https://github.com/jesseduffield/lazygit/blob/c199ac69f5bb26d5b4a5094301f1918d9aec89ac/pkg/gui/background.go#L269-L281)).

The lower-left animation is an operation status. A background fetch enters a
`Fetching` waiting status while the actual `git fetch` runs
([`background.go:107-147`](https://github.com/jesseduffield/lazygit/blob/c199ac69f5bb26d5b4a5094301f1918d9aec89ac/pkg/gui/background.go#L107-L147)).
The status manager adds the spinner only for a waiting status, removes it when the
operation ends, and animates one shared status render loop
([`status_manager.go:56-89`](https://github.com/jesseduffield/lazygit/blob/c199ac69f5bb26d5b4a5094301f1918d9aec89ac/pkg/gui/status/status_manager.go#L56-L89),
[`app_status_helper.go:126-171`](https://github.com/jesseduffield/lazygit/blob/c199ac69f5bb26d5b4a5094301f1918d9aec89ac/pkg/gui/controllers/helpers/app_status_helper.go#L126-L171)).

This is not an always-on heartbeat. It is a visible transition into and out of
real work. LazyGit also polls local Git state and runs `git fetch`; it does not
query Actions, Issues, Pull Requests, and Security from the GitHub API. Its
animation pattern is comparable to gh-glance's status problem, but its request
budget is not comparable.

## 4. External GitHub constraints

GitHub's current REST guidance prefers webhooks over polling. When polling is
required, it says to use a fixed schedule, honor `x-poll-interval`, use
authenticated conditional requests, keep responses stable, and serialize
requests to reduce secondary-rate-limit risk
([GitHub REST best practices](https://docs.github.com/en/rest/using-the-rest-api/best-practices-for-using-the-rest-api?apiVersion=2022-11-28)).

An authenticated conditional GET that returns `304 Not Modified` does not count
against the primary rate limit. The request still exists, so secondary-rate-limit
and concurrency constraints remain
([GitHub conditional requests](https://docs.github.com/en/rest/using-the-rest-api/best-practices-for-using-the-rest-api?apiVersion=2022-11-28#use-conditional-requests)).

GitHub documents a 5,000-request/hour personal authenticated REST budget, a
separate GraphQL primary budget, a shared maximum of 100 concurrent REST and
GraphQL requests, and response headers for remaining/reset state. It recommends
using response headers instead of polling `GET /rate_limit` when possible because
the rate-limit endpoint can count against secondary limits
([GitHub REST rate limits](https://docs.github.com/en/rest/using-the-rest-api/rate-limits-for-the-rest-api)).

GitHub CLI exposes `gh api --cache <duration>` and arbitrary request headers, but
the higher-level `gh run list` command has no cache or response-header option
([`gh api` manual](https://cli.github.com/manual/gh_api),
[`gh run list` manual](https://cli.github.com/manual/gh_run_list)). gh-glance
currently uses `gh run list` for Actions and direct `gh api` calls for Security
(`index.mjs:810-844`, `index.mjs:1165-1175`).

GitHub also provides `workflow_run` webhooks for requested, in-progress, and
completed run activity, but receiving them requires webhook delivery
infrastructure. GitHub's GitHub App guidance also says that native clients cannot
secure an app private key and should not generate installation tokens locally
([workflow webhook event](https://docs.github.com/en/webhooks/webhook-events-and-payloads#workflow_run),
[GitHub App credential guidance](https://docs.github.com/en/apps/creating-github-apps/about-creating-github-apps/best-practices-for-creating-a-github-app)).

## 5. Architecture patterns available to a later plan

The evidence establishes five distinct patterns. They have different effects and
are not interchangeable.

| Pattern | What it changes | API effect | Product boundary |
|---|---|---|---|
| Explicit status-state model | Distinguishes idle/scheduled, checking, success, backoff, and stale states; can expose last success and next due time | None by itself | Retains current process and API design |
| Shared local scheduler or broker | One account/host coordinator grants request slots to all pane clients, probes the budget once, and can serialize or stagger work | Controls concurrency and allocation; unique repository requests still cost the same | Adds IPC, lifecycle, permissions, failure recovery, and a new local process role |
| Conditional REST polling | Persists ETag/Last-Modified validators per account, host, repository, and endpoint, then reuses data on `304` | Unchanged authenticated REST responses do not consume the primary REST budget | Requires direct REST response/header handling; it does not cover current GraphQL list calls |
| One multi-repository process | Moves all repository views under one scheduler and one set of timers | Makes coordination exact and removes duplicate budget probes | Changes the current one-pane-per-project usage model |
| GitHub App plus webhooks | Replaces most polling with pushed events and targeted reconciliation | Lowest steady polling cost and faster event delivery | Requires a registered app and reachable service; it is no longer the current serverless, delegated-`gh` CLI architecture |

The first pattern addresses the observed feedback gap without altering API
spend. The next three alter local request architecture. The webhook pattern is a
different product and authentication model. GitHub's guidance supports the
conditional-request and webhook mechanics cited above; the current repository
constraints for the single-file CLI and single `runGh` seam are documented at
`CONTRIBUTING.md:185-198`.

## 6. Evidence boundaries for a later plan

- The current unit suite models up to 20 consumers, but the PTY throttle test
  compares one drained pane with one healthy pane. It proves that the budget
  probe runs, the badge appears, and request count falls; it does not launch 12
  concurrent processes (`test/unit.test.mjs:2132-2158`,
  `test/pty/throttle.test.mjs:18-65`).
- The current PTY suite proves that automatic polling continues while `Fetching`
  remains dim, which explains the screenshot but does not test a last-check or
  next-check presentation because neither exists
  (`test/pty/runtime-remediation.test.mjs:212-221`).
- The last-known-good cache is already account-scoped and multi-process safe, but
  it does not coordinate polling (`README.md:358-387`,
  `index.mjs:3393-3464`).
- ADR 0001 keeps independent `gh` data calls because Actions cannot be reached
  from one repository GraphQL query and combining Issues/Pull Requests did not
  meet the recorded latency bar. It permits revisiting the decision if GitHub's
  data surface changes (`docs/decisions/0001-keep-the-gh-cli-data-layer.md:27-65`,
  `docs/decisions/0001-keep-the-gh-cli-data-layer.md:89-101`).

## Conclusion

The screenshot shows a healthy protective state whose meaning is not explicit.
At `throttled 54s`, the active Actions tab still checks about once per minute.
The absence of cyan movement is expected because released v0.9.1 intentionally
hides settled automatic polls.

The current controller already provides token-aware protection without a daemon.
The research separates the remaining design space into status feedback, local
coordination, conditional HTTP polling, multi-repository process ownership, and
webhook delivery. A `/plan` can now choose among these patterns and define the
exact status vocabulary, request architecture, and verification needed for 12
concurrent panes.
