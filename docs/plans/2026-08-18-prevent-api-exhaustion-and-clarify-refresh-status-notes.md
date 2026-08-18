# Implementation notes: prevent API exhaustion and clarify refresh status

## Deviations

### Phase 2 host precedence

- Plan said: resolve `GH_HOST` before treating an explicit unqualified `owner/repo` slug as `github.com`.
- Found: this conflicts with the existing documented rule that explicit `--repo` takes precedence over repository environment configuration and could route an explicit github.com repository through a host selected by `GH_HOST` or `GH_REPO`.
- Chose: explicit `--repo` wins over `GH_REPO`; a host-qualified explicit value uses that host, and an explicit unqualified slug uses `github.com`.
- Why: the user approved this precedence explicitly, and it keeps the repository route, budget route, and governor scope on one deterministic host.
