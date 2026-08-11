// Real SGR mouse coverage. Each report is sent through script(1) to the
// foreground process, so Ink sees the same bytes and raw-mode timing as it does
// in a terminal. The first report is deliberately split within Ink's pending
// CSI window to pin the parser boundary that is easiest to regress.

import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { TABS, dividerHandles } from "../../index.mjs";
import { capture, parseCapture } from "./capture.mjs";

const ESC = String.fromCharCode(27);
const actionsHeader = TABS.find(({ key }) => key === "actions").header;

// The fixture's 80-column frame starts at x=2 and its header starts at y=3.
// dividerHandles works in zero-based screen coordinates; SGR reports are
// one-based on the wire. Keeping this conversion next to the PTY inputs makes a
// header-layout change fail as a coordinate-contract failure, not as a mystery
// persistence timeout.
const liveHandles = dividerHandles({
  header: actionsHeader,
  metrics: { x: 2, y: 3, width: 75, height: 2 },
});
const workflowHandle = liveHandles.find(({ key }) => key === "workflow");
assert.deepEqual(workflowHandle, {
  key: "workflow",
  x: 33,
  yStart: 3,
  yEnd: 5,
  width: 10,
  direction: -1,
});
const PRESS_X = workflowHandle.x + 1;
const PRESS_Y = workflowHandle.yStart + 1;
const DRAG_X = PRESS_X + 3;
const OUTSIDE_Y = workflowHandle.yEnd + 1;

const noRemoteEnv = {
  GH_GLANCE_FIXTURE_FAIL: "failed to determine base repo: no git remotes found",
  GH_GLANCE_FIXTURE_FAIL_ON: "run,issue,pr,api",
};

function captureWithPreloader(prefix, source, options) {
  const preloaderRoot = mkdtempSync(join(tmpdir(), prefix));
  const preloaderPath = join(preloaderRoot, "lifecycle.cjs");
  try {
    writeFileSync(preloaderPath, source, "utf8");
    return capture({
      ...options,
      env: { ...options.env, NODE_OPTIONS: `--require=${preloaderPath}` },
    });
  } finally {
    rmSync(preloaderRoot, { recursive: true, force: true });
  }
}

function assertMouseLifecycle(result, label) {
  assert.equal(result.altEnter, 1, `${label}: alternate-screen enter count`);
  assert.equal(result.altExit, 1, `${label}: alternate-screen exit count`);
  assert.ok(result.cursorShows >= 1, `${label}: cursor was not restored`);
  assert.equal(result.mouse1002Enter, 1, `${label}: button-event enable count`);
  assert.equal(result.mouse1002Exit, 1, `${label}: button-event disable count`);
  assert.equal(result.mouse1006Enter, 1, `${label}: SGR enable count`);
  assert.equal(result.mouse1006Exit, 1, `${label}: SGR disable count`);
  assert.equal(result.mouseDisableBeforeAltExit, true, `${label}: mouse disabled too late`);
  assert.equal(
    result.afterRestore.mouseReportingEnabled,
    false,
    `${label}: mouse reporting remained enabled`,
  );
  assert.equal(result.afterRestore.hasClear, false, `${label}: primary buffer was cleared`);
  assert.equal(
    result.afterRestore.hasScrollbackErase,
    false,
    `${label}: primary-buffer scrollback was erased`,
  );
}

function assertBoundedOutput(result, { cols, label }) {
  assert.ok(
    result.finalFrame.widest <= cols,
    `${label}: widest line was ${result.finalFrame.widest} in ${cols} columns`,
  );
  assert.ok(result.fullClears <= 2, `${label}: unexpected full-screen repaint count`);
}

function assertBoundedFrame(result, { cols, rows, label }) {
  assert.equal(result.finalFrame.lines.length, rows - 1, `${label}: guarded frame height`);
  assertBoundedOutput(result, { cols, label });
}

function assertCleanMouseCapture(result, { cols, rows, label }) {
  assert.equal(result.exitCode, 0, `${label}: q should exit 0`);
  assertBoundedFrame(result, { cols, rows, label });
  assertMouseLifecycle(result, label);
  assert.equal(result.afterRestore.visible, "", `${label}: a dead frame remained after restore`);
}

