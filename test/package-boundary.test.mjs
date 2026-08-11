import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import test from "node:test";

const execFileAsync = promisify(execFile);

async function run(command, args, options = {}) {
  return execFileAsync(command, args, {
    encoding: "utf8",
    maxBuffer: 10 * 1024 * 1024,
    timeout: 120_000,
    ...options,
  });
}

function parsePackManifest(stdout, packageName) {
  const payload = JSON.parse(stdout);
  const manifest = Array.isArray(payload) ? payload[0] : payload?.[packageName];
  assert.ok(manifest && typeof manifest === "object", "npm pack must report the package manifest");
  return manifest;
}

test("npm pack manifests support npm 11 and npm 12 JSON shapes", () => {
  const manifest = { filename: "gh-glance.tgz", files: [] };
  assert.deepEqual(parsePackManifest(JSON.stringify([manifest]), "gh-glance"), manifest);
  assert.deepEqual(
    parsePackManifest(JSON.stringify({ "gh-glance": manifest }), "gh-glance"),
    manifest,
  );
});

test("the installed package supports only the gh-glance executable", async () => {
  const root = await mkdtemp(join(tmpdir(), "gh-glance-package-test-"));
  try {
    const pack = await run(
      "npm",
      ["pack", "--ignore-scripts", "--json", "--pack-destination", root],
      { cwd: process.cwd() },
    );
    const manifest = parsePackManifest(pack.stdout, "gh-glance");
    const tarball = join(root, manifest.filename);
    const paths = manifest.files.map(({ path }) => path);

    for (const required of ["index.mjs", "README.md", "CHANGELOG.md", "LICENSE", "package.json"]) {
      assert.ok(paths.includes(required), `${required} must be published`);
    }
    assert.ok(paths.every((path) => !path.startsWith("test/")), "tests must stay out of the package");

    const installRoot = join(root, "installed");
    await run(
      "npm",
      [
        "install",
        "--ignore-scripts",
        "--no-audit",
        "--no-fund",
        "--no-package-lock",
        "--prefix",
        installRoot,
        tarball,
      ],
      { cwd: root },
    );

    const installedPackage = JSON.parse(
      await readFile(join(installRoot, "node_modules/gh-glance/package.json"), "utf8"),
    );
    assert.deepEqual(installedPackage.exports, {});

    const expectedVersion = installedPackage.version;
    const bin = join(installRoot, "node_modules/.bin/gh-glance");
    assert.equal((await run(bin, ["--version"], { cwd: installRoot })).stdout.trim(), expectedVersion);
    assert.equal(
      (await run("npx", ["--no-install", "gh-glance", "--version"], { cwd: installRoot })).stdout.trim(),
      expectedVersion,
    );

    for (const specifier of ["gh-glance", "gh-glance/index.mjs"]) {
      await assert.rejects(
        run(
          process.execPath,
          ["--input-type=module", "--eval", `import.meta.resolve(${JSON.stringify(specifier)})`],
          { cwd: installRoot },
        ),
        (error) => {
          assert.match(error.stderr, /ERR_PACKAGE_PATH_NOT_EXPORTED/);
          return true;
        },
      );
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
