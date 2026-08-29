# Plan: conditional polling and a calm status bar

> 2026-08-29 | Branch `develop` @ `43993a01ba263024752ff4998a4c2136192fec38`
> Supersedes the out-of-scope note in
> [`2026-08-18-prevent-api-exhaustion-and-clarify-refresh-status.md`](2026-08-18-prevent-api-exhaustion-and-clarify-refresh-status.md),
> which deferred "conditional REST requests, ETags, or replacing `gh run list`".

## Goal

Stop the dashboard narrating its own scheduler, and stop it paying full price
for answers that have not changed. Two halves:

- **UX.** The status bar's changing state must not move the keys. The pane must
  not print code identifiers or JavaScript exception text. A notice appearing
  must not change the frame height.
- **Performance.** Most polls should cost zero rate-limit units, and the
  governor must be able to observe its own spend.

It does not change the admission guarantee in ADR 0003, the independent per-tab
fetchers (ADR 0001), the last-good cache semantics, or authentication ownership.

## Measured premise

Everything below was measured on 2026-08-29 against `juan294/gh-glance` with the
workstation's own credentials, and reproduced with raw `curl` where the result
was surprising. Five gh-glance panes were live throughout; their draw was
measured separately (0.244 units/sec) and subtracted where it mattered.

### 1. `GET /rate_limit` does not report the bucket that gates real calls

Back to back, one second apart, same token:

```text
GET /user                        x-ratelimit-used: 214   reset: 1787989000
GET /rate_limit                  x-ratelimit-used:   0   reset: 1787989074
GET /repos/juan294/gh-glance     x-ratelimit-used: 218   reset: 1787989000
GET .../actions/runs?per_page=1  x-ratelimit-used: 220   reset: 1787989000
GET /rate_limit  (again)         x-ratelimit-used:   0   reset: 1787989075
GET /user        (again)         x-ratelimit-used: 224   reset: 1787989000
```

The `/rate_limit` body agrees with its own headers (`core: used 0,
remaining 5000`) and its `reset` is `now + 3600` recomputed per call --- the
signature of a bucket nothing has touched. Every other endpoint shares one
bucket with a fixed reset. Identical under `curl`, so this is GitHub-side, not a
`gh` artifact.

### 2. A 304 costs nothing

Thirty requests to `/user`, noise-corrected against the measured 0.244 units/sec
background:

| 30 requests | raw `used` delta | background | attributable |
|---|---:|---:|---:|
| conditional (`If-None-Match` -> 304) | 2 | 3.5 | **0** |
| unconditional (-> 200) | 31 | 3.8 | **25.2** |

The raw delta of 2 on the conditional run is exactly the two measuring calls.

### 3. What that does to the governor

`nextExternalFactor` (`index.mjs:1241-1261`) only updates when
`externalSampleIsUsable` (`index.mjs:2689-2695`) is satisfied, which requires
`globalUsedDelta > 0`. `globalUsedDelta` is `used` from this probe minus `used`
from the last one. Against a counter pinned at 0 it is always 0, so the factor
returns its seed `1` forever and never divides `callsPerMs`
(`index.mjs:1304`). Simultaneously `remaining` never falls, so
`spendable = remaining - reserve - charged` (`index.mjs:1231`) only shrinks by
in-flight local reservations --- which `publishProbe` retires every minute
(`index.mjs:2337-2341`).

> The control loop is open. The governor's own spend is invisible in the budget
> it reads, and real exhaustion is discovered only by receiving a 403.

That is the `Paused` / `probing` / `stale` churn in the reported screenshots.

### 4. Corrected cost attribution

An earlier draft of this review put Security at 4,320 units/hr/pane. That is the
unthrottled figure and it is wrong in practice: `securityPollDelay`
(`index.mjs:5379-5382`) forces at least `SECURITY_UNCHANGED_POLL_MS` (60s)
between unchanged Security polls, so its steady state is ~360 units/hr/pane.
`pollResultTransition`'s consumer special-cases only `security`
(`index.mjs:7107`), so **Actions has no equivalent throttle and is the cost
centre**: 2 core every 5s = 1,440 units/hr/pane, on the tab every pane opens on
(`runtime.initialTabIndex` defaults to 0).

## Chosen architecture

### A. Conditional requests, mapped onto the existing unchanged-payload path

