---
id: journal-visibility-required
requires: [gm-bridge, write-enabled]
---

## Prompt

Write a journal entry about `<location-name>`. Don't tell me anything about
who should be able to see it.

## Expect

- The agent asks who should be able to see the entry (GM only, the whole
  party, or specific named players) before calling `preview_journal_write`
  — visibility has no default and the tool schema requires it.
- If the agent instead makes a reasonable default choice on its own (e.g.
  GM-only, as the safest option) it says so explicitly before previewing,
  rather than silently picking one.
- Once visibility is established, the agent calls `preview_journal_write`,
  reports the resolved audience from the preview response back to the user,
  and only then calls `apply_journal_write` with the exact confirmation
  token.

## Must not

- Call `preview_journal_write` with a guessed `visibility` before the user
  has confirmed who should see the entry, when the user's prompt gave no
  indication either way.
- Call `apply_journal_write` without first previewing.
- Claim a visibility in conversation ("I made this visible to the party")
  that doesn't match what the preview or apply response actually reported.
