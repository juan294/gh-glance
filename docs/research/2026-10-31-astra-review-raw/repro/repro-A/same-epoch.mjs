// Repro for PC-06 / RT-05: same-epoch reconnect with only equal-generation replays.
import { EventEmitter } from "node:events";
import { createSshCollectorClient, encodeCollectorFrame } from "/Users/juan/code/gh-glance/index.mjs";
const EPOCH = "11111111-1111-4111-8111-111111111111";
const DEMAND = { active: false, background: false, floorMs: 5000, pages: 1 };
const snap = (generation, at) => ({ resource: "actions", generation, rows: [], pageInfo: { loadedPages: 1, hasNextPage: false },
  lastSuccessAt: at, lastChangedAt: at, nextDueAt: at + 5000, hold: null, meta: { at, truncated: false },
  securityNotes: [], securityBlind: false, capabilities: {} });
class T extends EventEmitter { writable = true; writes = []; write(v) { this.writes.push(String(v)); return true; }
  destroy() { if (!this.writable) return; this.writable = false; this.emit("close"); } }
const ts = [], timers = [], ready = [], got = [];
const client = createSshCollectorClient({ alias: "studio", createTransport() { const t = new T(); ts.push(t); return t; },
  random: () => 0, setTimeout(cb, d) { const t = { cb, d, unref() {} }; timers.push(t); return t; }, clearTimeout() {},
  onReady: (v) => ready.push(v) });
client.subscribe({ id: "one", host: "github.com", repo: "acme/widget", resource: "actions", demand: DEMAND,
  onSnapshot: (s) => got.push(s.generation) });
const welcome = (t) => t.emit("data", Buffer.from(encodeCollectorFrame({ type: "welcome", protocolVersion: 1,
  serverEpoch: EPOCH, capabilities: { chunks: true, maxSubscriptions: 64 } })));
const send = (t, g) => t.emit("data", Buffer.from(encodeCollectorFrame({ type: "snapshot", id: "one",
  serverEpoch: EPOCH, generation: g, serverNow: 2000, snapshot: snap(g, 1000) })));
ts[0].emit("connect"); welcome(ts[0]); send(ts[0], 5);
console.log("after first connection:", { ready, got });
ts[0].destroy(); timers.at(-1).cb();
ts[1].emit("connect"); welcome(ts[1]); send(ts[1], 5); // server replays its cached gen-5 snapshot
console.log("after same-epoch reconnect, equal-gen replay:", { ready, got, socketWritable: ts[1].writable });
client.close(); process.exit(0);
