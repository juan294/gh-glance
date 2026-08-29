# Phase 3: keep internals out of the pane

> Parent: [`../2026-08-29-conditional-polling-and-calm-status.md`](../2026-08-29-conditional-polling-and-calm-status.md)
> Depends on: Phase 1
> Batch eligibility: no

## Objective

Two reported screenshots show text that was written for a maintainer:
`API coordination unavailable (unknown-scope); retrying safely`, and
`Unexpected end of JSON input`. Neither tells the user anything they can act on,
and the second stands where the data should be.

## Source changes

### 1. A transient verdict for unusable subprocess output

`Unexpected end of JSON input` is `JSON.parse("")` --- empty stdout from `gh`,
which happens when the subprocess is SIGKILLed at `GH_TIMEOUT_MS`
(`index.mjs:133`) or dies mid-write. `classify` (`index.mjs:406`) has no pattern
for it, so it lands in `other`, and `other` is passed through verbatim by
`formatTabError` (`index.mjs:498`).

That passthrough is the right rule for an unrecognised **`gh`** message and the
comment at `index.mjs:415-428` argues it well. It is the wrong rule for the
app's own exceptions. So `other` is left exactly as it is --- two tests pin it
(`test/unit.test.mjs:281-282`, `test/pty/status.test.mjs:508`) --- and a new
verdict is added ahead of it.

```text
classify gains one branch, ordered *last* before "other":

  if isUnusableOutput(err): return "unusable-output"

  isUnusableOutput := the failure is our own parse of an empty or truncated
                      payload, not a message gh produced

The blind Security path is the precedent to copy (index.mjs:5732-5739,
7140-7153): a failed observation that keeps last-good rows, does not advance
freshness, does not poison the raw comparison, and does not paint an error row.

  transition kind "unusable" behaves as "blind" does:
      keep data, keep meta
      do NOT write lastOkRef        # freshness must keep ageing honestly
      do NOT write rawRef           # so the retry is parsed, not fast-pathed
      clear the error row
      retry on the very next tick   # no FAILURE_LADDER entry, as with "other"
```

**The `VERDICT_REMEDY` / `FAILURE_LADDER` invariant must be updated
deliberately.** `test/unit.test.mjs:2284-2297` asserts

```text
keys(VERDICT_REMEDY) minus "rate-limited"  ==  keys(FAILURE_LADDER)
"other" not in VERDICT_REMEDY
```

`unusable-output` belongs in neither table --- no remedy (there is nothing for
the user to do) and no ladder (it must retry immediately, like `other`). The
invariant test is extended to assert both exclusions explicitly, so a future
verdict cannot be added to one table and forgotten in the other.

### 2. Coordination notices become user-facing, and transient ones stay silent

`pauseCoordination` (`index.mjs:6959`) interpolates the governor's raw reason
into the banner (`index.mjs:8085`). The reachable set is large and entirely
internal: `unknown-scope`, `block-unpublished`, `unavailable`, plus `corrupt`,
`busy`, `stale`, `unwritable`, `unknown-host` from the storage layer and
`budget-unknown`, `budget-future`, `budget-stale`, `budget-reset`,
`reservations-invalid`, `external-factor-invalid`, `reserve`, `pacing-invalid`,
`reset`, `probe-failed` from the scheduler.

`unknown-scope` in particular is a designed startup state, not a fault: it means
`governorScopeHash` (`index.mjs:1605`) could not yet build a key from host plus
auth identity, i.e. `gh auth status` had not resolved. The 2026-08-18 plan
introduced it deliberately. It lasts a second or two and it prints a sentence
about API coordination being unavailable.

```text
two changes, both in the render path -- the governor's vocabulary is untouched:

  1. a notice is only rendered once the same coordination condition has held
     continuously for COORDINATION_NOTICE_AFTER_MS. Startup transients never
     reach the screen.

  2. the reason is translated, and the raw value is kept for --verbose/--doctor:

       unknown-scope                    -> "Confirming your GitHub login…"
       block-unpublished                -> "Holding until the rate-limit block is shared"
       busy | stale                     -> "Coordinating with your other panes"
       corrupt | unwritable | unknown-host
                                        -> "Can't coordinate API use — retrying"
       anything else                    -> "Can't coordinate API use — retrying"

       # the last row is the honest default: an unrecognised internal reason is
       # not evidence about what the user should do, exactly as VERDICT_REMEDY
       # declines to invent a remedy for "other"
```

No test pins a reason string on screen --- `test/pty/status.test.mjs:326, 340,
352` match only `/API coordination unavailable/`, and `test/governor.test.mjs:751`
asserts `coordinationError === true` without pinning text. Those three
assertions are updated to the new copy.

## Behaviour to match

- `test/pty/runtime-remediation.test.mjs:171-176` (`"a timer-driven list failure
  recovers in the same process"`) is the executable model for the new transient:
  it asserts a failure retried on the next tick and that its text is gone by the
  end. The new `unusable-output` case must satisfy the same shape, plus the
  stronger claim that the text never appeared at all.
- `test/pty/status.test.mjs:377-407` (`"incomplete Security observation preserves
  known rows"`) is the model for keeping last-good rows through a failed
  observation.

## Success criteria

### Automated

- A unit case asserts `classify` returns `unusable-output` for an empty-stdout
  parse failure and still returns `other` for
  `"dial tcp: lookup api.github.com: no such host"`.
- `test/unit.test.mjs:2284-2297` extended to assert `unusable-output` is in
  neither `VERDICT_REMEDY` nor `FAILURE_LADDER`.
- A unit case asserts the `unusable` transition returns `nextRaw === null` and
  does not advance `lastOk`.
- A PTY capture with a fixture that returns empty stdout once asserts the frame
  never contains `/JSON input/` and that the tab recovers on the next tick.
- A PTY capture asserts a sub-threshold coordination blip renders no notice, and
  a sustained one renders the translated copy.
- The three `/API coordination unavailable/` assertions updated.
- `node test/pty/readme-sample.mjs` regenerated if the block moved.
- Sequential verification passes.

### Manual

- Start a pane with `gh` briefly unauthenticated so scope resolution is slow;
  confirm no notice appears during the startup transient.
- Corrupt the governor state file while a pane runs; confirm the pane shows the
  translated sentence and `--doctor` still reports the raw reason.

## Out of scope

The governor's internal reason vocabulary --- only its presentation changes.
