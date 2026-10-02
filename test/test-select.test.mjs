import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import {
  PROFILE_SELECTIONS, PTY_SMOKE, ROOT, classifyChanges, discoverTests, selections, validateSelections,
} from "../scripts/test-select.mjs";

const SCRIPT = join(ROOT, "scripts/test-select.mjs");

test("SELECT-01 every discovered test file has an owner and no selection is empty", () => {
  const found = discoverTests();
  assert.deepEqual(validateSelections(found), []);
  const all = selections(found);
  const unitUnion = new Set([...all.fast.files, ...all.recovery.files, ...all.package.files]);
  assert.deepEqual([...unitUnion].sort(), found.unit, "fast + recovery + package must equal the npm test file set");
  assert.deepEqual(all.pty.files, found.pty);
  assert.ok(!all.fast.files.includes("test/sustained-recovery.test.mjs"));
  assert.ok(!all.fast.files.includes("test/package-boundary.test.mjs"));
  assert.ok(all.fast.args.includes("--test-skip-pattern=E2E-"), "fast must not run E2E efficiency workloads");
  assert.ok(all.fast.files.includes("test/efficiency.test.mjs"), "cheap efficiency checks stay in fast");
});

test("SELECT-02 an unowned test file or an empty selection is rejected", () => {
  const found = discoverTests();
  const extra = { ...found, unit: [...found.unit, "test/new-feature.test.mjs"] };
  const problems = validateSelections(extra, selections(found));
  assert.ok(problems.some((problem) => problem.includes("unowned unit test test/new-feature.test.mjs")));
  const empty = { ...selections(found), recovery: { files: [], args: [] } };
  assert.ok(validateSelections(found, empty).some((problem) => problem === "recovery: empty selection"));
  const strayPty = { ...found, pty: [...found.pty, "test/pty/new.test.mjs"] };
  assert.ok(validateSelections(strayPty, selections(found))
    .some((problem) => problem.includes("unowned terminal test test/pty/new.test.mjs")));
});

test("SELECT-03 the npm test script still covers exactly the unit selections", () => {
  const scripts = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8")).scripts;
  assert.match(scripts.test, /test\/\*\.test\.mjs/);
  assert.match(scripts.test, /--test-skip-pattern='E2E-'/);
  for (const name of ["test:fast", "test:recovery", "test:package", "test:pty", "test:pty:smoke", "test:efficiency"]) {
    assert.match(scripts[name], new RegExp(`scripts/test-select\\.mjs run ${name.slice(5)}$`));
  }
});

