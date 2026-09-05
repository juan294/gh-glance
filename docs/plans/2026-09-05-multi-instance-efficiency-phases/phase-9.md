# Phase 9: SSH clients and cross-computer sharing

Parent: [complete plan](../2026-09-05-multi-instance-efficiency.md)  
Depends on: 8. Batch eligibility: no.

## Objective and files

Let several computers subscribe to one collector without transferring GitHub credentials or starting independent API loops. Add SSH transport/client session handling within `index.mjs`; add `test/ssh-transport.test.mjs`, fixture `test/fixtures/ssh`, and `test/pty/remote-collector.test.mjs`. Extend protocol, args, doctor, browser-open and package tests. Update README/SECURITY and ADR 0005.

## Changes and pseudocode

Public syntax is `gh-glance --connect ssh:<alias> --repo [host/]owner/name`; aliases use the existing user SSH config. Restrict alias syntax to letters/digits/dot/underscore/hyphen, not starting with hyphen. More complex user/port/ProxyJump configuration belongs in SSH config. Never interpolate repository data into a remote shell command.

```text
transport = spawn('ssh', [
  '-T', '-o', 'BatchMode=yes', '-o', 'ClearAllForwardings=yes',
  '--', validatedAlias, 'gh-glance --collector-stdio'
])
handshake protocol 1 over stdio
subscribe using local-resolved explicit host/repo identity
render sanitized collector snapshots
on disconnect:
  preserve rows and their original successful observation timestamp
  mark connection hold; do not run local API fallback
  retry after 1,2,4,8,16,30 seconds plus bounded jitter
on reconnect:
  handshake new epoch, resubscribe once, request current snapshot
```

The fixed remote command is the only remote shell string. Do not disable host-key checking or install keys. Batch mode avoids interactive SSH prompts inside the dashboard. Redact/bound stderr, show a concise connection remedy, and preserve terminal lifecycle. Cancellation kills only the owned SSH child, never a shared collector. No automatic remote installation, upgrade or collector startup.

Server GitHub credentials/provider and repository allowlist govern access. Clients never forward local tokens, keys, `GH_*` values, config directories or credential hashes. Requested host/repository must match collector policy. The UI reports the configured collector/source, so remote account choice is not silently assumed to match the client machine's `gh` login. Failure diagnosis uses collector evidence and local SSH connection status.

Client receive time does not change source freshness. To handle clock skew, carry source observation timestamps plus server current time; derive a local monotonic age lower bound at receipt and increase it while disconnected. For the same or older source observation, reconnect or backward client wall-clock adjustment cannot reduce known age. A genuinely newer successful source observation may reset age, including an unchanged-content 304 with later lastSuccess. Page requests and manual refresh travel as bounded semantic messages. Browser opening uses a validated HTTPS URL on the client computer with zero GitHub API cost.

Persist each connected snapshot under collector identity plus target, with source lastSuccess, lastChanged, received age, client checkpoint time and server epoch. A cold offline restart displays cached rows as unverified/stale, using the greater of stored age and nonnegative wall-clock elapsed estimate; a backward clock cannot imply freshness. Only a new validated handshake/observation updates the source-age estimate. Chunked snapshots from phase 8 adopt atomically after complete verification.

## Automated acceptance

- `SSH-01`: groups of three and four panes in distinct config roots share one collector/query stream; client's failing fixture `gh` records zero API calls.
- `SSH-02`: alias metacharacters/options are rejected; repositories/titles cannot alter fixed SSH argv/remote command; normal SSH config alias works through the fake transport.
- `SSH-03`: broken pipe, timeout and protocol mismatch preserve rows and source age; no automatic local API fallback; reconnect attempts bounded.
- `SSH-04`: reconnect/server restart produces one subscription each, rejects buffered old epochs/generations, and does not duplicate a completed fetch.
- `SSH-05`: one client quits without stopping shared service or another client's request; owned child exits on q/SIGTERM and restores terminal.
- `SSH-06`: skew/reconnect/cold restart cannot make the same or older observation younger, while a genuinely newer lastSuccess correctly resets age; local browser opener receives only allowed URL schemes.
- `SSH-07`: diagnostics and wire capture contain no GitHub credential or private local config data.

Test the exact argv with a fake SSH executable that launches the real local bridge against real private IPC, plus separate client config roots. This exercises the full application protocol without requiring SSH server setup or remote compute. Run all parent gates sequentially.

## Manual success criteria

No real network is required for implementation acceptance. A documented activation recipe lets the user start a collector and verify their SSH alias/key/host trust; those are environment setup steps, not automatic actions or blockers to shipping the tested capability. Do not claim a real cross-device deployment was tested unless separately performed.

## Completion

- [ ] SSH transport, reconnect, age handling and client-local opening implemented.
- [ ] SSH scenarios and parent local gates passed.
- [ ] Independent compliance/quality review complete; integrated locally; stop.
