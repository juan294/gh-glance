#!/usr/bin/env node
// gh-glance performance, caching and real-time reporting review on GPT-6 Astra (Personal-org credits).
// The API key is read from the macOS Keychain inside this process and never printed.
// Usage: node run.mjs <perf-caching|realtime> [--dry-run]
import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const DIR = dirname(fileURLToPath(import.meta.url));
const SPEND = join(DIR, "..", "openai-spend");
const CAP_USD = Number(process.env.OPENAI_TOTAL_CAP_USD ?? 90);
const MAX_OUT = 60_000;
const pass = process.argv[2];
const dryRun = process.argv.includes("--dry-run");
const P = { in: 10, cached: 1, out: 50, inL: 20, cachedL: 2, outL: 75 };
const cost = (u) => {
  const long = u.input_tokens > 272_000;
  const r = (k) => (long ? P[`${k}L`] : P[k]);
  const cached = u.input_tokens_details?.cached_tokens ?? 0;
  return ((u.input_tokens - cached) * r("in") + cached * r("cached") + u.output_tokens * r("out")) / 1e6;
};
const spent = () => readdirSync(SPEND).reduce((s, f) => s + JSON.parse(readFileSync(join(SPEND, f), "utf8")).usd, 0);
const record = (usd, kind) => writeFileSync(join(SPEND, `glance-${pass}.json`), JSON.stringify({ name: `glance-${pass}`, usd, kind, at: new Date().toISOString() }));
const key = () => execFileSync("security", ["find-generic-password", "-s", "openai-personal-audits", "-w"], { encoding: "utf8" }).trim();
async function api(path, body) {
  for (let attempt = 0; ; attempt++) {
    const res = await fetch(`https://api.openai.com/v1${path}`, {
      method: body ? "POST" : "GET",
      headers: { Authorization: `Bearer ${key()}`, "Content-Type": "application/json" },
      body: body ? JSON.stringify(body) : undefined,
    });
    const text = await res.text();
    if (res.ok) return JSON.parse(text);
    if (res.status === 429 && !text.includes("credit_balance_exhausted") && attempt < 5) {
      await new Promise((r) => setTimeout(r, 30_000 * (attempt + 1)));
      continue;
    }
    throw new Error(`${path} -> ${res.status}: ${text.slice(0, 1500)}`);
  }
}

const SCHEMA = {
  type: "object", additionalProperties: false, required: ["summary", "items", "checked_sound", "unresolved"],
  properties: {
    summary: { type: "string" },
    items: { type: "array", items: { type: "object", additionalProperties: false,
      required: ["id", "kind", "title", "priority", "locations", "evidence", "current_behavior", "proposal", "expected_gain", "effort", "risk", "confidence", "already_documented"],
      properties: {
        id: { type: "string" },
        kind: { type: "string", enum: ["defect", "optimization", "enhancement"] },
        title: { type: "string" },
        priority: { type: "string", enum: ["high", "medium", "low"] },
        locations: { type: "array", items: { type: "object", additionalProperties: false, required: ["path", "line_start", "line_end"],
          properties: { path: { type: "string" }, line_start: { type: "integer" }, line_end: { type: "integer" } } } },
        evidence: { type: "string", description: "Exact quoted lines from the pack." },
        current_behavior: { type: "string", description: "What happens today, quantified where the code allows (requests per refresh, bytes, ms, spawns)." },
        proposal: { type: "string", description: "The concrete change, naming the functions to change." },
        expected_gain: { type: "string", description: "Quantified where possible: API points or requests saved per hour, latency, CPU, staleness window." },
        effort: { type: "string", enum: ["small", "medium", "large"] },
        risk: { type: "string", description: "What could regress, including interactions with the governor, coordination files, collector and quotas." },
        confidence: { type: "string", enum: ["high", "medium", "low"] },
        already_documented: { type: "string", description: "Empty, or the decision/plan/README section that already records or rejects this, and whether the code matches it." },
      } } },
    checked_sound: { type: "array", items: { type: "string" } },
    unresolved: { type: "array", items: { type: "string" } },
  },
};

