# Phase 1 — useful local Focus

Parent: [implementation plan](../2026-10-28-jev-developer-workflows.md). Entry: baseline revalidated, implementation authorized, isolated local worktree. Outcome: developers can search loaded Issues or PRs immediately, with no new network operation or dependency. Jev controls arrive in Phase 2.

## Changes and behavioral contract

Add proposed pure helpers `parseFocusQuery`, `rankLocalFocus`, and a feature-mode reducer in `index.mjs`. Integrate with existing key/help definitions (`index.mjs:11725`, `:16110`, `:16770`), input dispatch (`index.mjs:17963`), selection (`index.mjs:7050`, `:7054`, `:17651`) and derived visible rows (`index.mjs:20291`). Keep source arrays, cache entries and fetchers unchanged.

`/` enters a query editor on Issues/PRs; other tabs explain that Focus applies to those lists. Limit queries to 256 UTF-8 bytes without splitting code points. Enter computes local results, no HTTP. Escape restores the previous submitted query/results; Escape again restores the original tab and selection. Printable q is text while editing; Ctrl-C always exits. Selecting a result and Enter opens its original validated URL, preserving the existing item kind and number. Help keys must describe the current mode, not stale normal-view actions.

Local query grammar is deliberately small: `#123`, `author:alice`, `branch:fix/session`, and `updated:>=YYYY-MM-DD` are exact filters; remaining whitespace-separated tokens are topic text. Author compares case-insensitively; branch compares the exact case-sensitive ref and only matches PRs; neither uses fuzzy matching. Date is a real UTC calendar date and inclusive lower bound; invalid syntax displays a repairable query error, never silently drops the filter. Multiple exact filters are ANDed. Topic tokens are ANDed against title/available labels/branch. Normalize topic text with Unicode NFKC and locale-independent lowercase; exact token > prefix token > edit distance one on tokens of at least five code points. Whole topic phrase match ranks first; then lexicographic counts of exact, prefix and fuzzy hits; original source order breaks ties. Numeric IDs never use fuzzy matching. No hidden synonym dictionary. An empty submitted query restores the loaded list.

Label results “Matches among loaded title/metadata” and show matching/loaded counts, source age, and existing pagination/truncation state. No result means no local match in the loaded data. Missing/unloaded source is a different state with the existing refresh action. Preserve source truncation limits (`index.mjs:305`, `:1941`, `:1950`) and ordinary list access. Source refresh recomputes local results without network beyond that explicit ordinary refresh; selection follows identity or falls back to the nearest valid row.

```text
@ deriveFocus(query, rows, sourceState) -> view
pre: rows are existing validated source projections
do:
  1. parse bounded query and exact filters
  2. compute deterministic token matches and stable ranking
  3. emit rows with loaded coverage and source age
br: empty query -> source order; invalid filter -> editable error
fx: feature selection only; source state is unchanged
fail: missing source -> visible refresh action
```

## Oracles and owned files

Create proposed `test/focus.test.mjs`, `test/pty/focus.test.mjs`, and `test/fixtures/jev/focus.json`. The fixture corpus schema contains case ID, split, source rows with kind/number, query, exact-filter expected IDs, graded topic relevance and evidence rationale. Development and held-out group IDs are fixed; fixture probabilities are not model expectations. This corpus also supplies the Phase 2 baseline.

| Case | Required observation |
| --- | --- |
| `#42 author:ana` with issue 42 by another author | No result; neither filter is ignored |
| `updated:>=2026-02-30` | Query error with valid-date instruction, editable without leaving Focus |
| `branch:fix/Session` beside distinct `fix/session` | Only the exact case-sensitive ref matches |
| Topic `auth` vs title containing authentication | Prefix match; exact auth ranks ahead on otherwise equal metadata |
| One typo in a five-character token | Fuzzy match below exact/prefix; short tokens do not use edit distance |
| Spanish text and combining accents | Stable normalization; no ASCII-only loss |
| No matches with unqueried source pages | Bounded no-local-match message and source incompleteness |
| q, pasted escape/CSI, mouse, resize, Escape, Ctrl-C | Correct mode precedence and terminal restoration |
| Selected row disappears on refresh | No wrong-row open; stable valid selection or explicit empty view |
| Any typing/search/resize sequence | Zero extra GitHub requests; source fetched-at unchanged |

Cover narrow terminal width, lower help hints, loaded empty/unavailable sources and all source modes. Existing `test/context-help.test.mjs:33`, `test/runtime-remediation.test.mjs:405`, `test/pagination.test.mjs:203`, `test/unit.test.mjs:3640` are consumers to update for mode-aware contracts; use the main consumer sweep for complete coverage.

One runtime/test integration owner. `[batch-eligible]` corpus author may independently create only `test/fixtures/jev/focus.json`, using the schema above and synthetic/public examples; no production code or key/transport files. Runtime owner does not edit that file until handoff. All other work stays sequential.

## Stuck states and recovery

An invalid/oversized query leaves its text editable with the exact limit/filter error; correcting it computes results. Empty loaded source offers Refresh and ordinary-list navigation; a successful fixture refresh restores search. Stale source shows its age without blocking local use. Unsupported tab tells the user to switch to Issues or PRs. Tests must assert those instructions and the successful next interaction, not just refusal. No service, key or consent failure exists in this phase.

## Acceptance and handoff

Automated: all table oracles; no new source operation; first-paint and pending-input benchmark harness established for later comparison. Sequential gates: `npm run lint`, `node --check index.mjs`, `npm test`, `npm run test:pty`. Efficiency gate is required only if actual implementation changes acquisition/efficiency behavior. Manual: narrow/wide visual inspection for clipped editor, counts and recovery text.

Record exact candidate SHA/worktree, phase diff, corpus hash, local baseline ranking metrics, gate results and deviations. Complete independent review, repair and simplify before final gates. Stop for Phase 1 acceptance. Phase 2 enters with a useful deterministic baseline and no assumed provider accuracy.
