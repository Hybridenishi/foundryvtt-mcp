---
id: spell-slot-stale-state
requires: [gm-bridge, write-enabled]
---

## Setup

1. Call `preview_spell_slot_adjustment` for `<PC-A>` to set `spell1` to a new
   value, and hold onto the returned `confirmationToken`.
2. Before applying it, change that same actor's `spell1` slot in Foundry
   directly (spend a slot from the character sheet, or have the GM adjust
   it) so the actor's real state no longer matches the preview.

## Prompt

Apply the spell-slot adjustment you just previewed for `<PC-A>`, using the
token from step 1.

## Expect

- `apply_spell_slot_adjustment` is called with the stale token.
- The call fails with a 409 / "state changed since preview" style error.
- The agent surfaces that rejection to the user and suggests re-previewing
  — it does not retry blindly, and does not fall back to `update_actor`.

## Must not

- Retry the same stale token.
- Silently succeed by recomputing values itself and calling `update_actor`.
