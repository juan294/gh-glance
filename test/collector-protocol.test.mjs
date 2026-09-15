import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { test } from "node:test";

import {
  COLLECTOR_FRAME_MAX_BYTES,
  collectorDisplayDecision,
  createCollectorFrameDecoder,
  createCollectorSnapshotAssembler,
  createCollectorSnapshotEncodingCache,
  createCollectorSender,
  createLocalCollectorClient,
  encodeCollectorFrame,
  encodeCollectorSnapshotFrames,
  projectCollectorSnapshot,
  validateCollectorClientMessage,
} from "../index.mjs";

function largeRows(fields = 10) {
  return Array.from({ length: 512 }, (_, row) => ({
    databaseId: row,
    displayTitle: `${row}-${"x".repeat(fields * 90)}`,
    workflowName: "x".repeat(fields * 90),
    number: row,
    headBranch: "x".repeat(fields * 90),
    status: "x".repeat(fields * 90),
    conclusion: "x".repeat(fields * 90),
    startedAt: "x".repeat(fields * 90),
    updatedAt: "x".repeat(fields * 90),
    url: "x".repeat(fields * 90),
  }));
}

test("COL-02: newline JSON accepts exact messages and rejects arbitrary input", () => {
  assert.deepEqual(validateCollectorClientMessage({ type: "hello", protocolVersion: 1 }), {
    type: "hello", protocolVersion: 1,
  });
  assert.equal(validateCollectorClientMessage({ type: "hello", protocolVersion: 1, path: "/user" }), null);
  assert.equal(validateCollectorClientMessage({ type: "command", argv: ["api", "/user"] }), null);
  assert.deepEqual(validateCollectorClientMessage({ type: "refresh", id: "one", force: true }),
    { type: "refresh", id: "one", force: true });
  assert.equal(validateCollectorClientMessage({ type: "refresh", id: "one" }), null);
  assert.equal(validateCollectorClientMessage({ type: "demand", id: "one",
    demand: { active: true, floorMs: 5000, pages: 1 } }), null);
  assert.throws(() => encodeCollectorFrame({ value: "x".repeat(COLLECTOR_FRAME_MAX_BYTES) }), /frame too large/);

  const seen = [];
  const decoder = createCollectorFrameDecoder({ onFrame: (frame) => seen.push(frame) });
  const first = encodeCollectorFrame({ type: "hello", protocolVersion: 1 });
  decoder.push(Buffer.from(first.slice(0, 5)));
  decoder.push(Buffer.from(first.slice(5) + encodeCollectorFrame({ type: "inspect", id: "one" })));
  assert.deepEqual(seen, [
    { type: "hello", protocolVersion: 1 },
    { type: "inspect", id: "one" },
  ]);
  decoder.end();

  const errors = [];
  const remainder = createCollectorFrameDecoder({ onFrame() {}, onError: (error) => errors.push(error.message) });
  assert.equal(remainder.push(Buffer.concat([
    Buffer.from(encodeCollectorFrame({ type: "hello", protocolVersion: 1 })),
    Buffer.alloc(COLLECTOR_FRAME_MAX_BYTES + 1, 0x78),
  ])), false);
  assert.deepEqual(errors, ["collector frame too large"]);
});

test("COL-02: maximally fragmented frames decode once without retaining a remainder", () => {
  const frame = encodeCollectorFrame({ type: "inspect", id: `sub-${"x".repeat(100)}` });
  const seen = [];
  const decoder = createCollectorFrameDecoder({ onFrame: (value) => seen.push(value) });
  for (const byte of Buffer.from(frame)) assert.equal(decoder.push(Buffer.from([byte])), true);
  assert.deepEqual(seen, [{ type: "inspect", id: `sub-${"x".repeat(100)}` }]);
  assert.equal(decoder.end(), true);
});

