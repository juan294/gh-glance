import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { once } from "node:events";
import { join } from "node:path";
import { test } from "node:test";

import { createCollectorService, normalizeCollectorConfig } from "../../index.mjs";
import { captureAsync, waitForAwk } from "./capture.mjs";

const ENTRY = new URL("../../index.mjs", import.meta.url).pathname;
const FIXTURES = new URL("./fixtures/", import.meta.url).pathname;
const CONFIG = { version: 1,
  providers: { personal: { type: "gh", host: "github.com" } },
  targets: [{ host: "github.com", repo: "acme/widget", provider: "personal" }] };

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

test("COL-05: serve and bridge run without a TTY or terminal escapes", async (t) => {
  const root = mkdtempSync("/tmp/ggc-pty-");
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const config = join(root, "collector.json");
  writeFileSync(config, JSON.stringify(CONFIG), { mode: 0o600 });
  chmodSync(config, 0o600);
  const env = { ...process.env, XDG_CONFIG_HOME: root };
  const service = spawn(process.execPath, [ENTRY, "--serve", "--config", config], {
    env, stdio: ["ignore", "pipe", "pipe"],
  });
  t.after(() => service.kill("SIGTERM"));
  let stderr = "";
  service.stderr.on("data", (chunk) => { stderr += chunk; });
  for (let index = 0; index < 100 && !stderr.includes("collector listening"); index += 1) {
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  assert.match(stderr, /collector listening/);
  assert.equal(stderr.includes(`${String.fromCharCode(27)}[`), false);
  assert.equal(service.stdout.readableLength, 0);

  const bridge = spawn(process.execPath, [ENTRY, "--collector-stdio"], {
    env, stdio: ["pipe", "pipe", "pipe"],
  });
  t.after(() => { if (bridge.exitCode === null) bridge.kill("SIGTERM"); });
  bridge.stdin.end('{"type":"hello","protocolVersion":1}\n');
  let output = "";
  bridge.stdout.on("data", (chunk) => { output += chunk; });
  await waitForExit(bridge);
  assert.match(output, /"type":"welcome"/);
  assert.equal(output.includes(`${String.fromCharCode(27)}[`), false);
  service.kill("SIGTERM");
  await waitForExit(service);
});

test("COL-05: Windows collector modes reject before endpoint creation", async () => {
  if (process.platform === "win32") return;
  const script = `import { createCollectorService } from ${JSON.stringify(new URL("../../index.mjs", import.meta.url).href)};
    await createCollectorService({ config:{}, runtime:{subscribe(){}}, platform:'win32' });`;
  await assert.rejects(new Promise((resolve, reject) => execFile(process.execPath,
    ["--input-type=module", "--eval", script], (error, stdout, stderr) =>
      error ? reject(Object.assign(error, { stderr })) : resolve(stdout))), /unsupported on Windows/);
});

test("COL-03: a real local dashboard renders shared collector data without GitHub preflight", async (t) => {
  const root = mkdtempSync("/tmp/ggc-dashboard-");
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const snapshot = { generation: 1, rows: [], pageInfo: { loadedPages: 1, hasNextPage: false },
    lastSuccessAt: Date.now(), lastChangedAt: Date.now(), nextDueAt: Date.now() + 60_000,
    hold: null, meta: { at: Date.now(), truncated: false }, securityNotes: [],
    securityBlind: false, capabilities: {} };
  const demands = [];
  const runtime = {
    subscribe({ resource, onSnapshot }) {
      queueMicrotask(() => onSnapshot(snapshot));
      return { updateDemand(demand) { demands.push({ resource, demand }); }, refresh() {}, inspect() {}, close() {} };
    },
    close() {},
  };
  const service = await createCollectorService({
    config: normalizeCollectorConfig(CONFIG),
    pathOptions: { env: { XDG_CONFIG_HOME: root }, platform: process.platform },
    runtime,
  });
  t.after(() => service.close());
  const result = await captureAsync({
    cols: 80, rows: 20, signal: "none", settle: 12, configHome: root,
    args: "--connect local --repo acme/widget --tab actions",
    stdin: waitForAwk('"$GH_GLANCE_CAPTURE_OUT"', 'index($0, "Shared") { ok=1 }') + "printf 2; sleep .3; printf q",
  });
  assert.ok(result.liveScreen.statusHistory.some((line) => /Shared/.test(line)));
  assert.ok(result.liveScreen.statusHistory.every((line) => !/Watching.*(?:stale|Disconnected)/i.test(line)));
  assert.doesNotMatch(result.raw, /API budget paused|budget-reset/);
  assert.ok(demands.some(({ resource, demand }) => resource === "actions" && demand.active === false));
  assert.ok(demands.some(({ resource, demand }) => resource === "issues" && demand.active === true));
});

test("COL-03: a cold local connection renders Disconnected before any snapshot", async (t) => {
  const root = mkdtempSync("/tmp/ggc-cold-");
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const result = await captureAsync({
    cols: 80, rows: 20, signal: "none", settle: 8, configHome: root,
    args: "--connect local --repo acme/widget --tab actions",
    stdin: waitForAwk('"$GH_GLANCE_CAPTURE_OUT"', 'index($0, "Disconnected") { ok=1 }') + "printf q",
  });
  assert.ok(result.liveScreen.statusHistory.some((line) => /Disconnected/.test(line)));
  assert.doesNotMatch(result.raw, /Watching.*Disconnected/);
});

test("COL-01/06: foreground collector performs governor-backed acquisition while the client makes zero gh calls", async (t) => {
  const root = mkdtempSync("/tmp/ggc-production-");
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const config = join(root, "collector.json");
  const serverCalls = join(root, "server.calls");
  const clientCalls = join(root, "client.calls");
  writeFileSync(config, JSON.stringify(CONFIG), { mode: 0o600 });
  const fixturePath = `${FIXTURES}:${process.env.PATH}`;
  const service = spawn(process.execPath, [ENTRY, "--serve", "--config", config], {
    env: { ...process.env, PATH: fixturePath, XDG_CONFIG_HOME: root, GH_CONFIG_DIR: root,
      GH_GLANCE_FIXTURE_LOG: serverCalls },
    stdio: ["ignore", "ignore", "pipe"],
  });
  t.after(() => service.kill("SIGTERM"));
  let stderr = "";
  service.stderr.on("data", (chunk) => { stderr += chunk; });
  for (let index = 0; index < 200 && !stderr.includes("collector listening"); index += 1) {
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  assert.match(stderr, /collector listening/);
  const result = await captureAsync({
    cols: 80, rows: 20, signal: "none", settle: 20, configHome: root,
    args: "--connect local --repo acme/widget --tab actions",
    env: { PATH: fixturePath, GH_GLANCE_FIXTURE_LOG: clientCalls },
    stdin: waitForAwk('"$GH_GLANCE_CAPTURE_OUT"', 'index($0, "Shared") && index($0, "ago") { ok=1 }', 200) +
      "sleep .2; printf q",
  });
  const serverLog = existsSync(serverCalls) ? readFileSync(serverCalls, "utf8") : "";
  const clientLog = existsSync(clientCalls) ? readFileSync(clientCalls, "utf8") : "";
  assert.ok(result.liveScreen.statusHistory.some((line) => /Shared/.test(line)),
    JSON.stringify({ statuses: result.liveScreen.statusHistory, serverLog, clientLog, stderr }));
  assert.match(serverLog, /(?:actions\/runs|issues\.page|pulls\.page)/);
  assert.equal(clientLog, "");
  service.kill("SIGTERM");
  await waitForExit(service);
});
