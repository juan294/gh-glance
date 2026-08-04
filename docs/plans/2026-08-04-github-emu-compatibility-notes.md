# Implementation notes -- `2026-08-04-github-emu-compatibility.md`

## Deviations

### Phase 2 -- one extra marker in `AUTH_MARKERS`

- **Plan said**: `AUTH_MARKERS = /SAML|single[- ]sign[- ]on|\bSSO\b|must grant|not
  authoriz|unauthoriz|Bad credentials|requires authentication|re-?authoriz|token
  .*scope|missing .*scope|insufficient/i`, and separately that
  `isAuthProblem({stderr: "HTTP 403: Although you appear to have the correct
  authorization credentials, the organization has enabled OAuth App access
  restrictions"})` must be `true`.
- **Found**: those two halves of the phase contradict each other. That message
  matches no marker in the stated pattern -- it is an authorization failure
  phrased entirely in the positive ("you appear to have the *correct*
  authorization credentials"), so every negative marker (`not authoriz`,
  `unauthoriz`, `Bad credentials`) misses it. Implementing the regex verbatim
  failed the phase's own test.
- **Chose**: added `access restriction` to the alternation. Nothing else changed.
- **Why**: the test is the executable artifact the phase names as primary, and
  the plan's stated intent is a deliberately broad detector. `access
  restriction` is the phrase unique to that message family (OAuth App and
  third-party access restrictions) and appears in none of the genuine
  not-enabled messages, which talk about features rather than access -- so the
  negative assertion (`"Advanced Security must be enabled for this repository"`
  stays `unavailable`) still holds.

### Phases 2 and 3 -- `classify()` owns the precedence, rather than restating it

- **Plan said**: phase 2 gives `fetchAlertSource` the literal expression
  `unavailable <- isUnavailable(err) AND NOT isRateLimited(err) AND NOT
  isAuthProblem(err)`, and phase 3 separately defines `classify(err)` as an
  if-chain over the same three predicates, describing it as computed "with the
  *same* predicates the dashboard uses ... so the report states what `gh-glance`
  would actually have concluded".
- **Found**: same predicates, but not the same ordering. The phase 2 expression
  does not gate `authProblem` on `!isRateLimited`, so a message matching both
  the rate-limit pattern and an auth marker would take the auth ladder at
  runtime while `--doctor` reported `rate-limited` -- the report claiming a
  classification the dashboard does not make, which is the one thing phase 3
  says it exists to prevent. Unreachable today only because the two regexes
  happen to share no keyword, and `AUTH_MARKERS` is documented as broad and
  expected to grow.
- **Chose**: moved `classify()` up beside the three predicates as the single
  place the verdict is derived, and had `fetchAlertSource` switch on it via a
  `FAILURE_LADDER` lookup (`unavailable` -> `BACKOFF_STEPS_MS`, `auth-problem`
  -> `AUTH_RETRY_MS`, everything else -> no backoff) instead of re-deriving two
  booleans. Also factored the four copies of
  `String(err?.stderr ?? err?.message ?? "")` into `errText()`.
- **Why**: behaviour is identical for every input either form can currently
  reach, and where they would diverge, `classify()`'s ordering is the one phase
  2 actually asks for in prose -- "Rate-limited and network errors keep today's
  behaviour exactly: no backoff at all". Both plan-stated properties still hold
  and are still asserted by the phase 2 and phase 3 tests, unmodified.
