# Phase 6 — Document the harness `[batch-eligible]`

Depends on: Phase 4. Touches only `CONTRIBUTING.md`, disjoint from Phase 5.

## Files

- `CONTRIBUTING.md` — extend the existing Tests section (`:39-62`)

## Change

The Tests section already lists `npm test`, `npm run lint` and
`node --check index.mjs`, and records the three invariants a contributor must
not break (`:52-62`). Add the pty harness alongside them, in the same voice.

Content to cover, briefly:

- `npm run test:pty` — what it is, that it drives the real binary under a pty
  with a fixture `gh`, and that it is **advisory** in CI rather than required.
- That it is deliberately separate from `npm test` so the fast unit run stays
  fast and required while the slow one stays advisory.
- The one rule that keeps it useful: **assert structure, never cell contents.**
  Line counts, widths, escape balance and exit codes are fair game; the text in
  a cell is not, because a copy change would red the build for no defect.
- That fixture drift is expected and is the point — the fixture pins the
  contract the app depends on, not the CLI's behaviour.
- That `script(1)` differs between darwin and ubuntu, so `run.sh` implements
  both forms and a change to one must be checked against the other.

Do **not** restate the phase files or the research document here. A contributor
needs to know how to run it and what not to assert; the reasoning lives in
`docs/research/2026-08-03-pty-harness-attachment-points.md`.

## Not in scope

`README.md` is a user-facing document. The harness is a contributor concern, and
`README.md` already carries the Troubleshooting and Limitations sections a user
needs. Adding test tooling there would be noise.

## Success criteria

**Automated**

- `npm run lint` passes (markdown is not linted by eslint, but the repo has no
  markdownlint config either — this is a no-op check confirming nothing else
  broke).
- No stale claim introduced: `grep -n "no test suite\|do not invent one"` across
  `CONTRIBUTING.md`, `CLAUDE.md` and `AGENTS.md` returns nothing. All three were
  brought into agreement in `85784c2`; this phase must not reintroduce drift.

**Manual**

- Read the new section as someone who has never seen the harness and confirm it
  answers: how do I run it, why is it separate, and what am I not allowed to
  assert.
