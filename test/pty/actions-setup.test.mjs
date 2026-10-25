import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { capture } from "./capture.mjs";

const RUNS = "repos/acme/widget/actions/runs?exclude_pull_requests=true&per_page=60";
const SETUP = "repos/acme/widget/actions/workflows?per_page=100&page=1";
const reader = new URL("./capture.mjs", import.meta.url).href;
function fixture(t, overrides = {}) {
  const root = mkdtempSync(join(tmpdir(), "gh-glance-actions-setup-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const now = Date.now();
  writeFileSync(join(root, "fixture.json"), JSON.stringify({ createdAt: now,
    core: { limit: 5000, remaining: 5000, used: 0, resetMs: now + 3_600_000 },
    graphql: { limit: 5000, remaining: 5000, used: 0, resetMs: now + 3_600_000 }, events: [],
    apiEntities: { [RUNS]: { body: "[]" }, [SETUP]: { body: '{"total_count":0,"workflows":[]}' } },
    ...overrides }));
  return root;
}
function driver(root, program, dimensions) {
  const path = join(root, "driver.mjs");
  writeFileSync(path, `import assert from "node:assert/strict";
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { parseCapture } from ${JSON.stringify(reader)};
const root = ${JSON.stringify(root)};
const dimensions = ${JSON.stringify(dimensions)};
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
const screen = () => parseCapture(readFileSync(process.env.GH_GLANCE_CAPTURE_OUT,"utf8"), dimensions).finalFrame.lines.join("\\n");
const send = key => process.stdout.write(key);
const state = () => JSON.parse(readFileSync(root+"/fixture.json", "utf8"));
const calls = () => readFileSync(process.env.GH_GLANCE_CAPTURE_OUT+".calls", "utf8").split("\\n").filter(Boolean);
const setupCalls = () => calls().filter(call => call.includes("total_count"));
const until = async predicate => { const end = Date.now()+16000; while(Date.now()<end) { try { if(predicate()) return; } catch {} await pause(40); } throw Error("UI barrier timed out: "+predicate+"\\n"+screen()); };
const save = name => writeFileSync(root+"/"+name+".txt",screen());
try { ${program} } catch(error) { writeFileSync(root+"/driver-error",String(error)); } finally { send("q"); }
`);
  execFileSync(process.execPath, ["--check", path]);
  return `node '${path}'; `;
}
function run(t, program, { cols = 45, rows = 24, overrides = {}, args = "--repo acme/widget --refresh 300 --background off", env = {}, prepare = () => ({}) } = {}) {
  const root = fixture(t, overrides);
  const result = capture({ cols, rows, signal: "none", settle: 65, configHome: root, args,
    env: { GH_GLANCE_FIXTURE_STATE: join(root, "fixture.json"), GH_GLANCE_CAPTURE_LIVE_FLUSH: "1", NO_COLOR: "1", ...env, ...prepare(root) },
    stdin: driver(root, program, { cols, rows }) });
  assert.equal(result.exitCode, 0);
  assert.equal(existsSync(join(root, "driver-error")), false,
    existsSync(join(root, "driver-error")) ? readFileSync(join(root, "driver-error"), "utf8") : "");
  if (process.env.GH_GLANCE_SETUP_CAPTURES) {
    for (const name of ["empty", "success", "denied", "connected"]) {
      if (existsSync(join(root, name+".txt"))) writeFileSync(join(process.env.GH_GLANCE_SETUP_CAPTURES, `${cols}x${rows}-${name}.txt`), readFileSync(join(root, name+".txt")));
    }
  }
  return { root, result };
}

for (const [cols, rows] of [[45, 24], [24, 10]]) {
  test(`SET-01/02/07/11/12 manual setup is isolated and cached at ${cols}x${rows}`, (t) => {
    const { root, result } = run(t, `
await until(() => screen().includes("No workflow runs") && screen().includes("Watching")); save("empty");
assert.equal(setupCalls().length,0);
for (const key of ["r","R"]) {
 const before=state().events.filter(e=>e.type==="end"&&e.argv?.some(a=>a.includes("/actions/runs?"))).length;
 send(key);
 await until(()=>state().events.filter(e=>e.type==="end"&&e.argv?.some(a=>a.includes("/actions/runs?"))).length>before && screen().includes("Watching"));
}
assert.equal(setupCalls().length,0);
const cachePath=root+"/gh-glance/dashboard-cache.json";
const source=()=>Object.values(JSON.parse(readFileSync(cachePath,"utf8")).targets).find(x=>x.tabs.actions)?.tabs.actions.lastOk;
await until(()=>source()); const before=source();
send("s"); await until(()=>screen().includes("Checking Actions"));
send("s"); await pause(50); send("s");
await until(()=>screen().includes("No workflows found")); save("success");
const observed=screen();
send("s"); await pause(250);
assert.equal(setupCalls().length,1); assert.equal(source(),before);
assert.ok(!screen().includes("Could not load Actions"));
assert.ok(screen().includes("No workflows found"));
assert.equal(state().events.filter(e=>e.type==="start"&&e.argv?.some(a=>a.includes("total_count"))).length,1);
writeFileSync(root+"/success-observation.txt",observed);
`, { cols, rows, overrides: { delayByCommand: { setup: 500 } } });
    const events = JSON.parse(readFileSync(join(root, "fixture.json"))).events;
    const starts = events.filter((e) => e.type === "start" && e.argv?.some((a) => a.includes("total_count")));
    assert.equal(starts.length, 1);
    assert.deepEqual(starts[0].cost, { core: 1, graphql: 0 });
    assert.equal(result.fixtureCalls.some((call) => call.includes("--paginate")), false);
    assert.match(readFileSync(join(root, "success-observation.txt"), "utf8"), /No workflows found/);
  });
}

test("SET-05/07 setup HTTP failure stays separate from the populated run list and key repeats respect cooldown", (t) => {
  run(t, `
await until(()=>screen().includes("ci: pin actions") && screen().includes("Watching"));
send("s"); await until(()=>screen().includes("Setup check unavailable")); save("denied");
assert.ok(screen().includes("ci: pin actions"));
assert.ok(!screen().includes("Could not refresh Actions"));
for(let i=0;i<4;i++){send("s");await pause(40);}
assert.equal(setupCalls().length,1);
assert.ok(screen().includes("Press s to retry"));
assert.ok(!screen().includes("No workflows found"));
`, { cols: 80, overrides: { apiEntities: {}, failure: { selector: "setup", remaining: 1, message: "HTTP 403: Resource not accessible by integration" } } });
});

for (const [connect, cols, rows] of [["local",45,24],["ssh:studio",45,24],["local",24,10],["ssh:studio",24,10]]) {
  test(`SET-09 ${connect} ${cols}x${rows} setup is unsupported with no local API fallback`, (t) => {
    const { result } = run(t, `
await until(()=>/Disconnec|Restore|collector/.test(screen()));
const before=calls(); send("s"); await until(()=>screen().includes("Standalone only")); save("connected");
assert.ok(screen().includes("Restore connection")); assert.ok(screen().includes("g Actions"));
assert.equal(setupCalls().length,0);
send("g"); await until(()=>calls().some(call=>/^open |^xdg-open /.test(call)));
assert.equal(calls().filter(call=>/^api /.test(call)).length,0);
`, { args: `--repo acme/widget --connect ${connect} --background off`, cols, rows });
    assert.equal(result.fixtureCalls.filter((call) => /^(open|xdg-open) /.test(call)).length, 1);
    assert.equal(result.fixtureCalls.some((call) => call.startsWith("api ")), false);
  });
}

test("SET-10 browser failure is separate, retry opens the validated Actions URL, and help consumes g/s", (t) => {
  const { result } = run(t, `
await until(()=>screen().includes("No workflow runs") && screen().includes("Watching"));
for(const key of ["s","g"]) { send("?"); await until(()=>/n next.*p prev/.test(screen())); send(key); await until(()=>!/n next.*p prev/.test(screen())); }
assert.equal(setupCalls().length,0); assert.ok(!calls().some(call=>/^open |^xdg-open /.test(call)));
send("g"); await until(()=>screen().includes("Actions page unavailable"));
assert.ok(!screen().includes("Could not refresh Actions"));
writeFileSync(root+"/opener-error.txt", screen());
const fs=await import("node:fs"); fs.unlinkSync(root+"/opener-fails");
send("g"); await until(()=>calls().filter(call=>/^open |^xdg-open /.test(call)).length===2);
await until(()=>!screen().includes("Actions page unavailable"));
assert.ok(!screen().includes("g Retry"));
assert.equal(setupCalls().length,0);
`, { cols: 80, prepare(root) { const path=join(root,"opener-fails"); writeFileSync(path, "fail"); return { GH_GLANCE_FIXTURE_OPEN_FAILURE_FILE: path }; } });
  assert.deepEqual(result.fixtureCalls.filter((call)=>/^(open|xdg-open) /.test(call)).map((call)=>call.split(" ").at(-1)),
    ["https://github.com/acme/widget/actions", "https://github.com/acme/widget/actions"]);
});

test("SET-08 quit aborts a pending setup child and preserves its original charged receipt", (t) => {
  const { root } = run(t, `
await until(()=>screen().includes("No workflow runs") && screen().includes("Watching"));
send("s"); await until(()=>state().events.some(e=>e.type==="start"&&e.argv?.some(a=>a.includes("total_count"))));
`, { overrides: { delayByCommand: { setup: 30_000 } } });
  const state = JSON.parse(readFileSync(join(root,"fixture.json")));
  const start = state.events.find(e=>e.type==="start"&&e.argv?.some(a=>a.includes("total_count")));
  assert.ok(start);
  assert.throws(()=>process.kill(start.pid, 0), /ESRCH/);
  const registry = JSON.parse(readFileSync(join(root,"gh-glance/coordination-v2/registry.json")));
  const identity = Object.values(registry.identities).find(identity=>identity.id===1);
  const ledger = JSON.parse(readFileSync(join(root,`gh-glance/coordination-v2/quota-${identity.quotaKey}.json`)));
  const reservation = Object.values(ledger.reservations).find(r=>r.receipt?.dispatches?.some(d=>d.operation==="setup:actions-workflows"));
  assert.ok(reservation, "setup reservation remains in captured ledger");
  assert.equal(reservation.costs.core, 1);
});

test("SET-08/11 a tab switch retains setup; an account change aborts it and fences old evidence", (t) => {
  run(t, `
await until(()=>screen().includes("No workflow runs")&&screen().includes("Watching"));
send("s"); await until(()=>state().events.some(e=>e.type==="start"&&e.argv?.some(a=>a.includes("total_count"))));
send("2"); await until(()=>screen().includes("[2:"));
const account=JSON.parse(readFileSync(root+"/account.json","utf8"));
account.token="fixture-new-access-token"; account.user={id:2,login:"new-account"};
writeFileSync(root+"/account.json",JSON.stringify(account)); writeFileSync(root+"/hosts.yml","fixture-account: changed\\n");
const registry=()=>JSON.parse(readFileSync(root+"/gh-glance/coordination-v2/registry.json","utf8"));
await until(()=>Object.values(registry().identities).some(i=>i.id===2));
const old=Object.values(registry().identities).find(i=>i.id===1);
const ledger=()=>JSON.parse(readFileSync(root+"/gh-glance/coordination-v2/quota-"+old.quotaKey+".json","utf8"));
await until(()=>Object.values(ledger().reservations).some(r=>r.receipt?.dispatches?.some(d=>d.operation==="setup:actions-workflows")&&r.status==="completed"));
assert.ok(screen().includes("[2:"));
send("1"); await until(()=>screen().includes("[1:"));
assert.ok(!screen().includes("All listed workflows")); assert.ok(!screen().includes("Checking Actions setup"));
assert.equal(setupCalls().length,1);
`, { cols: 80, args: "--repo acme/widget --refresh 5 --background off",
    overrides: { delayByCommand: { setup: 12_000 }, apiEntities: { [RUNS]: { body: "[]" },
      [SETUP]: { body: '{"total_count":1,"workflows":[{"id":1,"name":"private","state":"disabled_manually"}]}' } } },
    prepare(root) { const path=join(root,"account.json"); writeFileSync(path, JSON.stringify({ token:"fixture-old-access-token",user:{id:1,login:"old-account"} })); writeFileSync(join(root,"hosts.yml"),"fixture-account: old\n"); return { GH_GLANCE_FIXTURE_ACCOUNT_FILE:path }; } });
});

test("SET-06/11 failed shared-hold publication pauses concurrent data and recovery resumes polling without a setup retry", (t) => {
  run(t, `
await until(()=>screen().includes("ci: pin actions")&&screen().includes("Watching"));
send("s"); await until(()=>state().events.some(e=>e.type==="start"&&e.argv?.some(a=>a.includes("total_count"))));
const registry=JSON.parse(readFileSync(root+"/gh-glance/coordination-v2/registry.json","utf8"));
const identity=Object.values(registry.identities).find(i=>i.id===1);
const ledgerPath=root+"/gh-glance/coordination-v2/quota-"+identity.quotaKey+".json";
const lockPath=ledgerPath+".lock";
await until(()=>{try{writeFileSync(lockPath,JSON.stringify({pid:process.pid,nonce:"setup-publication-test"}),{flag:"wx"});return true;}catch{return false;}});
await until(()=>screen().includes("Paused")||screen().includes("Limited"));
assert.ok(screen().includes("ci: pin actions"));
assert.ok(!screen().includes("Could not refresh Actions"));
const before=state().events.filter(e=>e.type==="start"&&e.argv?.some(a=>a.includes("/actions/runs?"))).length;
await pause(300); assert.equal(state().events.filter(e=>e.type==="start"&&e.argv?.some(a=>a.includes("/actions/runs?"))).length,before);
const fs=await import("node:fs"); fs.unlinkSync(lockPath);
await until(()=>state().events.filter(e=>e.type==="end"&&e.argv?.some(a=>a.includes("/actions/runs?"))).length>before);
assert.equal(setupCalls().length,1);
assert.ok(!screen().includes("Could not refresh Actions"));
`, { cols: 80, args: "--repo acme/widget --refresh 5 --background off",
    overrides: { delayByCommand: { setup: 1_000 }, apiEntities: {
      [SETUP]: { status: 429, headers: { "retry-after": "2" }, body: '{"message":"secondary rate limit"}' } } } });
});

for (const [cols, rows] of [[24,10],[45,24]]) {
  test(`SET-06 existing storage recovery keeps priority over a saved setup result at ${cols}x${rows}`, (t) => {
    run(t, `
await until(()=>screen().includes("No workflow runs")&&screen().includes("Watching"));
send("s"); await until(()=>screen().includes("No workflows found"));
const registry=JSON.parse(readFileSync(root+"/gh-glance/coordination-v2/registry.json","utf8"));
const identity=Object.values(registry.identities).find(i=>i.id===1);
const ledgerPath=root+"/gh-glance/coordination-v2/quota-"+identity.quotaKey+".json";
const fs=await import("node:fs");
const ledgerLock=ledgerPath+".lock";
const registryLock=root+"/gh-glance/coordination-v2/registry.json.lock";
const owner=JSON.stringify({pid:process.pid,nonce:"setup-storage-recovery"});
const lock=async path=>until(()=>{try{writeFileSync(path,owner,{flag:"wx"});return true;}catch{return false;}});
await lock(ledgerLock);
const original=readFileSync(ledgerPath,"utf8");
writeFileSync(ledgerPath,"fixture corrupt storage"); fs.unlinkSync(ledgerLock);
let registryHeld=false;
try {
 send("R"); await until(()=>screen().includes("--doctor"));
 if (dimensions.cols===45) {
  // Force a later busy observation while the proven ledger fault persists.
  await lock(registryLock); registryHeld=true;
  send("s");
  await until(()=>!screen().includes("Setup checked:")&&!screen().includes("Saved setup check:"));
  send("s"); await until(()=>screen().includes("Setup check unavailable"));
 } else { send("s"); await pause(200); }
 assert.equal(readFileSync(ledgerPath,"utf8"),"fixture corrupt storage");
 assert.ok(screen().includes("--doctor")); save("denied");
 assert.equal(setupCalls().length,1);
} finally {
 await lock(ledgerLock); writeFileSync(ledgerPath,original); fs.unlinkSync(ledgerLock);
 if(registryHeld)fs.unlinkSync(registryLock);
}
send("R"); await until(()=>screen().includes("Watching")&&!screen().includes("--doctor"));
assert.ok(JSON.parse(readFileSync(ledgerPath,"utf8")).budgets.core);
assert.equal(setupCalls().length,1);
`, { cols, rows });
  });
}
