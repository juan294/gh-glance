# Implementation notes — `2026-08-10-adaptive-rate-limit-budgeting.md`

## Deviations

### Phase 1

**Test comment wording.**
Plan said: pin `REST_PER_FETCH.actions` with the comment "Pinned because phases
3-4 budget against it."
Found: the plan document is untracked, so a phase-number reference in shipped
source dangles the moment the plan is deleted or renumbered.
Chose: "Pinned because the adaptive throttle budgets against it."
Why: same meaning, no dependency on a document that is not in the repository.
The assertion itself is unchanged.

**Corrected a stale figure the plan did not list.**
Plan said: nothing about `rateBudget`'s doc comment; Phase 5 covers README,
ADR 0001 and CHANGELOG only.
Found: `index.mjs:1314-1315` hand-quotes "around 2,200 REST requests an hour --
about 44% of a personal token's 5,000" for the Security tab. That figure was
derived from the `actions: 1` table this phase corrects; the true value is 2,280
(~46%), which the new `projectedHourlyCost("security")` test now pins.
Chose: corrected it to 2,280 / 46% in this phase.
Why: no later phase covers in-source comments, so it would have survived the
whole plan as a second, wrong copy of the number Phase 1 exists to fix.

**Dropped one of two placement comments.**
Plan said: leave a pointer comment at the `BACKGROUND_EVERY` site explaining that
the tables live down by `ALERT_SOURCES`.
Found: writing both that pointer and a matching "which is why these sit here
rather than up with `BACKGROUND_EVERY`" clause in the table's own block comment
left two comments stating one fact from opposite ends.
Chose: kept the pointer comment at `BACKGROUND_EVERY` (as specified), dropped the
trailing clause from the table block.
Why: two copies of a placement rationale drift the first time the tables move.

### Phase 2

**`doctor()` test helper left unchanged.**
Plan said: "`doctor()` currently returns only `stdout` and throws on non-zero
exit; the third test needs `stderr` and `code`, so extend the helper to surface
them rather than adding a second spawner."
Found: no extension is needed. Node's `util.promisify(execFile)` already attaches
`code`, `stdout` and `stderr` to the rejected `Error`, so the existing helper's
rejection path exposes both (verified directly, not assumed).
Chose: left the helper alone; the spec's test body works verbatim.
Why: widening it would have added an unused return shape to eight existing
callers to re-expose what the rejection already carries.

**Doctor env-line assertion relaxed from `{2,}` to `\s+`.**
Plan said: `assert.match(report, /GH_GLANCE_REFRESH {2,}30/)`.
Found: `field()` pads labels to `DOCTOR_LABEL_WIDTH` (`index.mjs:1290-1291`).
`GH_GLANCE_REFRESH` is 17 characters and the column is 18, so the report emits
exactly **one** space. The plan's `{2,}` would have failed against correct output.
Chose: `/GH_GLANCE_REFRESH\s+30/`.
Why: the assertion is about the variable being reported with its value, not about
a column width that `field()` already owns and tests elsewhere.

**Bounds-message rationale stated once, not three times.**
Plan said: comment the entry-block substitution, the `refreshLabel` line, and the
new args test each with the "rather than a second copy of the bounds" reasoning.
Found: written as specified, that fact appears three times across two files.
Chose: kept it at the entry block (where the placement decision is actually made)
and shortened the other two.
Why: three copies of one rationale drift the first time one is edited — the same
failure mode the tables in Phase 1 exist to prevent.

**Corrected an overclaim in the entry-block comment.**
Plan said: the env fallback uses "the same precedence GH_REPO has".
Found: the *precedence* matches, the *mechanism* does not. `GH_REPO` is read
directly at each use site (`index.mjs:1157`, `:1307`, `:3087`) and never passes
through `parseArgs`, because `gh` honours it natively and a slug needs no
validation. An interval does, so it must be resolved once, before the bounds check.
Chose: comment now states the precedence match and names the difference.
Why: a future reader will trust "the same as GH_REPO" literally and go looking for
a shared helper that does not exist.

**Not changed, but worth recording.** The `/simplify` altitude pass argued the env
substitution belongs inside `parseArgs` rather than the `IS_MAIN` entry block, so
that the variable is reachable from unit tests and from any future embedder that
imports `parseArgs`/`validateArgs`. The plan specifies the entry block explicitly
("let `parseArgs` keep returning only what argv said") and builds its test split
around it, so this was followed as written. The consequence is real: three
`doctor.test.mjs` tests spawn a child process to cover the substitution.

