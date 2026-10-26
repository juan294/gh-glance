# Phase 2 — Doctor occupancy and remedy disclosure

Parent: [debt-journal compaction plan](../2026-10-26-debt-journal-compaction.md). Depends on Phase 1 accepted. Status: not started.

## Scope and evidence

Implement AC-7 from the parent. Own `index.mjs` (doctor section and `recoveryLedgerSummary` only), `test/doctor.test.mjs`, and the Unreleased section of `CHANGELOG.md`. Relevant source: doctor governor section `index.mjs:11320-11356`, state-file line `:11328`, `recoveryLedgerSummary` `:16186-16211`, `recoveryCause` destructuring `:15718-15740`, `governorHealth` `:6420-6445`, the hard-reason list in `recordRuntimeRecovery` `:18045`, doctor tests `test/doctor.test.mjs:333-374`.

## Work sequence

1. Write failing doctor tests first: a ledger with 128 quiescent groups prints `debt groups  128/128 (128 quiescent)`; a healthy ledger prints `debt groups  0/128 (0 quiescent)`; a journal whose current core reason is `accounting-overflow` (or `corrupt`, `capacity`, `unwritable`) prints a `state file` line and a `repair` line naming the quit-panes-then-move steps and all three files (`quota-…json`, `…recovery.json`, `registry.json`); a `debt-journal-full` current reason prints no repair line. Add one governor-level test: a registry that knows a `quotaKey` whose ledger is missing yields `corrupt` from `readIdentityQuotaState`, and the same scope with no registry file yields a fresh ledger (documents why the remedy names `registry.json`).
2. Extend `recoveryLedgerSummary` with `debtGroups` (count) and `quiescentGroups` (count). `recoveryCause` ignores unknown fields, so recovery journal entries keep their exact-key shape; assert that in the doctor test by reading the journal after a transition.
3. In the doctor governor section add one `debt groups` field, and when `currentRecovery.code` is one of the hard storage reasons print `state file` (always, not only when the cached read failed) and `repair` with the exact remedy: quit every gh-glance pane, move `<path>`, `<path>.recovery.json` and `<dir>/registry.json` aside, relaunch; note that at most the ledger's outstanding debt units may be spent twice within the current hour. `registry.json` is mandatory: without it `readIdentityQuotaState` (`index.mjs:3278-3283`) reports the missing ledger as `corrupt` (observed on the work machine, 2026-10-26).
4. Add the CHANGELOG Unreleased entry under Changed for the new doctor lines. Review, repair, simplify, verify, record evidence.

```text
@ doctorGovernorRepairLines(currentRecovery, cachedQuota) -> lines
pre: cachedQuota.path known when a ledger exists
do:
  1. validate code in HARD_STORAGE_REASONS
  2. emit "state file" with the redacted path (existing format)
  3. emit "repair" with quit, move both files, relaunch, and the overspend bound
br: transient code -> emit nothing
```

## Automated acceptance

- AC-7 cases above with exact-line regexes in the style of `test/doctor.test.mjs:333-374`.
- Journal shape unchanged after a transition that spreads the extended summary (exact keys at `index.mjs:16118-16128` still validate).
- Gates, sequential: `npm run lint; node --check index.mjs; npm test; npm run test:pty:smoke`.

## Manual acceptance

Parent manual acceptance: run `--doctor` against a copied wedged ledger in a scratch `XDG_CONFIG_HOME`, observe `128/128` then `≤ 2/128` after one dashboard refresh, then confirm the owner's work panes refresh. Record the outcome and the exact binary SHA in the notes file.

## Stuck states and recovery

Parent row 4: the hard reasons now disclose the manual remedy in the doctor report the pane already points at. The doctor test for the repair line is the disclosure proof.

## Work units and gate

One sequential unit; not batch-eligible. Independent review checks that the repair text matches the actual file names and that no transient reason triggers it. No remote actions. Stop after gates and handoff for acceptance.
