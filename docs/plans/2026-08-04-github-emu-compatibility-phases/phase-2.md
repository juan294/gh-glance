# Phase 2 — Honest 403 classification

> Files: `index.mjs`, `test/unit.test.mjs`
> Depends on: phase 1 (shares `index.mjs`). Blocks: phases 3, 4.
> Not batch-eligible.

## Why

This is the defect that actually bites on an EMU tenant day to day.

The user's EMU SAML session lapses periodically and is re-authorized in the
browser. While lapsed the API answers **403**. Today:

1. `isUnavailable()` (`index.mjs:244-246`) matches `HTTP (403|404)` and returns
   true — it cannot tell "you may not see this" from "this is switched off".
2. `fetchAlertSource()` (`index.mjs:542-543`) therefore renders the source's
   fixed note, e.g. `"Code scanning: not enabled (needs GitHub Advanced
   Security)"` (`index.mjs:469`) — a confident claim about repository
   configuration that is simply false.
3. `recordFailure()` (`index.mjs:508-512`) latches a backoff escalating
   `60s → 300s → 1800s → 3600s` (`index.mjs:104`), cleared only by a successful
   fetch (`index.mjs:525`) that will not be attempted while the backoff holds
   (`index.mjs:519-522`).

Net effect: a lapse fixed in ten seconds can leave the Security tab blank and
falsely captioned for up to an hour. `README.md:284` already promises the
opposite — *"A genuine auth or network failure shows the real error instead."*

## Changes

### 1. `isAuthProblem()`, beside the other predicates (`index.mjs:244-250`)

```
# 403 on EMU carries meanings it never carries on a personal account: an
# expired SAML session, a credential not authorized for the org, a token
# missing a scope. None of them are statements about the repository's
# configuration, and all of them are fixed by the user in seconds -- so they
# must surface as themselves and must not latch an hour-long backoff.
AUTH_MARKERS = /SAML|single[- ]sign[- ]on|\bSSO\b|must grant|not authoriz|
                unauthoriz|Bad credentials|requires authentication|
                re-?authoriz|token .*scope|missing .*scope|insufficient/i

isAuthProblem(err) -> AUTH_MARKERS.test(String(err?.stderr ?? err?.message ?? ""))
```

Written broad on purpose. An SSO message that fails to match degrades to
today's behaviour and is caught by `--doctor` in phase 3; a false positive
merely means an endpoint retries every 30s instead of backing off, which is
cheap and self-correcting. The asymmetry favours breadth.

### 2. A short fixed ladder for auth problems (`index.mjs:104`)

```
BACKOFF_STEPS_MS = [60_000, 300_000, 1_800_000, 3_600_000]   # unchanged
AUTH_RETRY_MS    = [30_000]                                   # NEW, single step
```

Recovery after re-authorizing is then bounded at ~30s rather than an hour, while
a lapse lasting all night still costs at most two probes a minute per endpoint
instead of a probe every tick.

### 3. `recordFailure()` takes the ladder (`index.mjs:508-512`)

One code path, two ladders — rather than a second near-identical function, which
is the drift the `ALERT_SOURCES` refactor comment at `index.mjs:434-438` warns
about.

```
recordFailure(key, now, steps = BACKOFF_STEPS_MS):
    previous <- alertBackoff.get(key)
    step     <- min((previous?.step ?? -1) + 1, steps.length - 1)
    alertBackoff.set(key, { step, until: now + steps[step] })
```

### 4. `fetchAlertSource()` (`index.mjs:537-549`)

```
catch (err):
    authProblem <- isAuthProblem(err)
    unavailable <- isUnavailable(err) AND NOT isRateLimited(err) AND NOT authProblem

    note <- unavailable ? source.unavailable
                        : `${source.name}: ${shortErr(err)}`

    if unavailable:
        recordFailure(key, now)                      # existing escalating ladder
        alertBackoff.get(key).note <- note
    else if authProblem:
        recordFailure(key, now, AUTH_RETRY_MS)       # NEW short fixed ladder
        alertBackoff.get(key).note <- note

    return { raw: `unavailable:${note}`, parse: () => ({alerts: [], note, truncated: false}) }
```

Rate-limited and network errors keep today's behaviour exactly: no backoff at
all, real message surfaced.

### 5. Exports (`index.mjs:2046-2071`)

Add `isAuthProblem` and `AUTH_RETRY_MS`.

## Tests (`test/unit.test.mjs`)

The existing `isUnavailable` / `isRateLimited` tests (around
`test/unit.test.mjs:115`) stay untouched. Add:

```
test("a SAML/SSO 403 is an auth problem, not a disabled feature"):
    # Strings GitHub and gh actually emit. Verbatim capture from a real tenant
    # arrives via --doctor (phase 3); until then these are the documented forms.
    for s in [
      "HTTP 403: Resource protected by organization SAML enforcement. You must grant your OAuth token access to this organization (https://api.github.com/...)",
      "HTTP 403: Although you appear to have the correct authorization credentials, the organization has enabled OAuth App access restrictions",
      "HTTP 401: Bad credentials",
      "HTTP 403: Your token has not been granted the required scopes to execute this query",
    ]:
        assert isAuthProblem({stderr: s}) == true

test("a genuine not-enabled 403/404 is not an auth problem"):
    for s in ["HTTP 404: Not Found", "HTTP 403: Advanced Security must be enabled for this repository"]:
        assert isAuthProblem({stderr: s}) == false
        # and the combination the fetcher actually evaluates:
        assert (isUnavailable({stderr:s}) AND NOT isAuthProblem({stderr:s})) == true

test("a rate-limit message is still not an auth problem"):
    assert isAuthProblem({stderr: "HTTP 403: API rate limit exceeded"}) == false

test("the auth ladder is short, fixed, and far below the unavailable ladder"):
    assert AUTH_RETRY_MS.length == 1
    assert AUTH_RETRY_MS[0] < BACKOFF_STEPS_MS[0]
```

Note the second case: `"Advanced Security must be enabled"` contains neither an
auth marker nor the word `authoriz`, which is what keeps the genuine
not-enabled path intact. If a future marker addition breaks that assertion, the
marker is too broad.

## Success criteria

### Automated
- `npm test`, `npm run lint`, `node --check index.mjs` pass.
- Every pre-existing `isUnavailable` / `isRateLimited` assertion passes unedited.
- A 403 with SAML/SSO text yields `isAuthProblem == true`, produces no
  `source.unavailable` note, and uses `AUTH_RETRY_MS`.
- A 403 without auth markers still produces `source.unavailable` and the
  escalating ladder.

### Manual
- Deferred to phase 3's report. The verbatim tenant strings are captured there,
  and this phase's regex is revised from them if any lapse classified as `other`.
