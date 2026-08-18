// Parse a pty capture into a structured result. No assertions live here -- both
// test files share this so a parsing fix lands in one place.
//
// Two details are easy to get wrong and were both learned by getting them wrong:
//
//   1. Ink repaints without a separating newline. It emits an erase/cursor-up
//      run and then rewrites the whole frame (ink/build/log-update.js:20-57), so
//      measuring line widths over the raw capture measures several concatenated
//      frames at once and reports roughly 3x the real width.
//   2. GNU script(1) writes "Script started on ..." and "Script done on ..."
//      into the capture file even under -q. Those lines are longer than a narrow
//      terminal, so a width check that does not skip them fails on Linux only.

import { execFile, execFileSync } from "node:child_process";
import { readFileSync, existsSync, mkdtempSync, rmSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, isAbsolute, join } from "node:path";
import { tmpdir } from "node:os";

const HERE = dirname(fileURLToPath(import.meta.url));
const RUN = join(HERE, "run.sh");

const ESC = String.fromCharCode(27);
const ALT_ENTER = `${ESC}[?1049h`;
const ALT_EXIT = `${ESC}[?1049l`;
const MOUSE_1002_ENTER = `${ESC}[?1002h`;
const MOUSE_1002_EXIT = `${ESC}[?1002l`;
const MOUSE_1006_ENTER = `${ESC}[?1006h`;
const MOUSE_1006_EXIT = `${ESC}[?1006l`;

const OSC = new RegExp(`${ESC}\\][^\\x07${ESC}]*(?:\\x07|${ESC}\\\\)`, "g");
const SGR_MOUSE = new RegExp(`${ESC}\\[<[0-9]+;[0-9]+;[0-9]+[Mm]`, "g");
const CSI = new RegExp(`${ESC}\\[[0-9;?]*[A-Za-z]`, "g");
const CHARSET = new RegExp(`${ESC}[()][A-Za-z0-9]`, "g");
// Any of these can begin a repaint, so the last one marks the start of the
// final frame.
const FRAME_BOUNDARY = new RegExp(`${ESC}\\[[0-9]*A|${ESC}\\[2J|${ESC}\\[H`, "g");
const SCRIPT_BANNER = /^Script (started|done) on /;
const TAB_BAR = /1:(?:Actions|Act)/;
// StatusBar always starts at column zero with one width-1 state marker. Panel
// rows start with a border, so remote titles containing these words cannot be
// mistaken for accumulated footers.
const STATUS_LINE = /^\S (?:Setup|Checking|Paused|Waiting|Failed|Limited|Watching)(?:\s|$)/;

export function isStatusLine(line) {
  return typeof line === "string" && STATUS_LINE.test(line);
}

export function waitForAwk(path, program, attempts = 150) {
  return `i=0; while ! awk '${program} END { exit ok ? 0 : 1 }' ${path} 2>/dev/null ` +
    `&& [ $i -lt ${attempts} ]; do i=$((i + 1)); sleep .1; done; `;
}

function readCaptureResult(out, dimensions) {
  const parsed = parseCapture(readFileSync(out, "utf8"), dimensions);
  const logPath = `${out}.calls`;
  parsed.fixtureCalls = existsSync(logPath)
    ? readFileSync(logPath, "utf8").split("\n").filter(Boolean)
    : [];
  return parsed;
}

function removeCaptureArtifacts(out) {
  for (const path of [out, `${out}.calls`]) {
    if (existsSync(path)) rmSync(path, { force: true });
  }
}

function stripEscapes(text) {
  return text
    .replace(OSC, "")
    .replace(SGR_MOUSE, "")
    .replace(CSI, "")
    .replace(CHARSET, "")
    .replace(/\r/g, "");
}

function countOf(text, needle) {
  let n = 0;
  let i = text.indexOf(needle);
  while (i !== -1) {
    n += 1;
    i = text.indexOf(needle, i + needle.length);
  }
  return n;
}

