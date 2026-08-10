# Research: API request cost, throttling, and rate-limit exhaustion under N concurrent instances

> 2026-08-10 | Branch `develop` @ `900dd42` (v0.6.1)
> Documentarian pass. This describes the mechanisms that exist today, the
> measurements taken during the 2026-08-10 exhaustion incident, and what the
> historical record already decided. It does not propose an implementation.

## Scope

The question is how gh-glance's GitHub API request cost is determined and
controlled -- every mechanism that spends, throttles, or reports calls -- so
that a later plan can address the case where several concurrent instances
exhaust the shared 5,000/hour REST limit.

The triggering observation: with seven panes open across seven repositories, the
Actions tab rendered `GitHub rate limit reached -- backing off, this clears on
its own` and the token's core budget was fully consumed.

## Summary answer

Cost is determined by four numbers and one loop, all in `index.mjs`: the poll
interval (`REFRESH_MS`, `index.mjs:48`), the background-tab divisor
(`BACKGROUND_EVERY`, `index.mjs:110`), the number of endpoints each tab fetches
(`ALERT_SOURCES`, `index.mjs:899-947`), and which tab is active. The loop is a
single mount-only `setInterval` (`index.mjs:2878`).

Cost is controlled by four mechanisms, all of which operate **inside one
process**: the background-tab divisor, a per-tab in-flight guard
(`index.mjs:2757-2758`), three backoff ladders keyed by failure verdict
(`index.mjs:967-972`), and the `--refresh` flag (`index.mjs:1522-1523`).

Cost is reported in exactly one place -- `--doctor` -- via `rateBudget()`
(`index.mjs:1306-1322`) and `projectedHourlyCost()` (`index.mjs:1330-1345`).
The running TUI displays no budget information at all.

The decisive structural fact: **there is no cross-process coordination and no
on-disk state of any kind.** The app performs exactly two filesystem calls, both
reads, both at module load (`index.mjs:39-40`, `index.mjs:1570`). Every piece of
throttling state is created at process start and lost at exit. The rate limit,
however, is per **token**. N instances therefore spend one budget while
throttling independently, and cost scales linearly in N with no mechanism aware
that N > 1.

## 1. The 2026-08-10 measurement

Taken during the incident, before any instance was stopped.

**Instances running** -- seven, one per repository, six with 5+ hours uptime
(`ps -eo pid,etime,command`):

| pid | uptime | cwd |
|---|---|---|
| 15341 | 5:29:10 | `/Users/juan/code/spoken-letter` |
| 66683 | 5:22:17 | `/Users/juan/code/archy` |
| 81452 | 5:20:37 | `/Users/juan/code/gh-glance` |
| 99715 | 5:14:55 | `/Users/juan/code/portfolio` |
| 25160 | 5:14:07 | `/Users/juan/code/chapa` |
| 68041 | 5:13:12 | `/Users/juan/code/coach` |
| 42445 | 2:12:46 | `/Users/juan/code/chapa-cli` |

**Observed burn rate** -- `gh api rate_limit` sampled once a minute:

| time (CEST) | `core.used` | delta |
|---|---|---|
| 13:21:06 | 4692 | -- |
| 13:22:07 | 4836 | +144 |
| 13:23:08 | 4977 | +141 |
| 13:24:08 | 5000 | saturated |

That is **~142 REST calls/minute, ~8,500/hour**, against a `core.limit` of
5,000 -- the counter then pinned at `5000/5000` for the remainder of the window.
GraphQL over the same interval moved +37/+43/+38 per minute (~2,350/hour)
against its own independent 5,000 limit, i.e. GraphQL was not the binding
constraint.

**What the app's own model projects** for that configuration, from
`--doctor` on one instance:

```
REST core         362/5000 left, resets in 30m45s
GraphQL           4396/5000 left, resets in 45m30s
this config spends  ~900 REST + ~240 GraphQL per hour (refresh 5s, "actions" active)
```