test("COL-05: Shared is earned by a full snapshot and never masks holds or disconnects", () => {
  assert.deepEqual(collectorDisplayDecision({ connected: true, hasSnapshot: false }),
    { mode: "waiting", detailKind: "collector" });
  assert.deepEqual(collectorDisplayDecision({ connected: true, hasSnapshot: true }), { sharedData: true });
  assert.deepEqual(collectorDisplayDecision({ connected: true, hasSnapshot: true, hold: "primary" }),
    { mode: "paused", detailKind: "primary" });
  assert.deepEqual(collectorDisplayDecision({ connected: true, hasSnapshot: true, hold: "shared-wait" }),
    { mode: "waiting", waitCause: "shared-lane" });
  assert.deepEqual(collectorDisplayDecision({ connected: false, hasSnapshot: true }), { disconnected: true });
});

test("COL-08: large snapshots assemble only after bounded digest validation", () => {
  const snapshot = {
    resource: "actions",
    generation: 7,
    rows: largeRows(),
    pageInfo: { loadedPages: 1, hasNextPage: false },
    lastSuccessAt: 10,
    lastChangedAt: 9,
    nextDueAt: 20,
    hold: null,
    meta: { at: 9, truncated: false },
    securityNotes: [], securityBlind: false, capabilities: {},
  };
  const frames = encodeCollectorSnapshotFrames("sub-1", "epoch-1", snapshot);
  assert.ok(frames.every((frame) => frame.type === "snapshot-part" || frame.type === "snapshot-end" ||
    Number.isFinite(frame.serverNow)), "the complete snapshot carries collector wall time");
  assert.equal(frames[0].type, "snapshot-begin");
  assert.equal(frames.at(-1).type, "snapshot-end");
  assert.ok(frames.every((frame) => Buffer.byteLength(encodeCollectorFrame(frame)) <= COLLECTOR_FRAME_MAX_BYTES));

  const adopted = [];
  const assembler = createCollectorSnapshotAssembler({ onSnapshot: (value) => adopted.push(value), now: () => 1 });
  for (const frame of frames) assert.equal(assembler.accept(frame).ok, true);
  assert.deepEqual(adopted, [projectCollectorSnapshot(snapshot)]);

  const damaged = structuredClone(frames);
  damaged[1].data = `${damaged[1].data.slice(0, -4)}AAAA`;
  const retained = [];
  const rejecting = createCollectorSnapshotAssembler({ onSnapshot: (value) => retained.push(value), now: () => 1 });
  assert.equal(rejecting.accept(damaged[0]).ok, true);
  assert.equal(rejecting.accept(damaged[1]).ok, true);
  for (const frame of damaged.slice(2, -1)) rejecting.accept(frame);
  assert.equal(rejecting.accept(damaged.at(-1)).ok, false);
  assert.deepEqual(retained, []);

  assert.throws(() => encodeCollectorSnapshotFrames("sub-1", "epoch-1", {
    ...snapshot,
    rows: [...snapshot.rows, snapshot.rows[0]],
  }), /invalid collector snapshot/);
});

test("COL-08: incomplete and out-of-order assemblies never publish", () => {
  const snapshot = { resource: "actions", generation: 2, rows: largeRows(),
    pageInfo: null, lastSuccessAt: 1, lastChangedAt: 1, nextDueAt: 2, hold: null,
    meta: { at: 1, truncated: false }, securityNotes: [], securityBlind: false, capabilities: {} };
  const frames = encodeCollectorSnapshotFrames("sub", "epoch", snapshot);
  const adopted = [];
  const assembler = createCollectorSnapshotAssembler({ onSnapshot: (value) => adopted.push(value), now: () => 1 });
  assembler.accept(frames[0]);
  assert.equal(assembler.accept({ ...frames[2], index: 9 }).ok, false);
  assert.equal(assembler.accept(frames.at(-1)).ok, false);
  assert.deepEqual(adopted, []);
});

