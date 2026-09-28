// Synthetic reproduction of the 0.15.2 receipt shape. No account, repository,
// credential, request payload, or local coordination data is copied from a user.
export function agedGovernorV6(base, now) {
  const state = structuredClone(base);
  state.version = 6;
  delete state.controlReceipts;
  delete state.revision;
  delete state.debt;
  delete state.debtGroups;
  delete state.ownerGenerations;
  delete state.importMarkers;
  state.intents = {};
  state.probeClaims = { core: null, graphql: null };
  const expired = "00000000-0000-4000-8000-00000000fffe";
  const live = "00000000-0000-4000-8000-00000000ffff";
  for (const [id, expiresAt] of [[expired, now - 1], [live, now + 60_000]]) {
    state.leases[id] = {
      expiresAt, floorMs: 5000, activeTab: "actions",
      phaseSeed: { seed: id, registeredAt: now - 10_000 },
      demand: { core: 1, graphql: 0 },
    };
  }
  for (let index = 0; index < 512; index += 1) {
    const id = `00000000-0000-4000-8000-${index.toString(16).padStart(12, "0")}`;
    const costs = index < 349 ? { core: 1, graphql: 0 }
      : index < 455 ? { core: 1, graphql: 1 }
        : index < 511 ? { core: 0, graphql: 1 }
          : { core: 1, graphql: 0 };
    const completed = index === 511;
    state.reservations[`reservation:${id}`] = {
      leaseId: index % 2 ? live : expired,
      intentId: id,
      costs,
      actualCosts: completed ? costs : null,
      accountedCosts: { core: 0, graphql: 0 },
      notBefore: now - 5000,
      status: completed ? "completed" : "started",
      epochs: { core: null, graphql: null },
      startedAt: now - 4000,
      completedAt: completed ? now - 3000 : null,
      outcome: completed ? "measured-success" : null,
    };
  }
  return state;
}

// Independent fixture oracle: compute retained charge without production code.
export function agedGovernorResiduals(state) {
  return Object.values(state.reservations).reduce((totals, receipt) => {
    for (const resource of ["core", "graphql"]) {
      totals[resource] += (receipt.actualCosts ?? receipt.costs)[resource] - receipt.accountedCosts[resource];
    }
    return totals;
  }, { core: 0, graphql: 0 });
}
