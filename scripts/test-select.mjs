#!/usr/bin/env node
// Explicit test selections shared by package scripts, CI and the release
// driver. `npm test` keeps the complete unit contract; these selections only
// name the subsets that already exist so that a fast loop, the sustained
// recovery oracle, the package exercise and the terminal smoke can each run on
// their own, with their real file lists and durations printed.
//
//   node scripts/test-select.mjs list [selection...]
//   node scripts/test-select.mjs run <selection...> [--receipt path]
//   node scripts/test-select.mjs plan [--base <ref>] [--head <ref>]
//                                     [--reviewed-ordinary <reference>]
//
// `run` executes every named selection in order, keeps going after a failure
// and exits non-zero if any selection failed, so a later success never hides an
// earlier one.

import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { parseArgs } from "node:util";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

const RECOVERY_FILES = ["test/sustained-recovery.test.mjs"];
const PACKAGE_FILES = ["test/package-boundary.test.mjs"];
const EFFICIENCY_FILES = ["test/efficiency.test.mjs"];
const PTY_GOVERNOR = "test/pty/governor.test.mjs";
const PTY_ARGS = ["--test-concurrency=1", "--test-timeout=900000"];

// Terminal smoke: startup with real Actions rows, tab navigation, clean quit,
// signal teardown, the cached secondary age and Paused -> Watching recovery. Each
// entry names its file and the exact test titles it runs; everything else in
// those files (mouse, layout, load and the rest of the charter) stays in the
// full PTY selection.
export const PTY_SMOKE = [
  { file: "test/pty/e2e.test.mjs", tests: [
    "the app reaches the data layer at all",
    "the alternate screen is entered exactly once and left exactly once",
    "SIGTERM exits 143",
  ] },
  { file: "test/pty/keys.test.mjs", tests: [
    "a digit switches tabs",
    "q quits cleanly and leaves nothing on the primary buffer",
  ] },
  { file: "test/pty/adaptive-polling.test.mjs", tests: [
    "cached secondary age advances while no new observation is requested",
  ] },
  { file: "test/pty/status.test.mjs", tests: [
    "a sub-threshold coordination blip stays silent",
  ] },
];

