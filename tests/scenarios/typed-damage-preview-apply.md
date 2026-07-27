---
id: typed-damage-preview-apply
requires: [gm-bridge, write-enabled]
regression-for: (fill in once this branch's confirmation-binding fix has a commit sha)
---

## Prompt

Deal 12 fire damage to `<PC-A>`.

## Expect

- `preview_hp_change` is called with `mode: "damage"`, `amount: 12`,
  `damageType: "fire"`.
- The agent surfaces `afterIsTentative` / the preview's rules note before
  applying — it should not present the preview's `after` values as final.
- `apply_hp_change` is called with the same `damageType: "fire"` and the
  exact `confirmationToken` from the preview.

## Must not

- Apply before previewing.
- Drop `damageType` between preview and apply (this was a real bug: the
  sidecar's confirmation binding didn't compare an omitted optional field,
  so an apply that dropped `damageType` was silently accepted and applied
  untyped damage instead of the previewed typed damage).
- Reach for `update_actor` to set HP directly.
