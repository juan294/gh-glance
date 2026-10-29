import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {writeFileSync} from 'node:fs';
import {registerLease,claimProbe,publishProbe,inspectGovernor,registerIntent,startReservation,issueGovernorDispatch,requestManualProbe,normalizeGovernorState} from '../../index.mjs';
import {testDebtGroup} from './debt-group.mjs';

export function populatedGovernorV7(scope, NOW, {includeLiveLease=false}={}){
  const b={scope,path:scope.path},id=randomUUID();
  registerLease(b.scope,{id,expiresAt:NOW+90000,floorMs:5000,activeTab:'actions',phaseSeed:{seed:id,registeredAt:NOW-10000},demand:{core:1,graphql:2}},NOW);
  let savedClaim;
  for(const resource of ['core','graphql']){
    const claim=claimProbe(b.scope,id,NOW,resource);assert.equal(claim.ok,true);assert.equal(claim.value.status,'claimed');
    if(resource==='core')savedClaim=structuredClone(inspectGovernor(b.scope,NOW).value.probeClaims.core);
    assert.equal(publishProbe(b.scope,id,claim.value.nonce,{[resource]:{source:resource==='core'?'core-observer':'graphql-observer',budget:{limit:5000,remaining:4900,used:100,resetMs:NOW+3600000}}},NOW,resource).ok,true);
  }
  const intent=registerIntent(b.scope,{id:randomUUID(),leaseId:id,tab:'tab:actions-runs',priority:'manual',costs:{core:1,graphql:0},requestedAt:NOW,expiresAt:NOW+90000}).value;
  const started=startReservation(b.scope,intent.reservationId,intent.notBefore);assert.equal(started.ok,true);
  assert.equal(issueGovernorDispatch(b.scope,started.value.receiptCapability,'tab:actions-runs',intent.notBefore).ok,true);
  const at=Math.max(NOW,intent.notBefore);b.scope.now=()=>at;
  requestManualProbe(b.scope,id,inspectGovernor(b.scope,at).value.epochs.core,at,at);
  const state=structuredClone(inspectGovernor(b.scope,at).value);state.version=7;state.revision=83;state.fairness.manualStreak=4;
  state.leases[id].expiresAt=NOW-1;
  state.probeClaims.core=savedClaim;
  state.importMarkers[randomUUID()]=true;
  const receipt=structuredClone(state.reservations[intent.reservationId]);
  receipt.leaseId=randomUUID();receipt.intentId=randomUUID();receipt.receipt.generation=randomUUID();receipt.receipt.ownerNonce=randomUUID();receipt.receipt.dispatches[0].operation='budget-core-observer';
  state.controlReceipts.core=receipt;
  state.debtGroups[randomUUID()]=testDebtGroup({at:NOW,quiescent:false,units:3});
  state.debt.core={unresolvedUnits:3,unresolvedCount:1,quiescentUnits:0,quiescentCount:0,revision:17};
  state.debtGroups[randomUUID()]=testDebtGroup({at,quiescent:true,units:2});
  state.debt.core.quiescentUnits=2;state.debt.core.quiescentCount=1;
  const completed=structuredClone(state.reservations[intent.reservationId]);
  completed.intentId=randomUUID();completed.status='completed';completed.completedAt=at;completed.outcome='measured-success';completed.actualCosts={core:1,graphql:0};completed.receipt.dispatches[0].terminalAt=at;
  state.reservations[`reservation:${completed.intentId}`]=completed;
  if(includeLiveLease){const live=randomUUID();state.leases[live]={...structuredClone(state.leases[id]),expiresAt:at+90000,phaseSeed:{seed:live,registeredAt:NOW-10000}};}
  const pending=randomUUID();state.intents[pending]={leaseId:id,tab:'page:issues',priority:'manual',costs:{core:0,graphql:2},requestedAt:NOW,expiresAt:NOW+90000};
  assert.ok(normalizeGovernorState(state,at,{prune:false,acceptVersion:7}),'fully populated literal v7 fixture must be valid');
  const raw=JSON.stringify(state)+'\n';writeFileSync(b.path,raw);return {...b,state,raw,at};
}