test("COL-02/08: snapshot frames reject unknown fields and malformed base64", () => {
  const snapshot = { resource: "actions", generation: 2, rows: largeRows(),
    pageInfo: null, lastSuccessAt: 1, lastChangedAt: 1, nextDueAt: 2, hold: null,
    meta: { at: 1, truncated: false }, securityNotes: [], securityBlind: false, capabilities: {} };
  const frames = encodeCollectorSnapshotFrames("sub", "epoch", snapshot);
  const assembler = createCollectorSnapshotAssembler({ onSnapshot() {}, now: () => 1 });
  assert.equal(assembler.accept({ ...frames[0], command: "gh api user" }).reason, "invalid");
  assert.equal(assembler.accept(frames[0]).ok, true);
  assert.equal(assembler.accept({ ...frames[1], data: "%%%=" }).ok, false);
  assert.equal(assembler.accept({ type: "snapshot", id: "sub", serverEpoch: "epoch", generation: 1,
    snapshot: { ...snapshot, extra: true } }).reason, "invalid");
  assert.equal(assembler.accept({ type: "snapshot", id: "sub", serverEpoch: "epoch", generation: 2,
    snapshot: { ...snapshot, rows: [{ ...snapshot.rows[0], secret: "no" }] } }).reason, "invalid");
});

test("COL-08: assemblies have independent deadlines, a hard cap, and exact chunk bounds", () => {
  const timers = [];
  const assembler = createCollectorSnapshotAssembler({
    onSnapshot() {},
    now: () => 1,
    resourceForId: () => "actions",
    setTimeout(callback, delay) { const timer = { callback, delay }; timers.push(timer); return timer; },
    clearTimeout() {},
  });
  const begin = (index) => ({ type: "snapshot-begin", id: `sub-${index}`, serverEpoch: "epoch",
    resource: "actions", generation: 1, snapshotId: `snap-${index}`, totalBytes: 400000,
    digest: "a".repeat(64), parts: 1 });
  for (let index = 0; index < 64; index += 1) assert.equal(assembler.accept(begin(index)).ok, true);
  assert.equal(assembler.accept(begin(64)).ok, false);
  assert.equal(assembler.inspect().pending, 64);
  assert.ok(timers.every((timer) => timer.delay === 10000));
  timers[0].callback();
  assert.equal(assembler.inspect().pending, 63);
  const oversized = { type: "snapshot-part", id: "sub-1", serverEpoch: "epoch", resource: "actions",
    generation: 1, snapshotId: "snap-1", index: 0, data: Buffer.alloc(400000).toString("base64") };
  assert.equal(assembler.accept(oversized).ok, false);
});

test("COL-08: four overlapping resource snapshots stay bounded and do not disconnect a healthy client", async () => {
  class HealthySocket extends EventEmitter {
    destroyed = false;
    lines = [];
    write(value) { this.lines.push(String(value)); return true; }
    destroy() { this.destroyed = true; this.emit("close"); }
  }
  const socket = new HealthySocket();
  const sender = createCollectorSender(socket);
  const text = "x".repeat(900);
  const rows = {
    actions: largeRows(),
    issues: Array.from({ length: 512 }, (_, number) => ({ number, title: text, author: text,
      label: text, updatedAt: text, url: text })),
    prs: Array.from({ length: 512 }, (_, number) => ({ number, title: text, author: text,
      headRefName: text, isDraft: false, reviewDecision: text, updatedAt: text, url: text })),
    security: Array.from({ length: 512 }, (_, number) => ({ id: `alert-${number}`, kind: text,
      severity: text, title: text, detail: text, createdAt: text })),
  };
  const accepted = [];
  for (const resource of ["actions", "issues", "prs", "security"]) {
    accepted.push(sender.sendSnapshot(resource, "epoch", { resource, generation: 1, rows: rows[resource], pageInfo: null,
      lastSuccessAt: 1, lastChangedAt: 1, nextDueAt: 2, hold: null,
      meta: { at: 1, truncated: false }, securityNotes: [], securityBlind: false, capabilities: {} }));
  }
  assert.deepEqual(accepted, [true, true, true, true]);
  while (sender.inspect().active) await new Promise((resolve) => setImmediate(resolve));
  assert.equal(socket.destroyed, false);
  assert.equal(socket.lines.filter((line) => ["snapshot", "snapshot-begin"].includes(JSON.parse(line).type)).length, 4);
  assert.deepEqual(sender.inspect(), { active: false, queuedFrames: 0, queuedBytes: 0,
    pendingSnapshots: 0, closed: false });
});

