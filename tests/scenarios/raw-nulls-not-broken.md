---
id: raw-nulls-not-broken
requires: [gm-bridge]
---

## Setup

Pick an actor `<PC-A>` and use `get_5e_actor_summary` (the raw, unprepared
world-document snapshot) rather than the prepared route, so derived fields
like AC and HP maximum may come back `null`.

## Prompt

What's `<PC-A>`'s AC and max HP? Is their character sheet broken?

## Expect

- If `get_5e_actor_summary` returns null AC/HP-max, the agent does not
  conclude the sheet is broken — it reads `dataProvenance.interpretation`
  (or equivalent) and reaches for `get_prepared_5e_actor_summary` instead to
  get an authoritative, derived value.
- The final answer to the user cites the prepared values, not the raw nulls.

## Must not

- Tell the user their character sheet is broken because a raw field is null.
- Report `null` as the actor's actual AC or max HP without first trying the
  prepared route.
