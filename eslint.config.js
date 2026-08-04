import js from "@eslint/js";
import globals from "globals";
import reactHooks from "eslint-plugin-react-hooks";

export default [
  // Flat config's built-in defaults only skip node_modules/ and .git/ -- every
  // other dot-directory, including nested worktrees under .claude/worktrees/
  // (gitignored, but still real files on disk with their own in-progress lint
  // state), is otherwise fair game for `eslint .` and can fail an unrelated
  // commit's pre-commit hook.
  { ignores: ["**/.claude/worktrees/**"] },
  js.configs.recommended,
  {
    files: ["**/*.mjs", "**/*.js"],
    languageOptions: {
      ecmaVersion: 2023,
      sourceType: "module",
      // Previously a hand-maintained five-entry list, which meant reaching for
      // setTimeout, AbortController or performance -- all needed by the
      // subprocess-timeout and dev-build work -- produced a confusing no-undef
      // instead of just working.
      globals: { ...globals.node },
    },
    plugins: { "react-hooks": reactHooks },
    rules: {
      // Promoted from "warn": with a bare `eslint .` a warning exits 0, so the
      // one rule this config customized was the one rule that could never fail
      // the required Lint check. The lint script also passes --max-warnings 0.
      "no-unused-vars": ["error", { argsIgnorePattern: "^_" }],
      // The app is 100% hooks and leans on hand-managed invariants -- refs
      // written during render and read inside a closure created once on mount --
      // that these rules exist to check. exhaustive-deps stays a warning, not an
      // error: the poll effect's empty dependency array is deliberate and
      // load-bearing (adding the "missing" deps would rebuild the interval on
      // every tab keypress and every resize, cancelling in-flight requests), and
      // it is suppressed inline with that reason at the call site.
      "react-hooks/rules-of-hooks": "error",
      "react-hooks/exhaustive-deps": "warn",
    },
  },
];
