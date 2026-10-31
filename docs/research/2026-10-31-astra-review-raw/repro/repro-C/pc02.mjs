import { fetchAlertSource } from "/Users/juan/code/gh-glance/index.mjs";
const source = { key: "dependabot-repro", name: "Dependabot", path: "repos/{owner}/{repo}/dependabot/alerts?per_page=100",
  priorityQueries: [], jq: ".", unavailable: "Dependabot alerts are not enabled", map: (a) => a };
const now = performance.now();
let callsB = 0;
// Repo A: 403 not enabled
const a = await fetchAlertSource(source, null, now, { request: async () => { const e = new Error("HTTP 403: Dependabot alerts are disabled"); throw e; } });
console.log("A verdict", a.verdict, "raw", a.raw);
// Repo B (different repo, same process/credential): would return a live alert
const b = await fetchAlertSource(source, null, now + 1000, { request: async () => { callsB++; return { status: 200, body: JSON.stringify([{ number: 7, state: "open" }]) }; } });
console.log("B request calls", callsB, "verdict", b.verdict, "raw", b.raw, "parsed", JSON.stringify(b.parse()));
