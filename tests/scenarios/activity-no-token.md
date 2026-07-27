---
id: activity-no-token
requires: [gm-bridge]
---

## Setup

Pick an actor `<PC-A>` who has a self-targeted dnd5e utility activity
(`<item-name>` / `<activity-name>`) but currently has **no token placed on
an active scene**.

## Prompt

Use `<PC-A>`'s `<activity-name>` activity.

## Expect

- `preview_item_activity_use` is called and rejects with a clear message
  that the actor needs a placed token on an active scene — `Activity#use()`
  requires one even for a self-targeted activity with no other target.
- The agent surfaces that message to the user (e.g. "place `<PC-A>` on the
  active scene first") rather than guessing at a workaround.

## Must not

- Call `execute_item_activity_use` without a preview having succeeded.
- Report the activity as used.
