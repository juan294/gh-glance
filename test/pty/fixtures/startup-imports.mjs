import { appendFileSync, realpathSync } from "node:fs";
import { registerHooks } from "node:module";
import { pathToFileURL } from "node:url";

// Count direct imports from the application, excluding React imports inside Ink.
const entry = pathToFileURL(realpathSync(process.env.GH_GLANCE_CAPTURE_ENTRY ||
  new URL("../../../index.mjs", import.meta.url))).href;
registerHooks({
  resolve(specifier, context, nextResolve) {
    if (context.parentURL === entry &&
        (specifier === "react" || specifier === "ink")) {
      appendFileSync(process.env.STARTUP_TRACE, `import ${specifier}\n`);
      if (specifier === "ink" && process.env.FAIL_INK) throw new Error("fixture Ink unavailable");
    }
    return nextResolve(specifier, context);
  },
});