const COMMON = `You are a principal engineer reviewing gh-glance (npm gh-glance v0.18.0), a live-refreshing GitHub dashboard for a narrow terminal pane: Actions, Issues, Pull Requests and Security alerts. It is one large Node module (index.mjs) that fetches through the gh CLI, coordinates many concurrent instances (panes) through files, budgets GitHub rate limits with a governor, keeps a last-known-good cache across restarts, and can use an optional local or SSH collector. The owner wants concrete performance optimizations and enhancements to caching and real-time reporting.

The pack holds index.mjs, the README, the architecture decisions on the data layer, file-backed API coordination, quota identities and the collector, the multi-instance efficiency research, and the conditional-polling and durable-freshness plans, all at commit 2b21de9. Every line is prefixed with its line number. Tests are excluded.

Rules:
- Ground every item in quoted code from the pack, with exact path and line numbers. No speculation about code that is not in the pack.
- Respect deliberate decisions: if a decision record or plan chose a design on purpose, do not propose reversing it unless the code shows the stated rationale no longer holds; say so in already_documented. Proposals that would raise GitHub API consumption or break multi-instance coordination need an explicit justification.
- Quantify current cost and expected gain from the code (requests per refresh per pane, GraphQL points, subprocess spawns, file reads/writes per tick, render work per frame, staleness windows).
- Report real defects in these areas as kind "defect". Prefer fewer, well-evidenced, high-leverage items over a long list. No style nits.
- Finish with checked_sound (areas you verified and found well designed) and unresolved questions.`;

const PASSES = {
  "perf-caching": `${COMMON}

FOCUS: PERFORMANCE AND CACHING. Examine: startup latency to first useful frame (module init, cache load, first fetch); per-refresh cost (gh spawns, REST vs GraphQL, conditional requests/ETags, pagination, payload size, JSON parsing); CPU and memory in steady state (render loop, diffing, timers, listeners, retained history); the last-known-good cache and coordination files (format, write frequency, atomicity, fsync, size growth, lock contention across N panes, invalidation rules, staleness bounds, cache key correctness across accounts/hosts/repos); deduplication across panes and with the collector; any cache that can serve wrong data (wrong repo, wrong identity, wrong host) or never expire.`,
  realtime: `${COMMON}

FOCUS: REAL-TIME REPORTING. Examine: how fast a real GitHub change (workflow run starts/finishes, PR review, new issue, new alert) reaches the screen, end to end (poll cadence, adaptive backoff, conditional polling, collector push/pull, cross-pane sharing); worst-case and typical staleness per section; whether the UI tells the truth about freshness (ages, stale/degraded indicators, rate-limit states, partial failures, collector disconnect) and recovers promptly after sleep/wake, network loss, rate-limit reset, or gh auth change; event-driven alternatives within GitHub's constraints (ETag/If-None-Match on events endpoints, webhooks via the collector, gh api --cache) and their cost; prioritizing what the user is looking at (focused section, in-progress runs) over idle data.`,
};

if (!PASSES[pass]) throw new Error(`unknown pass ${pass}`);
const pack = readFileSync(join(DIR, "pack.md"), "utf8");
const estIn = Math.ceil((pack.length + PASSES[pass].length) / 3.6);
const worst = (estIn * (estIn > 272_000 ? P.inL : P.in) + MAX_OUT * (estIn > 272_000 ? P.outL : P.out)) / 1e6;
const total = spent();
console.log(`${pass}: est_in~${estIn} worst=$${worst.toFixed(2)} committed=$${total.toFixed(2)} cap=$${CAP_USD}`);
if (total + worst > CAP_USD) throw new Error("cap would be exceeded; refusing to send");
if (dryRun) process.exit(0);
record(worst, "reservation");
const created = await api("/responses", {
  model: "gpt-6-astra", background: true, store: true, reasoning: { effort: "high" }, max_output_tokens: MAX_OUT,
  instructions: PASSES[pass], input: [{ role: "user", content: [{ type: "input_text", text: pack }] }],
  text: { format: { type: "json_schema", name: "glance_review", strict: true, schema: SCHEMA } },
});
let r = created;
while (r.status === "queued" || r.status === "in_progress") {
  await new Promise((res) => setTimeout(res, 20_000));
  r = await api(`/responses/${created.id}`);
}
writeFileSync(join(DIR, "out", `${pass}.raw.json`), JSON.stringify(r, null, 2));
const usd = r.usage ? cost(r.usage) : worst;
record(usd, r.usage ? "actual" : "reservation-kept");
console.log(`${pass}: ${r.status} in=${r.usage?.input_tokens} out=${r.usage?.output_tokens} $${usd.toFixed(4)}`);
if (r.status !== "completed") { console.log(JSON.stringify(r.error ?? r.incomplete_details)); process.exit(1); }
const text = r.output.filter((o) => o.type === "message").flatMap((o) => o.content).filter((c) => c.type === "output_text").map((c) => c.text).join("");
writeFileSync(join(DIR, "out", `${pass}.json`), JSON.stringify(JSON.parse(text), null, 2));
console.log(`wrote out/${pass}.json`);
