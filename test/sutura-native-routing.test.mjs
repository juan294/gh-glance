// Exercise the installed planner and CLI. Only the external gh API is faked.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, delimiter } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { planCi } from '../scripts/release-candidate.mjs';

const repository = 'example/consumer';
const commit = 'a'.repeat(40);
const repair = {
  number: 7, head: 'b'.repeat(40), headRef: 'sutura/fix-123',
  headRepository: repository, baseRepository: repository, base: 'develop',
  mergedAt: '2026-10-27T00:00:00Z', mergeCommit: commit,
};
const quick = ['lint', 'smoke', 'test', 'terminal-smoke', 'candidate'];
const prQuick = ['lint', 'smoke', 'test', 'terminal-smoke', 'pty', 'candidate'];
const broad = ['lint', 'smoke', 'test', 'terminal-smoke', 'sustained', 'pty-governor', 'pty-rest', 'pty', 'candidate'];
const integration = (mergedPullRequest = repair, extra = {}) => planCi({
  event: 'push', repository, baseRef: 'develop', commit, mergedPullRequest, ...extra,
});
const proposal = (extra = {}) => planCi({
  event: 'pull_request', repository, baseRef: 'develop', headRepository: repository,
  headRef: repair.headRef, changedPaths: ['README.md'], ...extra,
});
const assertBroad = (plan) => {
  assert.equal(plan.profile, 'broad');
  assert.deepEqual(plan.jobs, broad);
  assert.equal(plan.jobs.includes('pack'), false);
  assert.equal(plan.jobs.includes('promotion'), false);
};

test('same-repository Sutura repair proposals select full native application checks', () => {
  for (const headRef of ['sutura/fix-123', `sutura/fix-123-dispatch-${'a'.repeat(16)}`]) {
    const plan = proposal({ headRef });
    assert.equal(plan.role, 'pull-request');
    assertBroad(plan);
  }
});

test('proposal branch names do not grant routing to foreign repositories or other bases', () => {
  for (const extra of [
    { headRepository: 'other/repo' }, { headRepository: null }, { baseRef: 'other' },
    { headRef: 'feature/x' }, { headRef: 'sutura/fix-0' }, { headRef: 'sutura/fix-01' },
    { headRef: 'sutura/fix-123/extra' }, { headRef: 'sutura/fix-123-dispatch-abcd' },
    { headRef: `sutura/fix-123-dispatch-${'A'.repeat(16)}` },
  ]) {
    const plan = proposal(extra);
    assert.equal(plan.profile, 'docs', JSON.stringify(extra));
    assert.deepEqual(plan.jobs, prQuick, JSON.stringify(extra));
  }
  const rejected = proposal({ baseRef: 'main' });
  assert.equal(rejected.role, 'rejected');
  assert.equal(rejected.jobs.includes('pack'), false);
});

test('exact authenticated repair integration selects broad work even with a release PR open', () => {
  for (const releasePrOpen of [false, true]) {
    const plan = integration(repair, { releasePrOpen });
    assert.equal(plan.role, 'integration');
    assert.equal(plan.repairIntegration, true);
    assertBroad(plan);
  }
});

for (const [name, patch] of [
  ['wrong merge SHA', { mergeCommit: 'c'.repeat(40) }],
  ['wrong base', { base: 'main' }],
  ['foreign head repository', { headRepository: 'other/repo' }],
  ['foreign base repository', { baseRepository: 'other/repo' }],
  ['missing base repository', { baseRepository: null }],
  ['missing head repository', { headRepository: null }],
  ['ordinary head', { headRef: 'feature/x' }],
  ['not merged', { mergedAt: null }],
  ['malformed repair head', { headRef: 'sutura/fix-123/extra' }],
  ['zero repair number', { headRef: 'sutura/fix-0' }],
  ['malformed dispatch suffix', { headRef: 'sutura/fix-123-dispatch-abcd' }],
]) {
  test(`repair integration rejects ${name} without changing ordinary cadence`, () => {
    for (const releasePrOpen of [false, true]) {
      const plan = integration({ ...repair, ...patch }, { releasePrOpen });
      assert.notEqual(plan.repairIntegration, true);
      assert.deepEqual(plan.jobs, releasePrOpen ? ['candidate'] : quick);
    }
  });
}

test('authenticated long-dispatch repair integrations receive full native checks', () => {
  const plan = integration({ ...repair, headRef: `sutura/fix-123-dispatch-${'a'.repeat(16)}` });
  assert.equal(plan.repairIntegration, true);
  assertBroad(plan);
});

test('missing evidence and invalid commit identities retain QUICK or covered cadence', () => {
  assert.deepEqual(integration(null).jobs, quick);
  assert.deepEqual(integration(null, { releasePrOpen: true }).jobs, ['candidate']);
  for (const commit of [undefined, null, '', 'short', 'A'.repeat(40)]) {
    const plan = integration(repair, { commit });
    assert.notEqual(plan.repairIntegration, true);
    assert.deepEqual(plan.jobs, quick);
  }
});

