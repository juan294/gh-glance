// RT-04 (#171): in collector mode the App returned from its acquisition effect
// before any standalone wake advanced the display clock, so a running run's
// TIME and every UPDATED age froze while connected. The display clock is now
// independent of acquisition mode.
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { test } from "node:test";

import { createCollectorService, normalizeCollectorConfig } from "../../index.mjs";
import { captureAsync, waitForAwk } from "./capture.mjs";

const CONFIG = { version: 1,
  providers: { personal: { type: "gh", host: "github.com" } },
  targets: [{ host: "github.com", repo: "acme/widget", provider: "personal" }] };

test("RT-04: a running collector Actions row keeps advancing its TIME while connected", async (t) => {
  const root = mkdtempSync("/tmp/ggc-clock-");
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const runtime = {
    subscribe({ resource, onSnapshot }) {
      queueMicrotask(() => {
        const at = Date.now();
        // Started ten seconds before delivery, so the first frame shows at most
        // 10s; only a ticking display clock can reach 14s.
        const rows = resource === "actions" ? [{ databaseId: 7, displayTitle: "clock probe",
          workflowName: "CI", number: 7, headBranch: "main", status: "in_progress", conclusion: null,
          startedAt: new Date(at - 10_000).toISOString(), updatedAt: new Date(at - 10_000).toISOString(),
          url: "https://github.com/acme/widget/actions/runs/7" }] : [];
        onSnapshot({ generation: 1, rows, pageInfo: { loadedPages: 1, hasNextPage: false },
          lastSuccessAt: at, lastChangedAt: at, nextDueAt: at + 60_000, hold: null,
          meta: { at, truncated: false }, securityNotes: [], securityBlind: false, capabilities: {} });
      });
      return { updateDemand() {}, refresh() {}, inspect() {}, close() {} };
    },
    close() {},
  };
  const service = await createCollectorService({
    config: normalizeCollectorConfig(CONFIG),
    pathOptions: { env: { XDG_CONFIG_HOME: root }, platform: process.platform },
    runtime,
  });
  t.after(() => service.close());
  const result = await captureAsync({
    cols: 100, rows: 20, signal: "none", settle: 20, configHome: root,
    args: "--connect local --repo acme/widget --tab actions --background off",
    stdin: waitForAwk('"$GH_GLANCE_CAPTURE_OUT"', 'index($0, "clock probe") { seen=1 } ' +
      'seen && /(^|[^0-9m])1[4-9]s/ { ok=1 }', 150) + "printf q",
  });
  const frames = result.raw;
  assert.match(frames, /clock probe/);
  assert.match(frames, /(^|[^0-9m])1[4-9]s/,
    `running TIME did not advance: ${result.finalFrame.lines.join("\n")}`);
});
