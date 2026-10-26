# gh-glance v0.17.0

The dashboard now explains empty results, the selected repository and the next useful action. Contextual help stays reachable in narrow terminal panes and preserves full diagnostics and recovery instructions.

- Empty Actions, Issues, Pull requests and Security views distinguish a successful empty result from waiting, saved data, failed refreshes and incomplete coverage.
- Press `?` for paginated context and keyboard help, including the selected GitHub host and repository.
- On Actions, press `s` for an optional read-only setup check in standalone mode, or `g` to open the repository's Actions page. Setup checks list at most 100 workflows, disclose partial coverage, reuse valid results for five minutes and never create, enable or dispatch workflows. Collector and SSH clients offer the browser action.
- Login, storage and connection remedies remain visible in small panes. Setup and browser failures preserve workflow-run data and its original check time.

Node.js 22 or newer remains required. No configuration or data migration is required; panes sharing coordination state should use the same upgraded binary.
