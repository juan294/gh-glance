No change to the dashboard itself: `index.mjs` is identical to 0.16.1. This
release changes how gh-glance is tested and published.

### Changed

- The published npm package is now the exact tarball the release pull request
  tested: CI packs it once, the package and terminal smoke checks run those
  bytes, and the release workflow verifies the tested tree, run, archive digest and
  tarball digests before publishing it with lifecycle scripts disabled and
  pinned Node 22.22.2 / npm 11.21.0. A version collision or an unclear
  registry answer stops publication instead of skipping it.
- Release delivery is checked automatically: registry integrity, npm
  provenance bound to this release workflow, tag and merge commit, and a fresh
  install run on Node 22 and 24.
- CI runs the full suites once, on the release pull request; pushes to
  `develop` and `main` run quick checks or a promotion identity check, and
  coverage runs on a schedule instead of on every push.
- README: the live freshness monitor section explains how to observe the
  default on-demand mode (continuously active Actions only).

