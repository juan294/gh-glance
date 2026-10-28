# Jev developer workflows — implementation notes

Implementation authorized 2026-10-28 for all five phases without intermediate stops, then local integration into `develop`, one integration push and task-worktree pruning. No live Jev experiment or release is authorized. Base: `0319c9c58d211867ec35776357259b02b235909f`. Task branch: `feat/jev-developer-workflows`. Worktree: `/Users/juan/code/gh-glance-jev-workflows`. Integration owner: parent agent. Source, dependency and query identities are recorded with each phase's check evidence.

## Deviations

No architecture or scope deviation has been selected. Focus helper tests clarify edit distance one as one insertion/deletion/substitution; transposition is two edits. Rendering uses existing row components and browser URL validation, with separate local feature state. The common feature state gains later phase identities as their acquisition/provider capabilities are implemented.

## Phase 1 — accepted locally

The implementation adds deterministic exact-filter/topic ranking, a bounded editor, derived source-preserving results and contextual coverage/hints. All search work is local. Focus navigation suppresses implicit source pagination. The frozen synthetic corpus contains 92 cases (80 held-out); SHA-256 `bc4094adfe2da5ff55b76c36f69b5b25be5309872fbafd6c23202d08030c6b1f`.

TDD: `/tmp/gh-glance-jev-phase1-red.log` records four missing-helper failures before implementation. Initial pure tests passed. The first PTY driver failed because it combined Backspace, query and Enter in one terminal write, then used `q` while the editor owned printable input; it timed out. The driver now waits for each state transition and always uses Ctrl-C for cleanup. Both 40/100-column focused PTYs passed after that repair. Full unit/PTY gates remain pending.

Independent review findings F1–F7: stale editor footer, clipped narrow disclosure, empty-query Escape, hidden unsupported-tab notice, missing scope retirement, rejected printable bracket text, and help Escape ownership. Repairs are implemented; final reviewer approval remains pending. Simplify and full gates must finish before acceptance. Corpus author had exclusive ownership of `test/fixtures/jev/focus.json`; ownership has returned to integration.

The initial local corpus run measured macro precision@k and recall@5 of 0.1667 on 48 matching cases, synonym recall@5 of 0 on 39 synonym cases, and specificity 1.0 on 20 no-match cases. These are deterministic vocabulary-baseline results, not model measurements or developer benefit. Ambiguous and filter-only cases are excluded from those semantic denominators. Measurement command now identifies dirty source inputs by content hashes as well as its base commit; the earlier base-only identity is superseded by that exact-input report. Live contract and semantic qualification remain UNVERIFIED.


### Final Phase 1 candidate and review

Frozen implementation/test/package candidate: `4b54eecbb4eaeddeae1c793977a0b3ecf9ed87f36528a04dc53fa0e3e4a84252`. Its complete per-file SHA-256 manifest and sequential gate statuses are preserved at `/Users/juan/.local/share/gh-glance/implementation/2026-10-28-jev-workflows/phase1-candidate.json` and `phase1-gate-status.json`. Runtime SHA-256: `477b9a552b6280a0ed1f6bd3febafd393092cd02362235fd8b0665e5aaec8b5f`; Focus PTY SHA-256: `bfbb276f0430b670f7a639c78a95f840a1f15d0c86a361aab73f3e5c1a50a7c1`.

F1–F11 received independent source/test approval. The connected-source test then found F12: passing filtered-empty rows into ordinary presentation produced a false source-empty claim. A new regression failed on that exact text, then passed after presentation received original source rows and Focus separately derived table visibility/explanation. The independent reviewer approved the repair and final SSH/PR tests. Simplify: reuse found no additional duplication; quality findings were repaired; efficiency now memoizes ranking by query and the selected source array. No further confirmed finding remains open; acceptance still awaits final gates.

Focused evidence: initial expanded suite passed its five standalone flows; the connected fixture was repaired to gate initial delivery and tolerate wrapped disclosure text, then passed. F12 has separate RED/GREEN logs. Added SSH Focus and exact PR URL cases each passed. Tests cover local/collector/SSH source modes, original item kind/URL, unchanged source timestamps and data, invalid-date repair, maximum-byte queries, CSI/mouse/resize, unloaded/empty/partial source recovery and disappearing selection. These targeted passes precede the final frozen-candidate full gates and do not replace them.

An initial full unit run passed 879/879. Later presentation repairs invalidated its UI inputs; the complete final unit and PTY gates are running against the frozen manifest. Lint and syntax passed for that manifest. No Jev dependency, SDK import, model call or new GitHub operation exists in Phase 1.


### Phase 1 acceptance

Accepted locally on Node v24.22.1 (darwin-arm64), with independent review and simplify complete. Frozen-candidate lint, syntax and `npm test` passed (879/879). Full `npm run test:pty` passed (215 passed, 1 optional historical 0.15.2 reproduction skipped because `GH_GLANCE_BASELINE_ENTRY` was not supplied, 0 failures). PTY duration was 2,273.8 seconds. All eight new Focus interactions passed in that full run. No acquisition/scheduling change was made, so the separate efficiency gate is not applicable to Phase 1.

The paired benchmark used five baseline/candidate pairs, the same runtime/fixtures/arguments, and an entry-import-to-first-dashboard-frame clock excluding Node startup: baseline median 222 ms, candidate 236 ms, within 5% plus 20 ms allowance. Keypress-to-paint p95 was 41.4 ms over 100 samples. Local ranking p95 was 0.30 ms over 100 samples. Process-tree CPU/RSS and model/provider latency are unmeasured. The final ranking report retained the earlier 0.1667 matching macro precision/recall, zero synonym recall, and 1.0 specificity; 10 ambiguous cases and 2 filter-only cases were excluded from semantic denominators and reported separately, with zero unsupported local assertions on ambiguous cases.

Manual inspection of captured 40×24 and 100×24 frames confirmed the editor/results, count/source-age/recovery hints and footer fit. Both captures exited 0 with one alternate-screen enter/exit and widths 39/99. Evidence is preserved as `phase1-visual-40.txt` and `phase1-visual-100.txt` in the external evidence directory. The final manifest comparison reported no changed tested inputs.

- [x] Phase 1: local Focus, corpus, review, simplify and complete local gates.
- [ ] Phase 2: optional Jev adapter and semantic Focus.
- [ ] Phase 3: shared protocol v8 and exact CI evidence.
- [ ] Phase 4: evidence-bound CI observations.
- [ ] Phase 5: exact personal attention and optional badges.

Phase 2 entry is authorized by the owner's all-phases instruction. Preserve local Focus and frozen labels; add the pinned optional provider with no live experiments. Integration/push/pruning occur only after every phase is complete. All raw phase evidence has been preserved outside the disposable worktree.
