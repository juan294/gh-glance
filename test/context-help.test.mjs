import assert from "node:assert/strict";
import { test } from "node:test";
import * as app from "../index.mjs";

const context = (overrides = {}) => ({
  tab: "actions",
  target: { repository: "acme/widget", host: "github.com", label: "acme/widget" },
  view: app.dashboardPresentation({ tab: "actions", rows: [], sourceAt: 1_000, nowMs: 2_000 }),
  ...overrides,
});
const content = (pages) => pages.flat().join(" ");

test("NAV-01/02: selected target reuses resolver precedence without claiming access", () => {
  const cases = [
    [{ runtimeRepo: "explicit/repo", runtimeHost: null, repoExplicit: true,
      ghRepo: "tenant.ghe.com/other/repo", ghHost: "tenant.ghe.com" }, "explicit/repo", "github.com"],
    [{ ghRepo: "tenant.ghe.com/acme/widget" }, "acme/widget", "tenant.ghe.com"],
    [{ remoteUrls: ["https://github.com/acme/widget.git"] }, "acme/widget", "github.com"],
    [{ remoteUrls: ["git@tenant.ghe.com:acme/widget.git"] }, "acme/widget", "tenant.ghe.com"],
  ];
  for (const [options, repository, host] of cases) {
    const target = app.dashboardTarget({ repository: app.resolveEffectiveRepository(options),
      host: app.resolveEffectiveHost(options) });
    assert.equal(target.repository, repository);
    assert.equal(target.host, host);
    assert.equal(target.label, host === "github.com" ? repository : `${host}/${repository}`);
    assert.doesNotMatch(target.label, /verified|connected|authenticated/i);
  }
  const target = app.dashboardTarget({ repository: app.resolveEffectiveRepository({
    remoteUrls: ["https://github.com/first/repo.git", "https://github.com/second/repo.git"],
  }), host: null });
  assert.equal(target.label, "Repository unresolved");
  const pages = app.contextHelpPages(context({ target }), [], 75, 18);
  assert.match(content(pages), /Repository unresolved/);
  assert.match(content(pages), /gh-glance --repo owner\/name/);
  assert.doesNotMatch(content(pages), /acme\/widget|Connected|authenticated/);
});

test("NAV-03/04: narrow help retains complete context, prioritizes recovery and declares controls", () => {
  const repository = `longowner/${"longrepository".repeat(12)}`;
  const action = "Run gh-glance --doctor; check storage permissions and restore the coordination directory before retrying.";
  const view = { title: "Could not refresh Actions", action, sourceCheck: "Last-check time unavailable",
    explanation: "No successful new observation is available.", notes: ["storage detail\u001b[31m with controls"], state: "failed" };
  for (const [width, height] of [[19, 4], [40, 18], [75, 18], [115, 18]]) {
    const pages = app.contextHelpPages(context({ target: app.dashboardTarget({ repository, host: "tenant.ghe.com" }), view }),
      ["r Refresh", "q / Esc / Ctrl+C Quit"], width, height);
    assert.ok(pages.length > 0);
    assert.match(pages[0].join(" "), /Could not/);
    assert.match(pages[0].join(" "), /doctor/);
    for (const page of pages) {
      assert.ok(page.length <= height);
      assert.ok(page.every((line) => [...line].length <= width));
      assert.match(page.join(" "), /n.*p/);
      assert.match(page.join(" "), /\?.*close/);
      assert.match(page.join(" "), /quit/i);
      assert.equal(page.join(" ").includes(String.fromCharCode(27)), false);
    }
    // Page controls separate chunks; remove them before reconstructing content.
    const body = pages.flatMap((page) => page.filter((line) => !/^\d+\/\d+ /.test(line) && line !== "q/Esc/^C quit"))
      .join("").replace(/\s+/g, "");
    assert.ok(body.includes(repository));
    assert.ok(body.includes(action.replace(/\s+/g, "")));
    assert.ok(body.includes("Last-checktimeunavailable"));
    assert.equal(app.clampHelpPage(1_000, pages.length), pages.length - 1);
    assert.equal(app.clampHelpPage(-1, pages.length), 0);
  }
});

test("NAV-04: Help is reserved beside refresh and quit at the minimum drawable width", () => {
  const hints = app.activeKeyHints({ interactive: true, canMove: true, canOpen: true, canResize: true });
  const layout = app.statusBarLayout({ cols: 23, interactive: true, availableHints: hints,
    status: app.refreshStatus(), version: "0.16.2" });
  assert.deepEqual(layout.mandatoryHints.map(({ keys }) => keys), ["r", "q", "?"]);
  assert.ok(layout.hints.every((hint) => hint.start + hint.text.length <= 23));
  assert.deepEqual(app.activeKeyHints({ interactive: false }), [{ label: "Quit", keys: "^C" }]);
  assert.ok(app.activeKeyHints({ interactive: true, remoteSetup: true }).some(({ keys }) => keys === "?"));
});

test("NAV-06/07: contextual target never renews unknown, cached or disconnected source evidence", () => {
  for (const overrides of [{ rows: null, sourceAt: null }, { rows: [], sourceAt: null }, { rows: [], sourceAt: 3000 },
    { rows: [], sourceAt: 1000, disconnected: true }, { rows: [], sourceAt: 1000, onDemand: true }]) {
    const view = app.dashboardPresentation({ tab: "issues", nowMs: 2000, ...overrides });
    const pages = app.contextHelpPages(context({ tab: "issues", view }), [], 75, 18);
    const text = content(pages);
    assert.match(text, /acme\/widget/);
    assert.match(text, /github.com/);
    assert.ok(text.includes(view.sourceCheck));
    assert.doesNotMatch(text, /Target verified|authenticated|checked just now/i);
  }
});

test("NAV-03: compact first-page recovery never invents a refresh remedy", () => {
  const pages = app.contextHelpPages(context({ view: { title: "Repository setup needs attention",
    action: "Repair the local configuration before restarting the dashboard.", sourceCheck: "Not checked yet",
    explanation: "", notes: [] } }), [], 19, 4);
  assert.match(pages[0].join(" "), /Repair/);
  assert.doesNotMatch(pages[0].join(" "), /then r/);
});

test("NAV-03: help retains each complete sanitized identity field without a second prefix truncation", () => {
  const repository = `owner/${"r".repeat(600)}`;
  const host = `${"host".repeat(45)}.example.com`;
  const target = app.dashboardTarget({ repository, host });
  assert.equal(target.repository, repository);
  assert.equal(target.host, host);
  const pages = app.contextHelpPages(context({ target }), [], 19, 4);
  const body = pages.flatMap((page) => page.filter((line) => !/^\d+\/\d+ /.test(line) && line !== "q/Esc/^C quit"))
    .join("").replace(/\s+/g, "");
  assert.ok(body.includes(target.repository));
  assert.ok(body.includes(target.host));
});
