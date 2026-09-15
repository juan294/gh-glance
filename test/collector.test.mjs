import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync,
  statSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createConnection } from "node:net";
import { EventEmitter, once } from "node:events";
import { test } from "node:test";

import {
  abortableDelay,
  awaitCollectorReservation,
  acquisitionQueryForTab,
  acquisitionStorePath,
  collectorPublicationFromResult,
  createAcquisitionEngine,
  createCollectorAcquisitionRuntime,
  collectorSocketPath,
  createCollectorFrameDecoder,
  createCollectorService,
  encodeCollectorFrame,
  loadCollectorConfig,
  loadAcquisitionStore,
  normalizeCollectorConfig,
  runCollectorStdioBridge,
} from "../index.mjs";

const CONFIG = {
  version: 1,
  providers: { personal: { type: "gh", host: "github.com" } },
  targets: [{ host: "github.com", repo: "acme/widget", provider: "personal" }],
};

test("COL-02/07: collector config is strict, private, and provider fenced", (t) => {
  const root = mkdtempSync(join(tmpdir(), "gh-glance-collector-config-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const path = join(root, "collector.json");
  writeFileSync(path, JSON.stringify(CONFIG), { mode: 0o600 });
  assert.equal(loadCollectorConfig(path).ok, true);
  assert.equal(normalizeCollectorConfig({ ...CONFIG, extra: true }), null);
  assert.equal(normalizeCollectorConfig({ ...CONFIG,
    targets: [...CONFIG.targets, { ...CONFIG.targets[0], provider: "other" }] }), null);
  assert.equal(normalizeCollectorConfig({ ...CONFIG,
    targets: [{ ...CONFIG.targets[0], provider: "missing" }] }), null);
  chmodSync(path, 0o644);
  assert.equal(loadCollectorConfig(path).reason, "permissions");
  const link = join(root, "collector-link.json");
  symlinkSync(path, link);
  assert.equal(loadCollectorConfig(link).reason, "unreadable");
  assert.equal(collectorSocketPath({ env: { XDG_CONFIG_HOME: root }, platform: "linux" }),
    join(root, "gh-glance", "collector-v1.sock"));
});

function connect(path) {
  return new Promise((resolve, reject) => {
    const socket = createConnection(path);
    socket.once("error", reject);
    socket.once("connect", () => resolve(socket));
  });
}

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

test("COL-01: a deferred collector admission releases its exact intent before retry", async () => {
  const intentId = "11111111-1111-4111-8111-111111111111";
  const cancelled = [];
  await assert.rejects(
    awaitCollectorReservation({
      scope: {}, leaseId: "22222222-2222-4222-8222-222222222222",
      operation: "tab:actions", priority: "active", now: () => 1_000,
      waitMs: 2_000,
      admit: () => ({ ok: true, value: { status: "waiting",
        reservationId: `reservation:${intentId}`, notBefore: 4_000 } }),
      cancel(_scope, id) { cancelled.push(id); return { ok: true }; },
    }),
    (error) => error.notStarted === true && error.retryAt === 4_000,
  );
  assert.deepEqual(cancelled, [intentId]);
});

test("COL-05: stdio bridge finalizes once and removes listeners after failure", async () => {
  class FakeSocket extends EventEmitter {
    writable = true;
    destroys = 0;
    write() { return true; }
    destroy() { this.destroys += 1; this.writable = false; }
    end() {}
  }
  class FakeInput extends EventEmitter { pause() {} resume() {} }
  class FakeOutput extends EventEmitter { write() { return true; } }
  const socket = new FakeSocket();
  const input = new FakeInput();
  const output = new FakeOutput();
  let stderr = "";
  const bridge = runCollectorStdioBridge({
    input, output, stderr: { write(value) { stderr += value; } },
    createConnection_() { return socket; },
  });
  socket.emit("connect");
  await new Promise((resolve) => setImmediate(resolve));
  input.emit("error", new Error("bridge failed"));
  socket.emit("close");
  await assert.rejects(bridge, /bridge failed/);
  assert.equal(socket.destroys, 1);
  assert.equal(stderr.split("\n").filter(Boolean).length, 1);
  assert.equal(input.listenerCount("data") + input.listenerCount("end") + input.listenerCount("error"), 0);
  assert.equal(socket.listenerCount("data") + socket.listenerCount("drain") + socket.listenerCount("close") +
    socket.listenerCount("error"), 0);
  assert.equal(output.listenerCount("drain"), 0);
});

test("COL-01/02/03: twelve clients share one query and invalid input starts no work", async (t) => {
  const root = mkdtempSync("/tmp/ggc-service-");
  t.after(() => rmSync(root, { recursive: true, force: true }));
  let starts = 0;
  const refreshes = [];
  const subscribers = new Map();
  const runtime = {
    subscribe({ target, resource, demand: _demand, onSnapshot }) {
      const key = `${target.host}/${target.repo}/${resource}`;
      let entry = subscribers.get(key);
      if (!entry) {
        starts += 1;
        entry = { refs: 0, listeners: new Set() };
        subscribers.set(key, entry);
      }
      entry.refs += 1;
      entry.listeners.add(onSnapshot);
      queueMicrotask(() => onSnapshot({ resource, generation: 1, rows: [], pageInfo: null,
        lastSuccessAt: 10, lastChangedAt: 10, nextDueAt: 20, hold: null }));
      return { updateDemand() {}, refresh(force) { refreshes.push(force); }, inspect() {}, close() {
        entry.listeners.delete(onSnapshot);
        entry.refs -= 1;
      } };
    },
    close() {},
  };
  const service = await createCollectorService({
    config: normalizeCollectorConfig(CONFIG),
    pathOptions: { env: { XDG_CONFIG_HOME: root }, platform: "linux" },
    runtime,
  });
  t.after(async () => service.close());

  const sockets = await Promise.all(Array.from({ length: 12 }, () => connect(service.socketPath)));
  t.after(() => sockets.forEach((socket) => socket.destroy()));
  const snapshots = sockets.map((socket, index) => new Promise((resolve, reject) => {
    const decoder = createCollectorFrameDecoder({
      onFrame(frame) {
        if (frame.type === "snapshot") resolve(frame);
        if (frame.type === "error") reject(new Error(frame.code));
      },
      onError: reject,
    });
    socket.on("data", (chunk) => decoder.push(chunk));
    socket.write(encodeCollectorFrame({ type: "hello", protocolVersion: 1 }));
    socket.write(encodeCollectorFrame({ type: "subscribe", id: `client-${index}`,
      host: "github.com", repo: "acme/widget", resource: "actions",
      demand: { active: true, background: true, floorMs: 5000, pages: 1 } }));
  }));
  const received = await within(Promise.all(snapshots));
  assert.equal(starts, 1);
  assert.equal(new Set(received.map((frame) => frame.snapshot.lastSuccessAt)).size, 1);
  sockets[0].write(encodeCollectorFrame({ type: "refresh", id: "client-0", force: false }));
  sockets[0].write(encodeCollectorFrame({ type: "refresh", id: "client-0", force: true }));
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.deepEqual(refreshes, [false, true]);

  const hostile = await connect(service.socketPath);
  hostile.write(encodeCollectorFrame({ type: "hello", protocolVersion: 1 }));
  hostile.write(encodeCollectorFrame({ type: "subscribe", id: "bad", host: "github.com",
    repo: "other/repo", resource: "actions", demand: { active: true, background: true, floorMs: 5000, pages: 1 } }));
  await once(hostile, "data");
  hostile.destroy();
  assert.equal(starts, 1);
});

test("COL-04: duplicate startup fails and close removes only its owned socket", async (t) => {
  const root = mkdtempSync("/tmp/ggc-lock-");
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const options = { config: normalizeCollectorConfig(CONFIG),
    pathOptions: { env: { XDG_CONFIG_HOME: root }, platform: "linux" },
    runtime: { subscribe() { throw new Error("unused"); }, close() {} } };
  const first = await createCollectorService(options);
  await assert.rejects(createCollectorService(options), /already running/);
  await first.close();
  const second = await createCollectorService(options);
  await second.close();
});

test("COL-04: stale ownership is recovered only with dead-owner and inode evidence", async (t) => {
  const root = mkdtempSync("/tmp/ggc-stale-");
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const pathOptions = { env: { XDG_CONFIG_HOME: root }, platform: "linux" };
  const endpoint = collectorSocketPath(pathOptions);
  mkdirSync(join(root, "gh-glance"), { mode: 0o700 });
  writeFileSync(`${endpoint}.lock`, JSON.stringify({ pid: 99999999, nonce: "old", serverEpoch: "old" }),
    { mode: 0o600 });
  const runtime = { subscribe() { throw new Error("unused"); }, close() {} };
  const service = await createCollectorService({ config: normalizeCollectorConfig(CONFIG), pathOptions, runtime,
    kill() { const error = new Error("dead"); error.code = "ESRCH"; throw error; } });
  await service.close();

  const active = await createCollectorService({ config: normalizeCollectorConfig(CONFIG), pathOptions, runtime });
  writeFileSync(`${endpoint}.lock`, JSON.stringify({ pid: 99999999, nonce: "forged", serverEpoch: "old" }),
    { mode: 0o600 });
  await assert.rejects(createCollectorService({ config: normalizeCollectorConfig(CONFIG), pathOptions, runtime,
    kill() { const error = new Error("dead"); error.code = "ESRCH"; throw error; } }), /already active/);
  const socket = await connect(endpoint);
  socket.destroy();
  await active.close();
});

test("COL-04: collector root symlinks are rejected before chmod or endpoint creation", async (t) => {
  const root = mkdtempSync("/tmp/ggc-root-");
  const target = mkdtempSync("/tmp/ggc-root-target-");
  t.after(() => { rmSync(root, { recursive: true, force: true }); rmSync(target, { recursive: true, force: true }); });
  symlinkSync(target, join(root, "gh-glance"));
  await assert.rejects(createCollectorService({
    config: normalizeCollectorConfig(CONFIG),
    pathOptions: { env: { XDG_CONFIG_HOME: root }, platform: "linux" },
    runtime: { subscribe() { throw new Error("unused"); }, close() {} },
  }), /privately owned/);
});

test("COL-04: shutdown preserves replacement lock and socket paths it does not own", async (t) => {
  const root = mkdtempSync("/tmp/ggc-replaced-");
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const pathOptions = { env: { XDG_CONFIG_HOME: root }, platform: "linux" };
  const runtime = { subscribe() { throw new Error("unused"); }, async close() {} };
  const service = await createCollectorService({ config: normalizeCollectorConfig(CONFIG), pathOptions, runtime });
  unlinkSync(`${service.socketPath}.lock`);
  writeFileSync(`${service.socketPath}.lock`, JSON.stringify({ pid: process.pid, nonce: "replacement" }), { mode: 0o600 });
  unlinkSync(service.socketPath);
  writeFileSync(service.socketPath, "replacement", { mode: 0o600 });
  await service.close();
  assert.equal(existsSync(service.socketPath), true);
  assert.equal(readFileSync(service.socketPath, "utf8"), "replacement");
  assert.match(readFileSync(`${service.socketPath}.lock`, "utf8"), /replacement/);
});

test("COL-04: listen and chmod startup failures close runtime and remove only owned artifacts", async (t) => {
  for (const stage of ["listen", "chmod"]) {
    const root = mkdtempSync(`/tmp/ggc-start-${stage}-`);
    t.after(() => rmSync(root, { recursive: true, force: true }));
    const pathOptions = { env: { XDG_CONFIG_HOME: root }, platform: "linux" };
    let runtimeClosed = 0;
    const runtime = { subscribe() {}, async close() { runtimeClosed += 1; } };
    const options = { config: normalizeCollectorConfig(CONFIG), pathOptions, runtime };
    if (stage === "listen") {
      class FailingServer extends EventEmitter {
        listen() { queueMicrotask(() => this.emit("error", new Error("listen failed"))); }
        close(callback) { callback(); }
      }
      options.createServer = () => new FailingServer();
    } else {
      options.chmod = () => { throw new Error("chmod failed"); };
    }
    await assert.rejects(createCollectorService(options), new RegExp(`${stage} failed`));
    assert.equal(runtimeClosed, 1);
    const endpoint = collectorSocketPath(pathOptions);
    assert.equal(existsSync(endpoint), false);
    assert.equal(existsSync(`${endpoint}.lock`), false);
  }
});

test("COL-04: close cleans owned endpoint and lock even when runtime close rejects", async (t) => {
  const root = mkdtempSync("/tmp/ggc-close-reject-");
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const runtime = { subscribe() { throw new Error("unused"); }, async close() { throw new Error("runtime close failed"); } };
  const service = await createCollectorService({
    config: normalizeCollectorConfig(CONFIG),
    pathOptions: { env: { XDG_CONFIG_HOME: root }, platform: "linux" },
    runtime,
  });
  await assert.rejects(service.close(), /runtime close failed/);
  assert.equal(existsSync(service.socketPath), false);
  assert.equal(existsSync(`${service.socketPath}.lock`), false);
});

function publication(repositoryIdentity = { id: "R_1", nameWithOwner: "acme/widget" }) {
  return {
    rows: [], entities: [], raw: "[]", pageInfo: { loadedPages: 1, hasNextPage: false },
    lastSuccessAt: 10, lastChangedAt: 10, nextDueAt: 20,
    hold: null,
    capabilities: {}, requestMetrics: { httpRequests: 1, rest200: 1, coreUnits: 1 },
    uncertainReceipts: [], repositoryIdentity,
    meta: { at: 10, truncated: false }, securityNotes: [], securityBlind: false,
  };
}

const IDENTITY = {
  host: "github.com", kind: "user", id: 7, login: "octo",
  quotaKey: "q".repeat(64), accessKey: "a".repeat(64), credentialKey: "c".repeat(64),
  generation: 1, observedAt: 1,
};

test("COL-01/06: headless runtime coalesces twelve subscribers through the shared acquisition store", async (t) => {
  const root = mkdtempSync("/tmp/ggc-runtime-");
  t.after(() => rmSync(root, { recursive: true, force: true }));
  let starts = 0;
  let providerResolutions = 0;
  let targetResolutions = 0;
  const runtime = createCollectorAcquisitionRuntime({
    config: normalizeCollectorConfig(CONFIG),
    pathOptions: { env: { XDG_CONFIG_HOME: root }, platform: "linux" },
    resolveProvider: async () => { providerResolutions += 1; return IDENTITY; },
    resolveTargetIdentity: async () => {
      targetResolutions += 1;
      return { id: "R_1", nameWithOwner: "acme/widget" };
    },
    async produce({ markStarted }) {
      starts += 1;
      assert.equal((await markStarted()).ok, true);
      await new Promise((resolve) => setTimeout(resolve, 20));
      return publication();
    },
  });
  t.after(() => runtime.close());
  const snapshots = await within(Promise.all(Array.from({ length: 12 }, () => new Promise((resolve, reject) => {
    runtime.subscribe({
      target: normalizeCollectorConfig(CONFIG).targets[0], resource: "actions",
      demand: { active: true, background: true, floorMs: 5000, pages: 1 },
      onSnapshot: resolve, onHold: (hold) => hold === "disconnected" && reject(new Error(hold)),
    });
  }))));
  assert.equal(starts, 1);
  assert.equal(providerResolutions, 1);
  assert.equal(targetResolutions, 1);
  assert.equal(new Set(snapshots.map((snapshot) => snapshot.lastSuccessAt)).size, 1);
});

test("COL-01/03/06: twelve real sockets share one real-runtime acquisition stream", async (t) => {
  const root = mkdtempSync("/tmp/ggc-e2e-sockets-");
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const config = normalizeCollectorConfig(CONFIG);
  let releaseProvider;
  const providerGate = new Promise((resolve) => { releaseProvider = resolve; });
  let providerResolutions = 0;
  let targetResolutions = 0;
  let producerStarts = 0;
  const runtime = createCollectorAcquisitionRuntime({
    config,
    pathOptions: { env: { XDG_CONFIG_HOME: root }, platform: "linux" },
    async resolveProvider() { providerResolutions += 1; await providerGate; return IDENTITY; },
    async resolveTargetIdentity() { targetResolutions += 1; return { id: "R_1", nameWithOwner: "acme/widget" }; },
    async produce({ markStarted }) {
      producerStarts += 1;
      await markStarted();
      return { ...publication(), nextDueAt: Date.now() + 60_000 };
    },
  });
  let subscribedCount = 0;
  let releaseSubscribed;
  const allSubscribed = new Promise((resolve) => { releaseSubscribed = resolve; });
  const subscribe = runtime.subscribe.bind(runtime);
  runtime.subscribe = (options) => {
    const handle = subscribe(options);
    subscribedCount += 1;
    if (subscribedCount === 12) releaseSubscribed();
    return handle;
  };
  const service = await createCollectorService({
    config,
    pathOptions: { env: { XDG_CONFIG_HOME: root }, platform: "linux" },
    runtime,
  });
  t.after(async () => service.close());
  const sockets = await Promise.all(Array.from({ length: 12 }, () => connect(service.socketPath)));
  t.after(() => sockets.forEach((socket) => socket.destroy()));
  const received = sockets.map((socket, index) => new Promise((resolve, reject) => {
    const decoder = createCollectorFrameDecoder({
      onFrame(frame) {
        if (frame.type === "snapshot") resolve(frame.snapshot);
        if (frame.type === "error") reject(new Error(frame.code));
      },
      onError: reject,
    });
    socket.on("data", (chunk) => decoder.push(chunk));
    socket.write(encodeCollectorFrame({ type: "hello", protocolVersion: 1 }));
    socket.write(encodeCollectorFrame({ type: "subscribe", id: `real-${index}`,
      host: "github.com", repo: "acme/widget", resource: "actions",
      demand: { active: true, background: true, floorMs: 5000, pages: 1 } }));
  }));
  await within(allSubscribed);
  releaseProvider();
  const snapshots = await within(Promise.all(received));
  assert.equal(providerResolutions, 1);
  assert.equal(targetResolutions, 1);
  assert.equal(producerStarts, 1);
  assert.equal(snapshots.length, 12);
  assert.equal(new Set(snapshots.map((snapshot) => snapshot.generation)).size, 1);
});

test("COL-06: a collector joins a standalone producer instead of starting duplicate work", async (t) => {
  const root = mkdtempSync("/tmp/ggc-shared-");
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const pathOptions = { env: { XDG_CONFIG_HOME: root }, platform: "linux" };
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  let standaloneStarts = 0;
  let collectorStarts = 0;
  const standalone = createAcquisitionEngine({ pathOptions, async transport({ claim: _claim }) {
    standaloneStarts += 1;
    await gate;
    return publication();
  } });
  t.after(() => standalone.close());
  const query = acquisitionQueryForTab("actions", IDENTITY, "acme/widget", 1);
  const registered = standalone.subscribe(query, { active: true, floorMs: 5000, pages: 1 });
  const producing = standalone.refresh(registered.value.id);
  const runtime = createCollectorAcquisitionRuntime({
    config: normalizeCollectorConfig(CONFIG), pathOptions,
    resolveProvider: async () => IDENTITY,
    async produce() { collectorStarts += 1; return publication(); },
  });
  t.after(() => runtime.close());
  const received = new Promise((resolve) => runtime.subscribe({
    target: normalizeCollectorConfig(CONFIG).targets[0], resource: "actions",
    demand: { active: true, background: true, floorMs: 5000, pages: 1 }, onSnapshot: resolve, onHold() {},
  }));
  await new Promise((resolve) => setTimeout(resolve, 20));
  release();
  await producing;
  await within(received);
  assert.equal(standaloneStarts, 1);
  assert.equal(collectorStarts, 0);
});

test("COL-07: pre-data canonical identity persists provider ownership across restart", async (t) => {
  const root = mkdtempSync("/tmp/ggc-canonical-");
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const config = normalizeCollectorConfig({
    version: 1,
    providers: {
      one: { type: "gh", host: "github.com" },
      two: { type: "gh", host: "github.com" },
    },
    targets: [
      { host: "github.com", repo: "acme/widget", provider: "one" },
      { host: "github.com", repo: "renamed/widget", provider: "two" },
    ],
  });
  let firstProduces = 0;
  const first = createCollectorAcquisitionRuntime({
    config, pathOptions: { env: { XDG_CONFIG_HOME: root }, platform: "linux" },
    resolveProvider: async () => IDENTITY,
    resolveTargetIdentity: async () => ({ id: "R_1", nameWithOwner: "acme/widget" }),
    async produce({ markStarted }) { firstProduces += 1; await markStarted(); return publication(); },
  });
  await new Promise((resolve) => first.subscribe({ target: config.targets[0], resource: "issues",
    demand: { active: true, background: true, floorMs: 5000, pages: 1 }, onSnapshot: resolve, onHold() {} }));
  await first.close();
  assert.equal(firstProduces, 1);

  const holds = [];
  let conflictingProduces = 0;
  let conflictingProviderResolutions = 0;
  const conflictingConfig = normalizeCollectorConfig({
    version: 1,
    providers: { two: { type: "gh", host: "github.com" } },
    targets: [{ host: "github.com", repo: "acme/widget", provider: "two" }],
  });
  const second = createCollectorAcquisitionRuntime({
    config: conflictingConfig, pathOptions: { env: { XDG_CONFIG_HOME: root }, platform: "linux" },
    resolveProvider: async () => { conflictingProviderResolutions += 1; return IDENTITY; },
    resolveTargetIdentity: async () => ({ id: "R_1", nameWithOwner: "acme/widget" }),
    async produce() { conflictingProduces += 1; return publication(); },
  });
  t.after(() => second.close());
  second.subscribe({ target: conflictingConfig.targets[0], resource: "issues",
    demand: { active: true, background: true, floorMs: 5000, pages: 1 }, onSnapshot() {}, onHold: (hold) => holds.push(hold) });
  await new Promise((resolve) => setTimeout(resolve, 30));
  assert.deepEqual(holds, ["disconnected"]);
  assert.equal(conflictingProduces, 0);
  assert.equal(conflictingProviderResolutions, 0);

  let repeatedIdentityCalls = 0;
  const third = createCollectorAcquisitionRuntime({
    config, pathOptions: { env: { XDG_CONFIG_HOME: root }, platform: "linux" },
    resolveProvider: async () => IDENTITY,
    resolveTargetIdentity: async () => { repeatedIdentityCalls += 1; throw new Error("must use persisted alias"); },
    async produce() { return publication(); },
  });
  t.after(() => third.close());
  const ownershipPath = join(root, "gh-glance", "collector-ownership-v1.json");
  const ownershipBefore = statSync(ownershipPath);
  await new Promise((resolve) => third.subscribe({ target: config.targets[0], resource: "issues",
    demand: { active: true, background: true, floorMs: 5000, pages: 1 }, onSnapshot: resolve, onHold() {} }));
  assert.equal(repeatedIdentityCalls, 0);
  assert.equal(statSync(ownershipPath).ino, ownershipBefore.ino,
    "an unchanged admission must not replace the ownership file");
});

test("COL-04: aborting a deferred admission releases its timer and cannot reach the start boundary", async () => {
  const controller = new AbortController();
  let callback;
  let clears = 0;
  const waiting = abortableDelay(5_000, controller.signal, {
    setTimeout(next) { callback = next; return { unref() {} }; },
    clearTimeout() { clears += 1; },
  });
  controller.abort();
  assert.equal(await waiting, false);
  assert.equal(clears, 1);
  // A timer implementation can race and deliver an already-queued callback.
  // The settled false result remains authoritative, so production never calls
  // startReservation after this boundary.
  callback();
  assert.equal(await waiting, false);
});

test("COL-01: headless publication retains validators and advances quiet cadence on 304", () => {
  const previous = {
    ...publication(),
    entities: [{ key: "actions\0runs", etag: '"one"', body: "[]" }],
  };
  const state = { unchangedCount: 2 };
  const next = collectorPublicationFromResult("actions", {
    raw: previous.raw,
    parse() { throw new Error("unchanged responses must not parse"); },
    limit: 50,
    stagedEntities: null,
    requestMetrics: { httpRequests: 1, rest304: 1, coreUnits: 0 },
    restSpent: 0,
  }, previous, { active: true, floorMs: 5000, pages: 1 }, 100, state);
  assert.deepEqual(next.entities, previous.entities);
  assert.equal(next.lastChangedAt, previous.lastChangedAt);
  assert.equal(state.unchangedCount, 3);
  assert.ok(next.nextDueAt > 100 + 5000);
});

test("COL-01: headless publication uses exact active, inactive, and background-off cadence", () => {
  const result = { raw: "[]", parse: () => [], limit: 50, stagedEntities: null,
    requestMetrics: { httpRequests: 1, rest200: 1, coreUnits: 1 }, restSpent: 1 };
  const active = collectorPublicationFromResult("issues", result, null,
    { active: true, background: true, floorMs: 5000, pages: 1 }, 100, {});
  const inactive = collectorPublicationFromResult("issues", result, null,
    { active: false, background: true, floorMs: 5000, pages: 1 }, 100, {});
  const off = collectorPublicationFromResult("issues", result, null,
    { active: false, background: false, floorMs: 5000, pages: 1 }, 100, {});
  assert.equal(active.nextDueAt, 5100);
  assert.ok(inactive.nextDueAt > active.nextDueAt);
  assert.equal(off.nextDueAt, Number.POSITIVE_INFINITY);
});

test("COL-01: provider failure schedules recovery instead of wedging the subscription", async (t) => {
  const root = mkdtempSync("/tmp/ggc-retry-");
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const scheduled = [];
  let attempts = 0;
  const runtime = createCollectorAcquisitionRuntime({
    config: normalizeCollectorConfig(CONFIG),
    pathOptions: { env: { XDG_CONFIG_HOME: root }, platform: "linux" },
    setTimeout(callback, delay) { scheduled.push({ callback, delay }); return { unref() {} }; },
    clearTimeout() {},
    async resolveProvider() {
      attempts += 1;
      if (attempts === 1) throw new Error("offline");
      return IDENTITY;
    },
    async produce({ markStarted }) { await markStarted(); return publication(); },
  });
  t.after(() => runtime.close());
  const received = new Promise((resolve) => runtime.subscribe({
    target: normalizeCollectorConfig(CONFIG).targets[0], resource: "actions",
    demand: { active: true, background: true, floorMs: 5000, pages: 1 }, onSnapshot: resolve, onHold() {},
  }));
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(scheduled.length, 1);
  assert.equal(scheduled[0].delay, 1000);
  scheduled.shift().callback();
  await received;
  assert.equal(attempts, 2);
});

test("COL-01: background-off starts no inactive work, promotion polls, and demotion cancels cadence", async (t) => {
  const root = mkdtempSync("/tmp/ggc-background-");
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const scheduled = [];
  const cleared = [];
  let starts = 0;
  const runtime = createCollectorAcquisitionRuntime({
    config: normalizeCollectorConfig(CONFIG),
    pathOptions: { env: { XDG_CONFIG_HOME: root }, platform: "linux" },
    setTimeout(callback, delay) { const timer = { callback, delay, unref() {} }; scheduled.push(timer); return timer; },
    clearTimeout(timer) { cleared.push(timer); },
    resolveProvider: async () => IDENTITY,
    async produce({ markStarted }) { starts += 1; await markStarted(); return publication(); },
  });
  t.after(() => runtime.close());
  let adopted;
  const received = new Promise((resolve) => { adopted = resolve; });
  const handle = runtime.subscribe({ target: normalizeCollectorConfig(CONFIG).targets[0], resource: "actions",
    demand: { active: false, background: false, floorMs: 5000, pages: 1 },
    onSnapshot: adopted, onHold() {} });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(starts, 0);
  handle.updateDemand({ active: true, background: false, floorMs: 5000, pages: 1 });
  await received;
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(starts, 1);
  assert.equal(scheduled.length, 1);
  handle.updateDemand({ active: false, background: false, floorMs: 5000, pages: 1 });
  assert.equal(cleared.includes(scheduled[0]), true);
});

test("COL-04/08: close aborts and awaits started acquisition while retaining conservative uncertainty", async (t) => {
  const root = mkdtempSync("/tmp/ggc-abort-");
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const pathOptions = { env: { XDG_CONFIG_HOME: root }, platform: "linux" };
  let started;
  const began = new Promise((resolve) => { started = resolve; });
  let settled = false;
  const runtime = createCollectorAcquisitionRuntime({
    config: normalizeCollectorConfig(CONFIG), pathOptions,
    resolveProvider: async () => IDENTITY,
    async produce({ markStarted, signal }) {
      await markStarted();
      started();
      try {
        await new Promise((resolve, reject) => {
          signal.addEventListener("abort", () => {
            const error = new Error("aborted");
            error.name = "AbortError";
            reject(error);
          }, { once: true });
        });
      } finally {
        settled = true;
      }
    },
  });
  runtime.subscribe({ target: normalizeCollectorConfig(CONFIG).targets[0], resource: "actions",
    demand: { active: true, background: true, floorMs: 5000, pages: 1 }, onSnapshot() {}, onHold() {} });
  await began;
  await runtime.close();
  assert.equal(settled, true);
  const stored = loadAcquisitionStore(acquisitionStorePath(pathOptions));
  assert.equal(stored.ok, true);
  assert.ok(stored.value.metrics.uncertainCoreUnits > 0);
});

test("COL-01: manual refresh queues behind a poll and R coalesces to one unconditional generation", async (t) => {
  const root = mkdtempSync("/tmp/ggc-manual-");
  t.after(() => rmSync(root, { recursive: true, force: true }));
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const forces = [];
  let second;
  const secondPublished = new Promise((resolve) => { second = resolve; });
  const runtime = createCollectorAcquisitionRuntime({
    config: normalizeCollectorConfig(CONFIG),
    pathOptions: { env: { XDG_CONFIG_HOME: root }, platform: "linux" },
    resolveProvider: async () => IDENTITY,
    async produce({ markStarted, force }) {
      forces.push(force);
      await markStarted();
      if (forces.length === 1) await gate;
      else second();
      return publication();
    },
  });
  t.after(() => runtime.close());
  const handle = runtime.subscribe({ target: normalizeCollectorConfig(CONFIG).targets[0], resource: "actions",
    demand: { active: true, background: true, floorMs: 5000, pages: 1 }, onSnapshot() {}, onHold() {} });
  while (forces.length === 0) await new Promise((resolve) => setImmediate(resolve));
  handle.refresh(false);
  handle.refresh(true);
  release();
  await secondPublished;
  assert.deepEqual(forces, [false, true]);
});

test("COL-07: a provider access-generation change remaps before the next target request", async (t) => {
  const root = mkdtempSync("/tmp/ggc-access-refresh-");
  t.after(() => rmSync(root, { recursive: true, force: true }));
  let identity = IDENTITY;
  const seen = [];
  const resolved = [];
  const refreshedProviders = [];
  let twice;
  const refreshed = new Promise((resolve) => { twice = resolve; });
  const runtime = createCollectorAcquisitionRuntime({
    config: normalizeCollectorConfig(CONFIG),
    pathOptions: { env: { XDG_CONFIG_HOME: root }, platform: "linux" },
    resolveProvider: async () => { resolved.push(identity.accessKey); return identity; },
    refreshProvider: async () => { refreshedProviders.push(identity.accessKey); return identity; },
    async produce({ markStarted, provider }) {
      seen.push(provider.accessKey);
      await markStarted();
      if (seen.length === 2) twice();
      return { ...publication(), nextDueAt: Date.now() + 5_000 };
    },
  });
  t.after(() => runtime.close());
  const handle = runtime.subscribe({ target: normalizeCollectorConfig(CONFIG).targets[0], resource: "actions",
    demand: { active: true, background: true, floorMs: 5000, pages: 1 }, onSnapshot() {}, onHold() {} });
  while (seen.length === 0) await new Promise((resolve) => setImmediate(resolve));
  identity = { ...IDENTITY, accessKey: "b".repeat(64), credentialKey: "d".repeat(64), generation: 2 };
  handle.refresh(false);
  await within(refreshed);
  assert.deepEqual(seen, [IDENTITY.accessKey, identity.accessKey],
    JSON.stringify({ resolved, refreshedProviders }));
});

test("COL-07: a later subscription revalidates rotated access before adopting retained data", async (t) => {
  const root = mkdtempSync("/tmp/ggc-new-access-");
  t.after(() => rmSync(root, { recursive: true, force: true }));
  let identity = IDENTITY;
  const producedFor = [];
  let resolutions = 0;
  const runtime = createCollectorAcquisitionRuntime({
    config: normalizeCollectorConfig(CONFIG),
    pathOptions: { env: { XDG_CONFIG_HOME: root }, platform: "linux" },
    resolveProvider: async () => { resolutions += 1; return identity; },
    async produce({ markStarted, provider }) {
      producedFor.push(provider.accessKey);
      await markStarted();
      return { ...publication(), lastSuccessAt: provider.generation, lastChangedAt: provider.generation,
        meta: { at: provider.generation, truncated: false } };
    },
  });
  t.after(() => runtime.close());
  const target = normalizeCollectorConfig(CONFIG).targets[0];
  const first = await within(new Promise((resolve) => runtime.subscribe({ target, resource: "actions",
    demand: { active: true, background: true, floorMs: 5000, pages: 1 }, onSnapshot: resolve, onHold() {} })));
  assert.equal(first.lastSuccessAt, 1);
  identity = { ...IDENTITY, accessKey: "b".repeat(64), credentialKey: "d".repeat(64), generation: 2 };
  const second = await within(new Promise((resolve) => runtime.subscribe({ target, resource: "actions",
    demand: { active: true, background: true, floorMs: 5000, pages: 1 }, onSnapshot: resolve, onHold() {} })));
  assert.equal(second.lastSuccessAt, 2);
  assert.equal(resolutions, 2);
  assert.deepEqual(producedFor, [IDENTITY.accessKey, identity.accessKey]);
});

test("COL-01: rejected provider refresh publishes a scoped hold and schedules recovery without rejection", async (t) => {
  const root = mkdtempSync("/tmp/ggc-refresh-reject-");
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const scheduled = [];
  const holds = [];
  const diagnostics = [];
  let refreshes = 0;
  let unhandled = null;
  const onUnhandled = (error) => { unhandled = error; };
  process.once("unhandledRejection", onUnhandled);
  t.after(() => process.off("unhandledRejection", onUnhandled));
  const runtime = createCollectorAcquisitionRuntime({
    config: normalizeCollectorConfig(CONFIG),
    pathOptions: { env: { XDG_CONFIG_HOME: root }, platform: "linux" },
    setTimeout(callback, delay) { const timer = { callback, delay, unref() {} }; scheduled.push(timer); return timer; },
    clearTimeout() {},
    resolveProvider: async () => IDENTITY,
    async refreshProvider() {
      refreshes += 1;
      if (refreshes === 1) throw new Error(`token helper failed ghp_${"x".repeat(36)}`);
      return IDENTITY;
    },
    async produce({ markStarted }) { await markStarted(); return publication(); },
    onDiagnostic: (event) => diagnostics.push(event),
  });
  t.after(() => runtime.close());
  const received = new Promise((resolve) => runtime.subscribe({
    target: normalizeCollectorConfig(CONFIG).targets[0], resource: "actions",
    demand: { active: true, background: true, floorMs: 5000, pages: 1 },
    onSnapshot: resolve, onHold: (hold) => holds.push(hold),
  }));
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(unhandled, null);
  assert.equal(scheduled.length, 1);
  assert.equal(scheduled[0].delay, 1000);
  assert.equal(holds.length, 1);
  assert.equal(diagnostics[0].stage, "provider-refresh");
  assert.doesNotMatch(JSON.stringify(diagnostics), /ghp_/);
  scheduled.shift().callback();
  await within(received);
  assert.equal(refreshes, 2);
});