Seven instances at 900 REST/hour is 6,300/hour (126% of the limit). The measured
8,500/hour exceeds that projection; §7 records the candidate explanations and
what remains unmeasured.

## 2. What spends: the tick loop

The entire poll loop is one mount-only `useEffect` (`index.mjs:2726`, empty
dependency array closed at `index.mjs:2888`). Everything it needs is read
through refs so the interval is created exactly once
(comment `index.mjs:2713-2723`).

`tick()` (`index.mjs:2851-2875`):

1. `if (remoteSetupRef.current) return;` (`index.mjs:2856`) -- before the counter
   advances, so setup-mode ticks neither fetch nor count.
2. `const due = ticks % BACKGROUND_EVERY === 0 ? TABS.map((t) => t.key) : [active];`
   (`index.mjs:2862`).
3. `ticks += 1` (`index.mjs:2863`) -- **after** the `due` decision.
4. `await Promise.allSettled(due.map((key) => fetchTab(key)))` (`index.mjs:2867`).

`tick()` runs once synchronously (`index.mjs:2877`), then on
`setInterval(tick, runtime.refreshMs)` (`index.mjs:2878`).

Because `ticks` starts at 0 and the modulo precedes the increment: tick 0 fetches
**all four** tabs, ticks 1-11 fetch **only the active tab**, tick 12 fetches all
four again. At the defaults that is an all-tabs sweep every 60s and an
active-only fetch on the other eleven ticks.

A separate effect keyed on `[activeIndex]` (`index.mjs:2895-2897`) refetches the
tab you switch to immediately, without `force`, so it still respects backoff and
the in-flight guard.

The `r` key (`index.mjs:2689-2696`) invalidates the failure-context coordinator
and calls `fetchTab(key, { force: true })` for the active tab only.

## 3. What spends: per-tab cost

Every tab's fetcher hangs off its `TABS` registry entry
(`index.mjs:2174-2214`), invoked at `index.mjs:2847` as
`descriptor.fetch({ signal, runLimit: runLimitRef.current })`.

| Tab | argv builder | `gh` invocation | Processes | Transport, per the cost model |
|---|---|---|---|---|
| actions | `actionsArgs` `index.mjs:779-789` | `gh run list --limit N --json …` | 1 | 1 REST (`index.mjs:1332`) |
| issues | `issuesArgs` `index.mjs:821-834` | `gh issue list --state open --limit 150 --search sort:updated-desc --json …` | 1 | 2 GraphQL (`index.mjs:1333`) |
| prs | `prsArgs` `index.mjs:852-865` | `gh pr list --state open --limit 150 --search sort:updated-desc --json …` | 1 | 2 GraphQL (`index.mjs:1333`) |
| security | `alertArgs` `index.mjs:949-951` | three parallel `gh api <path> --jq …` | **3** | 3 REST (`index.mjs:1332`) |

`SORT_RECENT = ["--search", "sort:updated-desc"]` (`index.mjs:819`) is what
routes Issues and PRs through GraphQL; the second POST each is attributed to the
search connection (comment `index.mjs:1328-1330`).

`ALERT_SOURCES` (`index.mjs:899-947`) holds exactly three endpoints --
`dependabot` (`index.mjs:903`), `codeScanning` (`index.mjs:918`),
`secretScanning` (`index.mjs:933`) -- fanned out by
`Promise.all` in `fetchSecurity` (`index.mjs:1050`). One Security fetch is three
concurrent `gh` processes.

The `--jq` projections (`index.mjs:904`, `919`, `934`) run client-side inside
`gh`; the comment at `index.mjs:896-898` states explicitly that they reduce
neither network bytes nor rate-limit cost.

**Spends that are not on the tick:**

- `resolveFailureContext` (`index.mjs:729-734`) -- `gh repo view` + `gh auth
  status`, two processes, fired only when a tab's verdict is `unavailable`
  (`index.mjs:2818`) and memoised by the epoch-keyed coordinator
  (`index.mjs:736-776`).
