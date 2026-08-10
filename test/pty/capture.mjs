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

import { execFileSync } from "node:child_process";
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

export function parseCapture(raw) {
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
  const finalFrameLines = visibleLines(
    raw.slice(lastBoundaryEnd).replace(/EXITCODE=\d+\s*$/, ""),
  ).filter((line) => !/^EXITCODE=/.test(line));

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
    hasTabBar: /1:(Actions|Act)/.test(visibleRaw),
    hasFullKeyHints: /Move:/.test(visibleRaw),
  };
}

let captureSeq = 0;

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
        env: { ...process.env, ...env, XDG_CONFIG_HOME: effectiveConfigHome },
      },
    );
    const parsed = parseCapture(readFileSync(out, "utf8"));
    const logPath = `${out}.calls`;
    parsed.fixtureCalls = existsSync(logPath)
      ? readFileSync(logPath, "utf8").split("\n").filter(Boolean)
      : [];
    return parsed;
  } finally {
    for (const path of [out, `${out}.calls`]) {
      if (existsSync(path)) rmSync(path, { force: true });
    }
    if (ownsConfigHome) rmSync(effectiveConfigHome, { recursive: true, force: true });
  }
}
