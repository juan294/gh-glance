import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const WORKER = join(dirname(fileURLToPath(import.meta.url)), "..", "fixtures", "acquisition-worker.mjs");

const query = {
  host: "github.com",
  repositoryId: "R_widget",
  repository: "acme/widget",
  accessKey: "a".repeat(64),
  targetKey: "github.com\0R_widget",
  resource: "actions",
  queryVersion: 2,
  filters: {},
  pageSize: 60,
  cursorGeneration: "first",
};

function snapshot() {
  const at = Date.now();
  const rows = [{ databaseId: 1, displayTitle: "shared process result", workflowName: "CI", number: 1,
    headBranch: "develop", status: "completed", conclusion: "success",
    startedAt: "2026-09-05T00:00:00Z", updatedAt: "2026-09-05T00:01:00Z",
    url: "https://github.com/acme/widget/actions/runs/1" }];
  return {
    rows,
    pageInfo: null,
    raw: JSON.stringify(rows),
    entities: [{ key: "actions\0runs", etag: "\"runs-v1\"", body: JSON.stringify(rows) }],
    lastSuccessAt: at,
    lastChangedAt: at,
    nextDueAt: at + 40_000,
    hold: null,
    capabilities: {},
    meta: { at: Date.now(), truncated: false },
    securityNotes: [],
    securityBlind: false,
  };
}

async function waitForWorkers(path, count) {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    if (readdirSync(path).length === count) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`only ${readdirSync(path).length}/${count} acquisition workers became ready`);
}

test("SHARE-01: twelve separate panes elect one acquisition producer", { timeout: 20_000 }, async (t) => {
  const root = mkdtempSync(join(tmpdir(), "gh-glance-shared-pty-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const readyDir = join(root, "ready");
  const goPath = join(root, "go");
  mkdirSync(readyDir);
  const workers = Array.from({ length: 12 }, (_, index) => execFileAsync(
    process.execPath,
    [WORKER, JSON.stringify({ root, readyDir, goPath, worker: String(index), operation: "refresh",
      query, snapshot: snapshot() })],
    { timeout: 15_000 },
  ));
  await waitForWorkers(readyDir, workers.length);
  writeFileSync(goPath, "go\n", { mode: 0o600 });
  const outcomes = (await Promise.all(workers)).map(({ stdout }) => JSON.parse(stdout));
  assert.equal(outcomes.filter((outcome) => outcome.value?.role === "producer").length, 1);
  assert.equal(outcomes.filter((outcome) => outcome.value?.role === "follower").length, 11,
    JSON.stringify(outcomes));
  assert.ok(outcomes.every((outcome) => outcome.ok));
  assert.ok(outcomes.every((outcome) =>
    outcome.value.snapshot.rows[0].displayTitle === "shared process result"));
});
