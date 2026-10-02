import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const scripts = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8")).scripts;
const lintArgs = scripts.lint.split(/\s+/).slice(1);
const targets = lintArgs.filter((arg) => !arg.startsWith("-") && !/^\d+$/.test(arg));

test("LINT-01 every tracked JavaScript file is inside an explicit lint target", () => {
  const tracked = spawnSync("git", ["ls-files", "*.js", "*.mjs", "*.cjs"], { cwd: ROOT, encoding: "utf8" });
  assert.equal(tracked.status, 0, tracked.stderr);
  assert.ok(!targets.includes("."), "lint must name its inputs, not the whole checkout");
  const uncovered = tracked.stdout.split("\n").filter(Boolean)
    .filter((file) => !targets.some((target) => file === target || file.startsWith(`${target}/`)));
  assert.deepEqual(uncovered, []);
});

test("LINT-02 scratch files are ignored while a real source diagnostic still fails", (t) => {
  const root = mkdtempSync(join(tmpdir(), "gh-glance-lint-scope-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  symlinkSync(join(ROOT, "node_modules"), join(root, "node_modules"));
  writeFileSync(join(root, "eslint.config.js"), readFileSync(join(ROOT, "eslint.config.js")));
  writeFileSync(join(root, "package.json"), JSON.stringify({ type: "module" }));
  writeFileSync(join(root, "index.mjs"), "export const ok = 1;\n");
  for (const target of targets.filter((target) => !/\.(m|c)?js$/.test(target))) {
    mkdirSync(join(root, target), { recursive: true });
    writeFileSync(join(root, target, "ok.mjs"), "export const ok = 1;\n");
  }
  writeFileSync(join(root, "scripts/planted.mjs"), "const unusedPlanted = 1;\n");
  mkdirSync(join(root, "docs/agents"), { recursive: true });
  writeFileSync(join(root, "docs/agents/scratch.mjs"), "const unusedScratch = 1;\n");
  const eslint = join(ROOT, "node_modules/.bin/eslint");
  const run = (args) => spawnSync(eslint, args, { cwd: root, encoding: "utf8" });

  const planted = run(lintArgs);
  assert.equal(planted.status, 1, planted.stdout + planted.stderr);
  assert.match(planted.stdout, /scripts\/planted\.mjs[\s\S]*unusedPlanted/);
  assert.doesNotMatch(planted.stdout, /scratch\.mjs/);

  rmSync(join(root, "scripts/planted.mjs"));
  const clean = run(lintArgs);
  assert.equal(clean.status, 0, clean.stdout + clean.stderr);
});
