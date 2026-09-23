import { claimGovernorLock, createAcquisitionEngine, withFileLock } from "../../index.mjs";
import { existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const command = JSON.parse(process.argv[2] ?? "{}");
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
if (command.operation === "stalledCreator") {
  const owner = { pid: process.pid, nonce: command.nonce };
  Object.defineProperty(owner, "nonce", { enumerable: true, get() {
    writeFileSync(command.openPath, "open\n", { mode: 0o600 });
    while (!existsSync(command.resumePath)) {
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 5);
    }
    return command.nonce;
  } });
  const claim = claimGovernorLock(command.lockPath, owner);
  process.stdout.write(`${JSON.stringify({ claim,
    successor: JSON.parse(readFileSync(command.lockPath, "utf8")) })}\n`);
  process.exit(0);
}
if (command.operation === "lock") {
  writeFileSync(join(command.readyDir, command.worker), "ready\n", { mode: 0o600 });
  while (!existsSync(command.goPath)) await wait(5);
  let overlap = false;
  const modes = {};
  const result = withFileLock(command.lockPath, () => {
    try { mkdirSync(command.criticalPath); } catch { overlap = true; }
    if (command.holdUntilPath) {
      const deadline = Date.now() + 5_000;
      while (!existsSync(command.holdUntilPath) && Date.now() < deadline) {
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 5);
      }
    } else {
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 30);
    }
    if (!overlap) rmSync(command.criticalPath, { recursive: true });
    return { ok: true, value: { overlap } };
  }, { waitMs: command.waitMs ?? 2_000, observeArtifact: (kind, path) => {
    modes[kind] = statSync(path).mode & 0o777;
  } });
  process.stdout.write(`${JSON.stringify({ ...result, modes })}\n`);
  process.exit(0);
}
let engine;
let subscribed;
for (let attempt = 0; attempt < 200; attempt += 1) {
  engine = createAcquisitionEngine({ pathOptions: { env: { XDG_CONFIG_HOME: command.root } } });
  subscribed = engine.subscribe(command.query, command.demand ?? { active: true, floorMs: 5_000 });
  if (subscribed.ok || subscribed.reason !== "busy") break;
  engine.close();
  await wait(5);
}
let result = subscribed;
if (subscribed.ok && command.operation === "refresh") {
  if (command.readyDir) {
    writeFileSync(join(command.readyDir, command.worker), "ready\n", { mode: 0o600 });
    while (!existsSync(command.goPath)) await wait(5);
  }
  for (let attempt = 0; attempt < 200; attempt += 1) {
    result = await engine.refresh(subscribed.value.id, { acquire: async () => command.snapshot });
    if (result.ok || result.reason !== "busy") break;
    await wait(5);
  }
  if (result.value?.role === "follower" && !result.value.snapshot) {
    for (let attempt = 0; attempt < 400; attempt += 1) {
      const inspected = engine.inspect(subscribed.value.id);
      if (inspected.ok && inspected.value?.snapshot) {
        result = { ok: true, value: { ...result.value, snapshot: inspected.value.snapshot } };
        break;
      }
      await wait(5);
    }
  }
}
process.stdout.write(`${JSON.stringify(result)}\n`);
engine?.close();
