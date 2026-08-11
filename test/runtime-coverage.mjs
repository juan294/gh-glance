import { spawnSync } from "node:child_process";
import {
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

function functionKey(fn) {
  const range = fn.ranges?.[0];
  return range == null
    ? null
    : `${fn.functionName}\0${range.startOffset}\0${range.endOffset}`;
}

export function summarizeRuntimeCoverage(reports, indexUrl) {
  const functions = new Map();
  let reportCount = 0;

  for (const report of reports) {
    const scripts = report.result?.filter(({ url }) => url === indexUrl) ?? [];
    if (scripts.length > 0) reportCount += 1;

    for (const script of scripts) {
      for (const fn of script.functions ?? []) {
        const key = functionKey(fn);
        if (key == null) continue;
        const observed = fn.ranges.some(({ count }) => count > 0);
        functions.set(key, (functions.get(key) ?? false) || observed);
      }
    }
  }

  const totalFunctions = functions.size;
  const observedFunctions = [...functions.values()].filter(Boolean).length;
  return {
    observedFunctions,
    totalFunctions,
    observedPercent: totalFunctions === 0
      ? 0
      : Number(((observedFunctions / totalFunctions) * 100).toFixed(2)),
    reportCount,
  };
}

export function formatRuntimeCoverage({
  observedFunctions,
  totalFunctions,
  observedPercent,
  reportCount,
}) {
  return [
    "### PTY runtime coverage",
    "",
    `PTY child processes observed **${observedFunctions} of ${totalFunctions} functions (${observedPercent.toFixed(2)}%)** in \`index.mjs\` across ${reportCount} V8 coverage reports.`,
    "",
    "This informational signal is separate from unit line coverage. It has no threshold and does not change the release gates.",
    "",
  ].join("\n");
}

function* readReports(directory) {
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    if (entry.isFile() && entry.name.endsWith(".json")) {
      yield JSON.parse(readFileSync(join(directory, entry.name), "utf8"));
    }
  }
}

function run() {
  const coverageDirectory = mkdtempSync(join(tmpdir(), "gh-glance-runtime-coverage-"));
  try {
    const result = spawnSync(
      "npm",
      ["run", "test:pty"],
      {
        env: { ...process.env, NODE_V8_COVERAGE: coverageDirectory },
        stdio: "inherit",
      },
    );
    if (result.error) throw result.error;
    if (result.status !== 0) return result.status ?? 1;

    const indexUrl = pathToFileURL(resolve("index.mjs")).href;
    const summary = summarizeRuntimeCoverage(readReports(coverageDirectory), indexUrl);
    if (summary.totalFunctions === 0) {
      throw new Error("PTY tests produced no V8 coverage for index.mjs");
    }

    const markdown = formatRuntimeCoverage(summary);
    process.stdout.write(markdown);
    if (process.env.RUNTIME_COVERAGE_SUMMARY) {
      writeFileSync(process.env.RUNTIME_COVERAGE_SUMMARY, markdown);
    }
    return 0;
  } finally {
    rmSync(coverageDirectory, { recursive: true, force: true });
  }
}

const isMain = process.argv[1] != null
  && resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (isMain) {
  try {
    process.exitCode = run();
  } catch (error) {
    console.error(`runtime coverage failed: ${error.message}`);
    process.exitCode = 1;
  }
}
