import { randomUUID } from "node:crypto";

// One debt group in the exact shape normalizeGovernorState accepts. A single
// unit of `resource`, quiescent by default; a known owner when `ownerNonce` is
// given, otherwise the owner-less shared shape.
export function testDebtGroup({ units = 1, at, revision = 1, quiescent = true, resource = "core",
  ownerNonce = null, bootId = null } = {}) {
  return {
    nonce: randomUUID(), ownerNonce,
    ownerPid: ownerNonce ? process.pid : null, ownerBirth: ownerNonce ? "owner-birth" : null, bootId,
    unknownChild: ownerNonce === null, sealed: true, quiescent,
    units: { core: 0, graphql: 0, [resource]: units }, counts: { core: 0, graphql: 0, [resource]: 1 }, at,
    barrierAt: quiescent ? at : null,
    barrierRevisions: { core: 0, graphql: 0, [resource]: quiescent ? revision : 0 },
  };
}
