// Interactive key coverage.
//
// Kept in its own file, and its own CI step, because every assertion here needs
// timed input -- the only flakiness risk in the harness. A timing flake fails
// this file alone and leaves e2e.test.mjs, which carries the #41 regression
// guard, unaffected.
//
// Why the app runs in the FOREGROUND here: backgrounding it (what e2e.test.mjs
// does, so it can be killed with a signal) detaches stdin, which makes
// isRawModeSupported falsy and leaves useInput inert. The key handlers only
// exist when stdin is an interactive tty, so these runs let the app quit itself
// with `q` instead of being signalled.
//
// script(1) forwards its own stdin to the pty master, so bytes piped in arrive
// at the child as genuine terminal input. That is what makes this possible
// without adding node-pty, which would be a native dependency the project's
// no-build-step stance rules out.

import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { capture, lazyCapture, waitForAwk } from "./capture.mjs";

// Width-mode probes do not depend on data rows; keep their short input spacing.
const REFRESH_SECONDS = 5;
const SETTLE = Math.ceil(REFRESH_SECONDS * 0.6);

// Move is advertised only after rows arrive. Force slow provider responses and
// wait for actual fixture rows before switching tabs and quitting.
const keyed = lazyCapture(() => {
  const configHome = mkdtempSync(join(tmpdir(), "gh-glance-pty-keys-"));
  const statePath = join(configHome, "fixture.json");
  const now = Date.now();
  writeFileSync(statePath, JSON.stringify({
    createdAt: now,
    core: { limit: 5000, used: 0, remaining: 5000, resetMs: now + 3_600_000 },
    graphql: { limit: 5000, used: 0, remaining: 5000, resetMs: now + 3_600_000 },
    events: [],
    delayByCommand: { actions: 8000, "graphql-data": 8000 },
  }), { mode: 0o600 });
  try {
    return capture({
      cols: 80, rows: 24, signal: "none", settle: 60, configHome,
      stdin: waitForAwk('"$GH_GLANCE_CAPTURE_OUT"', 'index($0, "ci: pin actions") { ok=1 }', 250) +
        "printf '2'; " +
        waitForAwk('"$GH_GLANCE_CAPTURE_OUT"', 'index($0, "SIGTERM erases") { ok=1 }', 250) +
        "printf 'q'; sleep 2",
      env: { GH_GLANCE_CAPTURE_LIVE_FLUSH: "1", GH_GLANCE_FIXTURE_STATE: statePath },
    });
  } finally {
    rmSync(configHome, { recursive: true, force: true });
  }
});

// The same app, backgrounded, so stdin is not a tty. Used only to prove the
// interactive gate works in both directions.
const detached = lazyCapture(() => capture({ cols: 80, rows: 24, settle: 4 }));

const noRemoteEnv = {
  GH_GLANCE_FIXTURE_FAIL: "failed to determine base repo: no git remotes found",
  GH_GLANCE_FIXTURE_FAIL_ON: "run,graphql,api",
};
const remoteSetupDeclined = lazyCapture(() => capture({
  cols: 80,
  rows: 24,
  signal: "none",
  settle: 10,
  stdin: "sleep 3; printf 'q'; sleep 2",
  env: noRemoteEnv,
}));

function assertCleanInteractiveCapture(result, { cols, rows, label }) {
  assert.equal(result.exitCode, 0, `${label}: q should exit 0`);
  assert.equal(result.finalFrame.lines.length, rows - 1, `${label}: guarded frame height`);
  assert.ok(
    result.finalFrame.widest <= cols,
    `${label}: widest line was ${result.finalFrame.widest} in a ${cols}-column terminal`,
  );
  assert.equal(result.altEnter, 1, `${label}: alternate-screen enter count`);
  assert.equal(result.altExit, 1, `${label}: alternate-screen exit count`);
  assert.ok(result.cursorShows >= 1, `${label}: cursor was not restored`);
  assert.equal(result.afterRestore.hasClear, false, `${label}: primary buffer was cleared`);
  assert.equal(
    result.afterRestore.hasScrollbackErase,
    false,
    `${label}: primary-buffer scrollback was erased`,
  );
  assert.equal(result.afterRestore.visible, "", `${label}: a dead frame remained after restore`);
}

test("keys are advertised only when stdin is interactive", () => {
  // Asserting one direction would pass against a permanently-open gate, so both
  // are checked. index.mjs shows the full hints when raw mode is supported and
  // only "Quit: ^C" when it is not -- advertising keys that cannot fire would be
  // telling the user something untrue about what the app can do.
  assert.match(keyed().raw, /ci: pin actions/, "Actions rows must arrive before switching");
  assert.match(keyed().finalFrame.lines.join("\n"), /SIGTERM erases/, "Issues rows must arrive before quitting");
  assert.ok(
    keyed().hasFullKeyHints,
    "expected the full key hints on a foreground run with an interactive stdin",
  );
  assert.ok(
    !detached().hasFullKeyHints,
    "expected only the Ctrl+C hint when stdin is not a tty",
  );
  assert.match(detached().finalFrame.lines.join("\n"), /Quit:\s+\^C/,
    "noninteractive stdin must advertise Ctrl+C even before rows arrive");
});

