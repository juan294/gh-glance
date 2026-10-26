# gh-glance v0.17.1

This patch fixes a coordination-journal deadlock and several input and collector edge cases.

- Full journals of settled request debt recover automatically after upgrading; compaction waits for any active probe to finish or expire. Journals still containing unsettled requests show a retry notice instead of a hard accounting-overflow error.
- `gh-glance --doctor` reports debt-group occupancy and gives the state-file recovery steps for hard coordination failures.
- Pasted multi-character input no longer acts as a tab number or replays commands. Single-digit navigation stays unchanged.
- Webhook repository matching handles mixed case, including access-removal events, while preserving host, provider and installation boundaries.
- Old collector snapshots retain their Stale/Cached status and source age; Disconnected is reserved for lost connection or authorization.
- React and existing development dependencies were updated, including fixes for the development-only brace-expansion and Zod advisories. Homebrew installation is documented.

Node.js 22 or newer remains required. No configuration or data migration is required. Upgrade panes sharing coordination state together so they use the same binary. Live personal/work EMU and native assistive-technology qualification remain unmeasured; this release does not claim to close those existing limits.
