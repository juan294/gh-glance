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
if [ "$SIGNAL" = "none" ]; then
  INNER="$ENV_PREFIX
    stty cols $COLS rows $ROWS;
    env -u CI -u CONTINUOUS_INTEGRATION node index.mjs $APP_ARGS;
    echo \"EXITCODE=\$?\""
else
  INNER="$ENV_PREFIX
    stty cols $COLS rows $ROWS;
    env -u CI -u CONTINUOUS_INTEGRATION node index.mjs $APP_ARGS &
    p=\$!;
    sleep $SETTLE;
    kill -$SIGNAL \$p 2>/dev/null;
    wait \$p;
    echo \"EXITCODE=\$?\""
fi

# The exit code is echoed into the capture rather than read from script(1),
# because BSD propagates the child's status automatically while GNU only does so
# with -e. Reading it in-band is identical on both.
if script --version 2>/dev/null | grep -q util-linux; then
  # GNU: command is one shell string via -c, outfile is the last positional,
  # and -e is REQUIRED for exit propagation.
  if [ -n "$STDIN_SCRIPT" ]; then
    printf '%s' "$STDIN_SCRIPT" | sh | script -q -e -c "$INNER" "$OUT" >/dev/null 2>&1
  else
    script -q -e -c "$INNER" "$OUT" </dev/null >/dev/null 2>&1
  fi
else
  # BSD: outfile is the FIRST positional and the command is an argv vector.
  # </dev/null is mandatory: with a socket stdin, script aborts with
  # "tcgetattr/ioctl: Operation not supported on socket" and leaves a zero-byte
  # file with rc=1 -- indistinguishable from "the app never rendered" unless the
  # caller checks, which is why capture.mjs treats an empty file as an error.
  if [ -n "$STDIN_SCRIPT" ]; then
    printf '%s' "$STDIN_SCRIPT" | sh | script -q "$OUT" /bin/sh -c "$INNER" >/dev/null 2>&1
  else
    script -q "$OUT" /bin/sh -c "$INNER" </dev/null >/dev/null 2>&1
  fi
fi

[ -s "$OUT" ] || { echo "run.sh: capture is empty ($OUT)" >&2; exit 1; }
exit 0
