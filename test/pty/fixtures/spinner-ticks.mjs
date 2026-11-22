import { appendFileSync } from "node:fs";

// Count the animation clock itself, including frames where Ink writes no bytes.
const original = globalThis.setInterval;
globalThis.setInterval = (callback, delay, ...args) => {
  if (delay !== 200) return original(callback, delay, ...args);
  return original((...values) => {
    appendFileSync(process.env.GH_GLANCE_TEST_SPINNER_TICKS, ".");
    callback(...values);
  }, delay, ...args);
};
