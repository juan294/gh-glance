# Durable freshness and recovery implementation notes

## Deviations

### Phase 4 advisory recovery journal clock skew

- Plan said: retained recovery diagnostics disclose current cause and retry information without blocking source publication.
- Found: a same-cause event with an earlier `at` than the previous `firstAt` produced a journal that the strict reader rejected. The installed candidate's retained Core event has this exact shape, so plain doctor reports a corrupt diagnostic journal despite a separately readable quota ledger.
- Chose: preserve a red-then-green repair on local branch `fix/recovery-journal-clock-skew` at `47d1b2b`. It clamps only the known timestamp skew on read and write, keeps all retained events and rejects other invalid fields. The branch is unmerged because the complete local gate could not pass in the managed sandbox.
- Why: deleting or overwriting the live journal would discard evidence, while leaving the writer unchanged would recreate the same invalid shape after any later event-clock rollback. The advisory repair must be fully verified before it can become a new installed candidate.

### Phase 4 cutover snapshot

- Plan said: capture a private snapshot after stopping all old panes and before migration.
- Found: Ghostty session replacement required the user to close and reopen the panes. The user completed both actions before the agent could capture an intervening quiet snapshot.
- Chose: preserve the earlier read-only, non-atomic v6 reference snapshot and record the missing quiet cutover snapshot in Phase 4 validation. Do not restore it over v7 state.
- Why: a later snapshot cannot reconstruct the exact quiet migration boundary, and representing the earlier copy as atomic would overstate its evidence.

### Phase 4 shared acquisition artifact read

- Plan said: qualify the exact installed candidate with independent source and quota monitoring after normal startup migration.
- Found: metadata replacement followed by artifact cleanup can race with a concurrent snapshot hydration in both the runtime and monitor. A live read reproduced an ENOENT for an artifact after metadata advanced.
- Chose: repair the shared read path with bounded metadata revalidation, retain failure for a missing current artifact, add a concurrency regression test, and rerun local gates before packaging a new candidate.
- Why: a monitor-only retry would conceal the same race in the running app and could leave an internal coordination hold.

### Phase 4 monitor first observation and quota clock

- Plan said: a healthy first active observation has a 60-second bound; background source freshness follows its declared cadence and overdue allowance.
- Found: the strict monitor applied 60 seconds to every first observation, including 120-second and 300-second background tabs. It also read quota using a clock captured before acquisition hydration, so a newer valid quota record could be rejected.
- Chose: retain 60 seconds for active demand, use cadence plus allowance for background demand, and validate quota against a fresh post-hydration clock.
- Why: the previous monitor could fail a valid background interval and could report quota unavailable during a concurrent valid write.

### Phase 4 subscription remap and source-read clock

- Plan said: one shared acquisition query survives repository identity discovery, and the strict report rejects genuinely future source timestamps.
- Found: a concurrent canonical query-key remap can occur after a subscription commits or after its snapshot hydrates, leaving a local first refresh on the old key. A source publication during monitor hydration can also be newer than the sample-start clock while remaining valid at read completion.
- Chose: register a cleanup owner before subscription hydration, follow the authoritative shared subscription key in setup and first refresh, and record a separate source-read completion time for validation and JSONL audit.
- Why: a committed subscription must not be orphaned by a remap, and a valid concurrent source publication must not fail the entire strict window as a future timestamp.
