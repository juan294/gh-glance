import assert from "node:assert/strict";
import { test } from "node:test";

import { reconcileSustainedTrace } from "../scripts/sustained-recovery.mjs";

// The cheap rejection cases of the sustained oracle's independent reconciler.
// They run in the fast selection; the 72-hour simulation itself stays in
// test/sustained-recovery.test.mjs (the recovery selection).
test("independent trace rejects dropped debt, charge, and source success without response", () => {
  const trace = { issues: [{ id: 1, resource: "core", cost: 1, at: 1000 }],
    finishes: [{ id: 1, status: "interrupted", actualCost: 1, counterDelta: 1, at: 1001 }],
    reservations: [{ id: 2, declaredCost: { core: 1, graphql: 0 }, status: "interrupted",
      expectedRequests: 1, governorStatus: "started", governorActual: null }],
    expectedUnterminalizedCharge: { core: 1, graphql: 0 },
    sources: [], governor: { outstandingUnits: { core: 1, graphql: 0 } } };
  assert.equal(reconcileSustainedTrace(trace).ok, true);
  assert.equal(reconcileSustainedTrace({ ...trace, governor: {
    outstandingUnits: { core: 0, graphql: 0 },
  } }).ok, false);
  assert.equal(reconcileSustainedTrace({ ...trace, issues: [
    ...trace.issues, { ...trace.issues[0] },
  ] }).ok, false);
  assert.equal(reconcileSustainedTrace({ ...trace,
    sources: [{ id: 1, at: 1002, generation: 1 }],
  }).ok, false);
  const settled = { ...trace, issues: [{ ...trace.issues[0], reservationId: 2 }],
    finishes: [{ ...trace.finishes[0], status: "success" }],
    reservations: [{ id: 2, declaredCost: { core: 1, graphql: 0 }, status: "success",
      expectedRequests: 1, governorStatus: "completed", governorActual: { core: 1, graphql: 0 } }],
    expectedUnterminalizedCharge: { core: 0, graphql: 0 } };
  assert.equal(reconcileSustainedTrace(settled).ok, true);
  assert.equal(reconcileSustainedTrace({ ...settled, reservations: [{ ...settled.reservations[0],
    governorActual: { core: 0, graphql: 0 } }] }).ok, false);
  assert.equal(reconcileSustainedTrace({ ...settled, sources: [
    { id: 1, key: "same-source", at: 1002, generation: 1 },
    { id: 1, key: "same-source", at: 1003, generation: 1 },
  ] }).ok, false);
});