test("a digit switches tabs", () => {
  // The active tab is bracketed rather than only inverse, so this survives
  // NO_COLOR -- which is why it is assertable at all after escapes are stripped.
  const plain = keyed().raw.replace(
    new RegExp(String.fromCharCode(27) + "\\[[0-9;?]*[A-Za-z]", "g"),
    "",
  );
  assert.ok(
    /\[2:Issues/.test(plain),
    "pressing 2 should have made the Issues tab active",
  );
});

test("q quits cleanly and leaves nothing on the primary buffer", () => {
  // The clean-quit counterpart to the SIGTERM assertion in e2e.test.mjs.
  // Together they are the pair that distinguishes #41: this path was always
  // clean because ink unmounts before restoreScreen runs, while the signal path
  // had the two in the opposite order.
  assert.equal(keyed().exitCode, 0, "q should exit 0");
  assert.equal(keyed().altEnter, 1);
  assert.equal(keyed().altExit, 1);
  assert.equal(
    keyed().afterRestore.hasScrollbackErase,
    false,
    "the clean-quit path must not erase the scrollback either",
  );
  assert.equal(
    keyed().afterRestore.visible,
    "",
    `a dead frame was left on the primary buffer: ${JSON.stringify(keyed().afterRestore.visible.slice(0, 120))}`,
  );
});

test("keyboard width changes persist across processes and defaults remove deviations", () => {
  const configHome = mkdtempSync(join(tmpdir(), "gh-glance-pty-widths-"));
  const preferencePath = join(configHome, "gh-glance", "preferences.json");
  try {
    const widened = capture({
      cols: 80,
      rows: 24,
      signal: "none",
      settle: 12,
      configHome,
      // Every logical key is a separate write. Combined escape/key strings can
      // be delivered as one useInput event and do not model a user's keypresses.
      stdin:
        `sleep ${SETTLE}; printf 'w'; sleep 1; printf '\\033[C'; ` +
        "sleep 1; printf '\\r'; sleep 1; printf 'q'; sleep 2",
    });

    assertCleanInteractiveCapture(widened, { cols: 80, rows: 24, label: "widen" });
    assert.deepEqual(JSON.parse(readFileSync(preferencePath, "utf8")), {
      version: 1,
      tabs: { actions: { workflow: 11 } },
    });

    const restoredThenReset = capture({
      cols: 80,
      rows: 24,
      signal: "none",
      settle: 12,
      configHome,
      stdin:
        `sleep ${SETTLE}; printf 'w'; sleep 1; printf '\\033[D'; ` +
        "sleep 1; printf '\\r'; sleep 1; printf 'q'; sleep 2",
    });

    assertCleanInteractiveCapture(restoredThenReset, {
      cols: 80,
      rows: 24,
      label: "restore and reset",
    });
    assert.deepEqual(JSON.parse(readFileSync(preferencePath, "utf8")), {
      version: 1,
      tabs: {},
    });
  } finally {
    // This exact root is caller-owned and was returned by this mkdtempSync call.
    rmSync(configHome, { recursive: true, force: true });
  }
});

test("compact width-mode input is a persistence no-op", () => {
  const configHome = mkdtempSync(join(tmpdir(), "gh-glance-pty-widths-compact-"));
  const preferencePath = join(configHome, "gh-glance", "preferences.json");
  try {
    const compact = capture({
      cols: 45,
      rows: 20,
      signal: "none",
      settle: 12,
      configHome,
      stdin:
        `sleep ${SETTLE}; printf 'w'; sleep 1; printf '\\033[C'; ` +
        "sleep 1; printf '\\033[D'; sleep 1; printf 'q'; sleep 2",
    });

    assertCleanInteractiveCapture(compact, { cols: 45, rows: 20, label: "compact" });
    assert.equal(
      existsSync(preferencePath),
      false,
      "compact-mode width keys must not create a preference file",
    );
  } finally {
    rmSync(configHome, { recursive: true, force: true });
  }
});

test("quitting the missing-remote prompt makes no repository change", () => {
  assert.ok(
    !remoteSetupDeclined().fixtureCalls.some((call) => call.startsWith("repo create")),
    "declining setup unexpectedly invoked gh repo create",
  );
  assert.equal(remoteSetupDeclined().exitCode, 0);
  assert.equal(remoteSetupDeclined().altEnter, 1);
  assert.equal(remoteSetupDeclined().altExit, 1);
  assert.equal(remoteSetupDeclined().afterRestore.visible, "");
});
