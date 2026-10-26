import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { capture, waitForAwk } from "./capture.mjs";

const waitFor = (text) => waitForAwk('"$GH_GLANCE_CAPTURE_OUT"', `index($0, "${text}") { ok=1 }`, 200);
const reader = new URL("./capture.mjs", import.meta.url).href;
function box(t) {
  const root = mkdtempSync(join(tmpdir(), "gh-glance-context-help-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  return root;
}
function driver(root, program, dimensions = { cols: 80, rows: 24 }) {
  const path = join(root, "driver.mjs");
  writeFileSync(path, `import { readFileSync, writeFileSync } from "node:fs";
import { parseCapture } from ${JSON.stringify(reader)};
const root = ${JSON.stringify(root)};
const dimensions = ${JSON.stringify(dimensions)};
const pause = (ms) => new Promise(resolve => setTimeout(resolve, ms));
const frame = () => parseCapture(readFileSync(process.env.GH_GLANCE_CAPTURE_OUT, "utf8"), dimensions).finalFrame.lines;
const screen = () => frame().join("\\n");
const send = (key) => process.stdout.write(key);
const until = async (predicate) => { const deadline=Date.now()+12000; while(Date.now()<deadline) {
  try { if(predicate()) return; } catch {} await pause(50); } throw Error("UI barrier timed out: "+String(predicate)); };
const calls = () => readFileSync(process.env.GH_GLANCE_CAPTURE_OUT+".calls", "utf8").split("\\n").filter(Boolean);
try { ${program} } catch(error) { writeFileSync(root+"/driver-error", String(error)); }
finally { send("q"); }
`);
  execFileSync(process.execPath, ["--check", path]);
  return `node '${path}'; `;
}

for (const [name, remote] of [["HTTPS", "https://github.com/acme/inferred.git"],
  ["SSH", "git@github.com:acme/inferred.git"]]) {
  test(`NAV-01/06: ${name} inferred target appears in the header and contextual help`, (t) => {
    const root = box(t);
    execFileSync("git", ["init", "-q", root]);
    execFileSync("git", ["-C", root, "remote", "add", "origin", remote]);
    const result = capture({ cols: 80, rows: 24, signal: "none", settle: 30, configHome: root,
      args: "--refresh 300 --background off", env: { GH_GLANCE_CAPTURE_CWD: root,
        GH_REPO: "", GH_HOST: undefined, NO_COLOR: "1", GH_GLANCE_CAPTURE_LIVE_FLUSH: "1" },
      stdin: waitFor("ci: pin actions") + "printf '?'; sleep .3; printf q" });
    const screen = result.finalFrame.lines.join("\n");
    if (process.env.GH_GLANCE_HELP_CAPTURES && name === "HTTPS") {
      writeFileSync(join(process.env.GH_GLANCE_HELP_CAPTURES, "80x24-help.txt"), screen);
    }
    assert.match(screen, /Actions.*acme\/inferred/);
    assert.match(screen, /Target: acme\/inferred/);
    assert.match(screen, /Host: github.com/);
    assert.match(screen, /n next.*p prev/);
    assert.match(screen, /\? close.*quit/);
    assert.equal(result.exitCode, 0);
    assert.equal(result.fixtureCalls.filter((call) => call.includes("/actions/runs?")).length, 1);
    assert.equal(result.fixtureCalls.some((call) => /repo view|actions\/workflows/.test(call)), false);
  });
}

test("NAV-05: closing help consumes action keys and width mode retains ownership", (t) => {
  const root = box(t);
  const result = capture({ cols: 80, rows: 24, signal: "none", settle: 45, configHome: root,
    args: "--repo acme/widget --refresh 300 --background off",
    env: { GH_GLANCE_CAPTURE_LIVE_FLUSH: "1" }, stdin: driver(root, `
await until(() => screen().includes("ci: pin actions") && screen().includes("Watching"));
const before = calls();
for (const key of ["r", "R", "\\r", "w", "s", "g", "2"]) {
  send("?"); await until(() => /n next.*p prev/.test(screen()));
  send(key); await until(() => !/n next.*p prev/.test(screen()));
  if (!screen().includes("[1:Actions") || screen().includes("Width: WORKFLOW")) throw Error("Help key fell through");
}
await pause(300);
writeFileSync(root+"/calls-before", JSON.stringify(before));
writeFileSync(root+"/calls-after", JSON.stringify(calls()));
send("w"); await until(() => screen().includes("Width: WORKFLOW"));
send("?"); await pause(200);
if (!screen().includes("Width: WORKFLOW") || /n next.*p prev/.test(screen())) throw Error("Width mode lost ownership");
send("\\u001b"); await until(() => !screen().includes("Width: WORKFLOW"));
`) });
    assert.equal(result.exitCode, 0);
    assertDriver(root);
    assert.deepEqual(readFileSync(join(root, "calls-after"), "utf8"), readFileSync(join(root, "calls-before"), "utf8"));
    assert.equal(result.fixtureCalls.some((call) => /^(open|xdg-open) /.test(call)), false);
    assert.doesNotMatch(result.finalFrame.lines.join("\n"), /Width: WORKFLOW/);
});

function walkPages(root, dimensions) {
  return driver(root, `
await until(() => /doctor|Could not/.test(screen()));
send("?");
const pages = [];
for (let wanted=1; wanted<=120; wanted++) {
  await until(() => new RegExp("\\\\b"+wanted+"/([0-9]+) n/p ").test(screen()));
  const lines = frame(); const match = screen().match(new RegExp("([0-9]+)/([0-9]+) n/p "));
  pages.push(lines);
  if (Number(match[1]) === Number(match[2])) {
    send("n"); await pause(150);
    if (!screen().includes(match[0])) throw Error("Next escaped last page");
    send("p"); await until(() => screen().includes((Number(match[1])-1)+"/"+match[2]+" n/p "));
    send("n"); await until(() => screen().includes(match[0]));
    break;
  }
  send("n");
}
writeFileSync(root+"/pages.json", JSON.stringify(pages));
`, dimensions);
}
function assertDriver(root) {
  assert.equal(existsSync(join(root, "driver-error")), false,
    existsSync(join(root, "driver-error")) ? readFileSync(join(root, "driver-error"), "utf8") : "");
}
function pageBody(root) {
  assertDriver(root);
  return JSON.parse(readFileSync(join(root, "pages.json"), "utf8")).flatMap((lines) =>
    lines.filter((line) => line.startsWith("│") && !/\d+\/\d+ n\/p |q\/Esc\/\^C quit/.test(line))
      .map((line) => line.slice(1, -1).trim())).join("").replace(/\s+/g, "");
}

test("NAV-03: 24x10 pages expose the complete long target and storage remedy", (t) => {
  const root = box(t);
  const repository = `longowner/${"longrepository".repeat(42)}`;
  writeFileSync(join(root, "gh-glance"), "not a directory\n");
  const result = capture({ cols: 24, rows: 10, signal: "none", settle: 55, configHome: root,
    args: `--repo tenant.ghe.com/${repository} --background off`,
    env: { GH_GLANCE_CAPTURE_LIVE_FLUSH: "1", NO_COLOR: "1" },
    stdin: walkPages(root, { cols: 24, rows: 10 }) });
  assert.equal(result.exitCode, 0);
  const body = pageBody(root);
  assert.ok(body.includes(repository));
  assert.ok(body.includes("tenant.ghe.com"));
  assert.ok(body.includes("Rungh-glance--doctor;checkstoragepermissions"));
  const pages = JSON.parse(readFileSync(join(root, "pages.json"), "utf8"));
  if (process.env.GH_GLANCE_HELP_CAPTURES) {
    writeFileSync(join(process.env.GH_GLANCE_HELP_CAPTURES, "24x10-help-pages.json"), JSON.stringify(pages, null, 2));
  }
  assert.ok(pages.length > 3);
  assert.ok(pages.every((lines) => lines.length === 9 && lines.every((line) => [...line].length <= 23)));
  assert.match(pages[0].join(" "), /doctor/);
  assert.match(result.finalFrame.lines.at(-1), /r.*q.*\?/);
});

test("NAV-03/06: narrow help retains the complete sanitized source diagnostic", (t) => {
  const root = box(t);
  const diagnostic = "fixture diagnostic prefix " + "word ".repeat(10) + "distinctive-diagnostic-tail";
  const result = capture({ cols: 24, rows: 10, signal: "none", settle: 55, configHome: root,
    args: "--repo acme/widget --background off", env: { GH_GLANCE_CAPTURE_LIVE_FLUSH: "1",
      GH_GLANCE_FIXTURE_FAIL: diagnostic, GH_GLANCE_FIXTURE_FAIL_ON: "actions", NO_COLOR: "1" },
    stdin: walkPages(root, { cols: 24, rows: 10 }) });
  assert.equal(result.exitCode, 0);
  assert.ok(pageBody(root).includes(diagnostic.replace(/\s+/g, "")));
});

test("NAV-03: live resize reflows help and clamps a later narrow page", (t) => {
  const root = box(t);
  writeFileSync(join(root, "gh-glance"), "not a directory\n");
  const result = capture({ cols: 24, rows: 10, resize: { cols: 80, rows: 24, afterSeconds: 8 },
    signal: "none", settle: 35, configHome: root, args: "--repo acme/widget --background off",
    env: { GH_GLANCE_CAPTURE_LIVE_FLUSH: "1" }, stdin: driver(root, `
await until(() => /doctor/.test(screen())); send("?");
for (let page=1; page<=10; page++) {
  await until(() => screen().includes(page+"/") && screen().includes("n/p ?close"));
  if(page<10) send("n");
}
const before=screen().match(new RegExp("([0-9]+)/([0-9]+) n/p "));
await until(() => readFileSync(process.env.GH_GLANCE_CAPTURE_OUT,"utf8").includes("n next p prev"));
dimensions.cols=80; dimensions.rows=24;
await until(() => screen().includes("n next p prev"));
const after=screen().match(new RegExp("([0-9]+)/([0-9]+) n next"));
writeFileSync(root+"/resize.json",JSON.stringify({before:before.slice(1),after:after.slice(1),lines:frame()}));
`, { cols: 24, rows: 10 }) });
  assert.equal(result.exitCode, 0);
  assertDriver(root);
  const evidence = JSON.parse(readFileSync(join(root, "resize.json"), "utf8"));
  assert.equal(Number(evidence.before[0]), 10);
  assert.ok(Number(evidence.after[1]) < 10);
  assert.equal(Number(evidence.after[0]), Number(evidence.after[1]));
  assert.ok(result.finalFrame.widest <= 79);
  assert.ok(result.finalFrame.lines.length <= 23);
});

test("NAV-02/05: unresolved help exposes an explicit target and consumes prompt Enter", (t) => {
  const root = box(t);
  execFileSync("git", ["init", "-q", root]);
  const result = capture({ cols: 80, rows: 24, signal: "none", settle: 30, configHome: root,
    env: { GH_GLANCE_CAPTURE_CWD: root, GH_GLANCE_CAPTURE_LIVE_FLUSH: "1" },
    stdin: driver(root, `
await until(() => screen().includes("No GitHub remote found")); send("?");
await until(() => screen().includes("n next p prev"));
writeFileSync(root+"/unresolved.txt",screen());
send("\\r"); await until(() => !screen().includes("n next p prev"));
if(!screen().includes("No GitHub remote found")) throw Error("Prompt Enter fell through help");
`) });
  assertDriver(root);
  const help = readFileSync(join(root, "unresolved.txt"), "utf8");
  assert.match(help, /Repository unresolved/);
  assert.match(help, /gh-glance --repo owner\/name/);
  assert.doesNotMatch(help, /Connected|acme\/widget/);
  assert.deepEqual(result.fixtureCalls, ["--version"]);
  assert.equal(result.exitCode, 0);
});

for (const [name, quit] of [["Escape", "\\033"], ["Ctrl+C", "\\003"]]) {
  test(`NAV-05: ${name} still quits from contextual help`, () => {
    const result = capture({ cols: 80, rows: 24, signal: "none", settle: 25,
      args: "--repo acme/widget --refresh 300 --background off", env: { GH_GLANCE_CAPTURE_LIVE_FLUSH: "1" },
      stdin: waitFor("ci: pin actions") + "printf '?'; " + waitFor("n next p prev") + `printf '${quit}'` });
    assert.equal(result.exitCode, 0);
    assert.equal(result.afterRestore.visible, "");
    assert.match(result.finalFrame.lines.join("\n"), /n next p prev/);
  });
}

test("NAV-06: reader and no-color help include state, target, source and recovery controls", () => {
  const result = capture({ cols: 80, rows: 24, signal: "none", settle: 30,
    args: "--repo acme/widget --refresh 300 --background off", env: { GH_GLANCE_CAPTURE_LIVE_FLUSH: "1",
      INK_SCREEN_READER: "true", NO_COLOR: "1", GH_GLANCE_FIXTURE_FAIL: "HTTP 401: Bad credentials",
      GH_GLANCE_FIXTURE_FAIL_ON: "actions" },
    stdin: waitFor("Could not load Actions") + "printf '?'; " + waitFor("n next p prev") + "sleep 1; printf q" });
  const help = result.raw.slice(result.raw.indexOf("Target: acme/widget"));
  assert.match(help, /Host: github.com/);
  assert.match(result.raw, /Not checked yet/);
  assert.match(result.raw, /gh auth status/);
  assert.match(help, /n next p prev.*\? close.*quit/);
  assert.equal(result.exitCode, 0);
  assert.equal((help.match(/Target: acme\/widget/g) ?? []).length, 1);
});