function positionsOf(text, needle) {
  const positions = [];
  let i = text.indexOf(needle);
  while (i !== -1) {
    positions.push(i);
    i = text.indexOf(needle, i + needle.length);
  }
  return positions;
}

function lastBefore(positions, boundary) {
  let last = -1;
  for (const position of positions) {
    if (position >= boundary) break;
    last = position;
  }
  return last;
}

function lastPosition(positions) {
  return positions.at(-1) ?? -1;
}

function visibleLines(text) {
  return stripEscapes(text)
    .split("\n")
    .filter((line) => line.length > 0 && !SCRIPT_BANNER.test(line));
}

// Replay the control sequences Ink emits into a bounded terminal grid. The old
// parser could only take the bytes after the final cursor movement, which
// happened to work while fullscreen teardown repainted the whole frame. A
// non-fullscreen incremental frame ends as a sequence of small line patches, so
// byte slicing sees only the last patch rather than what a user saw.
//
// This is deliberately a terminal model, not another Ink frame parser: the bug
// this harness exists to catch is precisely a disagreement between Ink's frame
// and terminal cursor/scroll state. Only standard controls present in Ink's
// output are implemented; unknown CSI/OSC controls are consumed without
// changing the grid.
function replayTerminal(raw, cols, rows) {
  const blankRow = () => Array(cols).fill(" ");
  let screen = Array.from({ length: rows }, blankRow);
  let row = 0;
  let col = 0;
  let savedRow = 0;
  let savedCol = 0;
  let wrapPending = false;
  let inAlternateScreen = false;
  let lastDashboardScreen = null;
  let maxStatusLines = 0;
  const statusHistory = [];

  function clampCursor() {
    row = Math.max(0, Math.min(rows - 1, row));
    col = Math.max(0, Math.min(cols - 1, col));
    wrapPending = false;
  }

  function lineFeed() {
    wrapPending = false;
    if (row === rows - 1) {
      screen.shift();
      screen.push(blankRow());
    } else {
      row += 1;
    }
  }

  function snapshotDashboard() {
    if (!inAlternateScreen) return;
    const plain = screen.map((line) => line.join("").trimEnd());
    let hasTabBar = false;
    const visibleStatuses = [];
    for (const line of plain) {
      if (TAB_BAR.test(line)) hasTabBar = true;
      if (isStatusLine(line)) visibleStatuses.push(line);
    }
    if (hasTabBar) {
      lastDashboardScreen = plain;
      maxStatusLines = Math.max(maxStatusLines, visibleStatuses.length);
      for (const status of visibleStatuses) {
        if (statusHistory.at(-1) !== status) statusHistory.push(status);
      }
    }
  }

  function eraseDisplay(mode) {
    if (mode === 2 || mode === 3) {
      screen = Array.from({ length: rows }, blankRow);
      return;
    }
    if (mode === 0) {
      screen[row].fill(" ", col);
      for (let y = row + 1; y < rows; y += 1) screen[y].fill(" ");
      return;
    }
    if (mode === 1) {
      for (let y = 0; y < row; y += 1) screen[y].fill(" ");
      screen[row].fill(" ", 0, col + 1);
    }
  }

  function eraseLine(mode) {
    if (mode === 2) screen[row].fill(" ");
    else if (mode === 1) screen[row].fill(" ", 0, col + 1);
    else screen[row].fill(" ", col);
  }

  function firstParam(params, fallback = 1) {
    const value = Number(params.split(";")[0].replace(/^\?/, ""));
    return Number.isFinite(value) && value > 0 ? value : fallback;
  }

  function applyCsi(params, final) {
    const privateMode = params.startsWith("?");
    const values = params.replace(/^\?/, "").split(";").map((value) => Number(value || 0));
    const amount = firstParam(params);

    if (privateMode && values[0] === 1049 && final === "h") {
      inAlternateScreen = true;
      screen = Array.from({ length: rows }, blankRow);
      row = 0;
      col = 0;
      wrapPending = false;
      return;
    }
    if (privateMode && values[0] === 1049 && final === "l") {
      snapshotDashboard();
      inAlternateScreen = false;
      return;
    }
    if (privateMode && values[0] === 2026 && final === "l") {
      snapshotDashboard();
      return;
    }
    if (!inAlternateScreen) return;

    switch (final) {
      case "A":
        row -= amount;
        clampCursor();
        break;
      case "B":
        row += amount;
        clampCursor();
        break;
      case "C":
        col += amount;
        clampCursor();
        break;
      case "D":
        col -= amount;
        clampCursor();
        break;
      case "E":
        row += amount;
        col = 0;
        clampCursor();
        break;
      case "F":
        row -= amount;
        col = 0;
        clampCursor();
        break;
      case "G":
        col = amount - 1;
        clampCursor();
        break;
      case "H":
      case "f":
        row = Math.max(0, (values[0] || 1) - 1);
        col = Math.max(0, (values[1] || 1) - 1);
        clampCursor();
        break;
      case "J":
        eraseDisplay(values[0] || 0);
        wrapPending = false;
        break;
      case "K":
        eraseLine(values[0] || 0);
        wrapPending = false;
        break;
      case "s":
        savedRow = row;
        savedCol = col;
        break;
      case "u":
        row = savedRow;
        col = savedCol;
        clampCursor();
        break;
      default:
        // SGR, mode toggles, and device controls do not move the cursor.
        break;
    }
  }

  for (let index = 0; index < raw.length; ) {
    const char = raw[index];
    if (char === ESC && raw[index + 1] === "[") {
      let end = index + 2;
      while (end < raw.length && !/[A-Za-z]/.test(raw[end])) end += 1;
      if (end >= raw.length) break;
      applyCsi(raw.slice(index + 2, end), raw[end]);
      index = end + 1;
      continue;
    }
    if (char === ESC && raw[index + 1] === "]") {
      let end = index + 2;
      while (end < raw.length && raw[end] !== "\x07" && !(raw[end] === ESC && raw[end + 1] === "\\")) {
        end += 1;
      }
      index = end < raw.length && raw[end] === ESC ? end + 2 : end + 1;
      continue;
    }
    if (char === ESC) {
      // Character-set selectors carry one extra byte; other two-byte ESC
      // sequences are harmless to this grid.
      index += raw[index + 1] === "(" || raw[index + 1] === ")" ? 3 : 2;
      continue;
    }
    if (!inAlternateScreen) {
      index += 1;
      continue;
    }
    if (char === "\r") {
      col = 0;
      wrapPending = false;
      index += 1;
      continue;
    }
    if (char === "\n") {
      lineFeed();
      index += 1;
      continue;
    }
    if (char === "\b") {
      col = Math.max(0, col - 1);
      wrapPending = false;
      index += 1;
      continue;
    }
    if (char < " ") {
      index += 1;
      continue;
    }

    if (wrapPending) {
      col = 0;
      lineFeed();
    }
    const codePoint = raw.codePointAt(index);
    const glyph = String.fromCodePoint(codePoint);
    screen[row][col] = glyph;
    if (col === cols - 1) wrapPending = true;
    else col += 1;
    index += glyph.length;
  }

  snapshotDashboard();
  return {
    lines: lastDashboardScreen ?? screen.map((line) => line.join("").trimEnd()),
    maxStatusLines,
    statusHistory,
  };
}