test('repair evidence does not change promotion or ordinary release admission', () => {
  const promotion = integration(repair, { baseRef: 'main' });
  assert.equal(promotion.role, 'promotion');
  assert.deepEqual(promotion.jobs, ['promotion', 'candidate']);
  const release = proposal({ baseRef: 'main', headRef: 'develop' });
  assert.equal(release.role, 'candidate');
  assert.equal(release.profile, 'docs');
  assert.deepEqual(release.jobs, ['lint', 'smoke', 'test', 'terminal-smoke', 'pack', 'pty', 'candidate']);
});

const root = realpathSync(mkdtempSync(join(tmpdir(), 'gh-glance-sutura-routing-')));
test.after(() => rmSync(root, { recursive: true, force: true }));
writeFileSync(join(root, 'gh'), `#!${process.execPath}
const endpoint = process.argv.at(-1);
if (endpoint === process.env.ROUTING_TEST_ASSOCIATED_ENDPOINT) {
  process.stdout.write(process.env.ROUTING_TEST_PULLS);
} else if (endpoint === process.env.ROUTING_TEST_RELEASE_ENDPOINT) {
  process.stdout.write(process.env.ROUTING_TEST_RELEASE_PULLS);
} else {
  process.stderr.write('unexpected gh endpoint: ' + endpoint);
  process.exit(3);
}
`, { mode: 0o700 });

const rawRepair = {
  number: repair.number, merged_at: repair.mergedAt, merge_commit_sha: commit,
  head: { sha: repair.head, ref: repair.headRef, repo: { full_name: repository } },
  base: { ref: 'develop', repo: { full_name: repository } },
};

for (const [name, pulls, selected] of [
  ['one matching merged PR', [rawRepair], true],
  ['one matching long-dispatch PR', [{ ...rawRepair, head: { ...rawRepair.head,
    ref: `sutura/fix-123-dispatch-${'a'.repeat(16)}` } }], true],
  ['one matching PR and an unmerged proposal', [rawRepair, { ...rawRepair, number: 8, merged_at: null }], true],
  ['ambiguous merged PRs', [rawRepair, { ...rawRepair, number: 8 }], false],
  ['missing merged PR', [], false],
  ['non-list response', { message: 'unknown' }, false],
  ['wrong exact merge SHA', [{ ...rawRepair, merge_commit_sha: 'c'.repeat(40) }], false],
  ['foreign head repository', [{ ...rawRepair, head: { ...rawRepair.head, repo: { full_name: 'other/repo' } } }], false],
  ['wrong base repository', [{ ...rawRepair, base: { ...rawRepair.base, repo: { full_name: 'other/repo' } } }], false],
  ['missing base repository', [{ ...rawRepair, base: { ...rawRepair.base, repo: null } }], false],
  ['wrong base branch', [{ ...rawRepair, base: { ...rawRepair.base, ref: 'main' } }], false],
  ['ordinary head', [{ ...rawRepair, head: { ...rawRepair.head, ref: 'feature/x' } }], false],
  ['saturated associated-PR list', [rawRepair, ...Array.from({ length: 99 }, (_, index) => ({
    ...rawRepair, number: index + 8, merged_at: null,
  }))], false],
]) {
  test(`actual CLI associated-PR binding: ${name}`, () => {
    for (const releasePrOpen of [false, true]) {
      const result = spawnSync(process.execPath, [
        fileURLToPath(new URL('../scripts/release-candidate.mjs', import.meta.url)), 'plan-ci',
      ], {
        encoding: 'utf8', timeout: 10_000,
        env: {
          ...process.env, GITHUB_OUTPUT: '', GITHUB_ENV: '',
          PATH: `${root}${delimiter}${process.env.PATH}`,
          GITHUB_EVENT_NAME: 'push', GITHUB_REF_NAME: 'develop',
          GITHUB_REPOSITORY: repository, GITHUB_SHA: commit,
          ROUTING_TEST_ASSOCIATED_ENDPOINT: `repos/${repository}/commits/${commit}/pulls?per_page=100`,
          ROUTING_TEST_RELEASE_ENDPOINT: `repos/${repository}/pulls?base=main&head=example:develop&state=open`,
          ROUTING_TEST_PULLS: JSON.stringify(pulls),
          ROUTING_TEST_RELEASE_PULLS: JSON.stringify(releasePrOpen ? [{ number: 99 }] : []),
        },
      });
      assert.equal(result.error, undefined);
      assert.equal(result.status, 0, result.stderr);
      const line = result.stdout.split('\n').find((line) => line.startsWith('plan='));
      assert.ok(line, JSON.stringify({ stdout: result.stdout, stderr: result.stderr }));
      const plan = JSON.parse(line.slice(5));
      assert.equal(plan.repairIntegration === true, selected);
      assert.deepEqual(plan.jobs, selected ? broad : releasePrOpen ? ['candidate'] : quick);
      assert.equal(plan.jobs.includes('pack'), false);
      assert.equal(plan.jobs.includes('promotion'), false);
    }
  });
}
