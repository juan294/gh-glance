---
name: "source-command-fix-ci"
description: "Migrated source command `fix-ci`"
---

# source-command-fix-ci

Use this skill when the user asks to run the migrated source command `fix-ci`.

## Command Template

Repair existing CI failures for gh-glance.

Follow the native `rpi-fix-ci` skill ([`SKILL.md`](../rpi-fix-ci/SKILL.md)) for the repair
loop and the [release playbook's failure handling](../../../docs/release/release-playbook.md#failure-handling)
for what may be pushed afterwards. This command only routes there.
