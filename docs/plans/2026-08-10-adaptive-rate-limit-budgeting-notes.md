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
