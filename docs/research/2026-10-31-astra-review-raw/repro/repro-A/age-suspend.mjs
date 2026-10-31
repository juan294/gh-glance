// RT-04: source-age tracker omits an interval where wall time advances but the monotonic clock does not (suspend).
import { createCollectorSourceAgeTracker } from "/Users/juan/code/gh-glance/index.mjs";
let wall = 1_000_000, mono = 0;
const t = createCollectorSourceAgeTracker({ now: () => wall, monotonicNow: () => mono });
console.log("observe age:", t.observe({ lastSuccessAt: wall - 10_000, serverNow: wall }));
wall += 3_600_000; // one hour asleep: wall advances, monotonic does not
mono += 1_000;     // one second awake after resume
console.log("current() after 1h sleep + 1s:", t.current(), "(true age would be", 10_000 + 3_601_000, ")");
// Same observation re-delivered by server after wake (only possible if the client accepts it):
console.log("observe same observation with server wall clock:", t.observe({ lastSuccessAt: 1_000_000 - 10_000, serverNow: wall + 1_000 }));
process.exit(0);