### Phase 3

**`BUDGET_PROBE_MS` declared in Phase 4, not Phase 3.**
Plan said: declare it in Phase 3's constants block alongside the other four.
Found: nothing in Phase 3 reads it — it is the probe cadence, used only by the
loop — so `npm run lint` failed the phase outright on `no-unused-vars`.
Chose: moved the declaration (comment unchanged) into the Phase 4 commit, at the
same position in the same block.
Why: the alternative was exporting a constant no test uses, purely to satisfy the
linter. The constants block ends up exactly as the plan describes it.

**`restPerTick` assertions use `assertClose`, not `assert.equal`.**
Plan said: `assert.equal(restPerTick("issues"), (2 + 3) / BACKGROUND_EVERY)`.
Found: fails. `restPerTick` accumulates one division per background tab, so
`0 + 2/12 + 3/12` is `0.41666666666666663` while `5/12` is `0.4166666666666667`.
Chose: `assertClose(..., 1e-12)` for all three tabs.
Why: the assertion is about amortisation being applied, not about float
associativity. `assertClose` is already the phase's own helper.

**Fixed a defect in the plan's `at()` test helper.**
Plan said:
```js
const at = (over) => ({ budget: { ...FRESH, ...over?.budget }, nowMs: 0,
                        restPerTick: 2.25, floorMs: 5000, ...over });
```
Found: `...over` comes last, so it **replaces** the merged `budget` wholesale.
Any row overriding one budget field loses `resetMs`, making `secondsToReset` NaN
and the result NaN. This surfaced as "widening is capped" returning NaN; the
"exhausted budget" row passed only because `remaining: 0` returns before
`resetMs` is read — so the bug would have shipped half-hidden.
Chose: moved `budget` after the spread so the merge always wins.
Why: as written, a case could silently stop testing the thing it is named for.

### Phase 4

**`routing.test.mjs`'s `apiCalls` had to be narrowed.**
Plan said: nothing about it.
Found: the budget probe is `gh api rate_limit`, so it lands in the fixture log
and is picked up by `apiCalls = fixtureCalls.filter(c => c.startsWith("api "))`.
That helper feeds assertions like `call.includes("repos/acme/widget/")` and
`call.includes("--hostname tenant.ghe.com")` — both of which the probe fails, by
design: it is host-agnostic and carries no repository path. Three routing tests
would have gone red on a correct implementation.
Chose: excluded `api rate_limit` from that filter, with a comment saying why.
Why: those tests are about *alert endpoint* routing. Widening them to accommodate
the probe would have weakened the defect guard they exist to be.

**`capture()` exposes no `screen`, and `hasPanelFrame`/`hasTabBar` are not functions.**
Plan said: `drained.screen`, `hasPanelFrame(drained)`, `hasTabBar(drained)`.
Found: `parseCapture` returns `finalFrame: { lines, widest }` and booleans
`hasPanelFrame` / `hasTabBar` (`test/pty/capture.mjs:87-110`). None of the three
spec forms exist.
Chose: a local `screenOf(result)` joining `finalFrame.lines`, and the booleans
read as properties.
Why: mechanical correction to the real helper API.

**Added a probe-ran guard test the plan did not list.**
Plan said: four captures.
Found: every one of them passes vacuously if the loop never probes — "no badge"
and "fewer run-list calls" are both satisfied by a pane that did nothing.
Chose: added "the budget probe runs at all", asserting `api rate_limit` reached
the fixture.
Why: without it the file could go green while testing nothing.

**The meter bills before the `cancelled` early return.**
Plan said: `restSpentTotal += result.restSpent ?? 0` "immediately where the result
lands".
Found: placing it after the existing `if (cancelled) return` would drop the
billing for any fetch that landed during unmount.
Chose: billed on the first line of the `.then`, ahead of that guard.
Why: GitHub counted those requests whether or not this process still wants them,
and under-billing biases the inferred share the *unsafe* way.

### Process (all phases)

**No worktree.**
Process said: implement in a worktree.
Found: the plan, its phase files and the research document are all *untracked* in
the main checkout, so a worktree would not contain them — and every phase would
have to re-derive its own spec.
Chose: implemented directly on `develop` in the main checkout.
Why: `develop` is unprotected and takes direct commits (`CLAUDE.md`); no phase is
batch-eligible and no parallel agents are writing, so worktree isolation buys
nothing here and costs the spec.
