import {
  claimProbe,
  completeReservation,
  createGovernorScope,
  heartbeatLease,
  inspectGovernor,
  publishProbe,
  readIntentDecision,
  recordResourceBlock,
  registerIntent,
  registerLease,
  releaseLease,
  requestManualProbe,
  startReservation,
  withGovernorLock,
} from "../../index.mjs";

const command = JSON.parse(process.argv[2] ?? "{}");
const scopeResult = createGovernorScope({
  effectiveHost: command.host,
  authIdentity: command.authIdentity,
  env: { XDG_CONFIG_HOME: command.root },
  now: () => command.now,
});

if (!scopeResult.ok) {
  process.stdout.write(`${JSON.stringify(scopeResult)}\n`);
  process.exit(0);
}

const scope = scopeResult.value;
let result;
const waitCell = new Int32Array(new SharedArrayBuffer(4));
function retryBusy(operation) {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const value = operation();
    if (value?.reason !== "busy") return value;
    Atomics.wait(waitCell, 0, 0, 10);
  }
  return { ok: false, reason: "busy" };
}

switch (command.operation) {
  case "register-claim": {
    const registered = retryBusy(() => registerLease(scope, command.lease));
    result = registered.ok
      ? { registered, claim: retryBusy(() => claimProbe(scope, command.lease.id, command.now)) }
      : { registered };
    break;
  }
  case "register-intent": {
    const registered = retryBusy(() => registerLease(scope, command.lease));
    result = registered.ok
      ? { registered, intent: retryBusy(() => registerIntent(scope, command.intent)) }
      : { registered };
    break;
  }
  case "claim-hold": {
    const registered = retryBusy(() => registerLease(scope, command.lease));
    const claim = registered.ok
      ? retryBusy(() => claimProbe(scope, command.lease.id, command.now))
      : registered;
    process.stdout.write(`${JSON.stringify({ ready: true, registered, claim })}\n`);
    Atomics.wait(waitCell, 0, 0, command.holdMs ?? 10_000);
    result = { ok: true, value: "held" };
    break;
  }
  case "start-hold": {
    const started = retryBusy(() => startReservation(scope, command.reservationId, command.now));
    process.stdout.write(`${JSON.stringify({ ready: true, started })}\n`);
    Atomics.wait(waitCell, 0, 0, command.holdMs ?? 10_000);
    result = { ok: true, value: "held" };
    break;
  }
  case "registerLease": result = retryBusy(() => registerLease(scope, command.payload)); break;
  case "heartbeatLease": result = retryBusy(() => heartbeatLease(scope, command.leaseId, command.demand, command.now)); break;
  case "claimProbe": result = retryBusy(() => claimProbe(scope, command.leaseId, command.now)); break;
  case "publishProbe": result = retryBusy(() => publishProbe(scope, command.leaseId, command.nonce, command.budgets, command.now)); break;
  case "requestManualProbe": result = retryBusy(() => requestManualProbe(scope, command.leaseId, command.epoch, command.observedAt, command.now)); break;
  case "registerIntent": result = retryBusy(() => registerIntent(scope, command.payload)); break;
  case "readIntentDecision": result = retryBusy(() => readIntentDecision(scope, command.intentId, command.now)); break;
  case "startReservation": result = retryBusy(() => startReservation(scope, command.reservationId, command.now)); break;
  case "completeReservation": result = retryBusy(() => completeReservation(scope, command.reservationId, command.completion, command.now)); break;
  case "recordResourceBlock": result = retryBusy(() => recordResourceBlock(scope, command.resource, command.resetMs, command.reason)); break;
  case "releaseLease": result = retryBusy(() => releaseLease(scope, command.leaseId)); break;
  case "inspectGovernor": result = retryBusy(() => inspectGovernor(scope, command.now)); break;
  case "hold-lock": {
    result = withGovernorLock(scope, () => {
      process.stdout.write("ready\n");
      Atomics.wait(waitCell, 0, 0, command.holdMs ?? 1000);
      return { ok: true, value: "released" };
    }, { waitMs: command.waitMs ?? 250 });
    break;
  }
  default: result = { ok: false, reason: "corrupt" };
}

process.stdout.write(`${JSON.stringify(result)}\n`);
