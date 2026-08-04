import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

function requiredMatch(source, pattern, label) {
  const match = source.match(pattern);
  if (!match) throw new Error(`Node test output is missing ${label}`);
  return match[1];
}

export function parseNodeTestCoverage(source) {
  const testCount = Number(requiredMatch(source, /^\s*(?:[ℹ#]\s+)?tests\s+(\d+)\s*$/m, 'test count'));
  const passing = Number(requiredMatch(source, /^\s*(?:[ℹ#]\s+)?pass\s+(\d+)\s*$/m, 'passing count'));
  const failing = Number(requiredMatch(source, /^\s*(?:[ℹ#]\s+)?fail\s+(\d+)\s*$/m, 'failing count'));
  const coveragePercent = Number(requiredMatch(
    source,
    /^\s*(?:[ℹ#]\s+)?all files\s*\|\s*(\d+(?:\.\d+)?)\s*\|/m,
    'all-files line coverage',
  ));

  if (!Number.isInteger(testCount) || testCount <= 0) {
    throw new Error('Node test output must report at least one test');
  }
  if (!Number.isInteger(passing) || passing <= 0 || !Number.isInteger(failing) || failing !== 0) {
    throw new Error('Node test output must report a passing suite');
  }
  if (passing > testCount) {
    throw new Error('Node test totals are inconsistent');
  }
  if (!Number.isFinite(coveragePercent) || coveragePercent < 0 || coveragePercent > 100) {
    throw new Error('Node line coverage is invalid');
  }

  return { testCount, passing, failing, coveragePercent };
}

function run(argv) {
  const [outputPath] = argv;
  if (!outputPath) throw new Error('Usage: extract-coverage-metrics.mjs <node-test-output>');
  const metrics = parseNodeTestCoverage(readFileSync(outputPath, 'utf8'));
  process.stdout.write([
    `test_count=${metrics.testCount}`,
    `tests_passed=${metrics.passing}`,
    `tests_failed=${metrics.failing}`,
    `coverage_percent=${metrics.coveragePercent}`,
    '',
  ].join('\n'));
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    run(process.argv.slice(2));
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
