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
import { readFileSync, existsSync, rmSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";

const HERE = dirname(fileURLToPath(import.meta.url));
const RUN = join(HERE, "run.sh");

const ESC = String.fromCharCode(27);
const ALT_ENTER = `${ESC}[?1049h`;
const ALT_EXIT = `${ESC}[?1049l`;

const OSC = new RegExp(`${ESC}\\][^\\x07${ESC}]*(?:\\x07|${ESC}\\\\)`, "g");
const CSI = new RegExp(`${ESC}\\[[0-9;?]*[A-Za-z]`, "g");
const CHARSET = new RegExp(`${ESC}[()][A-Za-z0-9]`, "g");
// Any of these can begin a repaint, so the last one marks the start of the
// final frame.
const FRAME_BOUNDARY = new RegExp(`${ESC}\\[[0-9]*A|${ESC}\\[2J|${ESC}\\[H`, "g");
const SCRIPT_BANNER = /^Script (started|done) on /;

function stripEscapes(text) {
  return text.replace(OSC, "").replace(CSI, "").replace(CHARSET, "").replace(/\r/g, "");
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

function visibleLines(text) {
  return stripEscapes(text)
    .split("\n")
    .filter((line) => line.length > 0 && !SCRIPT_BANNER.test(line));
}

export function parseCapture(raw) {
  // Everything after the LAST frame boundary is the frame left on screen.
  let lastBoundaryEnd = 0;
  for (const match of raw.matchAll(FRAME_BOUNDARY)) {
    lastBoundaryEnd = match.index + match[0].length;
  }
  const finalFrameLines = visibleLines(raw.slice(lastBoundaryEnd)).filter(
    (line) => !/^EXITCODE=/.test(line),
  );

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
    altExit: countOf(raw, ALT_EXIT),
    cursorShows: countOf(raw, `${ESC}[?25h`),
    fullClears: countOf(raw, `${ESC}[2J`),
    finalFrame: {
      lines: finalFrameLines,
      widest: finalFrameLines.reduce((max, line) => Math.max(max, [...line].length), 0),
    },
    afterRestore: {
      bytes: tail.length,
      visible: afterRestoreVisible,
      hasClear: tail.includes(`${ESC}[2J`),
      hasScrollbackErase: tail.includes(`${ESC}[3J`),
    },
    // Chrome presence only. Cell contents are deliberately never asserted: a
    // copy change would red the build for no defect.
    hasPanelFrame: /[╭╰╮╯]/.test(stripEscapes(raw)),
    hasTabBar: /1:(Actions|Act)/.test(stripEscapes(raw)),
    hasFullKeyHints: /Move:/.test(stripEscapes(raw)),
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
 */
export function capture({ cols, rows, signal = "TERM", settle = 4, stdin = "" }) {
  captureSeq += 1;
  const out = join(tmpdir(), `gh-glance-pty-${process.pid}-${captureSeq}.txt`);
  try {
    execFileSync(
      "/bin/sh",
      [RUN, String(cols), String(rows), out, signal, String(settle), stdin],
      { stdio: "ignore", timeout: (settle + 25) * 1000 },
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
  }
}
