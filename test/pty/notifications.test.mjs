import assert from "node:assert/strict";
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { createServer } from "node:http";

import { capture, captureAsync, isStatusLine, waitForAwk } from "./capture.mjs";

const ESC = "\x1b";

function configRoot(t, prefix) {
  const root = mkdtempSync(join(tmpdir(), prefix));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  return root;
}

function governorPath(root) {
  const directory = join(root, "gh-glance", "coordination-v2");
  const name = readdirSync(directory).find((entry) => /^quota-[a-f0-9]{64}\.json$/.test(entry));
  assert.ok(name, "governor state was not created");
  return join(directory, name);
}

// One ordinary run that leaves cached Actions rows and a governor ledger, so
// the next run starts with a visible table.
function warmRoot(t, prefix) {
  const root = configRoot(t, prefix);
  capture({
    cols: 80,
    rows: 24,
    signal: "none",
    settle: 15,
    stdin: 'cache="$XDG_CONFIG_HOME/gh-glance/dashboard-cache.json"; ' +
      waitForAwk('"$cache"', 'index($0, "\\"actions\\"") { ok=1 }') + "sleep .3; printf q",
    configHome: root,
  });
  return root;
}

// Rows between the panel's top edge and the Actions column header.
function rowsAboveHeader(lines) {
  const top = lines.findIndex((line) => line.startsWith("╭"));
  const header = lines.findIndex((line, index) => index > top && /TITLE/.test(line));
  assert.ok(top >= 0 && header > top, `no table header in:\n${lines.join("\n")}`);
  return lines.slice(top + 1, header);
}

const holdLock = 'printf \'{"pid":%s,"nonce":"notifications-owner"}\\n\' "$$" > "$GH_GLANCE_NOTICE_LOCK"; ';

test("a wait cause leaves the table in place, colours the badge yellow and is listed in Notifications", (t) => {
  const root = warmRoot(t, "gh-glance-notifications-wait-");
  const env = { GH_GLANCE_CAPTURE_LIVE_FLUSH: "1", GH_GLANCE_NOTICE_LOCK: `${governorPath(root)}.lock` };

  const held = capture({
    cols: 80,
    rows: 20,
    signal: "none",
    settle: 20,
    stdin: waitForAwk('"$GH_GLANCE_CAPTURE_OUT"', 'index($0, "Watching") { ok=1 }') + holdLock +
      waitForAwk('"$GH_GLANCE_CAPTURE_OUT"', 'index($0, "Paused") { ok=1 }', 200) +
      // Past the 800 ms debounce, so the wait is recorded and badged.
      'sleep 2; printf q; sleep .5; rm -f "$GH_GLANCE_NOTICE_LOCK"',
    configHome: root,
    env,
  });
  // Captured before the lock is released: the frame still shows the wait.
  assert.match(held.finalFrame.lines.find(isStatusLine) ?? "", /^‖ Paused/);
  assert.match(held.raw, new RegExp(`${ESC}\\[93m 5:Status \\(\\d+\\) `));
  assert.doesNotMatch(held.raw, /Coordinating with your other panes/);
  assert.deepEqual(rowsAboveHeader(held.finalFrame.lines), []);
  assert.ok(held.finalFrame.widest <= 80);

  const viewed = capture({
    cols: 80,
    rows: 20,
    signal: "none",
    settle: 25,
    stdin: waitForAwk('"$GH_GLANCE_CAPTURE_OUT"', 'index($0, "Watching") { ok=1 }') + holdLock +
      waitForAwk('"$GH_GLANCE_CAPTURE_OUT"', 'index($0, "Paused") { ok=1 }', 200) +
      'sleep 2; rm -f "$GH_GLANCE_NOTICE_LOCK"; sleep 5; printf 5; ' +
      waitForAwk('"$GH_GLANCE_CAPTURE_OUT"', 'index($0, "Cleared: Coordinating") { ok=1 }', 200) +
      "sleep .3; printf q",
    configHome: root,
    env,
  });
  const view = viewed.finalFrame.lines.join("\n");
  assert.match(view, /Notifications · /);
  // Captures default the status check off; the header says so.
  assert.match(view, /GitHub status checks off \(GH_GLANCE_GITHUB_STATUS\)/);
  assert.match(view, /(?:Core|Actions): Coordinating with your other panes/);
  assert.match(view, /Cleared: Coordinating with your other panes/);
  // Opening the view marks the events seen.
  assert.match(viewed.finalFrame.lines[0], /\[5:Status\]/);
  assert.ok(viewed.finalFrame.widest <= 80);
});

test("an action cause stays inline above the table with its remedy and a red badge", (t) => {
  const root = warmRoot(t, "gh-glance-notifications-corrupt-");
  writeFileSync(governorPath(root), "{corrupt\n", { mode: 0o600 });
  const result = capture({ cols: 80, rows: 24, settle: 7, configHome: root });
  const inline = rowsAboveHeader(result.finalFrame.lines);
  assert.ok(inline.length >= 1 && inline.length <= 3, inline.join("\n"));
  assert.match(inline.join("\n"), /gh-glance --doctor/);
  assert.match(result.raw, new RegExp(`${ESC}\\[91m 5:Status \\(\\d+\\) `));
});

