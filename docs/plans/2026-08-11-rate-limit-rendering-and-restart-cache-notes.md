# Implementation notes — `2026-08-11-rate-limit-rendering-and-restart-cache.md`

## Deviations

### Phase 1

**The PTY parser now replays terminal state.**

Plan said: change existing `finalFrame` geometry assertions to prove that the
app renders one row below the terminal viewport.

Found: `finalFrame` was not a terminal screen model. It sliced bytes after the
last cursor-up, clear, or home escape. Fullscreen Ink teardown happened to emit
a complete clear/repaint, but the planned non-fullscreen frame correctly ends
as incremental line patches. The parser therefore returned one or two lines
from a healthy 23-line live screen.

Chose: replay Ink's cursor, erase, alternate-screen, synchronized-update, wrap,
and scroll controls into a bounded terminal grid. Geometry now reads the latest
complete live dashboard snapshot, and the harness retains the maximum visible
status-line count across all synchronized updates.

Why: changing only expected line counts would remove terminal geometry coverage
at the exact boundary responsible for the reported defect. Replay directly
proves the blank guard row and detects even a transient footer accumulation
that a later clean repaint would hide.
