import assert from "node:assert/strict";
import { test } from "node:test";
import {
  actionsSetupArgs, parseActionsSetup, actionsSetupFresh, actionsSetupRetryAt,
  actionsPageUrl, openBrowserUrl, operationCost, KEY_TABLE,
} from "../index.mjs";

// Published response contract: https://docs.github.com/en/rest/actions/workflows#list-repository-workflows
// Checked 2026-10-25. Keep the envelope independently of the workflow-name catalog.
const workflow = (id = 161335, state = "active") => ({ id, name: "CI", state });
const body = (workflows, total_count = workflows.length) => JSON.stringify({ total_count, workflows });

test("SET-01/12 setup is one explicit bounded core request with the schema envelope", () => {
  assert.deepEqual(actionsSetupArgs({ host: "git.example.com", repository: "acme/widget" }), [
    "repos/acme/widget/actions/workflows?per_page=100&page=1", "--hostname", "git.example.com",
    "--jq", "{total_count, workflows: [.workflows[] | {id, name, state}]}",
  ]);
  assert.deepEqual(operationCost("setup:actions-workflows"), { core: 1, graphql: 0 });
  for (const key of ["s", "g"]) assert.match(KEY_TABLE.find(([binding]) => binding === key)?.[1] ?? "", /Actions:/);
});

test("SET-02/03 complete observations distinguish empty, active, disabled, mixed and unknown", () => {
  assert.equal(parseActionsSetup(body([])).title, "No workflows found");
  assert.equal(parseActionsSetup(body([workflow()])).title, "Workflows found");
  assert.equal(parseActionsSetup(body([workflow(1, "disabled_manually"), workflow(2, "disabled_inactivity")])).title,
    "All listed workflows are disabled");
  for (const state of ["active", "deleted", "future_state"]) {
    const result = parseActionsSetup(body([workflow(1, "disabled_manually"), workflow(2, state)]));
    assert.equal(result.title, "Workflows found");
    assert.equal(result.disabled, 1);
    assert.equal(result.other, state === "active" ? 0 : 1);
    assert.equal(result.workflows[1].state, state);
  }
});

test("SET-04 partial evidence never becomes a complete disabled or empty claim", () => {
  const result = parseActionsSetup(body(Array.from({ length: 100 }, (_, i) => workflow(i + 1, "disabled_manually")), 101));
  assert.equal(result.complete, false);
  assert.equal(result.title, "Workflows found; setup check incomplete");
  assert.equal(result.disabled, 100);
  assert.equal(parseActionsSetup(body([workflow()]), { link: '<https://api.github.com/page=2>; rel="next"' }).complete, false);
  assert.throws(() => parseActionsSetup(body([]), { link: '<https://api.github.com/page=2>; rel="next"' }), /unusable/i);
  for (const value of ["", "null", "[]", "{", body([], 1), body([workflow()], 0),
    '{"workflows":[]}', body([workflow(), workflow()]), body([workflow(-1)]),
    body([{ id: 1, name: "CI" }]), body([{ id: 1, name: "", state: "active" }]),
    body([workflow()], -1), body([workflow()], Number.MAX_SAFE_INTEGER + 1),
    body(Array.from({ length: 101 }, (_, i) => workflow(i + 1)))]) {
    assert.throws(() => parseActionsSetup(value), /unusable/i, value);
  }
  assert.ok([...parseActionsSetup(body([{ id: 1, name: "\u001b[31mCI\u001b[0m", state: "active" }])).workflows[0].name]
    .every((char) => char.charCodeAt(0) >= 32));
});

test("SET-07 successful and partial cache expires after five minutes or clock rollback; failures wait at least thirty seconds", () => {
  const result = { checkedAt: 100_000 };
  assert.equal(actionsSetupFresh(result, 100_000), true);
  assert.equal(actionsSetupFresh(result, 399_999), true);
  assert.equal(actionsSetupFresh(result, 400_000), false);
  assert.equal(actionsSetupFresh(result, 99_999), false);
  assert.equal(actionsSetupFresh(null, 100_000), false);
  assert.equal(actionsSetupRetryAt(100_000), 130_000);
  assert.equal(actionsSetupRetryAt(100_000, 150_000), 150_000);
  assert.equal(actionsSetupRetryAt(100_000, 110_000), 130_000);
});

test("SET-10 Actions page uses a validated target and the existing captured argv opener", async () => {
  assert.equal(actionsPageUrl({ host: "github.com", repository: "acme/widget" }), "https://github.com/acme/widget/actions");
  assert.equal(actionsPageUrl({ host: "git.example.com", repository: "acme/widget" }), "https://git.example.com/acme/widget/actions");
  for (const target of [{ host: "github.com", repository: "bad" }, { host: "evil/host", repository: "a/b" },
    { host: "github.com", repository: "a/b\n" }]) assert.equal(actionsPageUrl(target), null);
  let args;
  await openBrowserUrl("https://github.com/acme/widget/actions", undefined, { run: async (argv) => { args = argv; } });
  assert.equal(args.at(-1), "https://github.com/acme/widget/actions");
  await assert.rejects(openBrowserUrl("https://github.com/acme/widget/actions", undefined,
    { run: async () => { throw new Error("opener unavailable"); } }), /opener unavailable/);
});