test("capture parsing strips SGR input and records mouse shutdown before screen restore", () => {
  const raw =
    `${ESC}[?1049h${ESC}[?1002h${ESC}[?1006h${ESC}[H` +
    `header${ESC}[<0;34;4M${ESC}[<32;37;4M${ESC}[<0;37;4m\n` +
    `${ESC}[?1002l${ESC}[?1006l${ESC}[?25h${ESC}[?1049lEXITCODE=0\n`;
  const parsed = parseCapture(raw);

  assert.equal(parsed.exitCode, 0);
  assert.deepEqual(parsed.finalFrame.lines, ["header"]);
  assert.equal(parsed.finalFrame.widest, 6);
  assertMouseLifecycle(parsed, "synthetic capture");
  assert.equal(parsed.afterRestore.visible, "");
});

test("a split press stops resizing after an outside-header release", () => {
  const configHome = mkdtempSync(join(tmpdir(), "gh-glance-pty-mouse-"));
  const preferencePath = join(configHome, "gh-glance", "preferences.json");
  try {
    const dragged = capture({
      cols: 80,
      rows: 24,
      signal: "none",
      settle: 14,
      configHome,
      stdin:
        `sleep 3; printf '\\033[<0;${PRESS_X};'; sleep 0.005; printf '${PRESS_Y}M'; ` +
        `sleep 1; printf '\\033[<32;${DRAG_X};${PRESS_Y}M'; ` +
        `sleep 1; printf '\\033[<0;${DRAG_X};${OUTSIDE_Y}m'; ` +
        `sleep 1; printf '\\033[<32;${DRAG_X + 3};${OUTSIDE_Y}M'; ` +
        "sleep 1; printf 'q'; sleep 2",
    });

    assert.equal(PRESS_X, 34, "live workflow grip encoded x coordinate changed");
    assert.equal(PRESS_Y, 4, "live Actions header encoded y coordinate changed");
    assertCleanMouseCapture(dragged, { cols: 80, rows: 24, label: "drag" });
    assert.deepEqual(JSON.parse(readFileSync(preferencePath, "utf8")), {
      version: 1,
      tabs: { actions: { workflow: 7 } },
    });
  } finally {
    rmSync(configHome, { recursive: true, force: true });
  }
});

test("SIGTERM disables active mouse reporting before restoring the screen", () => {
  const terminated = captureWithPreloader(
    "gh-glance-pty-mouse-sigterm-",
    `const path = require("node:path");
if (path.basename(process.argv[1] || "") === "index.mjs") {
  setTimeout(() => process.kill(process.pid, "SIGTERM"), 2500);
}
`,
    {
      cols: 80,
      rows: 24,
      signal: "none",
      settle: 10,
      stdin: "sleep 4",
    },
  );

  assert.equal(terminated.exitCode, 143, "SIGTERM should use the conventional exit code");
  assertBoundedFrame(terminated, { cols: 80, rows: 24, label: "SIGTERM" });
  assertMouseLifecycle(terminated, "SIGTERM");
  assert.equal(terminated.afterRestore.visible, "", "SIGTERM left output on the primary buffer");
});

test("an uncaught crash disables mouse reporting before printing its primary-buffer diagnostic", () => {
  const crashed = captureWithPreloader(
    "gh-glance-pty-mouse-crash-",
    `const path = require("node:path");
if (path.basename(process.argv[1] || "") === "index.mjs") {
  setTimeout(() => { throw new Error("phase4 lifecycle test crash"); }, 2500);
}
`,
    {
      cols: 80,
      rows: 24,
      signal: "none",
      settle: 10,
      stdin: "sleep 4",
    },
  );

  assert.equal(crashed.exitCode, 1, "an uncaught exception should exit nonzero");
  // Like remote setup, the primary diagnostic and stack are intentionally part
  // of the parsed final region after restore, so dashboard dimensions no longer
  // describe it. The bounded repaint and teardown contracts still apply.
  assert.ok(crashed.fullClears <= 2, "crash: unexpected full-screen repaint count");
  assertMouseLifecycle(crashed, "crash");
  assert.match(crashed.afterRestore.visible, /gh-glance: crashed/);
  assert.match(crashed.afterRestore.visible, /phase4 lifecycle test crash/);
});

