# Live staleness evidence, 2026-09-23

Observations from the user's macOS host. Times are CEST unless marked `Z`. The live acquisition lock and store were not changed. `--doctor --probe` used the quota governor and may have changed its ledger; the direct `gh` check made an API request. The isolated reproduction used a temporary directory and removed it afterwards.

## Running processes and version

- `git status --short --branch`: `## develop...origin/develop`; unrelated untracked `.agents/skills/macos-rules/` was already present.
- `git log -1 --oneline`: `f3f604e`; `node index.mjs --version`: `0.15.1`; installed `gh-glance --doctor`: `0.15.1`; `cmp -s index.mjs /Users/juan/.nvm/versions/node/v24.21.0/lib/node_modules/gh-glance/index.mjs` exited 0.
- `ps` and `lsof -d cwd` found live `gh-glance` PIDs 27627 (`sutura`), 37103 (`spoken-letter`), 38587 (`chapa`), 44909 (`archy`), 34069 (`cirujano`), and 88513 (`gh-glance`). The first five began between September 17 and September 22; the sixth began at 11:25 on September 23.

## Shared acquisition stop

- `stat` at about 11:32: `~/Library/Application Support/gh-glance/coordination-v2/acquisition.json.lock` was 0 bytes, mode 0600, last modified 07:54:59. `acquisition.json` was last modified 07:54:54.
- `lsof` on that exact lock path returned no open file. A later check still found the same empty lock.
- `df -h /Users/juan` showed 31 GiB available at inspection time (97% used). It does not show how much space was available when the lock was created.
- The saved acquisition metadata contained 36 queries and 20 subscriptions from the five older live PIDs. All 15 claims were `started:false`; 18 queries had a `coordination` hold. Subscription expiry times were about 07:55. The new `gh-glance` process had no subscription in this saved state.
- At about 11:32, installed `gh-glance --doctor --probe` reported verified `github.com: juan294`, governor `core 4584 remaining, 1000 reserved` and `graphql 4604 remaining, 1000 reserved`; the budgets had no block. It reported acquisition `status healthy`, `active queries 0`, `subscribers 0`, because those saved subscriptions were expired.
- At about 11:54, the quota ledger continued to update through separate files: core 3830/5000 and GraphQL 4519/5000, with no resource block. These values changed during other concurrent GitHub activity and are a point-in-time observation, not a capacity forecast.
- `gh run list --repo juan294/sutura --limit 1 --json status,createdAt` succeeded and returned a completed run created at `2026-09-23T09:39:24Z`.

## Older claims in the saved state

| Repository / resource | Last source success (UTC) | Claim created (UTC) | Claim state at the 07:54 freeze |
| --- | --- | --- | --- |
| `juan294/archy` / Actions | `2026-09-22T17:37:38.047Z` | `2026-09-22T17:37:43.144Z` | PID 44909, `started:false`, lease until `2026-09-23T05:55:35.878Z` |
| `juan294/sutura` / Actions | `2026-09-22T22:36:15.958Z` | `2026-09-22T22:36:46.037Z` | PID 27627, `started:false`, lease until `2026-09-23T05:55:37.959Z` |

The saved state does not record why these claims never entered transport. These gaps began before the empty acquisition lock appeared.

## Isolated reproduction

Using `createAcquisitionEngine` with a new temporary `XDG_CONFIG_HOME`, create an empty acquisition lock, set its modification time to 60 seconds ago, then call `recordMetrics({observerCalls:1})`:

```json
{"lockAgeSeconds":60,"lockBytes":0,"operation":"recordMetrics","ok":false,"reason":"busy"}
```

The command exited 0 and removed its temporary directory. It did not access or modify the user's live acquisition store.
