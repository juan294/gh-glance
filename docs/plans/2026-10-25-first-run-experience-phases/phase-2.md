# Phase 2 — Repository identity and discoverable help

Parent: [first-run experience plan](../2026-10-25-first-run-experience.md). Requires Phase 1 accepted with valid check evidence.

## Scope and design

Own `index.mjs`, onboarding/unit/runtime-remediation tests, PTY help/identity/layout tests, and README keybinding/First run sections. Reuse `effectiveRuntimeRepository` and `effectiveRuntimeHost` (`index.mjs:1282`, `:1292`); display the selected target for inferred as well as explicit repositories. A resolved slug proves selection, not successful authentication. Preserve host precedence. No new gh invocation is allowed for display.

Add `? Help` to footer hints after essential Quit/Refresh and before optional Width. At very small widths retain the bare `?` key with r/q. Full target, selected host, current tab meaning, source-check evidence and recovery action live in contextual help. Include key reference after context, using existing `KEY_TABLE`/`keyTableLines`; keep `helpLines` for legacy/static fallback tests and CLI use rather than silently changing its return contract.

Help is paginated after wrapping to actual drawable cell width and body height. Use n/p for next/previous page while help is open, `?` to close, and any other ordinary key to close without executing its normal action. q/Ctrl+C/Esc keep existing quit behavior. Every help page reserves a compact page/navigation line; the first content page prioritizes state and required remedy. Resizing reflows and clamps the page index. Do not put a long target solely on a truncated header or footer. A long unbroken slug must be split across lines so all characters are reachable.

```text
@ contextHelpPages(context, keys, width, height) -> pages
pre: context is sanitized display data with no credentials
do:
  1. compute source state and selected target lines
  2. compute wrapped lines by terminal cell width
  3. compute pages reserving navigation and quit disclosure
  4. emit complete reachable content in priority order
br: unresolved target -> include explicit-target remedy; narrow pane -> more pages
fail: no usable body space -> preserve existing minimum-size fallback and quit
```

## Work sequence

1. Write failing NAV tests below and targeted PTY cases for inferred target and long identities.
2. Add target display to panel/header from existing resolver results; unresolved stays explicit. Use `host/owner/repository` for non-default hosts. Help shows host for all targets. Never expose account access-key hashes or tokens.
3. Add contextual help pages and modal input dispatch without changing remote setup Enter, row Enter, refresh, resynchronize, tab navigation or width-mode key ownership outside help.
4. Connect Phase 1 shortened messages to full context. Keep the known remediation action accessible; don't move every error behind a keypress.
5. Update README/key table and regenerate applicable terminal samples through `test/pty/readme-sample.mjs:1`; preserve the explicit caveat that automated reader rendering does not prove assistive-technology compatibility. Review, simplify, verify.

## Automated acceptance

| ID | Oracle |
| --- | --- |
| NAV-01 | Explicit repo, qualified GH_REPO, unambiguous HTTPS/SSH remotes and enterprise host use existing precedence; no additional API or local subprocess for UI identity. |
| NAV-02 | Ambiguous/unresolved target says so and includes `gh-glance --repo owner/name`; no fabricated slug or connected badge. Existing no-remote prompt remains functional. |
| NAV-03 | At 24×10, paginate a long target and long storage remedy; reconstruct complete sanitized text from all pages; n/p and resize have bounded indexes. |
| NAV-04 | Footer retains r/q/? at minimum supported width; optional hints never displace them. Help page declares navigation and exit behavior. |
| NAV-05 | Help closing consumes the key; no accidental setup, browser open, refresh, or width mutation. q/Esc exits; width mode keeps owning its keys. |
| NAV-06 | Screen reader and no-color output include state, target, action and page controls; steady state does not introduce repeated announcements. |
| NAV-07 | Account unknown/change and collector reconnect cannot label cached results as newly verified; target selection remains separate from data-access state. |

Run Phase 1 CX tests again. Required sequential full gates: lint, syntax, unit suite, PTY suite. No acquisition changes are planned; if implementation adds any, require the efficiency gate and document the deviation before dependent work.

## Manual acceptance

Inspect wide and narrow captures for recognizable target and help affordance. Navigate the deterministic long-target help fixture to verify readability and complete disclosure. No external browser or account change is required.

## Stuck states, work units and gate

Unresolved target, hidden overflow, uncertain identity and short help pages are covered by NAV-02/03/07 and parent recovery table. One sequential unit; no batch eligibility due to shared App/input/layout ownership. Independent review checks key fall-through and target truth. Record exact candidate/check evidence and stop for phase acceptance.

## Completion evidence

- [x] NAV-01 through NAV-07 implemented and reviewed, with lifecycle evidence supplied by unchanged identity/collector regressions.
- [x] Required visual captures inspected and README sample regenerated.
- [x] Review findings and simplify corrections resolved.
- [x] Required sequential lint, syntax, unit and PTY commands exited 0 on fingerprint `8ae37264e0da450f61f2995f5caa4bdc5882263b51fc171b41d3f874a0c17334`.

Unit: 825 passed. PTY: 190 passed, 0 failed, 1 historical-baseline skip. Runtime SHA256: `7f69512f51313573e05cfd2f81ed0373a50973a53b4dd97b0b767282d79f264b`. See [implementation notes](../2026-10-25-first-run-experience-notes.md). Phase 3 may proceed under the owner's all-phases authorization.
