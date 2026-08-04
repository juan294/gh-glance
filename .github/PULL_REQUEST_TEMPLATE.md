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
- [ ] Ran `node index.mjs` in a real repository and confirmed all four tabs render
- [ ] If this changes how `gh` is invoked (argv, host routing, or error
      classification): ran `node index.mjs --doctor` and confirmed the argv and
      classification for each endpoint are what you intended

## Self-Review Checklist

- [ ] Code follows the project conventions
- [ ] PR targets the `develop` branch
- [ ] No tokens, secrets, or credentials included
- [ ] `gh` is still invoked via `execFile` with an argument array, never a
      shell string built from repository data (see SECURITY.md)