test("COL-08: a stalled client cannot consume another healthy client's aggregate allowance", () => {
  class Socket extends EventEmitter {
    destroyed = false;
    constructor(stalled) { super(); this.stalled = stalled; }
    write() { return !this.stalled; }
    destroy() { if (this.destroyed) return; this.destroyed = true; this.emit("close"); }
  }
  const aggregate = { bytes: 0 };
  const stalledSocket = new Socket(true);
  const healthySocket = new Socket(false);
  const stalled = createCollectorSender(stalledSocket, aggregate);
  const healthy = createCollectorSender(healthySocket, aggregate);
  for (let index = 0; index < 65; index += 1) stalled.send({ type: "diagnostic", id: `s-${index}`, value: "x" });
  assert.equal(stalledSocket.destroyed, true);
  assert.equal(healthy.send({ type: "diagnostic", id: "healthy", value: "ok" }), true);
  assert.equal(healthySocket.destroyed, false);
  assert.ok(aggregate.bytes >= 0);
});

test("COL-08: a non-reading client is disconnected at the exact outbound queue bound", async () => {
  class StalledSocket extends EventEmitter {
    destroyed = false;
    write() { return false; }
    destroy() { this.destroyed = true; this.emit("close"); }
  }
  const socket = new StalledSocket();
  const sender = createCollectorSender(socket);
  assert.equal(sender.send({ type: "diagnostic", id: "one", value: "x" }), true);
  for (let index = 1; index < 64; index += 1) {
    assert.equal(sender.send({ type: "diagnostic", id: `q-${index}`, value: "x" }), true);
  }
  assert.equal(sender.send({ type: "diagnostic", id: "overflow", value: "x" }), false);
  assert.equal(socket.destroyed, true);
  assert.equal(sender.inspect().closed, true);
});

test("COL-08: drain stalls have a deadline and release snapshot counters exactly once", async () => {
  class StalledSocket extends EventEmitter {
    destroyed = false;
    write() { return false; }
    destroy() { if (this.destroyed) return; this.destroyed = true; this.emit("close"); }
  }
  const timers = [];
  const aggregate = { bytes: 0 };
  const socket = new StalledSocket();
  const sender = createCollectorSender(socket, aggregate, {
    setTimeout(callback, delay) { const timer = { callback, delay }; timers.push(timer); return timer; },
    clearTimeout() {},
  });
  assert.equal(sender.sendSnapshot("actions", "epoch", { resource: "actions", generation: 1, rows: [],
    pageInfo: null, lastSuccessAt: 1, lastChangedAt: 1, nextDueAt: 2, hold: null,
    meta: { at: 1, truncated: false }, securityNotes: [], securityBlind: false, capabilities: {} }), true);
  assert.ok(sender.inspect().queuedBytes > 0);
  assert.ok(sender.inspect().queuedFrames > 0);
  assert.equal(aggregate.bytes, sender.inspect().queuedBytes);
  assert.equal(timers[0].delay, 10000);
  timers[0].callback();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(socket.destroyed, true);
  assert.deepEqual(sender.inspect(), { active: false, queuedFrames: 0, queuedBytes: 0,
    pendingSnapshots: 0, closed: true });
  assert.equal(aggregate.bytes, 0);
});

