// Generate README.md's terminal sample from the real candidate and the
// deterministic fixture. This is a documentation tool, not a test: it prints
// the final replayed frame exactly as the PTY displayed it.

import { capture, waitForAwk } from "./capture.mjs";

const SAMPLE_ROW = "ci: pin actions to com";
const SAMPLE_STATUS = "Watching";
const waitForRenderedRows = waitForAwk(
  '"$GH_GLANCE_CAPTURE_OUT"',
  `index($0, "${SAMPLE_ROW}") { row=1 } ` +
    `index($0, "${SAMPLE_STATUS}") { status=1 } { ok=row && status }`,
  200,
) + "printf 'j'; sleep .3; printf 'q'; sleep 2";

const result = capture({
  cols: 76,
  rows: 14,
  signal: "none",
  settle: 22,
  stdin: waitForRenderedRows,
  icons: "unicode",
  env: {
    GH_GLANCE_CAPTURE_LIVE_FLUSH: "1",
    GH_CONFIG_DIR: "",
    GH_HOST: "github.com",
    GH_REPO: "owner/repo",
    GH_TOKEN: "",
    GITHUB_TOKEN: "",
    GH_ENTERPRISE_TOKEN: "",
    GITHUB_ENTERPRISE_TOKEN: "",
  },
});

if (result.exitCode !== 0) {
  throw new Error(`README sample exited ${result.exitCode}`);
}

const frame = result.finalFrame.lines.join("\n");
if (!frame.includes(`>+  ${SAMPLE_ROW}`) || !frame.includes(SAMPLE_STATUS)) {
  throw new Error("README sample did not reach the selected settled frame");
}

process.stdout.write(`${frame}\n`);