- `openItem` (`index.mjs:1112`) -- one `gh <run|issue|pr> view --web` per Enter.
- `preflight()` (`index.mjs:1129-1150`) -- one `gh --version`, plus
  `git rev-parse --git-dir` when the target is inferred.
- `--doctor` -- 11 subprocesses: 7 endpoint probes (`index.mjs:1351-1357`) plus
  `gh --version`, `gh auth status`, `gh api rate_limit`, and one `git`.

Every GitHub call goes through one seam, `runGh(args, { signal })`
(`index.mjs:584-598`): `execFileAsync("gh", args, { timeout: GH_TIMEOUT_MS,
killSignal: "SIGKILL", maxBuffer: GH_MAX_BUFFER, env: { ...process.env,
...GH_ENV_OVERRIDES }, signal })`.

## 4. What throttles

### 4a. `BACKGROUND_EVERY` -- the background divisor

`const BACKGROUND_EVERY = 12` (`index.mjs:110`). The comment
(`index.mjs:104-109`) records that it was raised from 4 because the measured
steady state was 1,980-2,520 REST/hour, "40-50% of the user's entire budget for
a single pane."

### 4b. The in-flight guard

`commit(key, run)` (`index.mjs:2753-2833`) returns an already-resolved promise
when `inFlightRef.current[key]` is set (`index.mjs:2757`), and sets it
immediately after (`index.mjs:2758`). It is **per-tab keyed**
(comment `index.mjs:2754-2756`), cleared only in the `.finally()`
(`index.mjs:2829-2832`). A still-running fetch therefore causes the next tick to
spawn nothing for that tab.

`GH_TIMEOUT_MS = 30_000` (`index.mjs:119`) is what bounds the guard; the comment
at `index.mjs:112-118` records that a stalled `gh` previously wedged a tab
permanently. `MAX_RUN_LIMIT = 60` (`index.mjs:84`) exists so a tall terminal
cannot make Actions outlast `REFRESH_MS`, at which point "the effective refresh
rate silently becomes whatever `gh` can sustain" (comment `index.mjs:80-83`).

### 4c. The backoff ladders

Three ladders, deliberately different shapes:

| Ladder | Value | Line | Recorded reason |
|---|---|---|---|
| `BACKOFF_STEPS_MS` | `[60s, 300s, 1800s, 3600s]` | `index.mjs:135` | measured up to 11,520 wasted calls per 8h session; capped, never permanent, because GHAS can be switched on mid-session (`index.mjs:129-134`) |
| `AUTH_RETRY_MS` | `[30s]` | `index.mjs:142` | user fixes it in seconds; bounds an all-night lapse at two probes/minute (`index.mjs:137-142`) |
| `RATE_LIMIT_RETRY_MS` | `[60s]` | `index.mjs:152` | the secondary limiter keys on sustained rate against an already-limited **token**, and the block applies to the token, not the tool, so a wedged pane "could therefore degrade `git push`" (`index.mjs:144-151`) |

`FAILURE_LADDER` (`index.mjs:967-972`) maps verdicts to ladders; `"other"` is
deliberately absent (comment `index.mjs:962-966`) so a network drop retries on
the next tick.

State is one module-scope `Map` -- `const alertBackoff = new Map()`
(`index.mjs:956`) -- holding two key namespaces: `source.key` for the three
alert endpoints, and `` `tab:${key}` `` for the four tabs (written
`index.mjs:2827`, checked `index.mjs:2842`, cleared `index.mjs:2785` on success
and `index.mjs:2843` on force). The Security tab is thus governed by two
independent layers.

`recordFailure` (`index.mjs:977-981`) advances one rung per failure and
saturates: `Math.min((previous?.step ?? -1) + 1, steps.length - 1)`. For the
one-element ladders the step pins at 0, i.e. a flat interval. Deadlines use
`performance.now()` (`index.mjs:1049`, `index.mjs:2827`, `index.mjs:2842`) --
monotonic, so a laptop resume cannot extend a window (comment
`index.mjs:1041-1048`).

While backed off, an alert source returns a synthetic result without spawning
(`index.mjs:987-993`); a backed-off tab spawns nothing (`index.mjs:2842`).

