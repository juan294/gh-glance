# Phase 4: make coordination visible and prove the terminal behavior

> Parent: [`../2026-08-18-prevent-api-exhaustion-and-clarify-refresh-status.md`](../2026-08-18-prevent-api-exhaustion-and-clarify-refresh-status.md)
> Depends on: Phases 1 through 3
> Batch eligibility: no

## Objective

Replace the ambiguous `Fetching throttled Ns` footer with a truthful active-tab
state. Add end-to-end 12-pane evidence for safety, fairness, reset recovery,
cache preservation, layout, and motion.

## Source changes

### Pure status model (`index.mjs:3685-3718`)

Add a pure resolver. Its inputs are active-tab state, not process-wide booleans:

```text
refreshStatus({
    widthMode, remoteSetup, visibleLoading, visibleInFlight,
    automaticStatusVisible, governorDecision, activeError,
    securityIncomplete, screenReader,
})
```

Return:

```text
{kind, glyphKind, label, tone, animate, detailKind}
```

Pin exact states and precedence:

```text
width mode
Setup    -> · Setup
Checking -> spinner Checking
Paused   -> ‖ Paused
Waiting  -> · Waiting
Failed   -> ! Failed
Limited  -> ? Limited
Watching -> · Watching
```

`Limited` means one or more Security sources could not be observed. It does not
claim that all Security data is blind.

Select every marker through one width-1 glyph table. Use the displayed Unicode
markers in the normal/Unicode profiles and `.`, `|`, `!`, and `?` equivalents
in the ASCII profile. Checking uses the existing spinner and its existing
motion-disabled resting glyph. Text labels and the 12-cell width do not change
between icon profiles.

Only admitted startup/manual Checking animates. Adapted automatic Checking is
static. Ordinary healthy floor-rate automatic polls remain Watching to preserve
the existing quiet redraw contract. A request following a visible Wait/Pause
can show static Checking so the user sees that work began.

### StatusBar and layout (`index.mjs:3858-3988`)

Replace the `fetching` boolean and `throttle` string props with the semantic
status and governor detail. Keep the 12-cell left reservation.

Add a pure `statusBarLayout()` that receives `cols`, interactivity, available
hints, status, detail, and version. Select detail variants in this order:

```text
next 08:42 -> 08:42 -> omitted
reset 08:41 -> 08:41 -> omitted
probing -> omitted
```

Allocation order is:

```text
left status
Refresh and Quit
detail
Move/Open/Width hints that apply
version
```

At 80, 60, and 45 columns, preserve the longest variant that fits. At the
24-column minimum, omit detail before `r` or `q`. Width mode continues to own
the whole bar. Do not write into the blank physical guard row.

Remove `throttled Ns`. Do not use `API-safe`: it overstates a guarantee that
unrelated consumers can invalidate. `next HH:MM` refers only to one current
grant's `notBefore`; it is not a promise about later polls.

### Per-tab visible state (`index.mjs:4142-4150`, `index.mjs:4670-4815`)

Store pending/governor status per tab. Set Checking only after reservation start
and clear it in `finally`. A denied grant stays Waiting or Paused and never
starts the spinner.

Rate-limit failures map to shared Paused after the governor block is written;
the body retains the actionable GitHub error. Other active-tab failures map to
Failed. Security incomplete maps to Limited after request states settle.

For `INK_SCREEN_READER=true`, do not perform state writes for routine adapted
automatic Checking. Retain visible Setup, startup/manual Checking, Waiting,
Paused, Failed, Limited, stale, and error transitions.

### Spinner (`index.mjs:4951-4990`)

Preserve the manual-refresh animation fix. Do not add Waiting, Paused, or
routine automatic checks to the 200 ms timer. A failed/denied request must stop
motion immediately.

### Freshness (`index.mjs:5047-5061`)

Use:

```text
baseDeadline = lastOk + max(30s, runtime.refreshMs * 6)
if Waiting has a valid current-epoch grant:
    staleDeadline = max(baseDeadline, grant.notBefore + GH_TIMEOUT_MS)
else:
    staleDeadline = baseDeadline
```