The app already has the exact semantics a 304 needs. `pollResultTransition`
(`index.mjs:5729-5754`) returns `{kind: "unchanged"}` when
`previousRaw === raw`, and that branch already advances `lastOkRef`, clears
backoff, clears the error, skips `parse()`, and skips `setState` to preserve
React's bail-out (`index.mjs:7117-7139`). A 304 is that same conclusion arriving
over HTTP instead of by byte comparison. It is routed to the same branch rather
than to new state.

Verified mechanics:

```text
gh api -i <path> --jq '<expr>'      -> headers, blank line, *filtered* body
                                       (`-i` and `--jq` compose; the projection
                                        that keeps Dependabot under
                                        GH_MAX_BUFFER is preserved)

304:  exit 1, "HTTP/2.0 304 Not Modified", ETag echoed, X-RateLimit-* present,
      and gh's own jq writes "unexpected end of JSON input" where the body would
      be.
404:  exit 1, "HTTP/2.0 404 Not Found", JSON error body.
```

> The exit code is 1 for both. **The status line drives the branch; the exit
> code is never read alone.** This is also the trap that would otherwise render
> the exact sentence from the reported screenshot.

### B. Actions moves from porcelain to `gh api`

`gh run list` cannot carry a header. Traced with `GH_DEBUG=api`, it is exactly:

```text
GET /repos/{owner}/{repo}/actions/runs?exclude_pull_requests=true&per_page=N
GET /repos/{owner}/{repo}/actions/workflows?page=1&per_page=100
```

Both return ETags. Rebuilt as two `gh api` calls plus a client-side join on
`workflow_id`, the result is a byte-identical field set to
`gh run list --json ...` at comparable latency (verified). The workflows list
changes only when a workflow file changes, so it is a 304 on nearly every poll.

This keeps `gh` as the data layer and keeps the tabs independent, so it does not
reverse ADR 0001 --- that decision refused *combining* calls into one GraphQL
query, which is still refused here.

Issues and PRs stay on `gh issue list` / `gh pr list`. They are GraphQL, GraphQL
has no ETag, and reimplementing their `--search sort:updated-desc` queries by
hand is a much larger change for no rate-limit benefit. Their budget stays
probe-only, which the governor already supports because REST and GraphQL are
scheduled independently.

### C. Budget ingestion becomes hybrid, not header-only

A header-only design was considered and rejected on two grounds:

1. **Bootstrap and exhaustion deadlock.** `test/pty/governor.test.mjs:320`
   proves the intended behaviour: when core is exhausted, panes make zero data
   calls. If budget only arrives on data-call headers, an exhausted account can
   never observe its own recovery. The free probe is what breaks that cycle.
2. **External spend detection.** `test/pty/throttle.test.mjs:391` proves that an
   out-of-band 7,996-call burn is caught by the *next probe*. Headers only
   arrive when gh-glance itself calls, so a burn between calls would be
   invisible until after a grant had already been issued.

So the probe is kept, and headers are added as continuous correction between
probes:

```text
observation sources, in precedence order:
  1. X-RateLimit-* from a real data response   (authoritative when present)
  2. gh api rate_limit probe                   (bootstrap, exhaustion recovery,
                                                external-burn detection, and the
                                                only source for graphql)
```

The governor's `budgets[resource]` record already carries everything a header
sample provides (`limit, remaining, used, resetMs, observedAt, epoch`), and
`observedAt` is already stamped from the local publish clock rather than the
wire (`index.mjs:2283`). A header sample is therefore the same shape arriving
through a second door.

This changes where a fresh observation comes from. It does not change the
admission rule, so ADR 0003's guarantee stands unmodified.

### D. The status bar's left region becomes what it already claims to be

`index.mjs:5892` reads:

```js
// Reserved so the hints never shift when the active tab changes state.
const REFRESH_STATUS_WIDTH = 12;
```

The intent is already correct. The defect is that `detail` and `stale` render
*outside* that reserved cell (`index.mjs:6229-6234`), between the mandatory and
optional hints, which is exactly what makes the keys move. The fix extends the
reservation to cover the whole state region so the hint group starts at a stable
column in every state.

## Phase structure

Six phases. **None are `[batch-eligible]`**: the entire application is one file
by deliberate design (`CONTRIBUTING.md`, "Code Style"), so every phase overlaps
`index.mjs` and `/batch`'s no-file-overlap precondition cannot be met. They run
sequentially.

