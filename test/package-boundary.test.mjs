import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
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

async function waitForOutput(child, stream, pattern) {
  let output = "";
  stream.on("data", (chunk) => { output += chunk; });
  for (let index = 0; index < 200 && !pattern.test(output); index += 1) {
    if (child.exitCode !== null) break;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.match(output, pattern);
  return output;
}

async function waitForExit(child, timeoutMs = 5_000) {
  if (child.exitCode !== null) return child.exitCode;
  let timer;
  try {
    return await Promise.race([
      once(child, "exit").then(([code]) => code),
      new Promise((_, reject) => { timer = setTimeout(() => reject(new Error("child exit timed out")), timeoutMs); }),
    ]);
  } finally {
    clearTimeout(timer);
  }
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

    assert.deepEqual(paths.toSorted(), [
      "CHANGELOG.md", "LICENSE", "README.md", "index.mjs", "package.json",
    ], "the package must contain only the executable and public documentation");

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
    assert.deepEqual(installedPackage.bin, { "gh-glance": "./index.mjs" });
    for (const script of [installedPackage.scripts.test, installedPackage.scripts["test:coverage"]]) {
      assert.ok(script.includes("--test-skip-pattern='E2E-'"),
        "ordinary test gates must exclude the dedicated E2E efficiency cases");
    }
    assert.equal(installedPackage.scripts["test:efficiency"],
      "node --test test/efficiency.test.mjs");

    const expectedVersion = installedPackage.version;
    const bin = join(installRoot, "node_modules/.bin/gh-glance");
    assert.equal((await run(bin, ["--version"], { cwd: installRoot })).stdout.trim(), expectedVersion);
    assert.equal(
      (await run("npx", ["--no-install", "gh-glance", "--version"], { cwd: installRoot })).stdout.trim(),
      expectedVersion,
    );
    const help = (await run(bin, ["--help"], { cwd: installRoot })).stdout;
    assert.match(help, /--serve --config (?:PATH|<path>)/);
    assert.match(help, /--connect local/);
    assert.match(help, /--connect ssh:<alias>/);
    assert.match(help, /--collector-stdio/);

    await assert.rejects(
      run(bin, [], { cwd: installRoot }),
      (error) => {
        assert.equal(error.code, 1);
        assert.match(error.stderr, /stdout is not a terminal/);
        return true;
      },
    );
    await assert.rejects(
      run(bin, ["--definitely-not-a-flag"], { cwd: installRoot }),
      (error) => {
        assert.equal(error.code, 2);
        return true;
      },
    );

    // Exercise the installed artifact's three Phase 8 entry routes. This is
    // intentionally more than a manifest/help check: the foreground process
    // owns the packaged socket, the packaged stdio bridge completes a real
    // handshake through it, and the packaged local-client route reaches its
    // dashboard boundary with a resolved offline target.
    // Unix-domain socket paths are short on macOS. Keep the runtime root out
    // of npm's already-long package test directory so this tests the artifact,
    // not the platform pathname ceiling.
    const configHome = await mkdtemp("/tmp/ggcp-package-");
    const configPath = join(root, "collector.json");
    await writeFile(configPath, JSON.stringify({
      version: 1,
      providers: { personal: { type: "gh", host: "github.com" } },
      targets: [{ host: "github.com", repo: "acme/widget", provider: "personal" }],
    }), { mode: 0o600 });
    const env = { ...process.env, XDG_CONFIG_HOME: configHome };
    const serve = spawn(bin, ["--serve", "--config", configPath], {
      cwd: installRoot, env, stdio: ["ignore", "ignore", "pipe"],
    });
    try {
      await waitForOutput(serve, serve.stderr, /collector listening/);
      const bridge = spawn(bin, ["--collector-stdio"], {
        cwd: installRoot, env, stdio: ["pipe", "pipe", "pipe"],
      });
      let bridgeOutput = "";
      bridge.stdout.on("data", (chunk) => { bridgeOutput += chunk; });
      bridge.stdin.end('{"type":"hello","protocolVersion":1}\n');
      try { await waitForExit(bridge); }
      finally { if (bridge.exitCode === null) bridge.kill("SIGTERM"); }
      assert.match(bridgeOutput, /"type":"welcome"/);

      const doctor = await run(bin, ["--connect", "local", "--repo", "acme/widget", "--doctor"], {
        cwd: installRoot, env,
      });
      assert.match(doctor.stdout, /local collector/i);
      const sshDoctor = await run(bin,
        ["--connect", "ssh:studio", "--repo", "acme/widget", "--doctor"],
        { cwd: installRoot, env });
      assert.match(sshDoctor.stdout, /SSH collector[\s\S]*studio/);
      await assert.rejects(
        run(bin, ["--connect", "local", "--repo", "acme/widget"], { cwd: installRoot, env }),
        (error) => {
          assert.match(error.stderr, /stdout is not a terminal/);
          return true;
        },
      );
    } finally {
      serve.kill("SIGTERM");
      if (serve.exitCode === null) await waitForExit(serve);
      await rm(configHome, { recursive: true, force: true });
    }

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
