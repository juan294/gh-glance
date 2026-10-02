import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import test from "node:test";

import { PACKAGE_FILES, exerciseInstalled, inspectTarball, packCheckout } from "../scripts/package-check.mjs";

const execFileAsync = promisify(execFile);

async function run(command, args, options = {}) {
  return execFileAsync(command, args, {
    encoding: "utf8",
    maxBuffer: 10 * 1024 * 1024,
    timeout: 120_000,
    ...options,
  });
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

// Exercises one exact tarball: GH_GLANCE_PACKAGE_TARBALL when a candidate job
// passes its already packed artifact (never repacked here), otherwise a fresh
// pack of this checkout for standalone use. Version, help, exit codes, bin
// linkage and the blocked import surface come from the shared helper; this file
// adds the collector entry routes that need a real installed runtime.
test("the installed package supports only the gh-glance executable", async () => {
  const root = await mkdtemp(join(tmpdir(), "gh-glance-package-test-"));
  let installRoot = null;
  try {
    if (process.env.GH_GLANCE_PACKAGE_REQUIRE_TARBALL === "1" && !process.env.GH_GLANCE_PACKAGE_TARBALL) {
      throw new Error("GH_GLANCE_PACKAGE_TARBALL is required here; a candidate check never repacks");
    }
    const tarball = process.env.GH_GLANCE_PACKAGE_TARBALL || await packCheckout(root);
    const expectedVersion = JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf8")).version;
    const inspected = inspectTarball(await readFile(tarball), { expectedVersion });
    assert.deepEqual(inspected.problems, [], "the package must contain only the executable and public documentation");
    assert.deepEqual(inspected.files, [...PACKAGE_FILES].sort());

    const installed = await exerciseInstalled(tarball, { expectedVersion, keep: true,
      expectedFiles: inspected.fileSha256 });
    installRoot = installed.installRoot;
    assert.deepEqual(installed.problems, []);
    assert.ok(installed.dependencies?.ink && installed.dependencies?.react,
      `fresh consumer install must resolve its runtime dependencies: ${JSON.stringify(installed.dependencies)}`);

    const bin = join(installRoot, "node_modules/.bin/gh-glance");
    assert.equal(
      (await run("npx", ["--no-install", "gh-glance", "--version"], { cwd: installRoot })).stdout.trim(),
      expectedVersion,
    );
    const help = installed.runtimes[0].help.stdout;
    assert.match(help, /--serve --config (?:PATH|<path>)/);
    assert.match(help, /--connect local/);
    assert.match(help, /--connect ssh:<alias>/);
    assert.match(help, /--collector-stdio/);

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

  } finally {
    await rm(root, { recursive: true, force: true });
    if (installRoot) await rm(installRoot, { recursive: true, force: true });
  }
});