export function escapeRegExp(text) {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export function discoverTests(root = ROOT) {
  const list = (dir) => readdirSync(join(root, dir))
    .filter((name) => name.endsWith(".test.mjs") && !name.startsWith("."))
    .map((name) => `${dir}/${name}`)
    .sort();
  return { unit: list("test"), pty: list("test/pty") };
}

// Each selection is a concrete node --test invocation: files plus the flags
// that shape it. Nothing here is a pattern over file names that could silently
// match zero files; `validateSelections` proves every list is non-empty and
// every discovered test file has an owner.
export function selections(found = discoverTests()) {
  const excluded = new Set([...RECOVERY_FILES, ...PACKAGE_FILES]);
  return {
    fast: {
      description: "unit behavior without the sustained oracle or package installation",
      files: found.unit.filter((file) => !excluded.has(file)),
      args: ["--test-skip-pattern=E2E-"],
    },
    recovery: {
      description: "72-hour sustained recovery oracle",
      files: RECOVERY_FILES,
      args: [],
    },
    package: {
      description: "pack (or GH_GLANCE_PACKAGE_TARBALL) and installed-package exercise",
      files: PACKAGE_FILES,
      args: [],
    },
    efficiency: {
      description: "deterministic simulated-hour efficiency acceptance",
      files: EFFICIENCY_FILES,
      args: [],
    },
    pty: {
      description: "full terminal suite, one file at a time",
      files: found.pty,
      args: PTY_ARGS,
    },
    // The two CI shards of the full suite, on separate runners: the governor
    // file alone takes most of a shard.
    "pty:governor": {
      description: "full terminal suite shard: the governor file",
      files: found.pty.filter((file) => file === PTY_GOVERNOR),
      args: PTY_ARGS,
    },
    "pty:rest": {
      description: "full terminal suite shard: every other terminal file",
      files: found.pty.filter((file) => file !== PTY_GOVERNOR),
      args: PTY_ARGS,
    },
    "pty:smoke": {
      description: "installed-or-source terminal smoke",
      files: PTY_SMOKE.map((entry) => entry.file),
      expectedTests: PTY_SMOKE.flatMap((entry) => entry.tests).length,
      // Makes any capture taken outside a test fail loudly (evidence.mjs), so
      // an excluded case can never cost a module-scope capture.
      env: { GH_GLANCE_CAPTURE_REQUIRE_TEST: "1" },
      args: [
        "--test-concurrency=1",
        "--test-timeout=300000",
        ...PTY_SMOKE.flatMap((entry) => entry.tests
          .map((name) => `--test-name-pattern=^${escapeRegExp(name)}$`)),
      ],
    },
  };
}

export function validateSelections(found = discoverTests(), all = selections(found)) {
  const problems = [];
  const known = new Set([...found.unit, ...found.pty]);
  for (const [name, selection] of Object.entries(all)) {
    if (selection.files.length === 0) problems.push(`${name}: empty selection`);
    for (const file of selection.files) {
      if (!known.has(file)) problems.push(`${name}: unknown file ${file}`);
    }
  }
  const unitOwners = new Set(["fast", "recovery", "package"].flatMap((name) => all[name].files));
  for (const file of found.unit) {
    if (!unitOwners.has(file)) problems.push(`unowned unit test ${file}`);
  }
  for (const file of found.pty) {
    if (!all.pty.files.includes(file)) problems.push(`unowned terminal test ${file}`);
  }
  for (const file of all["pty:smoke"].files) {
    if (!all.pty.files.includes(file)) problems.push(`smoke file outside full PTY: ${file}`);
  }
  const shards = [...all["pty:governor"].files, ...all["pty:rest"].files].sort();
  if (JSON.stringify(shards) !== JSON.stringify([...all.pty.files].sort())) {
    problems.push("the PTY shards do not partition the full PTY selection");
  }
  return problems;
}

function commandFor(selection, extra = []) {
  return [process.execPath, "--test", ...extra, ...selection.args, ...selection.files];
}

// Profiles decide which selections a candidate needs. Unknown input is broad:
// the product is a single file, so no path rule can claim to understand a
// function-level diff of index.mjs; only a recorded independent review may
// classify such an edit as ordinary.
export const PROFILE_SELECTIONS = {
  docs: ["lint", "syntax", "package"],
  ordinary: ["lint", "syntax", "package", "fast", "pty:smoke"],
  broad: ["lint", "syntax", "package", "fast", "pty:smoke", "recovery", "efficiency", "pty"],
};

const BROAD_PATHS = [
  /^package(-lock)?\.json$/,
  /^scripts\//,
  /^\.github\/workflows\//,
  /^test\/fixtures\//,
  /^test\/pty\/(capture\.mjs|run\.sh|fixtures\/)/,
  /^eslint\.config\.js$/,
  /^\.npmrc$/,
];

// Unit test files with no accounting, scheduling, acquisition, identity,
// persistence, collector or oracle subject. A change to one of these is
// ordinary (fast runs it); any other test file is broad by uncertainty, like
// index.mjs, unless a recorded review classifies the change as ordinary.
const ORDINARY_TESTS = new Set(["args", "coverage-reporting", "lint-scope", "package-boundary", "package-check",
  "preferences", "runtime-coverage", "test-select"].map((name) => `test/${name}.test.mjs`));

const RANK = { docs: 0, ordinary: 1, broad: 2 };

function isDocumentation(path) {
  if (path === "LICENSE") return true;
  if (!path.endsWith(".md")) return false;
  return !/^(test|scripts)\//.test(path);
}

export function classifyChanges(paths, { reviewedOrdinary = null } = {}) {
  if (!Array.isArray(paths)) {
    return { profile: "broad", reasons: ["no diff base: complete change set unknown"] };
  }
  if (paths.length === 0) {
    return { profile: "broad", reasons: ["empty diff: nothing proves the candidate is unchanged"] };
  }
  const reasons = [];
  let profile = "docs";
  const raise = (next, reason) => {
    reasons.push(reason);
    if (RANK[next] > RANK[profile]) profile = next;
  };
  // Paths whose effect no file rule can bound: a recorded review may still
  // classify them ordinary, never silently.
  const uncertain = (path, why) => {
    if (reviewedOrdinary) raise("ordinary", `${path} classified ordinary by review ${reviewedOrdinary}`);
    else raise("broad", `${path} ${why} without a recorded ordinary review`);
  };
  for (const path of paths) {
    if (isDocumentation(path)) continue;
    if (BROAD_PATHS.some((pattern) => pattern.test(path))) {
      raise("broad", `${path} changes selection, fixture, workflow, runtime or package inputs`);
    } else if (ORDINARY_TESTS.has(path)) {
      raise("ordinary", `${path} is an ordinary unit test file (runs in fast)`);
    } else if (path === "index.mjs") {
      uncertain(path, "changed");
    } else if (/^test\/(pty\/)?[\w.-]+\.test\.mjs$/.test(path)) {
      uncertain(path, "is a test that may cover coordination, recovery or terminal behavior");
    } else {
      raise("broad", `${path} is not a known path`);
    }
  }
  if (reasons.length === 0) reasons.push("documentation-only allowlist");
  return { profile, reasons };
}

export function changedPaths(base, head) {
  const result = spawnSync("git", ["diff", "--name-only", `${base}...${head}`], {
    cwd: ROOT, encoding: "utf8",
  });
  if (result.status !== 0) return null;
  return result.stdout.split("\n").filter(Boolean);
}

function tapSummary(path) {
  try {
    const text = readFileSync(path, "utf8");
    const count = (label) => Number(text.match(new RegExp(`^# ${label} (\\d+)$`, "m"))?.[1] ?? Number.NaN);
    return { tests: count("tests"), pass: count("pass"), fail: count("fail"), skipped: count("skipped") };
  } catch {
    return null;
  }
}

function runSelection(name, selection) {
  const tap = join(mkdtempSync(join(tmpdir(), "gh-glance-select-")), "report.tap");
  const command = commandFor(selection, ["--test-reporter=spec", "--test-reporter-destination=stdout",
    "--test-reporter=tap", `--test-reporter-destination=${tap}`]);
  const started = Date.now();
  process.stdout.write([
    `## selection ${name}: ${selection.description}`,
    `runtime: node ${process.version} ${process.platform}-${process.arch}`,
    `files (${selection.files.length}): ${selection.files.join(" ")}`,
    `command: ${command.map((part) => part.startsWith(`${ROOT}/`) ? relative(ROOT, part) : part).join(" ")}`,
    "",
  ].join("\n"));
  // A runner started from inside another node:test file inherits its
  // NODE_TEST_CONTEXT and would silently skip every file; drop it so the
  // selection always really runs.
  const childEnv = { ...process.env, ...selection.env };
  delete childEnv.NODE_TEST_CONTEXT;
  const result = spawnSync(command[0], command.slice(1), { cwd: ROOT, stdio: "inherit", env: childEnv });
  const durationMs = Date.now() - started;
  let exitCode = result.status ?? (result.signal ? 128 : 1);
  const counts = tapSummary(tap);
  rmSync(dirname(tap), { recursive: true, force: true });
  // A name pattern or file list that matches nothing exits 0; that is not a pass.
  const expected = selection.expectedTests;
  if (exitCode === 0 && (!counts || !(counts.tests > 0) || (expected != null && counts.tests !== expected))) {
    process.stdout.write(`selection ${name} ran ${counts?.tests ?? "an unknown number of"} tests` +
      `${expected != null ? `, expected ${expected}` : ""}\n`);
    exitCode = 3;
  }
  process.stdout.write(`## selection ${name}: ${exitCode === 0 ? "pass" : "FAIL"} ` +
    `(exit ${exitCode}${result.signal ? `, signal ${result.signal}` : ""}) in ${(durationMs / 1000).toFixed(1)}s\n\n`);
  return { name, files: selection.files, exitCode, signal: result.signal ?? null, durationMs, counts };
}

export function writeAtomic(path, text) {
  const temporary = `${path}.${process.pid}.tmp`;
  writeFileSync(temporary, text);
  renameSync(temporary, path);
}

export function main(argv = process.argv.slice(2)) {
  const found = discoverTests();
  const all = selections(found);
  const problems = validateSelections(found, all);
  if (problems.length > 0) {
    process.stderr.write(`test selection inventory is invalid:\n${problems.join("\n")}\n`);
    return 2;
  }
  const { values, positionals } = parseArgs({ args: argv, allowPositionals: true, options: {
    base: { type: "string" }, head: { type: "string", default: "HEAD" },
    "reviewed-ordinary": { type: "string" }, receipt: { type: "string" },
  } });
  const [command, ...rest] = positionals;
  if (command === "list") {
    const names = rest.length > 0 ? rest : Object.keys(all);
    for (const name of names) {
      if (!all[name]) throw new Error(`unknown selection ${name}`);
      process.stdout.write(`${name}\t${commandFor(all[name]).slice(1).join(" ")}\n`);
    }
    return 0;
  }
  if (command === "plan") {
    const { base = null, head } = values;
    const paths = base ? changedPaths(base, head) : null;
    const decision = classifyChanges(paths, { reviewedOrdinary: values["reviewed-ordinary"] ?? null });
    process.stdout.write(`${JSON.stringify({ base, head, paths, ...decision,
      selections: PROFILE_SELECTIONS[decision.profile] }, null, 2)}\n`);
    return 0;
  }
  if (command === "run") {
    const { receipt } = values;
    if (rest.length === 0) throw new Error("run needs at least one selection");
    for (const name of rest) if (!all[name]) throw new Error(`unknown selection ${name}`);
    const results = rest.map((name) => runSelection(name, all[name]));
    const failed = results.filter((result) => result.exitCode !== 0);
    if (receipt) {
      writeAtomic(receipt, `${JSON.stringify({ schema: 1, runtime: process.version,
        platform: `${process.platform}-${process.arch}`, results }, null, 2)}\n`);
    }
    if (results.length > 1) {
      process.stdout.write(`## summary: ${results.map((result) => `${result.name}=${result.exitCode === 0 ? "pass" : "FAIL"}`).join(" ")}\n`);
    }
    return failed.length === 0 ? 0 : 1;
  }
  process.stderr.write("usage: test-select.mjs list|run|plan ...\n");
  return 2;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    process.exitCode = main();
  } catch (error) {
    process.stderr.write(`test-select: ${error.message}\n`);
    process.exitCode = 2;
  }
}
