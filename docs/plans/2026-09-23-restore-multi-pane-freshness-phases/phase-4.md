# Phase 4: truthful doctor and actionable stale status

Depends on: Phase 3. Stops after local verification and review.

## Deliverable

Give doctor two independent acquisition results: metadata/snapshot integrity and known lock-path blockers. Plain `--doctor` reads local files without acquiring, deleting, or repairing a lock. It distinguishes a young contended owner, a confirmed live/unknown owner, an aged empty/partial orphan, an obviously unwritable directory, and corrupt metadata. It reports the elapsed lock age and a sanitized reason; `healthy` means no blocker was observed, not that a future write is guaranteed. `--doctor --probe` keeps quota and acquisition findings separate. [Current metadata-only read](../../../index.mjs:12832), [hard-coded healthy](../../../index.mjs:12370), [doctor assembly](../../../index.mjs:9993)

Keep an acquisition/pending failure reason until a validated snapshot or completed cleanup clears it. A successful budget observation alone cannot erase an acquisition error. Render one stale label with its age and a short cause when width permits; remove the `Stale stale` duplication. Use truthful larger ages (`100h+` or compact days) instead of capping all ages at 99h59m. At the 24-column minimum, preserve mandatory `r` and `q` hints and put the full sanitized reason in the existing notice line. No cache or lock recovery event advances `lastOk`. [Current decision overwrite](../../../index.mjs:15788), [status precedence](../../../index.mjs:14659), [layout](../../../index.mjs:14740), [age cap](../../../index.mjs:17404)

```text
diagnostic = { metadata: healthy|corrupt|unavailable,
               lock: unobstructed|busy|orphaned|unwritable,
               age, reason }
visibleStatus = select(auth/primary/secondary hold,
                       acquisition/pending hold,
                       source age, last successful observation)
display one compact stale age; retain cause until its own state clears
```

## Tests first

Add `test/doctor.test.mjs` cases for a valid store plus old empty/partial lock (unavailable, not healthy), young valid owner (busy), unreadable directory, and corrupt metadata. Assert plain doctor makes no API call, never changes the lock, and redacts private query/credential identifiers. Use the existing corrupt-metadata case as the pattern. [Existing doctor test](../../../test/doctor.test.mjs:275)

Add unit layout and PTY cases for the research screenshot state, an old lock followed by recovery, a long unstarted claim, and a failed unrelated observer that later recovers. Assert the visible cause persists across a budget update, `Stale stale` never appears, age can exceed 100 hours without freezing, and 24-/80-column frames retain one footer line and mandatory keys. Do not weaken current geometry/terminal restore assertions. [Existing PTY notice tests](../../../test/pty/status.test.mjs:673), [status layout](../../../index.mjs:14710)

Update README troubleshooting and CHANGELOG with the actual recovery/status contract; record the acquisition lock rule in ADR 0003 and the claim rule in ADR 0004. Documentation must not describe a live proof before Phase 5 has one. [Current troubleshooting](../../../README.md:985), [ADRs](../../decisions/0003-file-backed-api-coordination.md:1)

## Automated success

- Doctor refuses to call a blocked acquisition store healthy, while a brief live lock is not labeled orphaned.
- UI shows source age and the relevant hold without duplicate words, false freshness, overflow, or lost key hints.
- The lock and doctor inspection are read-only until normal runtime recovery takes ownership.
- Run the plan's sequential local verification gate.

## Manual success and limits

Review 24-column and normal-width PTY captures; inspect doctor output for a sanitized, actionable reason. This is a visual check on local fixtures, not a claim that the currently installed binary changed. [Current renderer](../../../index.mjs:14930)