test("the tab bar keeps all five section digits on one row from 120 to 40 columns", () => {
  for (const cols of [120, 80, 60, 40]) {
    const result = capture({ cols, rows: 16, settle: 5 });
    const [bar, divider] = result.finalFrame.lines;
    for (const digit of ["1", "2", "3", "4", "5"]) {
      assert.match(bar, new RegExp(`[[ ]${digit}[:(\\]]|[[ ]${digit} |[[ ]${digit}$`), `${cols}: ${bar}`);
    }
    assert.match(divider, /^─+$/, `${cols}: tab bar wrapped:\n${result.finalFrame.lines.slice(0, 3).join("\n")}`);
    assert.ok(result.finalFrame.widest <= cols, `${cols}-column frame overflowed`);
    if (cols === 120) assert.match(bar, /5:Notifications/);
    // Full names are used whenever they fit, so 80 columns shows either tier
    // depending on the counts loaded; tabBarEntries unit tests pin the tiers.
    if (cols === 80) assert.match(bar, /5:(?:Notifications|Status)/);
    assert.ok(result.finalFrame.lines.some(isStatusLine));
  }
});

test("Notifications keys: 5 opens, Esc and digits return, arrows cycle through five positions", (t) => {
  const root = configRoot(t, "gh-glance-notifications-keys-");
  const result = capture({
    cols: 80,
    rows: 18,
    signal: "none",
    settle: 15,
    stdin: waitForAwk('"$GH_GLANCE_CAPTURE_OUT"', 'index($0, "Watching") { ok=1 }') +
      // Right from Security lands on Notifications; Right again wraps to Actions.
      "printf 4; sleep .4; printf '\\033[C'; sleep .6; printf '\\033[C'; sleep .6; " +
      // Left from Actions opens Notifications; Esc returns to the last data tab.
      "printf '\\033[D'; sleep .6; printf '\\033'; sleep .8; printf 2; sleep .4; printf 5; sleep .6; " +
      // Esc with help open over the view closes help; it does not quit.
      "printf 3; sleep .6; printf 5; sleep .6; printf '?'; sleep .6; printf '\\033'; sleep .8; " +
      "printf 3; sleep .6; printf q",
    configHome: root,
    env: { GH_GLANCE_CAPTURE_LIVE_FLUSH: "1" },
  });
  // Every tab-bar write names the active position; collapse repeats.
  const active = [...result.raw.matchAll(/\[(\d):/g)].map((match) => Number(match[1]))
    .filter((position, index, all) => index === 0 || all[index - 1] !== position);
  // 4, Right to 5, Right wraps to 1, Left back to 5, Esc to the last data tab
  // (1), 2, 5, then 3 closes the view.
  assert.deepEqual(active, [1, 4, 5, 1, 5, 1, 2, 5, 3, 5, 3]);
  assert.match(result.finalFrame.lines[0], /\[3:(?:PRs|Pull requests)/);
  assert.equal(result.exitCode, 0);
  // Notifications is a view, never a cached data tab.
  const cache = JSON.parse(readFileSync(join(root, "gh-glance", "dashboard-cache.json"), "utf8"));
  for (const target of Object.values(cache.targets)) assert.equal(Object.hasOwn(target.tabs, "notifications"), false);
});

test("a GitHub incident from the status page turns the badge red, heads the view and clears on r", async (t) => {
  // First request: an Actions incident. Every later request: resolved.
  let requests = 0;
  const server = createServer((_request, reply) => {
    requests += 1;
    const incident = requests === 1;
    reply.setHeader("content-type", "application/json");
    reply.end(JSON.stringify({
      status: { indicator: incident ? "major" : "none" },
      components: [{ name: "Actions", status: incident ? "major_outage" : "operational" }],
      incidents: incident ? [{ id: "fixture-1", name: "Actions runs delayed", status: "investigating",
        impact: "major", components: [{ name: "Actions" }] }] : [],
    }));
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => server.close());
  const root = configRoot(t, "gh-glance-notifications-status-");
  const result = await captureAsync({
    cols: 100,
    rows: 18,
    signal: "none",
    settle: 90,
    stdin: waitForAwk('"$GH_GLANCE_CAPTURE_OUT"', 'index($0, "Notifications (") { ok=1 }', 200) +
      "printf 5; " +
      waitForAwk('"$GH_GLANCE_CAPTURE_OUT"', 'index($0, "GitHub incident: Actions runs delayed") { ok=1 }', 200) +
      // checkNow runs at most once a minute; r after that asks again.
      "sleep 62; printf r; " +
      waitForAwk('"$GH_GLANCE_CAPTURE_OUT"', 'index($0, "Cleared: Actions runs delayed") { ok=1 }', 200) +
      "sleep .3; printf q",
    configHome: root,
    env: { GH_GLANCE_CAPTURE_LIVE_FLUSH: "1",
      GH_GLANCE_GITHUB_STATUS: `http://127.0.0.1:${server.address().port}/api/v2/summary.json` },
  });
  assert.match(result.raw, new RegExp(`${ESC}\\[91m 5:Notifications \\(\\d+\\) `));
  assert.match(result.raw, /GitHub incident: Actions runs delayed/);
  const view = result.finalFrame.lines.join("\n");
  assert.match(view, /GitHub status: All systems operational/);
  assert.match(view, /GitHub status: Cleared: Actions runs delayed/);
  assert.match(view, /GitHub status: Cleared: Actions: major outage/);
  assert.equal(requests, 2);
  assert.equal(result.exitCode, 0);
});
