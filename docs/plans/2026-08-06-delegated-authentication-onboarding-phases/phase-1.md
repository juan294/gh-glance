# Phase 1 — Failure semantics and one-line remedies

> Files: `index.mjs`, `test/unit.test.mjs`
> Depends on: nothing. Blocks: phase 2.
> Not batch-eligible: phase 2 consumes this failure model and shares both files.

## Objective

Turn the exact no-login and repository-resolution messages observed in research
into the existing `auth-problem` and `unavailable` verdicts, then represent
fetch failures structurally so later context can refine their rendered copy.

This phase does not run an auth probe, add state outside the existing per-tab
errors, or change terminal geometry.

## Changes

### 1. Broaden auth evidence (`index.mjs:344-366`)

Extend `AUTH_MARKERS` with the concrete first-run/host-resolution forms:

```
not logged into any GitHub hosts
To get started with GitHub CLI
run: gh auth login
none of the git remotes ... point to a known GitHub host
```

Keep the current SAML/SSO, authorization, credential, and scope alternatives.
Do not add `HTTP 403` as an auth marker; rate-limit and genuine unavailable
responses rely on classification order and message-specific evidence.

### 2. Recognize GraphQL repository resolution (`index.mjs:331-338`)

Widen `isUnavailable(err)`:

```
text = errText(err)
return /HTTP (403|404)/.test(text)
    OR /Could not resolve to a Repository with the name .* \(repository\)/i.test(text)
```

The GraphQL marker is deliberately narrow. Do not classify every GraphQL error
as unavailable; schema, network, server, and query failures stay `other` and
retain their raw `gh` message.

### 3. Replace list-tab fixed remedies (`index.mjs:389-407`)

Set exact values:

```
VERDICT_REMEDY["auth-problem"] =
  "GitHub login or authorization required -- run `gh auth status`, then `gh auth login` or `gh auth refresh`"

VERDICT_REMEDY["unavailable"] =
  "Repository not found or inaccessible to the active `gh` account -- check `gh auth status` and the repository target"
```

Keep the rate-limit copy unchanged. Do not edit the three security-source notes
in `ALERT_SOURCES` (`index.mjs:665-713`); `fetchAlertSource()` owns their
feature-specific unavailable wording (`index.mjs:775-790`).

### 4. Introduce structured tab errors

Add pure helpers beside `VERDICT_REMEDY`:

```
toTabError(err):
    return {kind:"fetch", verdict:classify(err), raw:shortErr(err)}

textTabError(err):
    return {kind:"text", text:shortErr(err)}

formatTabError(error, failureContext = null):
    if error == null: return null
    if error.kind == "text": return error.text
    if error.verdict == "other": return error.raw
    if error.verdict == "unavailable" AND failureContext?.repo?.ok:
        return "not available for this repository"
    return pick(VERDICT_REMEDY, error.verdict, null) ?? error.raw
```

The phase-1 call site passes no context, so an unavailable list failure selects
the repository/account wording. Phase 2 supplies context and enables the visible
repository distinction.

In `commit().catch()` (`index.mjs:2522-2538`), store `toTabError(err)` instead of
a string. In `openSelected().catch()` (`index.mjs:2388-2391`), store a text
record because a browser-open error is not a tab-fetch verdict. Immediately
before render, derive:

```
displayError = formatTabError(errors[tab.key], null)
```

Keep boolean checks on the record itself for failed-tab coloring and line-count
reservation (`index.mjs:2242-2270`, `index.mjs:2688`). Success still sets the
entry to `null` (`index.mjs:2495-2505`).

### 5. Exports (`index.mjs:3004-3043`)

Export `toTabError` and `formatTabError` for executable behavior tests. Keep the
helpers internal to the package contract; exports exist only because importing
`index.mjs` is the current unit-test seam.

## Tests (`test/unit.test.mjs`)

Add failing-first cases:

```
test("fresh gh login failures are auth problems"):
    for message in [
      "You are not logged into any GitHub hosts. To log in, run: gh auth login",
      "To get started with GitHub CLI, please run: gh auth login",
      "none of the git remotes configured for this repository point to a known GitHub host"
    ]:
        assert isAuthProblem({stderr:message})
        assert classify({stderr:message}) == "auth-problem"

test("the screenshot GraphQL resolution failure is unavailable"):
    error.stderr = "GraphQL: Could not resolve to a Repository with the name 'Nvteca/cashflor-forecast'. (repository)"
    assert isUnavailable(error)
    assert classify(error) == "unavailable"

test("unrelated GraphQL errors remain other"):
    assert classify({stderr:"GraphQL: Something went wrong while executing your query"}) == "other"
```

Add formatter assertions:

- exact screenshot GraphQL failure selects the repository/account remedy;
- exact no-login failure selects the login/authorization remedy;
- `other` returns its shortened raw message;
- a `{kind:"text"}` error returns its text;
- fixed remedies contain no newline and are at most `MAX_ERR_LENGTH` characters;
- `Object.keys(VERDICT_REMEDY)` still equals
  `Object.keys(FAILURE_LADDER)`.

Retain every existing priority assertion: rate limit over auth, SAML/SSO as
auth, genuine HTTP 403/404 as unavailable, DNS as other, and the short auth
ladder (`test/unit.test.mjs:120-171`).

## Automated success criteria

Run sequentially:

```bash
npm run lint && npm test && node --check index.mjs && npm run test:pty
```

All pre-existing tests pass. The current healthy PTY suite proves that
introducing the record type does not disturb the success path or terminal
lifecycle. Active-error geometry is intentionally deferred to phase 3's
failure capture, after the context behavior it must exercise exists.

## Manual success criteria

None. Exact strings and formatter selection are deterministic unit contracts in
this phase.
