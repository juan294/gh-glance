# 2. Own the terminal lifecycle; adopt Ink's other primitives only where they add something

Date: 2026-08-03
Status: Accepted
Closes: [#36](https://github.com/juan294/gh-glance/issues/36) (FE-S1, FE-S2, AR-M1, AR-L4)

## Context

FE-S2 recorded that four Ink 7 primitives are reimplemented by hand and none
adopted, because `render()` is called with no options at all:
`alternateScreen`, `useWindowSize`, `useAnimation`, `incrementalRendering`. Its
argument was that owning the alternate screen outside Ink's lifecycle is
*"precisely why a crash frame gets erased and why `process.exit` can strand
terminal state"* — the root cause behind FE-H1 and FE-H2.

FE-S1 argued that `App` concentrates all state, all effects and all layout, and
that this is why the behavioural findings were hard to see.

Both were written before v0.2.0 and #41 shipped. The ground has moved.

## Decision

Adopted: **AR-M1** (fetchers on the `TABS` registry), **AR-L4** (semantic colour
constants), and the layout half of **FE-S1** (`useTerminalSize`).

Not adopted: **Ink's `alternateScreen`**, **`useWindowSize`**, **`useAnimation`**,
and the polling half of **FE-S1**.

## Why the four adoptions

- **AR-M1.** `CONTRIBUTING.md` invites "more tabs" as the first contribution and
  points at `TABS` as the seam. It was not one: the fetcher was resolved by an
  if/else chain 170 lines away, so a contributor adding an entry got headers and
  no data. Each tab now carries its own `fetch` on the descriptor.
- **AR-L4.** 28 inline colour literals across six values meant the meaning of a
  colour was carried only by repetition. `OK`/`BAD`/`ATTENTION`/`INERT` name it.
  `INERT` and `BORDER_COLOR` are the same value and stay separate names on
  purpose — one is chrome that should recede, the other is de-emphasised
  content, and merging them means the next person retuning the frame silently
  restyles every skipped run.
- **`useTerminalSize`.** A genuine seam: nothing about resize handling touches
  the fetch lifecycle. `bodyRows` deliberately stayed in `App`, because it
  depends on the active tab's error and note count — moving it would mean the
  hook knowing about tabs, which is not a separation.

## Why Ink's `alternateScreen` is not adopted

FE-S2's case for it was that it would fix FE-H1 and FE-H2 by giving Ink control
of teardown ordering. **Both are already fixed**, and #41 — found after FE-S2
was written — was fixed by taking *explicit* control of that ordering:
unmounting Ink before restoring the primary buffer.

Adopting `alternateScreen` now would hand that ordering back to Ink and re-open
the exact question #41 answered. The current arrangement is verified by the pty
harness on both the signal path and the clean-quit path; the alternative is
verified by nothing. Replacing a tested mechanism with an untested one to gain
a property the tested one already has is not an improvement.

Two further specifics, both recorded in FE-S2's own regression note:

- Ink enters the alternate screen *inside* `render()`, later than the current
  explicit write, so the launching shell prompt scrolls out at a different
  moment.
- `alternateScreen` is conditioned on `interactive && stdout.isTTY` and silently
  no-ops otherwise.

## Why `useWindowSize` and `useAnimation` are not adopted

- **`useWindowSize`** does not apply the 0-or-undefined fallback that
  `usableSize` exists for. Pty wrappers and a terminal mid-resize report both,
  and taking either literally collapses the table. Adopting it means wrapping it
  in the guard it lacks — the same code, plus a dependency on someone else's
  behaviour.
- **`useAnimation`** consolidates multiple animated components onto one timer.
  There is one animation here. The benefit is zero and the coupling is real.

## Why the polling half of FE-S1 is not extracted

`useTabData` is the extraction FE-S1 most wanted, and it is the one with the
least margin. The poll effect's empty dependency array is load-bearing: every
value it needs is read through a ref precisely so the interval is created once,
and adding dependencies rebuilds it on every tab keypress and every resize,
cancelling in-flight requests. `CONTRIBUTING.md` names this as one of three
invariants a contributor must not break.

FE-S1's own note says the comments at those sites document non-obvious
invariants and that *"a mechanical extraction destroys"* them, and that it
should happen *"after the behavioural fixes, not as a vehicle for them"*. Since
that was written the same function has absorbed selection, scrolling, `--repo`
threading and the #41 ordering fix. The right time to extract it is when it is
next changed for a behavioural reason, not on its own.

## Consequences

- Terminal lifecycle stays explicit and stays this project's responsibility. Any
  future move to Ink's `alternateScreen` must clear the pty harness's
  primary-buffer assertions first.
- `TABS` is now a real extension point, matching what `CONTRIBUTING.md` claims.
- `App` is smaller but still holds the fetch lifecycle. That is recorded here so
  the next reader knows it was considered rather than overlooked.
- If Ink later applies a 0-or-undefined guard in `useWindowSize`, that half of
  this decision is worth revisiting.