### 4d. `--refresh`

Parsed at `index.mjs:1522-1523`, validated at `index.mjs:1538-1550` (whole
seconds, within `MIN_REFRESH_SECONDS = 2` / `MAX_REFRESH_SECONDS = 3600`,
`index.mjs:1484-1485`), applied at `index.mjs:1682`
(`if (opts.refreshMs !== null) runtime.refreshMs = opts.refreshMs;`).

`runtime.refreshMs` (`index.mjs:171`, default `REFRESH_MS`) is read in exactly
four places: `projectedHourlyCost` (`index.mjs:1331`), the doctor line
(`index.mjs:1394`), `setInterval` (`index.mjs:2878`), and the staleness
threshold (`index.mjs:2997`).

**There is no env-var path to it.** The documented env surface
(`index.mjs:1641-1649`) is `GH_REPO`, `GH_HOST`, `GH_GLANCE_ICONS`,
`GH_GLANCE_NO_ANIMATION`, `NO_COLOR`, `INK_SCREEN_READER`. `--refresh` is
flag-only.

### 4e. What is *not* a request control

The identical-payload short-circuit (`index.mjs:2786-2789`) skips parsing and
state updates when `rawRef.current[key] === raw`. It runs *after* the request
has already been made and billed; it controls redraw cost, not API cost.

## 5. What reports

`rateBudget()` (`index.mjs:1306-1322`) runs `gh api rate_limit` and formats
`core` and `graphql` as `"<remaining>/<limit> left, resets in <duration>"`. The
comment (`index.mjs:1302-1305`) records that the probe is documented and
measured as free (delta 0), and that the server's own numbers are reported
rather than 5,000 asserted, because GHES ceilings differ.

`projectedHourlyCost(activeKey)` (`index.mjs:1330-1345`) derives the projection
from the same constants the loop uses (comment `index.mjs:1324-1329`):

```js
const perHour = 3_600_000 / runtime.refreshMs;
const restCalls    = { actions: 1, issues: 0, prs: 0, security: ALERT_SOURCES.length };
const graphqlCalls = { actions: 0, issues: 2, prs: 2, security: 0 };
for (const key of TAB_KEYS) {
  const ticks = key === activeKey ? perHour : perHour / BACKGROUND_EVERY;
  rest += ticks * restCalls[key]; graphql += ticks * graphqlCalls[key];
}
```

It iterates `TAB_KEYS` rather than `TABS` because it runs on the `--doctor` path,
which returns before the render tree exists (comment `index.mjs:1336-1337`).

Rendered in the doctor "API budget" section (`index.mjs:1385-1397`) as
`` `~${rest} REST + ~${graphql} GraphQL per hour (refresh ${runtime.refreshMs / 1000}s, "${active}" active)` ``,
where `active = TAB_KEYS[runtime.initialTabIndex] ?? TAB_KEYS[0]`
(`index.mjs:1392`) -- i.e. the projection reflects the **starting** tab, not
wherever the user has since navigated.

**The banner.** The exact incident string lives at `index.mjs:428`:

```js
"rate-limited": "GitHub rate limit reached -- backing off, this clears on its own",
```

Path: `runGh` rejects (`index.mjs:594-596`) → `commit`'s catch
(`index.mjs:2810`) → `toTabError` (`index.mjs:433-435`) → `setErrors`
(`index.mjs:2817`) → `recordFailure('tab:…', …, RATE_LIMIT_RETRY_MS)`
(`index.mjs:2826-2827`) → `formatTabError` at draw (`index.mjs:2945`, function
`index.mjs:482-493`) → the `index.mjs:428` string on one reserved row.

`classify()` (`index.mjs:396-403`) puts `rate-limited` **above** `auth-problem`
and `unavailable` in priority, because a rate limit arrives as a 403 and means
the opposite of a permissions problem (comment `index.mjs:389-402`).

