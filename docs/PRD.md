# PRD: foundryvtt-mcp (project level)

> **Status: `draft` — inferred, not ratified.** Every line below was drafted by an agent from
> existing repository sources and is marked with where it came from. Nothing here is binding until
> a human corrects it and ratifies it. Under the onboarding rule this experiment is testing, a
> draft charter may be read for orientation but **must not** be cited as a constraint, used to push
> back on a request, or used to justify a review finding.
>
> **Correcting this:** fix what is wrong, delete what is not confirmed — silence is not
> confirmation — then set `status: ratified` with your name and the date. Lines you neither confirm
> nor correct should be removed, not promoted.
>
> **Why this file exists:** it is an experiment for
> [FolioOS](https://github.com/Hybridenishi/FolioOS) — testing whether a *project-level* PRD, using
> the existing PRD template, closes the product-intent gap without needing a new `intent.md`
> concept. The fit notes in the final section are the actual output. This repository has not
> adopted FolioOS, and this file does not adopt it.

---

## Problem

*Inferred from `docs/ROADMAP.md` "Objective", `README.md`, `AGENTS.md`.*

One D&D 5e table runs on a self-hosted Foundry VTT instance whose useful state — actor sheets,
journals, combat, chat — is reachable only through a browser a human is looking at. An
MCP-compatible agent cannot answer "what is the party's HP", apply a previewed condition, or write
a lore journal with correct per-player visibility without a server that speaks Foundry's Socket.IO
protocol on its behalf. The general-purpose `foundryvtt-mcp` npm package does not work against
Foundry v14, which rejects query-param sessions.

<!-- STRAIN: the template asks "who hurts, how, today" — but for a standing charter "today"
     is ambiguous. The problem above is the *originating* problem, which is largely solved by
     the product existing; the *ongoing* reason to exist is a different sentence. The template
     gives no place to say which one is meant. -->

## Outcome

*Inferred from `docs/ROADMAP.md` "Objective" and "What is already built".*

An MCP-compatible agent can read this table's world and perform bounded, confirmation-gated
mutations against it, with every change executed through `dnd5e`'s own APIs so that active modules
observe it, and every result reported as a receipt read back from the changed document.

<!-- STRAIN: the template defines Outcome as "the user-observable difference when this ships."
     A standing charter never ships — it describes a continuing state, not a delta. The tense
     is wrong and there is no version of the heading that is right. -->

## Standing constraints

<!-- NOT IN THE TEMPLATE. Added because the majority of this project's real, durable product
     intent is constraints, and the PRD template has nowhere to put them. A constraint is not a
     non-goal: a non-goal is something the project will not build, a constraint is a rule binding
     what it does build. This section is the single largest fit failure found. -->

*Inferred from `AGENTS.md` "Coupling policy" / "Write pattern" / "Secrets", `docs/ROADMAP.md`
Phases 5-6.*

1. **Coupling tiers.** Tier A (Foundry core + `dnd5e` APIs) is the default for everything. Tier B
   (documented module hooks and public APIs) is optional, one adapter per module, capability-probed
   at startup, pinned to a known-good version range, degrading with an explicit error. Tier C
   (module internals, undocumented backends) is never used — Plutonium's included.
2. **Every mutation is preview → scoped single-use token → `dnd5e` API via the GM bridge →
   receipt.** The receipt reports before and after values read back from the changed document, not
   from what was sent. Reporting intent as outcome is how a silently failed write becomes a
   recorded success.
3. **Journal visibility is required and defaults to GM-only.** This is the highest-consequence
   write in the project, and not for rules reasons: a wrong hit point is corrected in seconds, a DM
   note rendered visible to a player cannot be un-seen. Receipts name the users who can see the
   result, resolved from the written document.
4. **Name resolution fails loud.** Zero matches or ambiguity is an error naming the ambiguity —
   never a guess.
5. **The player-scoped surface is read-only, permanently.** The boundary is the credential, not the
   subject matter: `PLAYER_API_KEY` is structurally unable to reach GM routes, actor routes, or any
   write route. A player-initiated write is a GM-approval mechanism with a human in the loop, not
   something a downstream service does directly.
   *Verified: `sidecar/app.js:437` mounts `playerRouter` ahead of the GM-only key check at
   `sidecar/app.js:439-440`; every route on it is a read.*
6. **Foundry is the index's source of truth, not an Obsidian vault.** A vault-sourced index has to
   reconstruct which content is safe through a mapping that drifts, and that drift is a silent
   leak — permission checked against one document, text retrieved from another.
7. **Secrets come from private environment configuration only.** Never committed, never in
   examples, never served to browser clients; tests assert their absence in source.
   *Verified: `sidecar/bridge-auth.test.js:22-23` and
   `module/scripts/prepared-actor-bridge.test.mjs:8` scan source for known credential strings.*

## Acceptance criteria

<!-- STRAIN — THE PRIMARY ONE. The template's spine is a checkbox list of "verifiable
     statements of behavior" that "the PM persona reviews against exactly these". At project
     scope that decomposes into two bad options, and the honest attempt below shows it:
       (a) enumerate every behavior — a 48-tool spec that duplicates ROADMAP.md and rots on
           the next merge; or
       (b) write product-level statements, as below — true, durable, and NOT per-criterion
           verifiable by a persona reviewing one change.
     The template's "empty state" and "error states" prompts are feature-level and have no
     charter-level meaning at all. -->

- [ ] Every advertised tool is implemented — an advertised-but-unimplemented tool is worse than a
      missing one.
- [ ] No mutation path exists that bypasses preview → confirmation → receipt, except the five
      documented legacy writes, which are on the roadmap to converge or be quarantined.
- [ ] No GM-only journal content is reachable through the player-scoped credential, verified
      server-side rather than by consumer behavior.
- [ ] A permission-filtered read is byte-identical between "hidden" and "does not exist".
      *Verified: `sidecar/app.test.js:596`.*

## Non-goals

*Inferred from `docs/ROADMAP.md` "Objective", Phase 4, Phase 6, Phase 7. This is the section the
template handles best, and the one carrying the most charter weight.*

- **Not a system-neutral Foundry integration.** Foundry-level concepts stay reusable internally,
  but the public MCP tools speak D&D 5e. This is a personal server for one table.
- **Not a rules engine.** Rules lookup is retrieval and provenance reporting against installed
  content — never reimplementation.
- **Not the Discord bot / vector-memory consumer.** This repo owes it a stable, versioned event
  stream and query API. The vector store, embeddings, recall index, platform identity mapping, and
  any local-model inference live in that repository, not this one.
- **Not the player-facing knowledge service ("Iris").** Same boundary: this repo owns the
  permission-filtered read routes and the credential that scopes them; answer composition belongs
  to the consumer, because content it never receives cannot leak from it.
- **Not a module-automation layer.** Tier B work interprets and reports what `midi-qol`, `dae` and
  `automated-conditions-5e` did. It never calls them.
- **Not a general-purpose write API.** Writes are enumerated, previewed and gated; there is no
  arbitrary-path document mutation tool.

## Design notes

<!-- STRAIN: the template's prompt is "Mockups, references, HIG patterns to follow." This is a
     headless MCP server and a sidecar. There is no UI, no mockup, and no HIG. The section is
     dead weight at this scope — not merely empty, but shaped for a kind of product this is not. -->

Not applicable — no user-facing interface. Architecture is documented in `README.md`; developer
reference in `docs/PRIMER.md`; live-deployment findings in `docs/FINDINGS.md`.

## Open product questions

*Genuinely open — these are questions the inference could not settle, not padding.*

- Does "personal server for one table" bind permanently, or is it a current-state description that
  a second table would revise? Constraint 5 and the whole player-scoped design read differently
  depending on the answer.
- Is the Phase 4 event-schema contract a product commitment (published, versioned, breaking changes
  cost something) or an internal interface that happens to have consumers?
- Do the five legacy raw writes converge onto the mutation pattern, or get quarantined behind a
  debug flag? Constraint 2's exception clause exists only because this is unresolved.

---

## Experiment result: where the PRD template fits, and where it does not

The point of this file. Scored against
[`kernel/templates/prd.md`](https://github.com/Hybridenishi/FolioOS/blob/master/kernel/templates/prd.md).

| Template section | Fit at project scope | Why |
|---|---|---|
| `## Problem` | **Partial** | Works, but cannot distinguish the originating problem from the ongoing reason to exist. |
| `## Outcome` | **Poor** | Defined as "the difference when this ships." A charter never ships. |
| `## Acceptance criteria` | **Poor — the primary failure** | Its spine is per-change verifiable checkboxes a persona reviews against. At charter scope it degrades into either a rotting spec or non-verifiable statements. The "empty state"/"error states" prompts are feature-level and meaningless here. |
| `## Non-goals` | **Good** | Carries real charter weight unmodified. |
| `## Design notes` | **Dead** | Shaped for UI work; this product has no interface. |
| `## Open product questions` | **Good** | Works unchanged. |
| *Standing constraints* | **Missing entirely** | Not a template section. The majority of this project's durable intent is constraints, and a constraint is not a non-goal. |

**Verdict: 2 of 6 sections fit, 1 partially, 2 fit badly, 1 is dead — and the section doing the
most work had to be invented.** The cheap path is cheaper than a new concept but does not close the
gap: adapting the PRD template to charter scope means deleting two sections, rewriting two, and
adding one the template does not have, which is a different template wearing the PRD's name.

**A third observation, on checkability.** Three of the constraints above were verifiable against
source in minutes (`app.js` mount order, the credential-scanning tests, the identical-404 test), and
their file:line citations are recorded inline. That is evidence for the derived-staleness design:
constraints stated concretely enough to cite are constraints a review can mechanically re-check,
and the ones that resisted citation are exactly the ones in the open-questions list. A charter whose
claims cannot be cited is a charter whose review degrades into a re-read.

**Independent finding, arguably worth more than the fit scoring:** this project already had
substantial standing intent before any of this — `ROADMAP.md`'s "Objective" is a product statement
with an explicit non-goal, `AGENTS.md` carries the coupling policy and write pattern, `README.md`
carries the boundary. The gap is not that the intent was never articulated. It is that it is
**spread across three documents with three different lifecycles** — a plan, an agent-instruction
file, and a user-facing readme — none of which is a charter, so no one of them can be cited,
reviewed for staleness, or ratified. That reframes the problem from *authoring* intent to
*consolidating* it.