export function parseCapture(raw, dimensions = null) {
  const visibleRaw = stripEscapes(raw);
  const altExitPositions = positionsOf(raw, ALT_EXIT);
  const mouse1002EnterPositions = positionsOf(raw, MOUSE_1002_ENTER);
  const mouse1002ExitPositions = positionsOf(raw, MOUSE_1002_EXIT);
  const mouse1006EnterPositions = positionsOf(raw, MOUSE_1006_ENTER);
  const mouse1006ExitPositions = positionsOf(raw, MOUSE_1006_EXIT);
  const mouseDisableBeforeAltExit =
    altExitPositions.length > 0 &&
    altExitPositions.every((position) => {
      const last1002Enter = lastBefore(mouse1002EnterPositions, position);
      const last1002Exit = lastBefore(mouse1002ExitPositions, position);
      const last1006Enter = lastBefore(mouse1006EnterPositions, position);
      const last1006Exit = lastBefore(mouse1006ExitPositions, position);
      return last1002Exit > last1002Enter && last1006Exit > last1006Enter;
    });
  const mouseReportingEnabled =
    lastPosition(mouse1002EnterPositions) > lastPosition(mouse1002ExitPositions) ||
    lastPosition(mouse1006EnterPositions) > lastPosition(mouse1006ExitPositions);

  // Everything after the LAST frame boundary is the frame left on screen.
  let lastBoundaryEnd = 0;
  for (const match of raw.matchAll(FRAME_BOUNDARY)) {
    lastBoundaryEnd = match.index + match[0].length;
  }
  // Strip the harness's own echo rather than dropping lines that start with it.
  // run.sh writes `EXITCODE=$?` after the app exits, and ink's final frame ends
  // without a trailing newline -- so the echo concatenates onto the last visible
  // line instead of occupying its own. An anchored filter never matched it, and
  // the artifact was being measured as part of the frame: the status bar read
  // "...Quit: qEXITCODE=0", inflating `widest` by 11 columns, and when the echo
  // did land on its own line a leading space let it escape the filter and count
  // toward the height. Both of those feed the suite's two structural assertions,
  // so they were measuring part app and part harness.
  const slicedFrameLines = visibleLines(
    raw.slice(lastBoundaryEnd).replace(/EXITCODE=\d+\s*$/, ""),
  ).filter((line) => !/^EXITCODE=/.test(line));
  const replayed =
    dimensions && Number.isSafeInteger(dimensions.cols) && Number.isSafeInteger(dimensions.rows)
      ? replayTerminal(raw, dimensions.cols, dimensions.rows)
      : null;
  const replayedScreen = replayed?.lines ?? null;
  const finalFrameLines = replayedScreen
    ? [...replayedScreen].slice(0, replayedScreen.findLastIndex((line) => line.length > 0) + 1)
    : slicedFrameLines;

  // Everything after the restore sequence landed on the PRIMARY buffer. This is
  // the #41 surface: the app's exit listener restores the primary buffer
  // (index.mjs:1618) and ink's unmount can then repaint onto it.
  const exitIndex = raw.indexOf(ALT_EXIT);
  const tail = exitIndex === -1 ? "" : raw.slice(exitIndex + ALT_EXIT.length);
  const afterRestoreVisible = visibleLines(tail)
    .join(" ")
    .replace(/EXITCODE=\d+/g, "")
    .replace(/\s+/g, " ")
    .trim();

  const exitMatch = raw.match(/EXITCODE=(\d+)/);

  return {
    raw,
    exitCode: exitMatch ? Number(exitMatch[1]) : null,
    altEnter: countOf(raw, ALT_ENTER),
    altExit: altExitPositions.length,
    cursorShows: countOf(raw, `${ESC}[?25h`),
    fullClears: countOf(raw, `${ESC}[2J`),
    mouse1002Enter: mouse1002EnterPositions.length,
    mouse1002Exit: mouse1002ExitPositions.length,
    mouse1006Enter: mouse1006EnterPositions.length,
    mouse1006Exit: mouse1006ExitPositions.length,
    mouse1002EnterPositions,
    mouse1002ExitPositions,
    mouse1006EnterPositions,
    mouse1006ExitPositions,
    mouseDisableBeforeAltExit,
    finalFrame: {
      lines: finalFrameLines,
      widest: finalFrameLines.reduce((max, line) => Math.max(max, [...line].length), 0),
    },
    liveScreen: replayedScreen
      ? {
          lines: replayedScreen,
          statusLines: replayedScreen.filter(isStatusLine).length,
          maxStatusLines: replayed.maxStatusLines,
          statusHistory: replayed.statusHistory,
        }
      : null,
    afterRestore: {
      bytes: tail.length,
      visible: afterRestoreVisible,
      hasClear: tail.includes(`${ESC}[2J`),
      hasScrollbackErase: tail.includes(`${ESC}[3J`),
      mouseReportingEnabled,
    },
    // Chrome presence only. Cell contents are deliberately never asserted: a
    // copy change would red the build for no defect.
    hasPanelFrame: /[╭╰╮╯]/.test(visibleRaw),
    hasTabBar: TAB_BAR.test(visibleRaw),
    hasFullKeyHints: /Move:/.test(visibleRaw),
  };
}

