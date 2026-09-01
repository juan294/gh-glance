---
description: TDD protocol and testing philosophy -- red-green-refactor, regression tests, verification hierarchy
paths:
  - "test/**"
---

# Testing

## TDD Protocol

All code changes follow Red-Green-Refactor:

1. **Red** -- Write a failing test FIRST
2. **Green** -- Minimum code to pass
3. **Refactor** -- Clean up with green tests

No exceptions. Bug fixes need a regression test.
Refactors need existing coverage. No "tests later."

Before chaining onto an API, confirm the method/type actually
exists -- docs, types, or a tiny probe. Run the targeted test BEFORE
committing the first attempt, not after -- a revert costs more than
the probe would have.

## Verification Sequencing

Run checks sequentially, never as parallel Bash calls
(hook enforced). Chain: `npm run lint ; npm test`
There is no typecheck step -- do not invent one. Add `npm run test:pty`
when touching rendering or the terminal lifecycle.
