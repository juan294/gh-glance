// R07: the publish command the release workflow runs, executed with a real npm
// CLI against a loopback registry. Proves the exact tarball bytes are what npm
// sends, that no lifecycle script runs, and that a refused publish is a
// failure. It does not prove OIDC, trusted-publisher configuration or registry
// provenance; those remain unverified until a real release.
//
// Uses GH_GLANCE_PINNED_NPM when set (the release pin is npm 11.21.0), else the
// npm on PATH, and reports which version actually ran.

import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { once } from "node:events";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { integrityOf } from "../scripts/package-check.mjs";
import { NPM_UPGRADE, PINS } from "../scripts/release-candidate.mjs";
import { packageTarball } from "./fixtures/tarball.mjs";

const NPM = process.env.GH_GLANCE_PINNED_NPM || "npm";
const PUBLISH_LINE = 'npm publish "$GH_GLANCE_PACKAGE_TARBALL" --ignore-scripts --provenance --access public';

async function loopbackRegistry(t, { refuse = false } = {}) {
  const received = [];
  const server = createServer((request, response) => {
    let body = "";
    request.on("data", (chunk) => { body += chunk; });
    request.on("end", () => {
      received.push({ method: request.method, url: request.url, authorization: request.headers.authorization, body });
      if (request.method === "PUT" && refuse) {
        response.writeHead(403, { "content-type": "application/json" });
        response.end(JSON.stringify({ error: "You cannot publish over the previously published versions" }));
      } else if (request.method === "PUT") {
        response.writeHead(201, { "content-type": "application/json" });
        response.end(JSON.stringify({ ok: true }));
      } else {
        response.writeHead(404, { "content-type": "application/json" });
        response.end(JSON.stringify({ error: "not found" }));
      }
    });
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  return { url: `http://127.0.0.1:${server.address().port}/`, received };
}

// Asynchronous on purpose: the loopback registry is served by this process,
// so a synchronous spawn would block the very event loop npm is waiting on.
async function publish(t, registry, tarball, { cwd = null } = {}) {
  const home = mkdtempSync(join(tmpdir(), "gh-glance-npm-home-"));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  const userconfig = join(home, ".npmrc");
  const host = registry.url.replace(/^http:/, "");
  writeFileSync(userconfig, `${host}:_authToken=loopback-test-token\nregistry=${registry.url}\n`);
  const args = ["publish", tarball, "--ignore-scripts", "--access", "public", "--registry", registry.url];
  const child = spawn(NPM, args, { cwd: cwd ?? home,
    env: { ...process.env, npm_config_userconfig: userconfig, npm_config_cache: join(home, "cache"), HOME: home } });
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (chunk) => { stdout += chunk; });
  child.stderr.on("data", (chunk) => { stderr += chunk; });
  const [status] = await once(child, "close");
  return { status, stdout, stderr };
}

test("NPM-01 the release workflow publishes the verified tarball path with lifecycle scripts off", () => {
  const workflow = readFileSync(new URL("../.github/workflows/release.yml", import.meta.url), "utf8");
  assert.ok(workflow.includes(PUBLISH_LINE), "publish command changed");
  assert.equal((workflow.match(/npm publish/g) ?? []).length, 1);
  assert.doesNotMatch(workflow, /npm@latest/);
  assert.equal(workflow.split(NPM_UPGRADE).length - 1, 2, "publish and delivery run the pinned npm");
});

test("NPM-02 real npm sends exactly the verified bytes and runs no lifecycle script", async (t) => {
  const version = spawnSync(NPM, ["--version"], { encoding: "utf8" }).stdout.trim();
  t.diagnostic(`npm ${version} (release pin ${PINS.npm})`);
  const root = mkdtempSync(join(tmpdir(), "gh-glance-npm-publish-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const marker = join(root, "lifecycle-ran");
  const scripts = Object.fromEntries(["prepublishOnly", "prepack", "prepare", "prepublish", "publish", "postpublish", "postpack"]
    .map((name) => [name, `node -e "require('fs').appendFileSync('${marker}', '${name}\\n')"`]));
  const bytes = packageTarball({ version: "9.9.9", manifest: { name: "gh-glance-loopback-fixture", scripts } });
  const tarball = join(root, "artifact.tgz");
  writeFileSync(tarball, bytes);

  const registry = await loopbackRegistry(t);
  const result = await publish(t, registry, tarball);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(existsSync(marker), false, `lifecycle scripts ran: ${existsSync(marker) ? readFileSync(marker, "utf8") : ""}`);
  const puts = registry.received.filter((request) => request.method === "PUT");
  assert.equal(puts.length, 1);
  assert.equal(puts[0].authorization, "Bearer loopback-test-token");
  const document = JSON.parse(puts[0].body);
  const [attachment] = Object.values(document._attachments);
  const sent = Buffer.from(attachment.data, "base64");
  assert.ok(sent.equals(bytes), "npm changed the tarball bytes");
  assert.equal(document.versions["9.9.9"].dist.integrity, integrityOf(bytes).sha512);
});

test("NPM-03 a refused publish (existing version) is a failure, never a skipped success", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "gh-glance-npm-refuse-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const tarball = join(root, "artifact.tgz");
  writeFileSync(tarball, packageTarball({ version: "9.9.9", manifest: { name: "gh-glance-loopback-fixture" } }));
  const registry = await loopbackRegistry(t, { refuse: true });
  const result = await publish(t, registry, tarball);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /403|E403/);
});

// The release job runs from its checkout, whose own package.json has
// prepublishOnly (lint + tests). Publishing the tarball path must not run it.
test("NPM-04 publishing from a checkout with lifecycle scripts still runs none of them", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "gh-glance-npm-checkout-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const marker = join(root, "checkout-lifecycle-ran");
  const hook = (name) => `node -e "require('fs').appendFileSync('${marker}', '${name}\\n')"`;
  writeFileSync(join(root, "package.json"), JSON.stringify({ name: "gh-glance-loopback-fixture", version: "9.9.9",
    scripts: { prepublishOnly: hook("prepublishOnly"), prepack: hook("prepack"), prepare: hook("prepare"),
      publish: hook("publish"), postpublish: hook("postpublish") } }));
  writeFileSync(join(root, "artifact.tgz"), packageTarball({ version: "9.9.9", manifest: { name: "gh-glance-loopback-fixture" } }));
  const registry = await loopbackRegistry(t);
  const result = await publish(t, registry, "./artifact.tgz", { cwd: root });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(existsSync(marker), false, `checkout lifecycle ran: ${existsSync(marker) ? readFileSync(marker, "utf8") : ""}`);
  assert.equal(registry.received.filter((request) => request.method === "PUT").length, 1);
});
