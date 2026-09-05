# Phase 11: GitHub App installation provider

Parent: [complete plan](../2026-09-05-multi-instance-efficiency.md)  
Depends on: 10. Batch eligibility: no.

## Objective and files

Add optional installation credentials to the collector without changing ordinary `gh auth login` use. Add provider configuration, native signing/token mint and provider-aware transport in `index.mjs`; add `test/app-auth.test.mjs` and collector permission/expiry integration tests. Update README, SECURITY, CONTRIBUTING and ADRs 0004/0005. No App registration, installation, credential creation or permission grant is performed remotely.

## Provider contract

```text
provider = {
  type: github-app,
  host, clientId, installationId, privateKeyFile,
  repositoryIds: explicit allowed set,
  permissions: explicit read-only set
}

credentialsFor(provider):
  if cached in-memory installation token valid for >5 minutes: reuse
  otherwise one refresh owner signs short-lived RS256 JWT
  POST exact host's /app/installations/{id}/access_tokens
  request only configured repositories/read permissions
  validate returned scope/expiry; retain token in memory only
```

Use native `node:crypto` for RS256, `iat = now - 60s`, `exp = now + 540s`, and configured client ID as issuer. A narrow native HTTPS authentication adapter sends the JWT as a Bearer header for token minting; it is the sole exception to `gh`-mediated GitHub transport. It uses validated configured hosts, normal TLS verification, timeout/body bounds, no cross-host redirects and redacted errors. Do not pass JWTs or tokens as argv/header flags. A provider request budget/secondary limiter covers mint attempts (one in flight, at most four retries with 60/120/240/480-second backoff); it is not labeled free. Ingest any returned quota evidence when its resource/principal attribution is valid.

For repository API data, continue using the same `gh api` request path and query contracts, with the installation token supplied only in a constructed child environment for the selected host; remove competing token variables for that invocation. Token values never enter persistence, wire snapshots, diagnostics or test failure output. Keep private keys on the collector machine, validate restrictive file permissions, and never send key paths/content to clients.

Quota principal is `(host, installation, installationId)`, distinct from a human user. Access partition includes provider, requested repository/permission set and authorization generation. Renewing equivalent credentials does not split quota state; permission changes advance access generation and fence old data. Different installations never share quota. No silent fallback to a broader personal token after a permission/token failure.

Make core observation provider-specific. Human credentials retain conditional `/user`; installation credentials use a conditional `GET /installation/repositories?per_page=1` through `gh api -i` with that installation token. Its first 200 declares one core unit, 304 declares zero, and its response headers establish/refine installation core authority under the same claimed epoch protocol. The installation provider does not call `/user` or require user identity for bootstrap. The configured installation ID is bound by successful JWT-authenticated token minting at that exact installation endpoint, not inferred from a token prefix. Keep the observer validator in the installation access partition and discard it when permissions/repository restrictions change. If the host lacks this endpoint/evidence, pause that provider with an explicit capability result rather than attempting personal credentials.

Token-mint response headers belong to the App-authentication request context. Do not merge them into the installation's data quota ledger merely because they name `core`; maintain separate control metrics/holds unless principal attribution is explicitly established. Installation observation/recovery inherits the persisted bootstrap allowance from phase 2, so token rotation or collector restart cannot create a new allowance.

Use `expires_at` from token response, not an assumed lifetime. Refresh at five minutes before expiry, or immediately if a shorter lifetime requires it; serialize concurrent requests. On refresh failure keep a still-valid old token only until its expiry, then hold data and retain stale rows. After 401, invalidate the token and permit one controlled refresh before a bounded failure hold. Installation deletion/suspension/repository removal webhook immediately invalidates relevant authority/data publication.

Document a read-only permission matrix: metadata, Actions, Issues and Pull requests for their tabs; Dependabot alerts, code scanning alerts and secret scanning alerts only when those Security surfaces are enabled. Tests verify each optional surface independently. Restricted/unsupported GraphQL fields or Enterprise features produce a capability state, never an ungoverned fallback or false empty Security result.

## Automated acceptance

- `APP-01`: generated JWT verifies with a fixture public key; claims stay within the documented time window; wrong key/host/config fails before data.
- `APP-02`: concurrent subscribers mint one token; actual expiry and early renewal are honored with injected time; failures/retries bounded.
- `APP-03`: data child environment contains only the selected provider token; no token/key/JWT appears in argv, disk, wire, logs or errors.
- `APP-04`: installations/user budgets stay distinct; token rotation preserves quota identity; permission changes fence snapshots and never widen requested access.
- `APP-05`: 401/403, installation suspension, revoked repository, refresh failure and expiry preserve rows as stale with no personal-token fallback.
- `APP-06`: mint request is counted/limited separately, rejects cross-host redirects and invalid TLS, and cannot be invoked through arbitrary client messages.
- `APP-07`: optional Security permissions fail per source while permitted Actions/Issues/PRs remain usable; normal gh-login mode is unchanged.
- `APP-08`: `/user` deliberately fails for the fixture installation while the installation-repository observer, Actions data and reset recovery succeed; first 200/next 304 reconcile with the installation ledger and do not touch the user ledger.

Use generated fixture keys and injected local HTTPS/token transport; no live GitHub App is needed. Run parent gates sequentially. Official contracts: [JWT generation](https://docs.github.com/en/apps/creating-github-apps/authenticating-with-a-github-app/generating-a-json-web-token-jwt-for-a-github-app), [installation tokens](https://docs.github.com/en/apps/creating-github-apps/authenticating-with-a-github-app/generating-an-installation-access-token-for-a-github-app).

## Manual success criteria

None required for implementation acceptance. User registration/installation and key placement are documented opt-in activation steps. The default product requires none of them.

## Completion

- [ ] Optional provider, signing/mint, renewal and permission isolation implemented.
- [ ] APP scenarios and parent local gates passed.
- [ ] Independent compliance/quality review complete; integrated locally; stop.
