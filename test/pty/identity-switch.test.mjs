import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { capture, captureAsync } from "./capture.mjs";

const RUNS = "repos/acme/widget/actions/runs?exclude_pull_requests=true&per_page=60";
const TOKENS = ["private-fixture-account-a", "private-fixture-account-b", "private-fixture-account-c"];

function account(token, id, title) {
  return { token, user: { id, login: `account-${id}` }, apiEntities: {
    [RUNS]: { body: JSON.stringify([{
      databaseId: id * 100, displayTitle: title, number: 1, headBranch: "develop",
      status: "completed", conclusion: "success", startedAt: "2026-09-01T10:00:00Z",
      // The run carries its own workflow name, so this pane makes exactly one
      // core request per Actions fetch. Without it the conditional catalog
      // fallback would add a second "actions" call -- delayed by the same
      // fixture delay, and matching the reservation search below.
      updatedAt: "2026-09-01T10:01:00Z", workflowId: 10, workflowName: "CI",
    }]) },
  } };
}

// Runs as the PTY's stdin producer, so the quit key is sent when the run has
// actually reached the state the assertions read -- the switched-in account's
// row on screen *and* the old account's delayed request settled in its original
// ledger. This was a flat `sleep 24`, which is a budget rather than a condition:
// every other synchronization in this file is condition-gated, and a loaded PTY
// run could exceed it and quit before the settlement it is asserting on.
async function quitWhenSwitchSettled(root) {
  const { readFileSync } = await import("node:fs");
  const { join } = await import("node:path");
  const directory = join(root, "gh-glance", "coordination-v2");
  const deadline = Date.now() + 60_000;
  while (Date.now() < deadline) {
    try {
      const registry = JSON.parse(readFileSync(join(directory, "registry.json"), "utf8"));
      const old = Object.values(registry.identities).find((identity) => identity.id === 1);
      if (old) {
        const ledger = JSON.parse(readFileSync(join(directory, `quota-${old.quotaKey}.json`), "utf8"));
        // The newest core-charging reservation, not the first one found. The
        // identity bootstrap also charges one core unit and stays started
        // across the switch by design, so "the first reservation that spends
        // core" names the wrong request -- and waits forever for a charge that
        // is meant to remain uncertain. Nothing new starts in the abandoned
        // scope after the switch, so the newest is the delayed Actions request.
        const newest = Object.values(ledger.reservations)
          .filter((reservation) => reservation.costs.core >= 1 && reservation.startedAt !== null)
          .sort((left, right) => right.startedAt - left.startedAt)[0];
        const settled = newest?.status === "completed";
        const rendered = readFileSync(process.env.GH_GLANCE_CAPTURE_OUT, "utf8").includes("NEW_PRIVATE_ROW");
        if (settled && rendered) break;
      }
    } catch { /* the registry and ledger appear as the run progresses */ }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  process.stdout.write("q");
}

async function waitFor(read, predicate, description) {
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    const value = read();
    if (predicate(value)) return value;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  assert.fail(`Timed out waiting for ${description}`);
}

function assertTerminal(result) {
  assert.equal(result.exitCode, 0);
  assert.equal(result.altEnter, 1);
  assert.equal(result.altExit, 1);
  assert.equal(result.liveScreen.lines.at(-1), "");
  assert.equal(result.afterRestore.visible, "");
  for (const token of TOKENS) {
    assert.equal(result.raw.includes(token), false);
    assert.equal(result.fixtureCalls.join("\n").includes(token), false);
  }
}

function serializedProductionState(root) {
  const directory = join(root, "gh-glance");
  return readdirSync(directory, { recursive: true, withFileTypes: true })
    .filter((entry) => entry.isFile())
    .map((entry) => readFileSync(join(entry.parentPath, entry.name), "utf8")).join("\n");
}

test("ID-02/03/06: switched accounts fence delayed rows, settle the old ledger, and isolate restart caches", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "glance-account-switch-"));
  let activeCapture;
  t.after(async () => {
    await activeCapture?.catch(() => {});
    rmSync(root, { recursive: true, force: true });
  });
  const statePath = join(root, "fixture.json");
  const accountPath = join(root, "fixture-account.json");
  const registryPath = join(root, "gh-glance", "coordination-v2", "registry.json");
  const readState = () => JSON.parse(readFileSync(statePath, "utf8"));
  const readRegistry = () => JSON.parse(readFileSync(registryPath, "utf8"));
  const readLedger = (identity) => JSON.parse(readFileSync(join(root, "gh-glance", "coordination-v2", `quota-${identity.quotaKey}.json`), "utf8"));
  const switchAccount = (value) => {
    writeFileSync(accountPath, JSON.stringify(value), { mode: 0o600 });
    // The production resolver observes gh's local configuration revision;
    // this fixture contains no real login configuration or credentials.
    writeFileSync(join(root, "hosts.yml"), `fixture-account: ${value.user.id}-${value.token.length}\n`, { mode: 0o600 });
  };
  const now = Date.now();
  const resource = () => ({ limit: 5000, remaining: 5000, used: 0, resetMs: now + 3_600_000 });
  writeFileSync(statePath, JSON.stringify({
    createdAt: now, core: resource(), graphql: resource(), events: [],
    delayByCommand: { actions: { ms: 8000, remaining: 1 } },
  }), { mode: 0o600 });
  switchAccount(account(TOKENS[0], 1, "OLD_PRIVATE_ROW"));
  const options = {
    cols: 100, rows: 24, signal: "none", args: "--repo acme/widget --refresh 5",
    configHome: root, env: { GH_GLANCE_FIXTURE_STATE: statePath, GH_GLANCE_FIXTURE_ACCOUNT_FILE: accountPath },
  };
  const running = captureAsync({
    ...options,
    settle: 30,
    stdin: `node -e '(${quitWhenSwitchSettled.toString()})(${JSON.stringify(root)})'`,
  });
  activeCapture = running;
  void running.catch(() => {});
  await waitFor(readState, (state) => state.events.some((event) => event.type === "start" && event.argv.includes(RUNS)), "old account's delayed Actions request");
  const oldIdentity = Object.values(readRegistry().identities).find((identity) => identity.id === 1);
  assert.ok(oldIdentity);
  // The newest started reservation that charges core: the identity bootstrap
  // charges one unit too, and it is meant to stay uncertain across the switch.
  const oldReservation = Object.entries(readLedger(oldIdentity).reservations)
    .filter(([, reservation]) => reservation.status === "started" && reservation.costs.core >= 1)
    .sort(([, left], [, right]) => right.startedAt - left.startedAt)[0];
  assert.ok(oldReservation, "old request had no durable quota reservation");
  switchAccount(account(TOKENS[1], 2, "NEW_PRIVATE_ROW"));
  const result = await running;
  assertTerminal(result);
  assert.equal(result.raw.includes("OLD_PRIVATE_ROW"), false, "delayed old-account rows reached the terminal");
  assert.match(result.finalFrame.lines.join("\n"), /NEW_PRIVATE_ROW/);
  const oldAfter = readLedger(oldIdentity).reservations[oldReservation[0]];
  assert.ok(oldAfter, "old request's charge disappeared on account switch");
  assert.equal(oldAfter.status, "completed", "old result did not settle in its original ledger");
  // The started charge above must survive the switch; anything still *scheduled*
  // on the old scope must not. An intent left behind goes on reserving budget in
  // an account this pane no longer holds a credential for.
  assert.deepEqual(Object.keys(readLedger(oldIdentity).intents), [], "old scope kept scheduled intents after the switch");
  const newIdentity = Object.values(readRegistry().identities).find((identity) => identity.id === 2);
  assert.ok(newIdentity);
  assert.notEqual(oldIdentity.quotaKey, newIdentity.quotaKey);
  assert.equal(readLedger(newIdentity).reservations[oldReservation[0]], undefined);

  // Deny fresh acquisition, so seeing this row on restart proves persisted
  // default-host hydration rather than a second successful HTTP response.
  const state = readState();
  state.failure = { selector: "actions", remaining: 100, message: "HTTP 403: Resource protected by organization SAML enforcement" };
  writeFileSync(statePath, JSON.stringify(state), { mode: 0o600 });
  const restored = capture({ ...options, settle: 10, stdin: "sleep 4; printf q" });
  assertTerminal(restored);
  assert.match(restored.finalFrame.lines.join("\n"), /NEW_PRIVATE_ROW/);

  // A different credential for that same verified user shares only quota.
  switchAccount(account(TOKENS[2], 2, "RESTRICTED_PRIVATE_ROW"));
  const restricted = capture({ ...options, settle: 10, stdin: "sleep 4; printf q" });
  assertTerminal(restricted);
  assert.equal(restricted.raw.includes("NEW_PRIVATE_ROW"), false, "another token hydrated private rows by account ID");
  const sameUser = Object.values(readRegistry().identities).filter((identity) => identity.id === 2);
  assert.equal(sameUser.length, 2);
  assert.equal(new Set(sameUser.map((identity) => identity.quotaKey)).size, 1);
  assert.equal(new Set(sameUser.map((identity) => identity.accessKey)).size, 2);
  const disk = serializedProductionState(root);
  for (const token of TOKENS) assert.equal(disk.includes(token), false, "raw credential reached production state");
});