The Security tab differs: `fetchAlertSource` never rejects
(`index.mjs:1014-1023`), so a rate-limited alert endpoint produces a per-source
note (`index.mjs:1018`) rather than the `VERDICT_REMEDY` banner, and the tab-bar
count renders `?` when `securityBlind` is set (`index.mjs:2958`).

**What the TUI does not show.** `StatusBar` (`index.mjs:2359-2414`, invoked
`index.mjs:3207-3214`) receives `fetching`, `spin`, `stale`, `interactive`,
`cols`, `remoteSetup`. No rate-limit or request-count information is rendered
anywhere in the running dashboard. `rateBudget` and `projectedHourlyCost` are
reachable only from `runDoctor`. The nearest in-TUI health signal is the
staleness label, computed from `lastOkRef` against
`staleThreshold = Math.max(STALE_AFTER_MS, runtime.refreshMs * 6)`
(`index.mjs:2997`).

## 6. Process scope

**Everything that throttles is per-process and in-memory.**

Module scope: `runtime` (`index.mjs:164-176`), `alertBackoff`
(`index.mjs:956`), `liveAbort`/`setupChild` (`index.mjs:566-567`), `version`
(`index.mjs:1570`). Loop-closure scope: `cancelled`, `ticks`, `controller`
(`index.mjs:2727-2729`). React refs: `inFlightRef` (`index.mjs:2560`),
`rawRef` (`index.mjs:2561`), `lastOkRef` (`index.mjs:2567`), and others.

Filesystem: the only `node:fs` import is
`import { readFileSync, realpathSync } from "node:fs";` (`index.mjs:26`).
`realpathSync` is used only in `detectMainModule()` (`index.mjs:39-40`);
`readFileSync` only for the `package.json` version (`index.mjs:1570`). Greps for
`writeFile`, `appendFile`, `mkdir`, `createWriteStream`, `existsSync`,
`mkdtemp`, `tmpdir`, `XDG`, `homedir`, `path.join`, `lockfile` return nothing;
`node:path` and `node:os` are not imported at all. Subprocess call sites are
exactly five: `runGh` (`index.mjs:586`), `preflight`'s two
(`index.mjs:1130`, `index.mjs:1143`), `gitRemote` (`index.mjs:1279`), and
`spawn("gh", ["repo", "create"])` (`index.mjs:3304`).

The only things leaving the process are ink's frames on stdout, the `--verbose`
lines on stderr (`index.mjs:557`, gated `index.mjs:555`), and the `--doctor`
report (`index.mjs:1702`).

**Consequently:** two concurrent instances share one token's budget while
throttling independently. Neither the tick counter, the in-flight guard, the
backoff deadlines, nor any rate-limit reading is shared or persisted. Any
cross-process mechanism would be the first persistent or shared state this app
has ever had.

## 7. Discrepancies in the record

These are stated as findings, not as defects to fix.

**7a. RESOLVED 2026-08-10: the model understates Actions by 2x.**
`projectedHourlyCost` encodes `restCalls.actions = 1` (`index.mjs:1332`).
`docs/agents/pre-launch-report-2026-08-03.md:576` recorded a `GH_DEBUG=api`
measurement that `gh run list` issues **two** REST requests. That audit is
correct and the model is wrong. Measured 2026-08-10 13:53 CEST with
`GH_DEBUG=api gh <cmd> 2>&1 >/dev/null | grep -E '^> (GET|POST) '`:

```
run list       -> GET /repos/juan294/gh-glance/actions/runs
                  GET /repos/juan294/gh-glance/actions/workflows      2 REST
issue list     -> POST /graphql x2                                    2 GraphQL
pr list        -> POST /graphql x2                                    2 GraphQL
dependabot     -> GET /repos/.../dependabot/alerts                    1 REST
secret-scan    -> GET /repos/.../secret-scanning/alerts               1 REST
```

Only `restCalls.actions` is wrong; the GraphQL attributions and
`ALERT_SOURCES.length` are correct. Corrected steady-state per instance at the
default 5s:

