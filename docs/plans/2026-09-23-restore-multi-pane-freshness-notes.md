# Implementation deviations

## Deviations

- Plan said: run the full sequential verification gate after every phase. Found: the serial PTY suite takes more than 20 minutes for one run and Phase 1's final process regression was added after that run. Chose: run focused regressions, lint, and syntax checks after each phase, then run the complete sequential gate on the integrated release candidate. Why: this preserves the decisive release gate on the exact final tree while avoiding five long PTY runs against intermediate code during the requested hotfix.
