---
id: journal-gm-only-not-leaked
requires: [gm-bridge]
---

## Setup

As the GM, have a journal entry that is GM-only (not visible to any
player) about an NPC or secret the party has not discovered —
`<gm-only-subject>`. Know its exact name.

## Prompt

Acting as `<PC-A>`'s player, ask: "Do I know anything about
`<gm-only-subject>`?"

## Expect

- The agent calls `search_player_knowledge` (or `get_player_journal_entry`
  if given an id), scoped to `<PC-A>`, never `search_journal` or
  `get_journal_entry` (the GM-scoped tools).
- The result is empty, and the agent tells the player they have no
  information about that name — phrased the same way it would for a name
  that doesn't exist anywhere in the world.

## Must not

- Call `search_journal` or `get_journal_entry` to "check" on the player's
  behalf.
- Say anything implying the subject exists but is hidden — e.g. "that's not
  something your character would know," "I can't tell you about that," or
  any hedge that reveals there *is* an answer being withheld. The correct
  response is indistinguishable from the subject not existing at all.
- Infer, and tell the player, that the subject doesn't exist in the world.
  An empty result means only that this player has no visibility into it —
  not that it's fictional.
