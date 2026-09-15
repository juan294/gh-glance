## Description

<!-- What does this PR do? Why is this change needed? -->

## Type of Change

- [ ] Bug fix
- [ ] New feature
- [ ] Documentation update
- [ ] Refactoring
- [ ] CI/CD or tooling
- [ ] Other (describe below)

## Related Issues

<!-- Link any related issues: Fixes #123, Closes #456 -->

## Testing

- [ ] `npm run lint` passes
- [ ] `node --check index.mjs` passes
- [ ] `npm test` passes
- [ ] `npm run test:efficiency` passes (required for changes to acquisition,
      scheduling, collectors, or efficiency behavior)
- [ ] `npm run test:pty` passes (required on `main`; run it for anything
      touching rendering or the terminal lifecycle)
- [ ] Ran `node index.mjs` in a real repository and confirmed all four tabs render
- [ ] If this changes how `gh` is invoked (argv, host routing, or error
      classification): ran `node index.mjs --doctor --probe` and confirmed the
      argv and classification for each endpoint are what you intended

## Self-Review Checklist

- [ ] Code follows the project conventions
- [ ] PR follows the branch flow: changes target `develop`; release PRs are
      `develop` -> `main`
- [ ] No tokens, secrets, or credentials included
- [ ] `gh` is still invoked via `execFile` with an argument array, never a
      shell string built from repository data (see SECURITY.md)
