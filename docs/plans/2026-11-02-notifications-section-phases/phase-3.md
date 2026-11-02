# Phase 3: GitHub platform status source

> Plan: [`../2026-11-02-notifications-section.md`](../2026-11-02-notifications-section.md) | Entry: Phase 2 accepted

## Objective

Report GitHub service status in the Notifications view and badge, without using GitHub API quota and without network access in tests.

## Changes (`index.mjs`)

### 1. Configuration

```
@ githubStatusConfig(env, host) -> { enabled, url, reason }
do:
  1. parse GH_GLANCE_GITHUB_STATUS: unset -> default URL; "off"|"0" -> disabled; http(s) URL -> override
  2. br host != github.com -> disabled, reason "not checked for <host>"
fail: any other value -> disabled, reason "GH_GLANCE_GITHUB_STATUS value not recognised"
```

Default URL: `https://www.githubstatus.com/api/v2/summary.json`. Document the variable in `--help` and README beside `GH_GLANCE_REFRESH`.

### 2. Fetch and parse

```
@ fetchGitHubStatus({ url, etag, signal, fetchImpl = globalThis.fetch }) -> { status: "ok"|"not-modified"|"unavailable", summary?, etag? }
ctx: HTTPS GET; not gh, not the governor (not GitHub API quota)
do:
  1. send If-None-Match when etag known; timeout 10 s via AbortSignal
  2. br 304 -> not-modified
  3. read body with 256 KiB cap; parse JSON
  4. validate shape; keep tracked components and incidents touching them
  5. sanitize every string with safe() and cap at MAX_FIELD_LENGTH
fail: network error, non-2xx/304, oversize, bad JSON, bad shape -> unavailable
```

`fetchImpl` injection follows `createJevSession` (`index.mjs:18507`). Tracked components: `API Requests`, `Actions`, `Issues`, `Pull Requests`, `Git Operations`, `Webhooks`. Incident fields read: `name`, `status`, `impact`, `updated_at`, `components[].name`; each is optional in the parser.

### 3. Poller

```
@ createGitHubStatusMonitor({ config, fetchImpl, log, now, setTimer }) -> { checkNow, stop, current }
do:
  1. schedule every 10 min; backoff to 15 min after unavailable
  2. checkNow(): run at most once per 60 s (view open, r, tab problem trigger)
  3. diff summary vs previous: incident begin/update/resolve, component degrade/recover
  4. record events: outage or incident -> problem; resolved -> info; unavailable -> one info per episode
fx: log entries; header text state for the view
risk: timers must unref and stop on exit (abortLiveRequests path, index.mjs:675)
```

- Start the monitor only inside the interactive TUI after `App` mounts. `--doctor`, `--version`, `--help` and other non-TUI paths never construct it.
- Trigger `checkNow()` when the snapshot diff records a `problem` or a `network-outage` begin.

## Harness isolation

- `test/pty/capture.mjs` `captureEnvironment` (`test/pty/capture.mjs:461-479`): add `GH_GLANCE_GITHUB_STATUS: env.GH_GLANCE_GITHUB_STATUS ?? "off"`.
- For each spawner in the plan's consumer sweep, confirm it launches the TUI through `capture.mjs` or a shared env builder; set `off` in any TUI launcher that does not. Record the list in the phase notes.
- Unit test: running `--doctor` and `--version` with an override URL to a local server records zero requests.

## Tests

1. Unit, injected `fetchImpl`: operational, minor and major component outage, incident begin/update/resolve, 304 reuse, timeout, 500, malformed JSON, 300 KiB body, missing incident fields, control characters in incident name.
2. Unit: `githubStatusConfig` for unset, `off`, `0`, URL, invalid value, GHES host.
3. Unit: monitor cadence with fake timers: 10 min interval, 15 min backoff, `checkNow` limit of one per 60 s, `stop()` clears timers.
4. PTY with a local `node:http` fixture server: the view header shows the incident name; the badge turns red; after the fixture resolves the incident, a resolved entry appears.
5. `npm run test:efficiency`: request counts unchanged (status fetch is outside acquisition).

## Verification

```bash
npm run lint && node --check index.mjs && npm test && npm run test:efficiency && npm run test:pty
```

## Acceptance

- [x] Automated checks above pass; no test reaches `www.githubstatus.com` (captures default the check off; the status PTY case uses a local server). Final gate on `82bbb13`: `npm run lint` 0, `node --check index.mjs` 0, `npm test` 1,100/1,100, `npm run test:efficiency` 9/9, `npm run test:pty` 264 pass, 0 fail, 1 skipped (the existing env-gated 0.15.2 baseline reproduction, which needs GH_GLANCE_BASELINE_ENTRY).
- [x] Live endpoint (replaces the manual check, 2026-11-02): one read-only probe of `https://www.githubstatus.com/api/v2/summary.json` through `fetchGitHubStatus` returned `ok` with all six tracked component names matched, the header `GitHub status: All systems operational`, and `not-modified` on revalidation with the returned ETag. The off reason is covered by the unit tests and the PTY header assertion. The incident field shape is still inferred (no live incident on 2026-11-02); the parser tolerates missing fields and the fixtures cover each.
- [x] Simplify pass and independent review done; findings resolved (see the notes file).
- [x] Owner authorized continuation through all phases (2026-11-02). Release is separate and follows `docs/release/release-playbook.md`.

## Handoff (2026-11-02)

- Done: githubstatus.com source, `GH_GLANCE_GITHUB_STATUS`, capture isolation, docs. Commits `3c6e4ff`, `7a5f875`.
- Final gate on `82bbb13`: `npm run lint` 0, `node --check index.mjs` 0, `npm test` 1,100/1,100, `npm run test:efficiency` 9/9, `npm run test:pty` 264 pass, 0 fail, 1 skipped (the existing env-gated 0.15.2 baseline reproduction, which needs GH_GLANCE_BASELINE_ENTRY).
- Spawner sweep and deviations: [`../2026-11-02-notifications-section-notes.md`](../2026-11-02-notifications-section-notes.md).
- Pending: none. Merged into local `develop`; no push, no release.
