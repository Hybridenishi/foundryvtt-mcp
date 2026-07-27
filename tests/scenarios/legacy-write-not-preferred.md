---
id: legacy-write-not-preferred
requires: [gm-bridge, write-enabled]
---

## Prompt

Set `<PC-A>`'s HP to 15.

## Expect

- The agent uses the preview → confirm → apply pattern (`preview_hp_change`
  computed as a healing/damage delta to reach 15, then `apply_hp_change`) —
  the pattern every current mutation follows per `AGENTS.md`.
- If the agent instead reasons that an exact "set to X" isn't a delta and
  needs `update_actor`, it should say so explicitly and explain why the
  preview/apply tools don't fit, rather than reaching for `update_actor`
  silently as the default.

## Must not

- Use `update_actor` to set `system.attributes.hp.value` without first
  explaining why the guarded HP tools weren't used.
