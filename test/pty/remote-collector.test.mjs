import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { once } from "node:events";
import { join } from "node:path";
import { test } from "node:test";

import { captureAsync, waitForAwk } from "./capture.mjs";

const ENTRY = new URL("../../index.mjs", import.meta.url).pathname;
const FIXTURES = new URL("./fixtures/", import.meta.url).pathname;
const SSH_FIXTURE = new URL("../fixtures/ssh", import.meta.url).pathname;

async function waitForExit(child, timeoutMs = 5_000) {
  if (child.exitCode !== null || child.signalCode !== null) return child.exitCode;
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

test("SSH-01/05/07: three plus four remote panes share one stream and restore every terminal", async (t) => {
  const root = mkdtempSync("/tmp/ggr-");
  const clientRoots = Array.from({ length: 7 }, () => mkdtempSync("/tmp/ggrc-"));
  let service = null;
  t.after(async () => {
    if (service?.exitCode === null && service.signalCode === null) service.kill("SIGTERM");
    if (service) {
      try {
        await waitForExit(service);
      } catch {
        if (service.exitCode === null && service.signalCode === null) service.kill("SIGKILL");
        await waitForExit(service).catch(() => {});
      }
    }
    rmSync(root, { recursive: true, force: true });
    for (const clientRoot of clientRoots) rmSync(clientRoot, { recursive: true, force: true });
  });
  const bin = join(root, "bin");
  mkdirSync(bin);
  symlinkSync(ENTRY, join(bin, "gh-glance"));
  symlinkSync(SSH_FIXTURE, join(bin, "ssh"));
  chmodSync(SSH_FIXTURE, 0o755);
  const config = join(root, "collector.json");
  const serverCalls = join(root, "server.calls");
  const clientCalls = clientRoots.map((_, index) => join(root, `client-${index}.calls`));
  writeFileSync(config, JSON.stringify({
    version: 1,
    providers: { personal: { type: "gh", host: "github.com" } },
    targets: [{ host: "github.com", repo: "acme/widget", provider: "personal" }],
  }), { mode: 0o600 });
  const serviceEnv = { ...process.env, PATH: `${FIXTURES}:${process.env.PATH}`, HOME: root,
    XDG_CONFIG_HOME: root, GH_CONFIG_DIR: root, GH_GLANCE_FIXTURE_LOG: serverCalls };
  service = spawn(process.execPath, [ENTRY, "--serve", "--config", config], {
    env: serviceEnv, stdio: ["ignore", "ignore", "pipe"],
  });
  let stderr = "";
  service.stderr.on("data", (chunk) => { stderr += chunk; });
  for (let index = 0; index < 200 && !stderr.includes("collector listening"); index += 1) {
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  assert.match(stderr, /collector listening/);

  const groups = [[0, 1, 2], [3, 4, 5, 6]];
  const results = (await Promise.all(groups.map((group) => Promise.all(group.map((index) => captureAsync({
    cols: 80, rows: 20, signal: "none", settle: 20, configHome: clientRoots[index],
    args: "--connect ssh:studio --repo acme/widget --tab actions --background off --refresh 3600",
    env: { PATH: `${bin}:${FIXTURES}:${process.env.PATH}`, HOME: root,
      GH_TOKEN: `ghp_client_${index}_must_not_cross`, GH_GLANCE_FIXTURE_LOG: clientCalls[index] },
    stdin: waitForAwk('"$GH_GLANCE_CAPTURE_OUT"', 'index($0, "Shared") { ok=1 }', 200) +
      "sleep .2; printf q",
  })))))).flat();
  assert.equal(results.length, 7);
  for (const [index, result] of results.entries()) {
    assert.ok(result.liveScreen.statusHistory.some((line) => /Shared/.test(line)),
      JSON.stringify({ index, statuses: result.liveScreen.statusHistory, stderr }));
    assert.equal(result.altEnter, 1);
    assert.equal(result.altExit, 1);
    assert.equal(existsSync(clientCalls[index]) ? readFileSync(clientCalls[index], "utf8") : "", "");
    assert.doesNotMatch(result.raw, /ghp_client_|API budget paused|collector admission deferred/);
  }
  const actionsCalls = readFileSync(serverCalls, "utf8").split("\n")
    .filter((line) => line.includes("/actions/runs?"));
  assert.equal(actionsCalls.length, 1, readFileSync(serverCalls, "utf8"));
});
