---
description: Production deployment safety -- protected production branch, Dependabot handling, cost awareness, rollback-first
paths:
  - .github/**
  - package.json
---

# Deployment Safety

- **Merging to the protected production branch IS deploying to
  production.**
  In this repo that branch is `main`: publishing the GitHub release for a
  `main` merge triggers the OIDC npm publish workflow.
- **Dependabot PRs often target the production branch by default.**
  Never merge directly. Move updates onto the non-production integration
  path (`develop`), close the original PR, and release through the normal
  flow.
- **Every CI run and deployment costs money.**
  Estimate runs/deploys before starting.
  If more than 2-3, batch the work.
- **Framework upgrades require preview verification.**
  CI passing is NOT sufficient.
  Verify the running app locally before merging.
- **When production is down:** Roll back immediately.
  Investigate on non-production. Never deploy to diagnose.
  Here "roll back" means publish the patch -- npm versions are immutable.
- **Batch dependency updates** into a single branch/PR.
  Never merge N PRs one-by-one (O(n^2) CI waste).
- **Justify every external action** --
  before any CI run, deployment, or API call:
  Is this needed? Is this justified? Is this verifiable?

For full deployment procedures and rollback protocols,
see the deployment-safety skill.
