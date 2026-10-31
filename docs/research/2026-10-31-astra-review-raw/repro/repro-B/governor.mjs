import { mkdtempSync, rmSync, statSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
const M = await import("/Users/juan/code/gh-glance/index.mjs");
const base = "/private/tmp/claude-501/-Users-juan-code-archy/bdf74263-0214-4fde-bf03-d21ba31a7a8e/scratchpad/glance-astra/repro-B";
const root = mkdtempSync(join(base, "state-"));
const NOW = 1_800_000_000_000;
let clock = NOW;
const scope = M.createGovernorScope({ effectiveHost: "github.com", authIdentity: "repro", env: { XDG_CONFIG_HOME: root }, now: () => clock }).value;
const leaseId = randomUUID();
M.registerLease(scope, { id: leaseId, expiresAt: NOW + M.GOVERNOR_LEASE_TTL_MS, floorMs: 5000, activeTab: "actions",
  phaseSeed: { seed: leaseId, registeredAt: NOW }, demand: { core: 1, graphql: 0 } });
const b = { core: { limit: 5000, remaining: 5000, used: 0, resetMs: NOW + 3_600_000 }, graphql: { limit: 5000, remaining: 5000, used: 0, resetMs: NOW + 3_600_000 } };
for (const r of ["core", "graphql"]) {
  const c = M.claimProbe(scope, leaseId, NOW, r);
  console.log("initial claim", r, c.value?.status, M.publishProbe(scope, leaseId, c.value.nonce, b, NOW, r).ok);
}
const intentId = randomUUID();
const grant = M.registerIntent(scope, { id: intentId, leaseId, tab: "actions", priority: "active", costs: { core: 1, graphql: 0 }, requestedAt: NOW, expiresAt: NOW + M.GOVERNOR_LEASE_TTL_MS }).value;
console.log("grant", grant.status, grant.reservationId, "notBefore-NOW", grant.notBefore - NOW);
// Make the GraphQL observer due and claim it (only GraphQL).
const st = M.inspectGovernor(scope, NOW + 1).value;
console.log("manual probe", M.requestManualProbe(scope, leaseId, st.budgets.graphql.epoch, NOW + 1, NOW + 1).ok);
const gq = M.claimProbe(scope, leaseId, NOW + 1, "graphql");
console.log("graphql claim", gq.value?.status, "startedReservationIds", gq.value?.startedReservationIds);
const st2 = M.inspectGovernor(scope, NOW + 1).value;
console.log("core claim:", st2.probeClaims.core, "core observer outcome:", st2.observers.core.outcome, "core observedAt age", NOW + 1 - st2.budgets.core.observedAt);
const at = Math.max(grant.notBefore, NOW + 1);
const started = M.startReservation(scope, grant.reservationId, at);
console.log("start core-only reservation during GraphQL claim:", JSON.stringify(started), "wait ms", started.value?.notBefore - at);

// PC-08: count no-op rewrites
const path = scope.path;
const rev = () => JSON.parse(readFileSync(path, "utf8")).revision;
const ino = () => statSync(path).ino;
let r0 = rev(), i0 = ino();
const waitClaim = M.claimProbe(scope, leaseId, at, "graphql");
console.log("claimProbe waiting:", waitClaim.value?.status, "revision", r0, "->", rev(), "inode changed", i0 !== ino());
r0 = rev(); i0 = ino();
const d1 = M.readIntentDecision(scope, intentId, at, null);
const r1 = rev();
const d2 = M.readIntentDecision(scope, intentId, at, null);
console.log("readIntentDecision x2:", d1.value?.status, d2.value?.status, "revision", r0, "->", r1, "->", rev(), "inode changed", i0 !== ino());
const s1 = readFileSync(path, "utf8");
M.readIntentDecision(scope, intentId, at, null);
const s2 = readFileSync(path, "utf8");
const strip = (s) => { const o = JSON.parse(s); delete o.revision; return JSON.stringify(o); };
console.log("bytes", Buffer.byteLength(s2), "content identical except revision:", strip(s1) === strip(s2));
r0 = rev();
M.inspectGovernor(scope, at);
console.log("inspectGovernor revision", r0, "->", rev());
rmSync(root, { recursive: true, force: true });
