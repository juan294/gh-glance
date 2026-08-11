import assert from "node:assert/strict";
import { pathToFileURL } from "node:url";
import test from "node:test";

import {
  formatRuntimeCoverage,
  summarizeRuntimeCoverage,
} from "./runtime-coverage.mjs";

const INDEX_URL = pathToFileURL("/workspace/index.mjs").href;

test("runtime coverage merges duplicate V8 functions across child processes", () => {
  const reports = [
    {
      result: [
        {
          url: INDEX_URL,
          functions: [
            { functionName: "main", ranges: [{ startOffset: 0, endOffset: 20, count: 1 }] },
            { functionName: "fetchRuns", ranges: [{ startOffset: 20, endOffset: 40, count: 0 }] },
          ],
        },
        {
          url: pathToFileURL("/workspace/test/pty/capture.mjs").href,
          functions: [{ functionName: "capture", ranges: [{ startOffset: 0, endOffset: 10, count: 1 }] }],
        },
      ],
    },
    {
      result: [
        {
          url: INDEX_URL,
          functions: [
            { functionName: "main", ranges: [{ startOffset: 0, endOffset: 20, count: 0 }] },
            { functionName: "fetchRuns", ranges: [{ startOffset: 20, endOffset: 40, count: 2 }] },
            { functionName: "fetchIssues", ranges: [{ startOffset: 40, endOffset: 60, count: 0 }] },
          ],
        },
      ],
    },
  ];

  assert.deepEqual(summarizeRuntimeCoverage(reports, INDEX_URL), {
    observedFunctions: 2,
    totalFunctions: 3,
    observedPercent: 66.67,
    reportCount: 2,
  });
});

test("runtime coverage markdown clearly separates PTY and unit signals", () => {
  const markdown = formatRuntimeCoverage({
    observedFunctions: 42,
    totalFunctions: 60,
    observedPercent: 70,
    reportCount: 8,
  });

  assert.match(markdown, /PTY child processes observed \*\*42 of 60 functions \(70\.00%\)\*\*/);
  assert.match(markdown, /separate from unit line coverage/i);
  assert.match(markdown, /informational signal/i);
});
