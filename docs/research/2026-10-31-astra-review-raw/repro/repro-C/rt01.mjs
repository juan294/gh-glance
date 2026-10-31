import { collectorPublicationFromResult, pollResultTransition } from "/Users/juan/code/gh-glance/index.mjs";
const rows = [{ number: 1, title: "x" }];
const envelope = JSON.stringify({ v: 1, totalCount: 1, incomplete: false, hasNextPage: false, rows });
const demand = { active: true, floorMs: 5000, pages: 1 };
// previous as produced by normalizeAcquisitionSnapshot: raw = JSON.stringify(rows)
let previous = { rows, raw: JSON.stringify(rows), entities: [], meta: { at: 0, truncated: false }, lastChangedAt: 0, lastSuccessAt: 0 };
const state = { unchangedCount: 0 };
for (let i = 1; i <= 3; i++) {
  const t = i * 10_000;
  const pub = collectorPublicationFromResult("issues", { raw: envelope, parse: () => rows, limit: 50, stagedEntities: null }, previous, demand, t, state);
  console.log(`poll ${i}: unchangedCount=${state.unchangedCount} interval=${pub.nextDueAt - t}ms`);
  // store round trip: normalize replaces raw with rows JSON
  previous = { ...pub, raw: JSON.stringify(pub.rows) };
}
// control: if raw were preserved, quiet cadence is reached
let prev2 = { rows, raw: envelope, entities: [], meta: { at: 0, truncated: false }, lastChangedAt: 0 };
const s2 = { unchangedCount: 0 };
for (let i = 1; i <= 3; i++) { const t = i * 10_000; const p = collectorPublicationFromResult("issues", { raw: envelope, parse: () => rows, limit: 50, stagedEntities: null }, prev2, demand, t, s2); console.log(`control ${i}: unchangedCount=${s2.unchangedCount} interval=${p.nextDueAt - t}ms`); prev2 = p; }
// RT-06: pane holds rawRef=envA, adopted rows B, server returns A again
const A = JSON.stringify({ v: 1, rows: [{ number: 1, state: "open" }] });
const tr = pollResultTransition({ key: "issues", previousRaw: A, raw: A, parse: () => { throw new Error("not parsed"); }, limit: 50, completedAt: 1 });
console.log("RT-06 transition for A after adopting B:", tr.kind, "(App then republishes dataRef rows = B)");
