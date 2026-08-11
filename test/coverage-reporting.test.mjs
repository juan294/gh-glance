import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import test from 'node:test';

import { parseNodeTestCoverage } from '../scripts/extract-coverage-metrics.mjs';

const SAMPLE = `
ℹ tests 87
ℹ suites 0
ℹ pass 87
ℹ fail 0
ℹ start of coverage report
ℹ -----------------------------------------------------
ℹ file      | line % | branch % | funcs % | uncovered lines
ℹ -----------------------------------------------------
ℹ index.mjs |  82.35 |    70.00 |   75.00 |
ℹ -----------------------------------------------------
ℹ all files |  82.35 |    70.00 |   75.00 |
ℹ -----------------------------------------------------
ℹ end of coverage report
`;

test('extracts test and line-coverage metrics from Node test output', () => {
  assert.deepEqual(parseNodeTestCoverage(SAMPLE), {
    testCount: 87,
    passing: 87,
    failing: 0,
    coveragePercent: 82.35,
  });
});

test('keeps skipped tests in the total without treating them as failures', () => {
  assert.deepEqual(
    parseNodeTestCoverage(SAMPLE.replace('ℹ tests 87', 'ℹ tests 88')),
    {
      testCount: 88,
      passing: 87,
      failing: 0,
      coveragePercent: 82.35,
    },
  );
});

test('accepts the hash-prefixed TAP summary emitted by Node 22 on Linux', () => {
  assert.deepEqual(parseNodeTestCoverage(SAMPLE.replaceAll('ℹ', '#')), {
    testCount: 87,
    passing: 87,
    failing: 0,
    coveragePercent: 82.35,
  });
});

test('rejects missing, zero, failed, or malformed coverage summaries', () => {
  for (const source of [
    '',
    SAMPLE.replace('ℹ tests 87', 'ℹ tests 0').replace('ℹ pass 87', 'ℹ pass 0'),
    SAMPLE.replace('ℹ fail 0', 'ℹ fail 1'),
    SAMPLE.replace('all files |  82.35', 'all files |  unknown'),
  ]) {
    assert.throws(() => parseNodeTestCoverage(source));
  }
});

test('coverage workflow is exact-SHA, scheduled, manual, and fail-closed', () => {
  const workflow = readFileSync('.github/workflows/coverage.yml', 'utf8');
  assert.match(workflow, /push:\s*\n\s+branches: \[develop\]/);
  assert.match(workflow, /schedule:\s*\n\s+- cron:/);
  assert.match(workflow, /workflow_dispatch:/);
  assert.match(workflow, /npm run test:coverage/);
  assert.match(workflow, /COVERAGE_SECRET: \$\{\{ secrets\.COVERAGE_SECRET \}\}/);
  assert.match(workflow, /SOURCE_COMMIT_SHA: \$\{\{ github\.sha \}\}/);
  assert.match(workflow, /COVERAGE_WORKFLOW_REF: \$\{\{ github\.workflow_ref \}\}/);
  assert.match(workflow, /SOURCE_TARGET_BRANCH: develop/);
  assert.match(workflow, /bash scripts\/report-coverage\.sh/);
  assert.doesNotMatch(workflow, /continue-on-error|\|\| true/);
});

test('coverage workflow reports PTY runtime visibility without a threshold gate', () => {
  const workflow = readFileSync('.github/workflows/coverage.yml', 'utf8');
  const pkg = JSON.parse(readFileSync('package.json', 'utf8'));

  assert.equal(pkg.scripts['test:coverage:runtime'], 'node test/runtime-coverage.mjs');
  assert.match(workflow, /if: github\.event_name != 'push'/);
  assert.match(workflow, /npm run test:coverage:runtime/);
  assert.match(workflow, /RUNTIME_COVERAGE_SUMMARY=runtime-coverage\.md/);
  assert.match(workflow, /GITHUB_STEP_SUMMARY/);
  assert.doesNotMatch(workflow, /test-coverage-(?:lines|branches|functions)=/);
});

test('reporter fails before networking when required provenance is absent', () => {
  const result = spawnSync('bash', ['scripts/report-coverage.sh'], {
    encoding: 'utf8',
    env: { PATH: process.env.PATH },
  });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /COVERAGE_SECRET is required/);
});
