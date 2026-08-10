# Phase 5 — Correct README, ADR 0001, and CHANGELOG

Not batch-eligible: depends on Phase 1's corrected numbers, and on phases 2-4
existing to be documented.

## Why

Three documents carry figures now known to be wrong. Two of them were corrected
once already (`a89c816`, `934d8a0`) from a model that itself understated Actions by
2x, so the published table has been wrong since the section was introduced at
v0.2.0.

## Changes

### `README.md` — the `## Rate limit` section (`README.md:354-385`)

The per-tab table at `README.md:359-368` must be regenerated from
`projectedHourlyCost` as corrected in Phase 1. Take the numbers from
`--doctor`, not by hand:

```
for tab in actions issues prs security; do
  node index.mjs --tab "$tab" --doctor | grep "this config spends"
done
```

Expected replacement values:

| Tab | REST/hr | GraphQL/hr | was |
|---|---|---|---|
| Actions | **1,620** | 240 | ~900 / ~240 |
| Issues or Pull requests | **300** | 1,560 | ~240 / ~1,560 |
| Security | **2,280** | 240 | ~2,220 / ~240 |

`README.md:370-374` currently says Security is "the expensive one … just under
half the REST budget". Still true (2,280 of 5,000), but Actions is no longer
cheap — it is a third of the budget, and it is the default tab. The prose has to
stop implying that only Security is worth knowing about.

`README.md:383-385` says a pane "shares the budget with your other `gh` commands
rather than exhausting it". That claim is false for more than three concurrent
panes and must be replaced with the measured fact plus the new behaviour:

```
+ One pane on Actions costs about a third of an hourly REST budget, so roughly
+ three panes fill it. Past that, gh-glance widens its own poll interval: it reads
+ your remaining budget once a minute, works out how much of it belongs to this
+ pane by comparing its own spend against the token's total, and slows down to fit.
+ The status bar says `throttled 18s` while that is in effect. Nothing is shared
+ between panes -- the token's own counter is what they all read.
+
+ `GH_GLANCE_REFRESH=30` sets a wider floor for every pane in a shell; `--refresh`
+ still wins per pane. The adaptive interval only ever widens from that floor.
```

Also update:
- `README.md:267` (flags table) — unchanged, `--refresh` semantics are the same.
- The environment table — add `GH_GLANCE_REFRESH`, matching the `HELP` wording
  from Phase 2.
- `README.md:376-381` (the backoff ladder paragraph) — unchanged.

### `docs/decisions/0001-keep-the-gh-cli-data-layer.md`

Lines 82-87 claim `BACKGROUND_EVERY` 4→12 "cut steady-state usage to roughly 500
calls per hour". Two documentation sweeps already found that figure does not
follow from the constants, and the ADR was never corrected. Lines 10-13 also state
a full tick costs "five REST and two GraphQL" requests, which the 2026-08-10
measurement makes six REST (Actions is 2, not 1).

An accepted ADR is not rewritten — append a correction note, matching how this
project records superseded reasoning:

```
+ ## Correction (2026-08-10)
+
+ Two figures above are wrong and are corrected here rather than edited in place,
+ because the decision they support still stands.
+
+ - A full tick costs **six** REST requests, not five: `gh run list` issues
+   `GET /actions/runs` *and* `GET /actions/workflows` (measured with
+   `GH_DEBUG=api`, 2026-08-10). The GraphQL count of two is correct.
+ - "Roughly 500 calls per hour" was never reached. It was PE-B1's *target*, not a
+   measurement, and it was already corrected twice in the README (`a89c816`,
+   `934d8a0`) from a cost model that itself understated Actions by half. The real
+   steady state at the default refresh is ~1,620 REST/hour with Actions visible.
+
+ Neither changes the conclusion. The saving on offer from collapsing the data
+ layer is still about one request per minute, and `core`/`graphql` are still
+ independent budgets.
+
+ See `docs/research/2026-08-10-api-request-cost-and-rate-limit-exhaustion.md`.
```

### `CHANGELOG.md` — a new `## [Unreleased]` body

`CHANGELOG.md:8` is currently an empty `## [Unreleased]`. Write entries in the
established voice — what changed, the measurement, and why it matters. Note the
project's changelog convention of stating the defect before the fix.

```
+ ### Added
+
+ - **gh-glance now widens its own poll interval when the API budget is draining.**
+   The rate limit is per token, not per process, so several panes spent one
+   budget while each throttled as though it were alone: seven panes exhausted a
+   5,000/hour REST limit in under half an hour (measured 8,500 calls/hour). Each
+   pane now reads `gh api rate_limit` once a minute -- a probe that does not
+   itself count against the limit -- infers how much of the budget is its own by
+   comparing its spend against the token's total, and slows down to fit, up to a
+   60-second ceiling. A single pane is unaffected and stays at 5 seconds. The
+   status bar shows `throttled 18s` whenever the interval has widened, and `r`
+   still refreshes immediately.
+ - **`GH_GLANCE_REFRESH` sets the poll interval for every pane in a shell.** Same
+   2-3600 second range as `--refresh`, which still takes precedence.
+
+ ### Fixed
+
+ - **The cost model understated the Actions tab by half.** `gh run list` issues
+   two REST requests, not one -- `GET /actions/runs` and
+   `GET /actions/workflows` -- so a pane on Actions costs about 1,620 requests an
+   hour rather than the 900 `--doctor` reported, and roughly three panes fill an
+   hourly budget rather than five. The figure was wrong in `--doctor`, in the
+   README's per-tab table, and in ADR 0001's request count. Measured with
+   `GH_DEBUG=api`; the projection and the new throttle now read one shared table.
```

## Verification

### Automated
- `npm test` and `npm run test:pty` still pass (no code changes here)
- Every number in `README.md`'s table matches `--doctor` output for that tab:
  ```
  for tab in actions issues prs security; do
    node index.mjs --tab "$tab" --doctor | grep "this config spends"
  done
  ```
  compared against the committed table — a mismatch is a failure.
- `npx markdownlint-cli2 README.md CHANGELOG.md docs/decisions/*.md` if the repo
  lints markdown; otherwise `npm run lint` only.

### Manual
- Read the `## Rate limit` section end to end and confirm it no longer implies
  that only the Security tab is expensive, and that it states the three-pane
  figure plainly.

## Out of scope

Do not restate the adaptive control law's arithmetic in the README — it belongs in
the research document and the code comments. The README says what the user
observes and what levers they have.
