#!/bin/sh
# Capture a real run of index.mjs under a pty.
#
#   run.sh <cols> <rows> <outfile> [signal] [settle-seconds] [stdin-script] [args]
#
# `script(1)` is used rather than node-pty because a native dependency would
# contradict the no-build-step, no-framework stance in CONTRIBUTING.md. The cost
# is that the two platforms are mutually incompatible, so both forms live here:
# development is darwin (BSD), CI is ubuntu-latest (GNU util-linux).
#
# If `signal` is the literal string "none", the app is run in the FOREGROUND and
# is expected to quit itself -- that is the only way stdin stays an interactive
# tty, which the key handlers require (ink/build/components/App.js:121). With any
# other value the app is backgrounded and killed with that signal, which detaches
# stdin and leaves the app non-interactive. Both modes are wanted; they test
# different things.
set -u

COLS="${1:?usage: run.sh <cols> <rows> <outfile> [signal] [settle] [stdin-script]}"
ROWS="${2:?}"
OUT="${3:?}"
SIGNAL="${4:-TERM}"
SETTLE="${5:-4}"
STDIN_SCRIPT="${6:-}"
# Deliberately word-split where it is used below: this is a flag vector, not one
# argument. Callers pass simple flags only -- the argv the app receives is
# exactly what the routing tests assert on.
APP_ARGS="${7:-}"
CAPTURE_PID=""
STDIN_PID=""
PIPE_ROOT=""

terminate_tree() {
  for child in $(pgrep -P "$1" 2>/dev/null); do
    terminate_tree "$child"
  done
  kill -TERM "$1" 2>/dev/null || true
}

cleanup_capture() {
  if [ -n "$CAPTURE_PID" ]; then
    terminate_tree "$CAPTURE_PID"
  fi
  if [ -n "$STDIN_PID" ]; then
    terminate_tree "$STDIN_PID"
  fi
  if [ -n "$PIPE_ROOT" ]; then
    rm -f "$PIPE_ROOT/producer.pid"
    rmdir "$PIPE_ROOT" 2>/dev/null || true
  fi
}
trap cleanup_capture EXIT HUP INT TERM

HERE=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
REPO=$(CDPATH= cd -- "$HERE/../.." && pwd)
LOG="${OUT}.calls"
: > "$LOG"

cd "$REPO" || exit 1

# GH_GLANCE_NO_ANIMATION removes the 100ms spinner, the single largest source of
# frame-to-frame variance (index.mjs:120).
# GH_GLANCE_ICONS=unicode keeps the capture ASCII: the default glyphs are Nerd
# Font private-use codepoints, which make both the source and any capture
# containing them register as binary to grep (index.mjs:708).
# CI and CONTINUOUS_INTEGRATION are BOTH unset because is-in-ci checks both
# (node_modules/is-in-ci/index.js:3-5), and ink in CI mode defers every write to
# unmount -- measured 992 bytes and zero synchronized-update pairs, versus 4,348
# bytes and three pairs interactively. Unsetting them makes the harness exercise
# the path real users get, including when it runs inside GitHub Actions.
ENV_PREFIX="export PATH=\"$HERE/fixtures:\$PATH\";
  export GH_GLANCE_FIXTURE_LOG=\"$LOG\";
  export GH_GLANCE_NO_ANIMATION=1;
  export GH_GLANCE_ICONS=unicode;"

# A pty has no controlling terminal here, so it defaults to 0x0 -- exactly the
# input usableSize() guards (index.mjs:244-246). COLUMNS/LINES are ignored
# because Node reads TIOCGWINSZ, so stty is the only mechanism that works.
# The leading newline is load-bearing: ink's final frame ends without a
# trailing newline, so without it EXITCODE glues onto the last visible line
# instead of occupying its own. capture.mjs already strips that with an
# end-anchored regex, but GNU script(1) trails its own "Script done on..."
# banner after the marker, which breaks the anchor and only surfaced once a
# status bar right-aligned real content flush to the frame's edge, leaving no
# slack for the glued text to hide in. Guaranteeing the newline here makes the
# marker always land on its own line, on both platforms, regardless of how
# close to the edge the app's own content gets.
if [ "$SIGNAL" = "none" ]; then
  INNER="$ENV_PREFIX
    stty cols $COLS rows $ROWS;
    env -u CI -u CONTINUOUS_INTEGRATION node index.mjs $APP_ARGS;
    printf '\nEXITCODE=%s\n' \"\$?\""