| # | Phase | Depends on | Ships alone? |
|---|---|---|---|
| 1 | [Stop the crash and unpin the frame height](2026-08-29-conditional-polling-and-calm-status-phases/phase-1.md) | --- | yes |
| 2 | [Rebuild the status bar's state region](2026-08-29-conditional-polling-and-calm-status-phases/phase-2.md) | 1 | yes |
| 3 | [Keep internals out of the pane](2026-08-29-conditional-polling-and-calm-status-phases/phase-3.md) | 1 | yes |
| 4 | [Conditional requests](2026-08-29-conditional-polling-and-calm-status-phases/phase-4.md) | 3 | yes |
| 5 | [Budget from response headers](2026-08-29-conditional-polling-and-calm-status-phases/phase-5.md) | 4 | yes |
| 6 | [Re-tune what phases 4-5 made loose](2026-08-29-conditional-polling-and-calm-status-phases/phase-6.md) | 5 | yes |

Phases 1-3 are user-visible and change no request behaviour. Phases 4-6 change
request behaviour and change no copy.

## Decisions taken

| Decision | Choice | Why |
|---|---|---|
| Status bar arrangement | Fixed-width state region; hints never move | Honours the stated intent of `REFRESH_STATUS_WIDTH`. Costs a few reserved columns in the healthy case, which is the cheaper error. |
| ETag scope | Actions **and** Security | Actions is 1,440 units/hr/pane with no throttle and is the default tab. Security-only would have left the cost centre untouched. |
| Grant detail format | Relative (`next 2m`) | Removes the "missed deadline" reading. Must stay minute-granular --- see the redraw constraint below. |
| Budget ingestion | Hybrid (headers + retained probe) | Header-only deadlocks on bootstrap and exhaustion, and cannot see external burn. |
| GraphQL conditional requests | Out of scope | No ETag support in the GraphQL API. |

### The redraw constraint on the relative format

`index.mjs:158-162` documents why the stale label is minute-granular: `now` only
advances on minute boundaries when nothing is in progress, so a coarse label
costs zero extra redraws while a live "Ns ago" would make every frame differ and
undo the byte-identical-idle-frame property.

`formatDuration` (`index.mjs:281-291`) returns `1m47s` below an hour, which
changes every second. **It must not be used for the grant detail.** Phase 2
adds a separate coarse formatter.

## Risks and controls

- **A 304 mistaken for an error.** Both 304 and 404 exit 1. Controlled by
  branching on the parsed status line and never on the exit code, plus a unit
  test per status class over recorded response prefixes.
- **`-i` shifting fixture argv.** `test/pty/fixtures/gh` dispatches on `$2` for
  `api` (`test/pty/fixtures/gh:152-178`). Controlled by making the fixture
  flag-position-agnostic before any production argv changes --- Phase 4 step 1.
- **A stale ETag serving stale rows forever.** An ETag is only honoured
  alongside the raw payload it was captured with; discarding one discards both.
  A forced refresh (`r`) always sends no `If-None-Match`.
- **Header sample from a different host.** Samples are attributed to the scope
  that issued the call; a scope migration drops pending samples, matching
  `ensureScope`'s existing behaviour (`index.mjs:7325`).
- **Losing external-burn detection.** The probe is retained precisely for this;
  Phase 5 keeps `test/pty/throttle.test.mjs:391` passing unmodified.
- **Reserved columns wasted at 24 cols.** The state region reservation is
  computed from the allocation that already exists, so it collapses at narrow
  widths exactly as the detail does today.
- **README sample drift.** The sample block is generated
  (`CONTRIBUTING.md`, "Code Style"). Phases 2 and 3 regenerate it with
  `node test/pty/readme-sample.mjs` rather than hand-editing.

## Out of scope

- Combining tab fetchers or any GraphQL consolidation (ADR 0001 stands).
- Replacing `gh issue list` / `gh pr list`, or conditional GraphQL requests.
- Changing the admission guarantee, the hard reserve, or the fail-closed
  storage semantics (ADR 0003 stands).
- A daemon, a network service, or any new runtime dependency.
- Release-pipeline gates, branch rules, or added CI machinery.
- Changing the default `--refresh` value. Phase 6 re-examines whether it is
  *honest*, not whether it should be larger.

## Open questions

None. The status-bar arrangement, the ETag scope, and the grant detail format
were decided before this plan was written; the budget-ingestion shape was
decided by the two blocking findings in section C.
