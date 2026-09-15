import assert from "node:assert/strict";
import { spawn as spawnChild } from "node:child_process";
import { EventEmitter } from "node:events";
import { chmodSync, mkdtempSync, rmSync, symlinkSync } from "node:fs";
import { createConnection } from "node:net";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { test } from "node:test";

import {
  collectorSshArgv,
  collectorSshEnvironment,
  createCollectorAcquisitionRuntime,
  createCollectorService,
  createCollectorSourceAgeTracker,
  createSshCollectorClient,
  createSshCollectorTransport,
  encodeCollectorFrame,
  sshReconnectDelay,
  validateSshAlias,
  normalizeCollectorConfig,
  rowBrowserUrl,
} from "../index.mjs";

const EPOCH_ONE = "11111111-1111-4111-8111-111111111111";
const EPOCH_TWO = "22222222-2222-4222-8222-222222222222";
const DEMAND = { active: true, background: true, floorMs: 5000, pages: 1 };

async function within(promise, timeoutMs = 5_000) {
  let timer;
  try {
    return await Promise.race([
      promise,
      new Promise((_, reject) => { timer = setTimeout(() => reject(new Error("async test timed out")), timeoutMs); }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

class FakeChild extends EventEmitter {
  constructor() {
    super();
    this.stdin = new PassThrough();
    this.stdout = new PassThrough();
    this.stderr = new PassThrough();
    this.kills = [];
    this.exitCode = null;
  }
  kill(signal) { this.kills.push(signal); return true; }
}

test("SSH-02/07: alias validation, argv, and child environment are strict", () => {
  for (const alias of ["studio", "studio.local", "build_box-2", "A9"]) {
    assert.equal(validateSshAlias(alias), alias);
  }
  for (const alias of ["", "-oProxyCommand=x", "user@host", "host;touch", "host name", "../host"]) {
    assert.throws(() => validateSshAlias(alias), /SSH alias/);
  }
  assert.deepEqual(collectorSshArgv("studio"), [
    "-T", "-o", "BatchMode=yes", "-o", "ClearAllForwardings=yes",
    "-o", "ForwardAgent=no", "--", "studio", "gh-glance --collector-stdio",
  ]);
  assert.throws(() => collectorSshArgv("studio; shutdown"), /SSH alias/);

  const clean = collectorSshEnvironment({
    PATH: "/bin", HOME: "/home/me", USER: "me", LANG: "en_US.UTF-8", LC_ALL: "C",
    SSH_AUTH_SOCK: "/tmp/agent", TERM: "xterm", TMPDIR: "/tmp",
    GH_TOKEN: "ghp_secret", GH_CONFIG_DIR: "/private/gh", GITHUB_TOKEN: "secret",
    XDG_CONFIG_HOME: "/private/config", NODE_OPTIONS: "--inspect", RANDOM_SECRET: "no",
  });
  assert.deepEqual(clean, {
    PATH: "/bin", HOME: "/home/me", USER: "me", LANG: "en_US.UTF-8", LC_ALL: "C",
    SSH_AUTH_SOCK: "/tmp/agent", TERM: "xterm", TMPDIR: "/tmp",
  });
});

test("SSH-02/05/07: transport owns one exact ssh child and bounds redacted stderr", async () => {
  const child = new FakeChild();
  const calls = [];
  const diagnostics = [];
  const transport = createSshCollectorTransport({
    alias: "studio",
    env: { PATH: "/bin", HOME: "/home/me", GH_TOKEN: "ghp_DO_NOT_FORWARD" },
    spawn_(command, args, options) { calls.push({ command, args, options }); return child; },
    onDiagnostic: (message) => diagnostics.push(message),
  });
  assert.deepEqual(calls, [{
    command: "ssh",
    args: collectorSshArgv("studio"),
    options: { env: { PATH: "/bin", HOME: "/home/me" }, stdio: ["pipe", "pipe", "pipe"] },
  }]);
  const events = [];
  transport.on("connect", () => events.push("connect"));
  transport.on("data", (chunk) => events.push(String(chunk)));
  transport.on("close", () => events.push("close"));
  child.emit("spawn");
  child.stdout.write("frame\n");
  child.stderr.write(`bad ghp_${"A".repeat(36)} ${"x".repeat(20_000)}`);
  child.exitCode = 255;
  child.emit("close", 255, null);
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(events, ["connect", "frame\n", "close"]);
  assert.equal(diagnostics.length, 1);
  assert.ok(diagnostics[0].length <= 4096);
  assert.doesNotMatch(diagnostics[0], /ghp_/);

  const owned = new FakeChild();
  const second = createSshCollectorTransport({ alias: "studio", spawn_() { return owned; } });
  second.destroy();
  assert.deepEqual(owned.kills, ["SIGTERM"]);

  const failed = new FakeChild();
  const failures = [];
  createSshCollectorTransport({ alias: "studio", spawn_() { return failed; },
    onDiagnostic: (message) => failures.push(message) });
  failed.emit("spawn");
  failed.exitCode = 255;
  failed.emit("close", 255, null);
  assert.match(failures[0], /SSH connection closed/);

  const broken = new FakeChild();
  const brokenTransport = createSshCollectorTransport({ alias: "studio", spawn_() { return broken; } });
  let closed = 0;
  brokenTransport.on("close", () => { closed += 1; });
  broken.emit("spawn");
  broken.stdin.emit("error", new Error("write EPIPE"));
  assert.deepEqual(broken.kills, ["SIGTERM"]);
  broken.emit("close", null, "SIGTERM");
  assert.equal(closed, 1);
});

test("SSH-03/04: reconnect retains same-epoch fences and adopts only a new epoch", () => {
  assert.deepEqual(Array.from({ length: 8 }, (_, attempt) =>
    sshReconnectDelay(attempt, { random: () => 0 })),
  [1000, 2000, 4000, 8000, 16000, 30000, 30000, 30000]);
  assert.equal(sshReconnectDelay(5, { random: () => 1 }), 31000);

  class FakeTransport extends EventEmitter {
    writable = true;
    writes = [];
    write(value) { this.writes.push(JSON.parse(String(value))); return true; }
    destroy() { if (!this.writable) return; this.writable = false; this.emit("close"); }
  }
  const transports = [];
  const timers = [];
  const ready = [];
  const snapshots = [];
  const client = createSshCollectorClient({
    alias: "studio",
    createTransport() { const value = new FakeTransport(); transports.push(value); return value; },
    random: () => 0,
    setTimeout(callback, delay) { const timer = { callback, delay, unref() {} }; timers.push(timer); return timer; },
    clearTimeout() {},
    onReady: (value) => ready.push(value),
  });
  client.subscribe({ id: "one", host: "github.com", repo: "acme/widget", resource: "actions",
    demand: DEMAND, onSnapshot: (snapshot) => snapshots.push(snapshot.generation) });
  transports[0].emit("connect");
  transports[0].emit("data", Buffer.from(encodeCollectorFrame({ type: "welcome", protocolVersion: 1,
    serverEpoch: EPOCH_ONE, capabilities: { chunks: true, maxSubscriptions: 64 } })));
  transports[0].emit("data", Buffer.from(encodeCollectorFrame({ type: "snapshot", id: "one",
    serverEpoch: EPOCH_ONE, generation: 5, serverNow: 1_100, snapshot: snapshot(5, 1000) })));
  transports[0].destroy();
  assert.equal(timers.at(-1).delay, 1000);
  timers.at(-1).callback();
  transports[1].emit("connect");
  transports[1].emit("data", Buffer.from(encodeCollectorFrame({ type: "welcome", protocolVersion: 1,
    serverEpoch: EPOCH_ONE, capabilities: { chunks: true, maxSubscriptions: 64 } })));
  for (const generation of [4, 5, 6]) {
    transports[1].emit("data", Buffer.from(encodeCollectorFrame({ type: "snapshot", id: "one",
      serverEpoch: EPOCH_ONE, generation, serverNow: 1_200,
      snapshot: snapshot(generation, 1100) })));
  }
  assert.deepEqual(snapshots, [5, 6]);
  assert.equal(transports[1].writes.filter((frame) => frame.type === "subscribe").length, 1);
  transports[1].destroy();
  timers.at(-1).callback();
  transports[2].emit("connect");
  transports[2].emit("data", Buffer.from(encodeCollectorFrame({ type: "snapshot", id: "one",
    serverEpoch: EPOCH_ONE, generation: 6, serverNow: 1_200, snapshot: snapshot(6, 1100) })));
  transports[2].emit("data", Buffer.from(encodeCollectorFrame({ type: "welcome", protocolVersion: 1,
    serverEpoch: EPOCH_TWO, capabilities: { chunks: true, maxSubscriptions: 64 } })));
  transports[2].emit("data", Buffer.from(encodeCollectorFrame({ type: "snapshot", id: "one",
    serverEpoch: EPOCH_ONE, generation: 7, serverNow: 1_300, snapshot: snapshot(7, 1200) })));
  transports[2].emit("data", Buffer.from(encodeCollectorFrame({ type: "snapshot", id: "one",
    serverEpoch: EPOCH_TWO, generation: 1, serverNow: 1_300, snapshot: snapshot(1, 1200) })));
  assert.deepEqual(snapshots, [5, 6, 1]);
  assert.deepEqual(ready, [true, false, true, false, true]);
  assert.equal(transports[2].writes.filter((frame) => frame.type === "subscribe").length, 1);
  client.close();
});

test("SSH-03: handshake timeout and mismatch preserve retained rows and source age", () => {
  class FakeTransport extends EventEmitter {
    writable = true;
    write() { return true; }
    destroy() { if (!this.writable) return; this.writable = false; this.emit("close"); }
  }
  const transports = [];
  const timers = [];
  let retained = null;
  const client = createSshCollectorClient({
    alias: "studio", random: () => 0, handshakeTimeoutMs: 10,
    createTransport() { const value = new FakeTransport(); transports.push(value); return value; },
    setTimeout(callback, delay) {
      const timer = { callback, delay, active: true, unref() {} };
      timers.push(timer);
      return timer;
    },
    clearTimeout(timer) { timer.active = false; },
  });
  client.subscribe({ id: "one", host: "github.com", repo: "acme/widget", resource: "actions",
    demand: DEMAND, onSnapshot: (value, receipt) => { retained = {
      generation: value.generation, sourceAgeMs: receipt.sourceAgeMs,
    }; } });
  transports[0].emit("connect");
  transports[0].emit("data", Buffer.from(encodeCollectorFrame({ type: "welcome", protocolVersion: 1,
    serverEpoch: EPOCH_ONE, capabilities: { chunks: true, maxSubscriptions: 64 } })));
  transports[0].emit("data", Buffer.from(encodeCollectorFrame({ type: "snapshot", id: "one",
    serverEpoch: EPOCH_ONE, generation: 5, serverNow: 1_100, snapshot: snapshot(5, 1_000) })));
  assert.deepEqual(retained, { generation: 5, sourceAgeMs: 100 });
  transports[0].destroy();
  timers.find((timer) => timer.active && timer.delay === 1000).callback();
  transports[1].emit("connect");
  timers.find((timer) => timer.active && timer.delay === 10).callback();
  assert.equal(transports[1].writable, false);
  assert.deepEqual(retained, { generation: 5, sourceAgeMs: 100 });
  timers.find((timer) => timer.active && timer.delay === 2000).callback();
  transports[2].emit("connect");
  transports[2].emit("data", Buffer.from(encodeCollectorFrame({ type: "welcome", protocolVersion: 99,
    serverEpoch: EPOCH_ONE, capabilities: { chunks: true, maxSubscriptions: 64 } })));
  assert.equal(transports[2].writable, false);
  assert.deepEqual(retained, { generation: 5, sourceAgeMs: 100 });
  client.close();
});

test("SSH-06: source age cannot shrink for the same observation across skew, reconnect, or restart", () => {
  let wall = 10_000;
  let mono = 100;
  const tracker = createCollectorSourceAgeTracker({ now: () => wall, monotonicNow: () => mono });
  assert.equal(tracker.observe({ lastSuccessAt: 8_000, serverNow: 10_000 }), 2_000);
  wall = 9_000;
  mono = 600;
  assert.equal(tracker.current(), 2_500);
  assert.equal(tracker.observe({ lastSuccessAt: 8_000, serverNow: 9_500 }), 2_500);
  assert.equal(tracker.observe({ lastSuccessAt: 9_400, serverNow: 9_500 }), 100);

  const cold = createCollectorSourceAgeTracker({ now: () => 4_000, monotonicNow: () => 0,
    checkpoint: { lastSuccessAt: 8_000, ageMs: 3_000, clientCheckpointAt: 5_000 } });
  assert.equal(cold.current(), 3_000, "backward wall clock cannot make cached evidence younger");
  wall = 12_000;
  const forward = createCollectorSourceAgeTracker({ now: () => wall, monotonicNow: () => 0,
    checkpoint: { lastSuccessAt: 8_000, ageMs: 3_000, clientCheckpointAt: 10_000 } });
  assert.equal(forward.current(), 5_000);
});

test("SSH-06: remote rows open only validated HTTPS pages on the requested target host", () => {
  assert.equal(rowBrowserUrl("issues", { url: "https://github.com/acme/widget/issues/7" },
    { host: "github.com" }), "https://github.com/acme/widget/issues/7");
  for (const url of ["http://github.com/acme/widget/issues/7", "file:///etc/passwd",
    "javascript:alert(1)", "https://evil.example/acme/widget/issues/7"]) {
    assert.equal(rowBrowserUrl("issues", { url }, { host: "github.com" }), null);
  }
});

test("SSH-06: protocol subscription carries cold age into its first same-source snapshot", () => {
  class FakeTransport extends EventEmitter {
    writable = true;
    write() { return true; }
    destroy() { this.writable = false; this.emit("close"); }
  }
  const transport = new FakeTransport();
  const receipts = [];
  const client = createSshCollectorClient({
    alias: "studio", createTransport: () => transport,
    now: () => 20_000, monotonicNow: () => 500,
    setTimeout() { return { unref() {} }; }, clearTimeout() {},
  });
  client.subscribe({ id: "one", host: "github.com", repo: "acme/widget", resource: "actions", demand: DEMAND,
    sourceCheckpoint: { lastSuccessAt: 8_000, ageMs: 6_000, clientCheckpointAt: 19_000 },
    onSnapshot(_value, receipt) { receipts.push(receipt.sourceAgeMs); } });
  transport.emit("connect");
  transport.emit("data", Buffer.from(encodeCollectorFrame({ type: "welcome", protocolVersion: 1,
    serverEpoch: EPOCH_ONE, capabilities: { chunks: true, maxSubscriptions: 64 } })));
  transport.emit("data", Buffer.from(encodeCollectorFrame({ type: "snapshot", id: "one",
    serverEpoch: EPOCH_ONE, generation: 1, serverNow: 20_000, snapshot: snapshot(1, 8_000) })));
  assert.deepEqual(receipts, [12_000]);
  client.close();
});

function snapshot(generation, lastSuccessAt) {
  return {
    resource: "actions", generation, rows: [], pageInfo: { loadedPages: 1, hasNextPage: false },
    lastSuccessAt, lastChangedAt: lastSuccessAt, nextDueAt: lastSuccessAt + 5000,
    hold: null, meta: { at: lastSuccessAt, truncated: false }, securityNotes: [],
    securityBlind: false, capabilities: {},
  };
}

test("SSH-04: a real service restart resubscribes once without duplicating a completed fetch", async (t) => {
  const root = mkdtempSync("/tmp/ggrs-");
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const config = normalizeCollectorConfig({
    version: 1,
    providers: { personal: { type: "gh", host: "github.com" } },
    targets: [{ host: "github.com", repo: "acme/widget", provider: "personal" }],
  });
  const pathOptions = { env: { XDG_CONFIG_HOME: root }, platform: process.platform, home: root };
  const identity = { host: "github.com", kind: "user", id: 7, login: "octo",
    quotaKey: "q".repeat(64), accessKey: "a".repeat(64), credentialKey: "c".repeat(64),
    generation: 1, observedAt: 1 };
  let starts = 0;
  const makeRuntime = () => createCollectorAcquisitionRuntime({
    config, pathOptions,
    resolveProvider: async () => identity,
    resolveTargetIdentity: async () => ({ id: "R_1", nameWithOwner: "acme/widget" }),
    async produce({ markStarted }) {
      starts += 1;
      await markStarted();
      return { ...snapshot(1, Date.now()), nextDueAt: Date.now() + 60_000,
        raw: "[]", entities: [], requestMetrics: { httpRequests: 1, rest200: 1, coreUnits: 1 },
        uncertainReceipts: [], repositoryIdentity: { id: "R_1", nameWithOwner: "acme/widget" } };
    },
  });
  let service = await createCollectorService({ config, runtime: makeRuntime(), pathOptions });
  t.after(async () => { await service?.close(); });
  const epochs = [];
  let resolveFirst;
  let resolveSecond;
  const first = new Promise((resolve) => { resolveFirst = resolve; });
  const second = new Promise((resolve) => { resolveSecond = resolve; });
  const client = createSshCollectorClient({
    alias: "studio", random: () => 0,
    createTransport: () => createConnection(service.socketPath),
  });
  t.after(() => client.close());
  client.subscribe({ id: "one", host: "github.com", repo: "acme/widget", resource: "actions", demand: DEMAND,
    onSnapshot(_value, receipt) {
      epochs.push(receipt.serverEpoch);
      if (epochs.length === 1) resolveFirst();
      if (epochs.length === 2) resolveSecond();
    } });
  await within(first);
  const firstEpoch = service.serverEpoch;
  await service.close();
  service = await createCollectorService({ config, runtime: makeRuntime(), pathOptions });
  await within(second);
  assert.notEqual(service.serverEpoch, firstEpoch);
  assert.equal(epochs[0], firstEpoch);
  assert.ok(epochs.slice(1).every((epoch) => epoch === service.serverEpoch));
  assert.equal(starts, 1);
});

test("SSH-05/07: one in-flight client quits while another bridge completes", async (t) => {
  const root = mkdtempSync("/tmp/ggs-");
  const bin = join(root, "bin");
  const config = normalizeCollectorConfig({
    version: 1,
    providers: { personal: { type: "gh", host: "github.com" } },
    targets: [{ host: "github.com", repo: "acme/widget", provider: "personal" }],
  });
  t.after(() => rmSync(root, { recursive: true, force: true }));
  await import("node:fs/promises").then(({ mkdir }) => mkdir(bin));
  symlinkSync(new URL("../index.mjs", import.meta.url).pathname, join(bin, "gh-glance"));
  symlinkSync(new URL("./fixtures/ssh", import.meta.url).pathname, join(bin, "ssh"));
  chmodSync(new URL("./fixtures/ssh", import.meta.url).pathname, 0o755);
  let starts = 0;
  let releaseProducer;
  let markProducerStarted;
  const producerStarted = new Promise((resolve) => { markProducerStarted = resolve; });
  const producerGate = new Promise((resolve) => { releaseProducer = resolve; });
  let markAllSubscribed;
  const allSubscribed = new Promise((resolve) => { markAllSubscribed = resolve; });
  const identity = { host: "github.com", kind: "user", id: 7, login: "octo",
    quotaKey: "q".repeat(64), accessKey: "a".repeat(64), credentialKey: "c".repeat(64),
    generation: 1, observedAt: 1 };
  const acquisitionRuntime = createCollectorAcquisitionRuntime({
    config,
    pathOptions: { env: { XDG_CONFIG_HOME: root }, platform: process.platform, home: root },
    resolveProvider: async () => identity,
    resolveTargetIdentity: async () => ({ id: "R_1", nameWithOwner: "acme/widget" }),
    async produce({ markStarted, signal }) {
      starts += 1;
      await markStarted();
      markProducerStarted();
      await Promise.race([producerGate, new Promise((_, reject) => signal.addEventListener("abort", () => {
        const error = new Error("aborted");
        error.name = "AbortError";
        reject(error);
      }, { once: true }))]);
      return { ...snapshot(1, Date.now()), raw: "[]", entities: [],
        requestMetrics: { httpRequests: 1, rest200: 1, coreUnits: 1 },
        uncertainReceipts: [], repositoryIdentity: { id: "R_1", nameWithOwner: "acme/widget" } };
    },
  });
  let subscriptionCount = 0;
  const runtime = {
    ...acquisitionRuntime,
    subscribe(options) {
      const handle = acquisitionRuntime.subscribe(options);
      subscriptionCount += 1;
      if (subscriptionCount === 2) markAllSubscribed();
      return handle;
    },
  };
  const service = await createCollectorService({ config, runtime,
    pathOptions: { env: { XDG_CONFIG_HOME: root }, platform: process.platform, home: root } });
  t.after(() => service.close());
  const children = [];
  const clients = Array.from({ length: 2 }, (_, index) => createSshCollectorClient({
    alias: `host-${index}`,
    env: { PATH: `${bin}:${process.env.PATH}`, HOME: root, GH_TOKEN: `ghp_client_${index}`,
      XDG_CONFIG_HOME: join(root, `client-${index}`) },
    spawn_(command, args, options) {
      const child = spawnChild(command, args, options);
      children[index] = child;
      return child;
    },
  }));
  t.after(() => clients.forEach((client) => client.close()));
  let markFollower;
  const follower = new Promise((resolve) => { markFollower = resolve; });
  const received = clients.map((client, index) => new Promise((resolve) => {
    client.subscribe({ id: `client-${index}`, host: "github.com", repo: "acme/widget", resource: "actions",
      demand: DEMAND, onSnapshot: resolve,
      onHold(hold) { if (hold === "shared-wait") markFollower(index); } });
  }));
  await within(allSubscribed).catch(() => { throw new Error(`service saw ${subscriptionCount}/2 subscriptions`); });
  await producerStarted;
  const followerIndex = await within(follower);
  const firstChildExit = new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error("owned SSH child did not exit")), 5_000);
    children[followerIndex].once("exit", (code, signal) => { clearTimeout(timeout); resolve({ code, signal }); });
  });
  clients[followerIndex].close();
  const exited = await firstChildExit;
  assert.equal(exited.signal, "SIGTERM");
  releaseProducer();
  await within(received[1 - followerIndex]).catch(() => { throw new Error("remaining SSH client did not complete"); });
  assert.equal(starts, 1);
  assert.equal(service.serverEpoch.length > 0, true);
});