test("SELECT-04 profiles: docs stay docs, unknown and product paths go broad", () => {
  assert.equal(classifyChanges(["docs/release/x.md", "CHANGELOG.md", "LICENSE"]).profile, "docs");
  assert.equal(classifyChanges(null).profile, "broad", "missing diff base");
  assert.equal(classifyChanges([]).profile, "broad");
  assert.equal(classifyChanges(["index.mjs"]).profile, "broad");
  const reviewed = classifyChanges(["index.mjs"], { reviewedOrdinary: "review-note.md#3" });
  assert.equal(reviewed.profile, "ordinary");
  assert.match(reviewed.reasons.join("\n"), /review-note\.md#3/);
  for (const path of ["package-lock.json", "scripts/test-select.mjs", ".github/workflows/ci.yml",
    "test/pty/capture.mjs", "test/fixtures/request-oracle.mjs", "src/new.mjs", "test/sustained-recovery.test.mjs",
    "test/efficiency.test.mjs"]) {
    assert.equal(classifyChanges(["README.md", path]).profile, "broad", path);
  }
  assert.equal(classifyChanges(["test/args.test.mjs"]).profile, "ordinary");
  // Any other test file is broad by uncertainty, including ones not yet written.
  for (const path of ["test/pty/governor.test.mjs", "test/pty/mouse.test.mjs", "test/pty/keys.test.mjs",
    "test/identity-process.test.mjs", "test/governor.test.mjs", "test/webhooks.test.mjs",
    "test/sustained-reconciliation.test.mjs", "test/unit.test.mjs", "test/lease-renewal.test.mjs"]) {
    assert.equal(classifyChanges([path]).profile, "broad", `${path} must select the broad profile`);
  }
  assert.equal(classifyChanges(["test/unit.test.mjs"], { reviewedOrdinary: "review#2" }).profile, "ordinary");
  assert.equal(classifyChanges(["test/scripts.md"]).profile, "broad", "markdown under test/ is not documentation");
  assert.deepEqual(PROFILE_SELECTIONS.broad.filter((name) => !PROFILE_SELECTIONS.ordinary.includes(name)),
    ["recovery", "efficiency", "pty"]);
});

test("SELECT-05 terminal smoke names real tests, counts them, and forbids module-scope captures", () => {
  const smoke = selections()["pty:smoke"];
  const names = PTY_SMOKE.flatMap((entry) => entry.tests);
  for (const entry of PTY_SMOKE) {
    const source = readFileSync(join(ROOT, entry.file), "utf8");
    for (const name of entry.tests) {
      assert.ok(source.includes(`test(${JSON.stringify(name)}`), `${entry.file} has no test ${name}`);
    }
  }
  assert.equal(smoke.expectedTests, names.length);
  assert.equal(smoke.env.GH_GLANCE_CAPTURE_REQUIRE_TEST, "1");
  const patterns = smoke.args.filter((arg) => arg.startsWith("--test-name-pattern="));
  assert.equal(patterns.length, names.length);
  assert.ok(patterns.every((pattern) => /^--test-name-pattern=\^.*\$$/.test(pattern)));
});

// A scratch checkout proves the runner's real behavior: a failing selection
// keeps its non-zero status even when a later selection passes, and excluded
// test modules are never imported.
function scratchProject(t) {
  const root = mkdtempSync(join(tmpdir(), "gh-glance-select-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  mkdirSync(join(root, "scripts"));
  mkdirSync(join(root, "test/pty"), { recursive: true });
  writeFileSync(join(root, "scripts/test-select.mjs"), readFileSync(SCRIPT));
  const marker = join(root, "imported.log");
  const body = (name, pass) => `import { appendFileSync } from "node:fs";\n` +
    `appendFileSync(${JSON.stringify(marker)}, ${JSON.stringify(`${name}\n`)});\n` +
    `import { test } from "node:test";\ntest(${JSON.stringify(name)}, () => { if (!${pass}) throw new Error("planted"); });\n`;
  writeFileSync(join(root, "test/sustained-recovery.test.mjs"), body("recovery", false));
  writeFileSync(join(root, "test/package-boundary.test.mjs"), body("package", true));
  writeFileSync(join(root, "test/efficiency.test.mjs"), body("efficiency", true));
  writeFileSync(join(root, "test/unit.test.mjs"), body("unit", true));
  for (const entry of PTY_SMOKE) writeFileSync(join(root, entry.file), body(entry.file, true));
  return { root, marker };
}

test("SELECT-06 run aggregates failures and never imports excluded files", (t) => {
  const box = scratchProject(t);
  const run = spawnSync(process.execPath, ["scripts/test-select.mjs", "run", "recovery", "fast",
    "--receipt", join(box.root, "receipt.json")], { cwd: box.root, encoding: "utf8" });
  assert.equal(run.status, 1, run.stdout + run.stderr);
  assert.match(run.stdout, /## selection recovery: FAIL \(exit 1\)/);
  assert.match(run.stdout, /## selection fast: pass/);
  assert.match(run.stdout, /## summary: recovery=FAIL fast=pass/);
  const receipt = JSON.parse(readFileSync(join(box.root, "receipt.json"), "utf8"));
  assert.deepEqual(receipt.results.map((result) => [result.name, result.exitCode]), [["recovery", 1], ["fast", 0]]);
  const imported = readFileSync(box.marker, "utf8").trim().split("\n").sort();
  assert.deepEqual(imported, ["efficiency", "recovery", "unit"],
    "fast must not import the package or recovery modules; recovery imports only itself");
});

test("SELECT-07 an inventory gap stops the runner before any test starts", (t) => {
  const box = scratchProject(t);
  rmSync(join(box.root, "test/pty/keys.test.mjs"));
  const run = spawnSync(process.execPath, ["scripts/test-select.mjs", "run", "fast"], { cwd: box.root, encoding: "utf8" });
  assert.equal(run.status, 2);
  assert.match(run.stderr, /pty:smoke: unknown file test\/pty\/keys\.test\.mjs/);
  assert.throws(() => readFileSync(box.marker, "utf8"), /ENOENT/);
});

test("SELECT-08 a selection that runs no tests, or not the expected ones, fails", (t) => {
  const box = scratchProject(t);
  const run = spawnSync(process.execPath, ["scripts/test-select.mjs", "run", "pty:smoke"], { cwd: box.root, encoding: "utf8" });
  assert.equal(run.status, 1, run.stdout + run.stderr);
  // Filtered-out files still report as one empty test each; the count, not
  // the exit status, exposes that none of the named cases ran.
  assert.match(run.stdout, /selection pty:smoke ran 4 tests, expected 7/);
  assert.match(run.stdout, /## selection pty:smoke: FAIL \(exit 3\)/);
});
