import assert from "node:assert/strict";
import { test } from "node:test";
import { readWorkflow } from "./fixtures/workflow.mjs";

test("Sutura consumer pins the published v0.5.1 repair engine and requires a fixed outcome", () => {
  const { jobs } = readWorkflow("sutura.yml");
  assert.match(jobs.repair.body, /uses: juan294\/sutura@ddab42eadc92801f97c4745ed10f7e467b9843c8 # v0\.5\.1/);
  assert.match(jobs.repair.body, /require-fixed: true/);
  assert.match(jobs.repair.body, /repair-inference-cost-usd: '0\.25'/);
  assert.match(jobs.repair.body, /repair-sandbox-operations: '32'/);
  assert.match(jobs.repair.body, /repair-elapsed-time-sec: '600'/);
});

test("Jev activation names exactly one selected source run and does not change native repair admission", () => {
  const { jobs, on } = readWorkflow("sutura.yml");
  assert.equal(on.trim(), 'workflow_run:\n    workflows: ["CI"]\n    types: [completed]');
  assert.match(jobs.repair.if, /github\.event\.workflow_run\.conclusion == 'failure' \|\| github\.event\.workflow_run\.conclusion == 'timed_out'/);
  const selection = jobs.repair.body.split("\n").find(line => line.includes("SUTURA_JEV_PILOT_SELECTED:"));
  assert.equal(selection?.trim(), "SUTURA_JEV_PILOT_SELECTED: ${{ vars.SUTURA_JEV_PILOT_RUN_ID != '' && vars.SUTURA_JEV_PILOT_RUN_ID == format('{0}', github.event.workflow_run.id) }}");
  assert.doesNotMatch(jobs.repair.if, /SUTURA_JEV_PILOT/);
});

test("Jev key, all decision roles and both TypeSafe budgets stay scoped to the selected run", () => {
  const { body } = readWorkflow("sutura.yml").jobs.repair;
  const input = name => body.split("\n").find(line => line.trimStart().startsWith(`${name}:`))?.trim();
  assert.equal(input("typesafe-api-key"), "typesafe-api-key: ${{ env.SUTURA_JEV_PILOT_SELECTED == 'true' && secrets.TYPESAFE_API_KEY || '' }}");
  for (const role of ["ranking", "grounding", "classification", "recovery"]) {
    assert.equal(input(`jev-${role}`), `jev-${role}: \${{ env.SUTURA_JEV_PILOT_SELECTED == 'true' && 'assist' || 'off' }}`);
  }
  assert.equal(input("jev-budget-usd"), "jev-budget-usd: ${{ env.SUTURA_JEV_PILOT_SELECTED == 'true' && '0.01' || '0' }}");
  assert.equal(input("repair-typesafe-audit-usd"), "repair-typesafe-audit-usd: '0.01'");
});