test("COL-08: reconnect adopts a new epoch while generations stay monotonic inside each epoch", () => {
  class FakeSocket extends EventEmitter {
    writable = true;
    writes = [];
    write(value) { this.writes.push(String(value)); return true; }
    destroy() { this.writable = false; this.emit("close"); }
  }
  const sockets = [new FakeSocket(), new FakeSocket()];
  const timers = [];
  let connection = 0;
  const adopted = [];
  const connections = [];
  const holds = [];
  const errors = [];
  const diagnostics = [];
  const client = createLocalCollectorClient({
    pathOptions: { env: { XDG_CONFIG_HOME: "/tmp/unused" }, platform: "linux" },
    createConnection_() { return sockets[connection++]; },
    setTimeout(callback, delay) { timers.push({ callback, delay }); return 1; },
    clearTimeout() {},
    onReady: (connected) => connections.push(connected),
  });
  client.subscribe({ id: "one", host: "github.com", repo: "acme/widget", resource: "actions",
    demand: { active: true, background: true, floorMs: 5000, pages: 1 },
    onSnapshot: (snapshot) => adopted.push(snapshot.generation), onHold: (hold) => holds.push(hold),
    onError: (error) => errors.push(error), onDiagnostic: (value) => diagnostics.push(value) });
  const epochs = ["11111111-1111-4111-8111-111111111111", "22222222-2222-4222-8222-222222222222"];
  const snapshot = { resource: "actions", generation: 5, rows: [], pageInfo: null, lastSuccessAt: 5, lastChangedAt: 5,
    nextDueAt: 10, hold: null, meta: { at: 5, truncated: false }, securityNotes: [],
    securityBlind: false, capabilities: {} };
  sockets[0].emit("connect");
  sockets[0].emit("data", Buffer.from(encodeCollectorFrame({ type: "welcome", protocolVersion: 1,
    serverEpoch: epochs[0], capabilities: { chunks: true, maxSubscriptions: 64 } })));
  assert.deepEqual(connections, []);
  sockets[0].emit("data", Buffer.from(encodeCollectorFrame({ type: "snapshot", id: "one",
    serverEpoch: epochs[0], generation: 5, snapshot })));
  assert.deepEqual(connections, [true]);
  sockets[0].emit("data", Buffer.from(encodeCollectorFrame({ type: "hold", id: "one",
    serverEpoch: epochs[0], generation: 4, hold: "primary" })));
  sockets[0].emit("data", Buffer.from(encodeCollectorFrame({ type: "hold", id: "one",
    serverEpoch: epochs[0], generation: 5, hold: "primary" })));
  sockets[0].emit("data", Buffer.from(encodeCollectorFrame({ type: "error", id: "one",
    serverEpoch: epochs[0], generation: 4, code: "old" })));
  const diagnostic = { source: "local collector", status: "healthy", resource: "actions",
    generation: 5, lastSuccessAt: 5, lastChangedAt: 5 };
  sockets[0].emit("data", Buffer.from(encodeCollectorFrame({ type: "diagnostic", id: "one",
    serverEpoch: epochs[0], generation: 4, diagnostic: { ...diagnostic, generation: 4 } })));
  sockets[0].emit("data", Buffer.from(encodeCollectorFrame({ type: "diagnostic", id: "one",
    serverEpoch: epochs[0], generation: 5, diagnostic })));
  assert.deepEqual(holds, ["primary"]);
  assert.deepEqual(errors, []);
  assert.deepEqual(diagnostics, [diagnostic]);
  sockets[0].emit("data", Buffer.from(encodeCollectorFrame({ type: "snapshot-begin", id: "one",
    serverEpoch: epochs[0], resource: "actions", generation: 6, snapshotId: "partial", totalBytes: 10,
    digest: "a".repeat(64), parts: 1 })));
  sockets[0].destroy();
  assert.deepEqual(connections, [true, false]);
  assert.deepEqual(timers.map((timer) => timer.delay).sort((a, b) => a - b), [1000, 10000, 10000]);
  timers.splice(timers.findIndex((timer) => timer.delay === 1000), 1)[0].callback();
  sockets[1].emit("connect");
  sockets[1].emit("data", Buffer.from(encodeCollectorFrame({ type: "welcome", protocolVersion: 1,
    serverEpoch: epochs[1], capabilities: { chunks: true, maxSubscriptions: 64 } })));
  assert.deepEqual(connections, [true, false]);
  sockets[1].emit("data", Buffer.from(encodeCollectorFrame({ type: "snapshot", id: "one",
    serverEpoch: epochs[1], generation: 1, snapshot: { ...snapshot, generation: 1 } })));
  sockets[1].emit("data", Buffer.from(encodeCollectorFrame({ type: "snapshot", id: "one",
    serverEpoch: epochs[1], generation: 1, snapshot: { ...snapshot, generation: 1 } })));
  assert.deepEqual(adopted, [5, 1]);
  assert.deepEqual(connections, [true, false, true]);
  client.close();
});

