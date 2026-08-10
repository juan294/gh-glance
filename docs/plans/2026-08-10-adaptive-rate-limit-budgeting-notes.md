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