let captureSeq = 0;

function captureEnvironment(env, configHome, animation, icons) {
  return {
    ...process.env,
    ...env,
    GH_GLANCE_CAPTURE_ANIMATION: animation ? "1" : "0",
    GH_GLANCE_CAPTURE_ICONS: icons,
    XDG_CONFIG_HOME: configHome,
  };
}

/**
 * Run the app under a pty and parse the result.
 *
 * @param {object} options
 * @param {number} options.cols     terminal width
 * @param {number} options.rows     terminal height
 * @param {string} [options.signal] signal to send, or "none" to run in the
 *                                  foreground so stdin stays an interactive tty
 * @param {number} [options.settle] seconds to let the app render
 * @param {string} [options.stdin]  shell snippet whose stdout is fed to the pty
 * @param {string} [options.args]   flags handed to index.mjs, space-separated
 * @param {object} [options.env]    environment overrides for the fixture run
 * @param {boolean} [options.animation] opt in to real spinner motion
 * @param {string} [options.icons] status icon profile (unicode or ascii)
 * @param {string} [options.configHome] caller-owned absolute config root; when
 *                                      omitted, capture creates and cleans one
 */
export function capture({
  cols,
  rows,
  signal = "TERM",
  settle = 4,
  stdin = "",
  args = "",
  env = {},
  animation = false,
  icons = "unicode",
  configHome,
}) {
  if (configHome != null && (!isAbsolute(configHome) || configHome.length === 0)) {
    throw new TypeError("configHome must be an absolute path");
  }

  captureSeq += 1;
  const out = join(tmpdir(), `gh-glance-pty-${process.pid}-${captureSeq}.txt`);
  const ownsConfigHome = configHome == null;
  const effectiveConfigHome = ownsConfigHome
    ? mkdtempSync(join(tmpdir(), "gh-glance-pty-config-"))
    : configHome;
  try {
    execFileSync(
      "/bin/sh",
      [RUN, String(cols), String(rows), out, signal, String(settle), stdin, args],
      {
        stdio: "ignore",
        timeout: (settle + 25) * 1000,
        // Isolation wins over caller-supplied environment overrides: every PTY
        // run must be unable to observe the developer's real preferences. A
        // caller that needs restart persistence supplies configHome explicitly.
        env: captureEnvironment(env, effectiveConfigHome, animation, icons),
      },
    );
    return readCaptureResult(out, { cols, rows });
  } finally {
    removeCaptureArtifacts(out);
    if (ownsConfigHome) rmSync(effectiveConfigHome, { recursive: true, force: true });
  }
}

export async function captureAsync(options) {
  const {
    cols,
    rows,
    signal = "TERM",
    settle = 4,
    stdin = "",
    args = "",
    env = {},
    animation = false,
    icons = "unicode",
    configHome,
  } = options;
  if (configHome == null || !isAbsolute(configHome) || configHome.length === 0) {
    throw new TypeError("captureAsync requires a shared absolute configHome");
  }
  captureSeq += 1;
  const out = join(tmpdir(), `gh-glance-pty-${process.pid}-${captureSeq}.txt`);
  try {
    await new Promise((resolve, reject) => {
      execFile(
        "/bin/sh",
        [RUN, String(cols), String(rows), out, signal, String(settle), stdin, args],
        {
          timeout: (settle + 25) * 1000,
          env: captureEnvironment(env, configHome, animation, icons),
        },
        (error) => error ? reject(error) : resolve(),
      );
    });
    return readCaptureResult(out, { cols, rows });
  } finally {
    removeCaptureArtifacts(out);
  }
}
