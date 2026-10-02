// A focused reader for the GitHub workflow YAML subset this repository uses
// (two-space indentation, one job per key, inline or folded `>-` scalars). It
// keeps the project free of a YAML dependency; tests that need more structure
// than this should say so rather than widen it silently.

import { readFileSync } from "node:fs";

export function readWorkflow(name) {
  const text = readFileSync(new URL(`../../.github/workflows/${name}`, import.meta.url), "utf8");
  const lines = text.split("\n");
  const section = (key) => {
    const start = lines.findIndex((line) => line === `${key}:`);
    if (start === -1) return [];
    const end = lines.findIndex((line, index) => index > start && /^\S/.test(line) && !line.startsWith("#"));
    return lines.slice(start + 1, end === -1 ? undefined : end);
  };
  const jobs = {};
  let current = null;
  for (const line of section("jobs")) {
    const job = line.match(/^ {2}([a-z][a-z0-9-]*):\s*$/);
    if (job) {
      current = job[1];
      jobs[current] = { lines: [] };
      continue;
    }
    if (current) jobs[current].lines.push(line);
  }
  for (const job of Object.values(jobs)) {
    const body = job.lines.join("\n");
    const key = (name) => {
      const index = job.lines.findIndex((line) => line.startsWith(`    ${name}:`));
      if (index === -1) return null;
      const inline = job.lines[index].slice(`    ${name}:`.length).trim();
      if (inline && inline !== ">-") return inline;
      const folded = [];
      for (const line of job.lines.slice(index + 1)) {
        if (!line.startsWith("      ")) break;
        folded.push(line.trim());
      }
      return folded.join(" ");
    };
    job.name = key("name");
    job.if = key("if");
    job.needs = (key("needs") ?? "").replace(/[[\]]/g, "").split(",").map((item) => item.trim()).filter(Boolean);
    job.environment = key("environment");
    job.body = body;
  }
  const meaningful = (key) => section(key).filter((line) => line.trim() && !line.trim().startsWith("#")).join("\n");
  return { text, on: meaningful("on"), jobs, top: meaningful };
}

// Render a job name the way GitHub does for the forms ci.yml uses: plain
// text, `${{ matrix.x }}`, and `${{ github.event_name == 'pull_request' && A || B }}`
// where A and B are quoted strings or format('...{0}...', matrix.x).
export function renderJobName(name, { event, matrix = {} }) {
  const value = (expression) => {
    const quoted = expression.match(/^'([^']*)'$/);
    if (quoted) return quoted[1];
    const format = expression.match(/^format\('([^']*)', matrix\.(\w+)\)$/);
    if (format) return format[1].replace("{0}", String(matrix[format[2]]));
    const field = expression.match(/^matrix\.(\w+)$/);
    if (field) return String(matrix[field[1]]);
    throw new Error(`unsupported expression ${expression}`);
  };
  return name.replace(/\$\{\{\s*(.*?)\s*\}\}/g, (_, expression) => {
    const branch = expression.match(/^github\.event_name == '(\w+)' && (.+?) \|\| (.+)$/);
    if (branch) return value(branch[1] === event ? branch[2] : branch[3]);
    return value(expression);
  });
}