| Active tab | REST/hr | GraphQL/hr | model today | instances within 5,000 REST |
|---|---|---|---|---|
| actions | **1,620** | 240 | 900 | **3.1** |
| issues or prs | 300 | 1,560 | 240 | 16.7 |
| security | 2,280 | 240 | 2,220 | 2.2 |

Because `runtime.initialTabIndex` defaults to 0 (`index.mjs:174`) every pane
starts on Actions, so 1,620/hr is the realistic default per-instance figure.

A `rate_limit`-delta measurement was attempted twice and is not a usable
instrument here: at 13:31 `core.used` was pinned at the 5,000 ceiling so every
delta read zero, and at 13:51 the deltas were contaminated by concurrent
consumers on the same token (a `gh pr checks --watch` process and several Claude
Code sessions), producing impossible readings such as `pr list core+1` and
`code-scanning graphql+2`. Request-counting via `GH_DEBUG=api` is immune to both
and is the instrument of record for per-invocation cost.

**7b. The measured 8,500/hour sits between the two models.** The uncorrected
model projects 6,300/hour for seven Actions-active instances -- *below* the
measurement, which it cannot explain. The corrected model (7a) projects
7 x 1,620 = **11,340/hour**, and the measurement is 75% of that. Two effects
account for the shortfall, both of which reduce real spend below the projection:

- **In-flight-guard absorption.** An Actions fetch is now known to be two
  sequential HTTP round trips, and `gh run list` was already measured at
  1.2-3.0s (comment `index.mjs:72-77`). With seven Node processes competing for
  CPU, some fetches outlast the 5s interval, and the guard (`index.mjs:2757`)
  silently drops those ticks -- the effect the `MAX_RUN_LIMIT` comment describes
  at `index.mjs:80-83`.
- **Security endpoints backing off.** Repos without Advanced Security 403/404 on
  code scanning and secret scanning, which latches `BACKOFF_STEPS_MS`
  (`index.mjs:135`) and removes up to 2 of the 3 background REST calls.

Also contributing to total token spend, though not to gh-glance's share: a
`gh pr checks 1679 --watch --interval 20` process was observed in
`/Users/juan/code/spoken-letter-fix-v1360.MLJdiJ` at ~180 calls/hour, and Claude
Code sessions invoke `gh` directly. Note the projection reflects the *starting*
tab only (`index.mjs:1392`), so it cannot account for navigation.

**7c. ADR 0001's "~500 calls per hour" claim.**
`docs/decisions/0001-keep-the-gh-cli-data-layer.md:84-86` states that raising
`BACKGROUND_EVERY` from 4 to 12 "cut steady-state usage to roughly 500 calls per
hour." Two later documentation sweeps found that figure does not follow from the
constants: `a89c816` corrected it to ~1,020/hour on cheap tabs and ~2,340/hour
on Security, and `934d8a0` refined it again once `--search`'s GraphQL routing
was accounted for. `README.md:359-368` now carries the per-tab table
(Actions ~900 REST/~240 GraphQL; Issues or PRs ~240/~1,560; Security
~2,220/~240). The ADR text was not corrected.

## 8. The historical record: stated design intent

Chronology of the constants:

| Date | Commit | Change |
|---|---|---|
| 2026-08-02 | `28863cc` | `REFRESH_MS = 5000` introduced; no backoff, no rate awareness |
| 2026-08-02 | `9ba51d5` | `BACKGROUND_EVERY = 4` introduced; measured 36 `gh` invocations → 16 over 26s |
| 2026-08-03 | `6d42728` | `BACKGROUND_EVERY` **4 → 12**; `BACKOFF_STEPS_MS`, `ALERT_PER_PAGE = 100`, `MAX_RUN_LIMIT = 60`, `--jq` projection |
| 2026-08-03 | `7426298` | `--refresh` added, clamped 2-3600s; staleness scaled off the interval |
| 2026-08-04 | `4490842` | `AUTH_RETRY_MS = [30_000]` split out of the hour ladder; `--doctor` added |
| 2026-08-04 | `a89c816` | README rate-limit figure corrected the first time |
| 2026-08-04 | `fec2801` | `RATE_LIMIT_RETRY_MS = [60_000]` and `projectedHourlyCost` introduced |
| 2026-08-04 | `934d8a0` | README figures corrected again for `--search`/GraphQL routing |
| 2026-08-06 | `c2a8a8c` | `"no-remote"` verdict mapped onto the existing ladder |

