import { createAcquisitionEngine } from "../../index.mjs";
import { existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const command = JSON.parse(process.argv[2] ?? "{}");
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
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