else
  INNER="$ENV_PREFIX
    stty cols $COLS rows $ROWS;
    env -u CI -u CONTINUOUS_INTEGRATION node index.mjs $APP_ARGS &
    p=\$!;
    sleep $SETTLE;
    kill -$SIGNAL \$p 2>/dev/null;
    wait \$p;
    printf '\nEXITCODE=%s\n' \"\$?\""
fi

# Give the stdin producer and script process separate roots. A background shell
# pipeline exposes only its final PID through `$!`; when a capture timed out that
# left the producer (and any sleep feeding it) reparented under init. The first
# shell records its own PID before exec while retaining the pipe input that BSD
# script(1) requires.
if [ -n "$STDIN_SCRIPT" ]; then
  PIPE_ROOT=$(mktemp -d "${TMPDIR:-/tmp}/gh-glance-pty-pipe.XXXXXX") || exit 1
fi

# The exit code is echoed into the capture rather than read from script(1),
# because BSD propagates the child's status automatically while GNU only does so
# with -e. Reading it in-band is identical on both.
if script --version 2>/dev/null | grep -q util-linux; then
  # GNU: command is one shell string via -c, outfile is the last positional,
  # and -e is REQUIRED for exit propagation.
  GNU_FLUSH_FLAG=""
  if [ "${GH_GLANCE_CAPTURE_LIVE_FLUSH:-}" = "1" ]; then
    GNU_FLUSH_FLAG="-f"
  fi
  if [ -n "$STDIN_SCRIPT" ]; then
    GH_GLANCE_CAPTURE_OUT="$OUT" GH_GLANCE_CAPTURE_STDIN="$STDIN_SCRIPT" \
      GH_GLANCE_CAPTURE_PID_FILE="$PIPE_ROOT/producer.pid" \
      sh -c 'printf "%s\n" "$$" > "$GH_GLANCE_CAPTURE_PID_FILE"; exec sh -c "$GH_GLANCE_CAPTURE_STDIN"' | \
      script -q -e $GNU_FLUSH_FLAG -c "$INNER" "$OUT" >/dev/null 2>&1 &
  else
    script -q -e $GNU_FLUSH_FLAG -c "$INNER" "$OUT" </dev/null >/dev/null 2>&1 &
  fi
else
  # BSD: outfile is the FIRST positional and the command is an argv vector.
  # </dev/null is mandatory: with a socket stdin, script aborts with
  # "tcgetattr/ioctl: Operation not supported on socket" and leaves a zero-byte
  # file with rc=1 -- indistinguishable from "the app never rendered" unless the
  # caller checks, which is why capture.mjs treats an empty file as an error.
  BSD_FLUSH_FLAG=""
  if [ "${GH_GLANCE_CAPTURE_LIVE_FLUSH:-}" = "1" ]; then
    BSD_FLUSH_FLAG="-F"
  fi
  if [ -n "$STDIN_SCRIPT" ]; then
    GH_GLANCE_CAPTURE_OUT="$OUT" GH_GLANCE_CAPTURE_STDIN="$STDIN_SCRIPT" \
      GH_GLANCE_CAPTURE_PID_FILE="$PIPE_ROOT/producer.pid" \
      sh -c 'printf "%s\n" "$$" > "$GH_GLANCE_CAPTURE_PID_FILE"; exec sh -c "$GH_GLANCE_CAPTURE_STDIN"' | \
      script -q $BSD_FLUSH_FLAG "$OUT" /bin/sh -c "$INNER" >/dev/null 2>&1 &
  else
    script -q $BSD_FLUSH_FLAG "$OUT" /bin/sh -c "$INNER" </dev/null >/dev/null 2>&1 &
  fi
fi

CAPTURE_PID=$!
if [ -n "$STDIN_SCRIPT" ]; then
  while [ ! -s "$PIPE_ROOT/producer.pid" ] && kill -0 "$CAPTURE_PID" 2>/dev/null; do
    sleep .01
  done
  if [ -s "$PIPE_ROOT/producer.pid" ]; then
    STDIN_PID=$(sed -n '1p' "$PIPE_ROOT/producer.pid")
  fi
fi
wait "$CAPTURE_PID"
CAPTURE_STATUS=$?
CAPTURE_PID=""
if [ -n "$STDIN_PID" ]; then
  terminate_tree "$STDIN_PID"
  wait "$STDIN_PID" 2>/dev/null || true
  STDIN_PID=""
fi
[ "$CAPTURE_STATUS" -eq 0 ] || exit "$CAPTURE_STATUS"

[ -s "$OUT" ] || { echo "run.sh: capture is empty ($OUT)" >&2; exit 1; }
exit 0