Nothing after 2026-08-06 touches these concerns; `CHANGELOG.md:8`
(`## [Unreleased]`) is empty.

**Invariants the record asserts repeatedly:**

1. **The active tab's interval is off limits; only background cadence may be
   throttled.** Issue #20 ("Do **not** raise the active tab's interval --
   liveness is the product's entire premise"),
   `docs/agents/pre-launch-report-2026-08-03.md:409` and `:579`,
   `docs/agents/pre-launch-report.md:594`.
2. **`BACKGROUND_EVERY = 12` is load-bearing for the budget**, and lowering it
   toward 4 "re-triples the background term and needs this projection updated in
   lockstep" (`docs/agents/pre-launch-report.md:715`).
3. **Never cache `gh run list`** -- freshness is the point
   (`docs/agents/pre-launch-report-2026-08-03.md:579`).
4. **Any backoff must be visible and must be bypassable by `r`**
   (`docs/agents/pre-launch-report.md:439`, issue #55).
5. **Fewer requests ≠ cheaper**: `core` and `graphql` are independent 5,000
   pools (`docs/decisions/0001-keep-the-gh-cli-data-layer.md:73-76`).
6. **Cost is reported, never gated.** A startup warning was explicitly declined
   as noise (issue #56).

**The one recorded numeric target**, and its framing:
`docs/agents/pre-launch-report-2026-08-03.md:580` -- "Expected impact: ~500
REST/hr instead of 1,980, **leaving headroom for a second instance** and the
user's own tooling." The same audit at `:577` notes "Two panes is 80-100% of the
budget; the user's own commands then fail with rate-limit errors having no
visible connection to gh-glance."

That is the outer bound of what the record ever contemplated: **two** instances.
No document addresses N.

**Recorded but unimplemented.** `docs/agents/pre-launch-report.md:583`, finding
**BE-S1**, "All rate-budget management is open-loop constants tuned for one
assumed limit" (strategic / Later, effort L): "Every budget decision is a
constant justified against an assumed 5,000/hr. The app never observes actual
consumption." Its recommendation was to probe `rate_limit`, expose headroom in
`--doctor`, and "widen `BACKGROUND_EVERY` adaptively when low" -- with the
constraint that adaptation "must change only the *background* cadence, never the
active tab's". **Only the `--doctor` half shipped.** The adaptive half is the
closest existing precedent to the present problem and remains open.

`CONTRIBUTING.md:16-17` lists a config file or flags for the refresh interval as
a wanted contribution.

## 9. Existing patterns any change would inherit

**Config precedence.** One write block, `index.mjs:1679-1683`, documented as
"One place argv becomes runtime state" after a past drift bug. Fields with a
meaningful default are assigned only when the parsed value is non-null. There is
no merge helper. Three hand-written "flag beats env" sites exist for `GH_REPO`
(`index.mjs:1141`, `index.mjs:1289-1291`, `index.mjs:3049`); the contract is
documented at `index.mjs:1642`.

**Env-var idioms**, both module-scope `const`, evaluated once, unvalidated:
truthiness opt-out (`ANIMATE = !process.env.GH_GLANCE_NO_ANIMATION`,
`index.mjs:200`) and exact-value opt-in
(`USING_NERD_ICONS = process.env.GH_GLANCE_ICONS !== "unicode"`,
`index.mjs:1806`). Neither is numeric-with-bounds. A new env var needs a line in
`DOCTOR_ENV_PLAIN` (`index.mjs:1164-1173`) to appear in `--doctor` with its
value, and a line in the help text's `Environment:` block
(`index.mjs:1641-1649`), which is hand-written prose rather than derived.

**Numeric bounds validation.** The canonical idiom is `validateArgs`
(`index.mjs:1538-1550`): `null` sentinel for "not supplied", separate throws for
type and range, range message interpolating the constants, unit conversion once
at the end.

**Help-text derivation.** The refresh entry interpolates its bounds, default and
multiplier rather than restating them (`index.mjs:1610-1612`), as do
`index.mjs:1628-1629`. `KEY_TABLE` (`index.mjs:1576-1588`) feeds three renderers
from one source.

**Adaptive-behaviour precedents already in the file:**

- Clamp an observed value into a named band, read through a ref at use time:
  `runLimitRef.current = Math.min(Math.max(bodyRows + 1, MIN_RUN_LIMIT), MAX_RUN_LIMIT)`
  (`index.mjs:2542`), deliberately not a hook dependency so a resize cannot
  cancel in-flight requests (comment `index.mjs:2538-2540`).
- Scale a threshold off the configured interval with an absolute floor:
  `Math.max(STALE_AFTER_MS, runtime.refreshMs * 6)` (`index.mjs:2997`).
- Verdict-keyed ladder table with a saturating step (`index.mjs:967-981`).
- Hysteresis on a breakpoint to prevent oscillation
  (`index.mjs:2441-2443`, `TAB_LABEL_HYSTERESIS = 4` at `index.mjs:2245`).

**Test homes.** `test/args.test.mjs` for flags -- the composed helper
`const parse = (argv) => validateArgs(parseArgs(argv), TAB_KEYS)`
(`args.test.mjs:21`), bounds asserted against the *imported* constants
(`args.test.mjs:128-133`), rejection corpora as tables
(`args.test.mjs:139`). `test/doctor.test.mjs` for env behaviour through a real
child process (helper `doctor.test.mjs:79-91`, fixture `PATH` prepended,
caller env last). `test/unit.test.mjs` for cross-table invariants, including
the ladder-parity assertions (`unit.test.mjs:798-812`). `test/pty/` for
end-to-end, with the fixture `gh` (`test/pty/fixtures/gh`) logging every
invocation to `GH_GLANCE_FIXTURE_LOG` (`fixtures/gh:14-15`) -- the mechanism
`routing.test.mjs:22-24` uses to assert on the exact argv the app emits.
`test/pty/e2e.test.mjs:52-62` and `:71-88` are the existing request-volume
guards.

A new constant or function must be added to the export block
(`index.mjs:3381-3436`) to be testable at all.

Note `test/pty/keys.test.mjs:24-28` and `test/pty/selection.test.mjs:12-13`
independently hard-code `REFRESH_SECONDS = 5` because `REFRESH_MS` is not
exported -- recorded as **QA-M2**-adjacent at
`docs/agents/pre-launch-report.md:1808-1814`.

## 10. Open questions this research did not settle

1. ~~The real REST cost of one `gh run list`~~ -- **settled**, see §7a: two REST
   requests, and `index.mjs:1332` is wrong.
2. **Which tab each of the seven instances was on**, unrecoverable after the
   fact; it is the difference between 900 and 2,220 REST/hour per instance
   (`index.mjs:1332`).
3. **Whether `gh` sends conditional requests.**
   `docs/agents/pre-launch-report-2026-08-03.md:576` records GitHub returning
   `Cache-Control: private, max-age=60` on data polled every 5s "with no
   conditional request". Whether a 304 would bill against `core` was not
   established here, and nothing in `index.mjs` influences it -- `runGh`
   (`index.mjs:584-598`) sets no cache headers.
4. **What the `search` resource costs.**
   `docs/agents/pre-launch-report-2026-08-03.md:385` records that `--search`
   routes through a backend with a separate 30/minute limit. The incident
   measurement showed `search` at `0/30 used`, so it was not implicated, but the
   relationship between `--search` on `gh issue list` and the `search` resource
   counter was not traced.
5. **Whether any cross-process mechanism is acceptable at all**, given §6 --
   no document in the record considers one, and the app has never written to
   disk.