test("COL-08: identical demand is a wire no-op and changed demand emits once", () => {
  class FakeSocket extends EventEmitter {
    writable = true;
    writes = [];
    write(value) { this.writes.push(JSON.parse(String(value))); return true; }
    destroy() { this.writable = false; this.emit("close"); }
  }
  const socket = new FakeSocket();
  const client = createLocalCollectorClient({
    pathOptions: { env: { XDG_CONFIG_HOME: "/tmp/unused" }, platform: "linux" },
    createConnection_() { return socket; },
    setTimeout() { return { unref() {} }; }, clearTimeout() {},
  });
  const demand = { active: true, background: true, floorMs: 5000, pages: 1 };
  const subscribed = client.subscribe({ id: "one", host: "github.com", repo: "acme/widget",
    resource: "actions", demand, onSnapshot() {} });
  socket.emit("connect");
  socket.emit("data", Buffer.from(encodeCollectorFrame({ type: "welcome", protocolVersion: 1,
    serverEpoch: "11111111-1111-4111-8111-111111111111", capabilities: { chunks: true, maxSubscriptions: 64 } })));
  socket.writes.length = 0;
  assert.equal(subscribed.value.updateDemand(demand).ok, true);
  assert.deepEqual(socket.writes, []);
  assert.equal(subscribed.value.updateDemand({ ...demand, pages: 2 }).ok, true);
  assert.equal(socket.writes.length, 1);
  assert.equal(socket.writes[0].type, "demand");
  client.close();
});

test("COL-08: service-scoped snapshot preparation is shared across healthy clients", async () => {
  class HealthySocket extends EventEmitter {
    destroyed = false;
    lines = [];
    write(value) { this.lines.push(String(value)); return true; }
    destroy() { this.destroyed = true; this.emit("close"); }
  }
  const cache = createCollectorSnapshotEncodingCache();
  const snapshot = { resource: "actions", generation: 1, rows: largeRows(), pageInfo: null,
    lastSuccessAt: 1, lastChangedAt: 1, nextDueAt: 2, hold: null,
    meta: { at: 1, truncated: false }, securityNotes: [], securityBlind: false, capabilities: {} };
  const sockets = [new HealthySocket(), new HealthySocket()];
  const senders = sockets.map((socket) => createCollectorSender(socket, { bytes: 0 }, { snapshotCache: cache }));
  assert.deepEqual(senders.map((sender, index) => sender.sendSnapshot(`sub-${index}`, "epoch", snapshot)), [true, true]);
  while (senders.some((sender) => sender.inspect().active)) await new Promise((resolve) => setImmediate(resolve));
  assert.equal(cache.inspect().preparations, 1);
  assert.equal(cache.inspect().references, 0);
  assert.ok(sockets.every((socket) => socket.lines.some((line) => JSON.parse(line).type === "snapshot-begin")));
});

test("COL-02: unknown snapshot IDs are rejected before assembly", () => {
  class FakeSocket extends EventEmitter {
    writable = true;
    destroyed = false;
    write() { return true; }
    destroy() { if (this.destroyed) return; this.destroyed = true; this.emit("close"); }
  }
  const socket = new FakeSocket();
  const client = createLocalCollectorClient({
    pathOptions: { env: { XDG_CONFIG_HOME: "/tmp/unused" }, platform: "linux" },
    createConnection_() { return socket; },
    setTimeout() { return { unref() {} }; }, clearTimeout() {},
  });
  socket.emit("connect");
  socket.emit("data", Buffer.from(encodeCollectorFrame({ type: "welcome", protocolVersion: 1,
    serverEpoch: "11111111-1111-4111-8111-111111111111", capabilities: { chunks: true, maxSubscriptions: 64 } })));
  const snapshot = { resource: "actions", generation: 1, rows: [], pageInfo: null,
    lastSuccessAt: 1, lastChangedAt: 1, nextDueAt: 2, hold: null,
    meta: { at: 1, truncated: false }, securityNotes: [], securityBlind: false, capabilities: {} };
  socket.emit("data", Buffer.from(encodeCollectorFrame({ type: "snapshot", id: "unknown",
    serverEpoch: "11111111-1111-4111-8111-111111111111", generation: 1, snapshot })));
  assert.equal(socket.destroyed, true);
  client.close();
});