test("remote setup disables mouse reporting before handing the terminal to gh", () => {
  const configHome = mkdtempSync(join(tmpdir(), "gh-glance-pty-mouse-handoff-"));
  const readyPath = join(configHome, "setup-ready");
  let handoff;
  let childReady;
  try {
    handoff = capture({
      cols: 80,
      rows: 24,
      signal: "none",
      settle: 12,
      configHome,
      stdin:
        "sleep 3; printf '\\r'; i=0; " +
        "while [ ! -f \"$GH_GLANCE_FIXTURE_READY\" ] && [ \"$i\" -lt 200 ]; " +
        "do sleep 0.05; i=$((i + 1)); done; sleep 0.2; printf 'confirm\\n'; " +
        "while :; do sleep 1; printf '\\n' || exit 0; done",
      env: { ...noRemoteEnv, GH_GLANCE_FIXTURE_READY: readyPath },
    });
    childReady = existsSync(readyPath);
  } finally {
    rmSync(configHome, { recursive: true, force: true });
  }

  assert.equal(
    handoff.exitCode,
    0,
    `successful gh setup handoff should exit 0: ${handoff.afterRestore.visible}`,
  );
  assert.equal(childReady, true, "fixture child never advertised input readiness");
  // The parsed final region also contains the legitimate primary-buffer gh
  // transcript and echoed interactive input after handoff, so neither its line
  // count nor its width describes the 24x80 dashboard anymore.
  assert.ok(handoff.fullClears <= 2, "remote setup: unexpected full-screen repaint count");
  assertMouseLifecycle(handoff, "remote setup");
  assert.deepEqual(
    handoff.fixtureCalls.filter((call) => call === "repo create"),
    ["repo create"],
  );
  assert.match(handoff.afterRestore.visible, /Interactive fixture accepted confirm/);
});

test("outside, wheel, non-left, and move-without-press reports do not persist widths", () => {
  const configHome = mkdtempSync(join(tmpdir(), "gh-glance-pty-mouse-invalid-"));
  const preferencePath = join(configHome, "gh-glance", "preferences.json");
  try {
    const invalid = capture({
      cols: 80,
      rows: 24,
      signal: "none",
      settle: 14,
      configHome,
      stdin:
        `sleep 3; printf '\\033[<32;${DRAG_X};${PRESS_Y}M'; ` +
        `sleep 0.5; printf '\\033[<0;10;${PRESS_Y}M'; ` +
        `sleep 0.5; printf '\\033[<0;10;${PRESS_Y}m'; ` +
        `sleep 0.5; printf '\\033[<64;${PRESS_X};${PRESS_Y}M'; ` +
        `sleep 0.5; printf '\\033[<1;${PRESS_X};${PRESS_Y}M'; ` +
        `sleep 0.5; printf '\\033[<2;${PRESS_X};${PRESS_Y}M'; ` +
        "sleep 0.5; printf 'q'; sleep 2",
    });

    assertCleanMouseCapture(invalid, { cols: 80, rows: 24, label: "invalid reports" });
    assert.equal(
      existsSync(preferencePath),
      false,
      "unsupported reports must not create a preference file",
    );
  } finally {
    rmSync(configHome, { recursive: true, force: true });
  }
});

test("otherwise valid mouse drags are a compact-layout persistence no-op", () => {
  const configHome = mkdtempSync(join(tmpdir(), "gh-glance-pty-mouse-compact-"));
  const preferencePath = join(configHome, "gh-glance", "preferences.json");
  try {
    const compact = capture({
      cols: 45,
      rows: 20,
      signal: "none",
      settle: 12,
      configHome,
      stdin:
        `sleep 3; printf '\\033[<0;${PRESS_X};${PRESS_Y}M'; ` +
        `sleep 1; printf '\\033[<32;${DRAG_X};${PRESS_Y}M'; ` +
        `sleep 1; printf '\\033[<0;${DRAG_X};${PRESS_Y}m'; ` +
        "sleep 1; printf 'q'; sleep 2",
    });

    assertCleanMouseCapture(compact, { cols: 45, rows: 20, label: "compact" });
    assert.equal(
      existsSync(preferencePath),
      false,
      "compact mouse input must not create a preference file",
    );
  } finally {
    rmSync(configHome, { recursive: true, force: true });
  }
});
