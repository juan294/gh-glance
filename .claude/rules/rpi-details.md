---
description: RPI workflow details -- phase rules, pre-release sequence, implementation loop
---

# RPI Details

## Context Management

- Each RPI phase should be its own conversation.
  Don't run research + plan + implement in one session.
- Use `/clear` between unrelated tasks.
  Use `/compact` when context is heavy but the task continues.
- Subagents are context control mechanisms --
  they search/read in their window and return only distilled results.
- Research and planning happen against the integration branch.
  Implementation happens in worktrees or temporary branches.

## Rules for All Phases

- Read all mentioned files COMPLETELY before doing anything else.
- Never suggest improvements during research --
  only document what exists.
- Every code reference must include file:line.
- Spawn parallel subagents for independent research tasks.
  Wait for ALL before synthesizing.
- Never write documents with placeholder values.
- Exhaust all tools before suggesting manual steps --
  check CLI tools, shell commands, MCP servers, and file tools
  before escalating to the user.

## Rules for Implementation

- Follow the atomic loop:
  implement -> review -> fix -> approve -> `/simplify` -> verify.
  `/simplify` catches code reuse, quality, and efficiency issues
  that the plan-compliance reviewer does not check.
- Check for `[batch-eligible]` units -- independent units in the current
  phase may run in parallel local worktrees with one integration owner.
  Never use a batch mode that pushes branches or opens PRs.
- Run ALL automated verification after each phase.
- STOP after each phase and wait for human confirmation.
- If the plan doesn't match reality, STOP and explain.

## Pre-Release Workflow

Releases follow [`docs/release/release-playbook.md`](../../docs/release/release-playbook.md),
including when a full `/pre-launch` audit applies. When an audit does run, fix
every confirmed finding; strategic items that need human architectural judgment
get an explicit disposition instead of a fix agent.

## Testing Philosophy

Prefer automated verification.
Manual only for: sudo, hardware, new installs, visual-only.
Don't use Claude for linting/formatting -- use tools and hooks.
