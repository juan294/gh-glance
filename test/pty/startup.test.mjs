import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { capture, waitForAwk } from "./capture.mjs";

const hook = new URL("./fixtures/startup-imports.mjs", import.meta.url).href;
function startupFixture(t) {
  const root = mkdtempSync(join(tmpdir(), "gh-glance-startup-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const trace = join(root, "trace");
  writeFileSync(trace, "");
  writeFileSync(join(root, "git"), `#!/bin/sh
if [ "$1" = rev-parse ]; then sleep .2; fi
echo "git $*" >> "$STARTUP_TRACE"
exec /usr/bin/git "$@"
`, { mode: 0o700 });
  return {
    root,
    readTrace: () => readFileSync(trace, "utf8").trim().split("\n").filter(Boolean),
    env: { STARTUP_TRACE: trace, NODE_OPTIONS: `--import=${hook}`,
      PATH: `${root}:${dirname(process.execPath)}:/usr/bin:/bin`,
      GH_GLANCE_CAPTURE_CWD: root, GH_GLANCE_CAPTURE_LIVE_FLUSH: "1" },
  };
}

const firstRows = waitForAwk('"$GH_GLANCE_CAPTURE_OUT"', 'index($0,"ci: pin actions") { ok=1 }') + "printf q";
const dashboard = { cols: 100, rows: 24, signal: "none", settle: 18, stdin: firstRows };

for (const selection of ["flag", "environment", "inferred"]) {
  test(`interactive startup with ${selection} repository selection`, (t) => {
    const { root, readTrace, env } = startupFixture(t);
    // The environment case also exercises mounted bootstrap outside a checkout.
    if (selection !== "environment") {
      execFileSync("git", ["-C", root, "init", "-q"]);
      const slug = selection === "flag" ? "other/fork" : "acme/widget";
      execFileSync("git", ["-C", root, "remote", "add", "origin", `https://github.com/${slug}.git`]);
    }
    if (selection === "environment") env.GH_REPO = "acme/widget";
    const result = capture({ ...dashboard, env, args: selection === "flag" ? "--repo acme/widget" : "" });
    assert.equal(result.exitCode, 0);
    assert.match(result.raw, /ci: pin actions/);
    assert.ok(result.fixtureCalls.some((call) => call.includes("repos/acme/widget/actions/runs")));
    const trace = readTrace();
    const git = trace.filter((line) => line.startsWith("git ")).sort();
    assert.deepEqual(git, selection === "inferred" ? [
      "git config --get remote.origin.gh-resolved", "git remote", "git remote get-url --all origin",
      "git rev-parse --git-dir",
    ] : []);
    assert.deepEqual(trace.filter((line) => line.startsWith("import ")).sort(), ["import ink", "import react"]);
    if (selection === "inferred") {
      assert.ok(trace.indexOf("import ink") < trace.indexOf("git rev-parse --git-dir"), trace.join("\n"));
    }
  });
}

test("preflight diagnostics take precedence over a failed UI import", (t) => {
  const { env, readTrace } = startupFixture(t);
  const options = { ...dashboard, stdin: "", env: { ...env, FAIL_INK: "1" } };
  // Outside a checkout, the delayed git check finishes after the rejected import.
  const failed = capture(options);
  assert.equal(failed.exitCode, 3);
  assert.match(failed.raw, /not inside a git repository/);
  assert.ok(readTrace().includes("import ink"));
  assert.doesNotMatch(failed.raw, /fixture Ink unavailable/);
  assert.equal(failed.altEnter, 0);
  const ui = capture({ ...options, args: "--repo acme/widget" });
  assert.equal(ui.exitCode, 1);
  assert.match(ui.raw, /fixture Ink unavailable/);
  assert.equal(ui.altEnter, 0);
});
