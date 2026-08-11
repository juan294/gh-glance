# Phase 2 — Add the versioned last-known-good cache

Not batch-eligible. Depends on Phase 1 and edits `index.mjs`.

## Changes

### `index.mjs` — storage model

- Add `dashboardCachePath()` beside `widthPreferencesPath()` and derive the same
  private application directory.
- Add a versioned cache document keyed by a deterministic target identity:
  explicit `--repo`, then `GH_REPO`, otherwise host plus current working
  directory.
- Decode each tab independently. Accept only arrays, finite non-negative
  timestamps, record metadata, string notes, and a boolean blind marker.
- Serialize a bounded set of recent targets so multi-repository use works
  without unbounded file growth.
- Save with same-directory temporary file, `0700` parent, `0600` file, atomic
  rename, and exact-temp cleanup on failure.
- Make all read/write errors nonfatal.

### `index.mjs` — App hydration and writes

- Load the current target's entry in the lazy initializers for `data`, `meta`,
  Security notes/blind state, and the last-success ref.
- Keep `errors` and `loading` live-only. A cached frame therefore continues to
  show a new rate-limit error and a fetch-in-progress state honestly.
- After a successful parse and state commit, merge that tab plus its success
  timestamp into the in-memory cache snapshot and schedule one coalesced atomic
  write.
- Do not schedule a write on an identical raw payload, failure, abort, or
  backoff skip.
- Flush a pending latest snapshot during unmount without letting a cache error
  affect terminal teardown.

### `test/cache.test.mjs`

- Missing/corrupt/future cache returns no entry and no throw.
- Valid data round-trips by target and tab.
- Invalid tabs are ignored independently.
- Different explicit targets and inferred-directory targets do not cross-read.
- Repeated saves atomically replace the file and leave no temp artifact.
- Directory/file permissions are private on POSIX.
- Write failure is nonfatal and preserves the caller's in-memory snapshot.

## Verification

- `npm run lint`
- `node --check index.mjs`
- `npm test`