This prevents a known pause or unknown coordinator from making old cache data
look indefinitely current.

### Footer parser (`test/pty/capture.mjs:35-43`)

Recognize the selected status vocabulary without matching body rows. Update
synthetic capture replay tests at `test/pty/capture.test.mjs:14-70` so footer
accumulation and the blank guard row still fail correctly.

Add an opt-in animation capture option. The default harness continues to set
`GH_GLANCE_NO_ANIMATION=1`; focused motion tests may omit it. Use completed-only
Actions fixtures so an in-progress workflow row cannot create false spinner
evidence.

## PTY and multi-process acceptance

### New `test/pty/governor.test.mjs`

Run 12 real application processes with one shared fixture account/host. Pure
governor tests use injected clocks; PTY reset cases use near-real reset offsets
and bounded real waits so the app and fixture observe the same clock. Cover:

1. **Startup:** one budget probe, active-only phased fetches, no all-tab burst,
   and eventual active progress for every pane.
2. **Open pacing:** shared fixture debits remain outside the hard reserve for
   core and GraphQL across mixed active tabs.
3. **Manual:** one `r` creates one highest-priority intent; it waits safely,
   then starts exactly one request. Repeated keys do not stack.
4. **Exhaustion:** core zero produces Paused/Waiting and zero REST data calls.
5. **Resource isolation:** switch to Issues while core is held; GraphQL checks
   and the selected footer changes independently.
6. **Reset:** one fresh probe, new epoch, phased active resume, and no retry herd.
7. **External burn:** a fixture-side spend burst reduces or pauses later grants
   without crossing the local reserve.
8. **Crash:** terminate probe and reservation owners and prove safe recovery.

### Status-specific captures

- Delayed startup shows animated Checking, then Watching.
- Healthy settled automatic polling performs repeated calls without permanent
  footer motion or routine floor-rate Checking.
- Adapted automatic polling shows static Checking only for an admitted call,
  then returns to Watching.
- A future grant shows Waiting with `next HH:MM` and no spinner.
- A reserve/reset hold shows Paused with `reset HH:MM` and no data calls.
- Corrupt, locked, or unwritable governor state shows Paused with an actionable
  coordination error and no data calls.
- Manual refresh animates only after admission, not while waiting.
- Non-budget failure shows Failed and stops motion.
- Incomplete Security visibility shows Limited and preserves known rows/`?`.
- Cached rows, live rate-limit error, Paused, and stale age coexist.
- Switching tabs reads that tab's own pending/in-flight/freshness state.

### Layout and accessibility

At 80, 60, 45, and 24 columns assert:

- widest rendered row does not exceed the pane;
- at most one status line exists;
- the guard row remains blank;
- Refresh and Quit remain usable;
- detail uses the deterministic variant or is omitted;
- no-color and no-animation modes remain understandable;
- `GH_GLANCE_ICONS=ascii` keeps width-1 markers and the same labels;
- linear screen-reader output omits routine automatic Checking but retains all
  user/action/error/hold states.

## Automated success criteria

- The real 12-pane fixture never consumes the configured reserve through
  gh-glance grants.
- Every pane receives fair active progress while capacity exists.
- Core/GraphQL isolation, startup/reset spreading, crash recovery, and manual
  safety are proven in executable tests.
- The footer shows no false Checking state and no permanent motion.
- Existing terminal lifecycle, alternate-screen cleanup, signal, and narrow
  geometry tests remain green.
- Run sequentially:

  ```bash
  npm run lint
  npm test
  node --check index.mjs
  npm run test:pty
  git diff --check
  ```

## Manual success criteria

Use the real terminal with 12 panes for 20 minutes and across a reset. Confirm
the status words match observed requests, no pane looks stale without an
explanation, active checks make progress, and there is no continuous footer
animation.

## Stop condition

Stop after the complete runtime and terminal acceptance matrix passes. Do not
write the ADR or final user documentation until Phase 5.
