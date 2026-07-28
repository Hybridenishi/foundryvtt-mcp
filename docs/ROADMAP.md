# Foundry VTT D&D 5e MCP Roadmap

## Objective

A small, dependable MCP server for one supported environment: Foundry Virtual Tabletop v14 build 365 and the official `dnd5e` system 5.3.3, with mixed 2014 and 2024 content whose per-Item rules source is preserved.

This is a personal server for one table. It will not become a system-neutral Foundry integration. Foundry-level concepts — documents, scenes, journals, chat, combat — remain reusable internally, but the public MCP tools speak D&D 5e.

Background, live-deployment inspection data, and architectural findings live in [`FINDINGS.md`](FINDINGS.md).

## Coupling policy

Everything below is organized by one rule: **prefer the layer with the longest maintenance horizon.**

| Tier | What | Use |
|---|---|---|
| **A** | Foundry core and `dnd5e` system APIs | Preferred for everything. Ships with the platform this project already pins. |
| **B** | Documented module hooks and public module APIs | Later and optional. One adapter per module, capability-probed at startup, pinned to a known-good version range. |
| **C** | Module internals and undocumented backends | Never. |

Phases 1 through 6 are Tier A only. Third-party module support is deferred to [Phase 7](#phase-7--module-support-tier) and is explicitly optional: when a supported module is missing or its version is unrecognized, the affected tools return an explicit degraded error. They do not crash, and they do not silently change behavior.

**This is not a rule against modules.** The reference world runs `midi-qol`, `dae`, and `automated-conditions-5e`, and they mutate the same state these tools touch. Calling the Tier A API is precisely what lets their hooks fire correctly; writing around them is the unsafe path. Tier B work is about *interpreting and reporting* what those modules did — never about calling them.

The same reasoning demotes Plutonium. It remains the best importer available and stays the recommended way to create complete 5e content, but the core plan no longer assumes it: Phase 3 gives the project its own content path through installed compendia, and Plutonium-aware discovery moves to Phase 7.

## What is already built

Shipped in v1.4.0 through v1.7.0:

- **Read-only 5e adapter** — `get_5e_actor_summary`, `list_actor_items`, `list_item_activities`, `get_item_activity`, `validate_5e_actor`. Embedded Items and Activities are paginated, rules-source provenance is retained, and the validator reports document shape and rules mix.
- **Prepared-data bridge** — a module running in an active GM browser, paired only after the sidecar validates that browser's authenticated Foundry GM session, then issued a short-lived in-memory token. Returns runtime-derived values the headless socket cannot supply.
- **Confirmation-gated HP changes** — `preview_hp_change` / `apply_hp_change`, applied through `dnd5e`'s `Actor.applyDamage` so temporary HP is consumed correctly. Supports optional `damageType` for typed damage with resistance/vulnerability/immunity calculation.
- **Temporary HP and standard conditions** — previewed, one-time-token changes through the GM bridge; temporary HP is explicit replacement and generic condition changes intentionally exclude level-based exhaustion.
- **Spell-slot adjustment** — `preview_spell_slot_adjustment` / `apply_spell_slot_adjustment`, exact-value administrative counter adjustment through the GM bridge. Supports pact magic, canonical binding, stale-state protection. Character actors only.
- **Prepared party overview** — one concise prepared read for all character actors, including HP, AC, conditions, and spell slots.
- **Guarded utility-activity execution** — `preview_item_activity_use` / `execute_item_activity_use`, running `Activity#use()` for real behind a strict eligibility guard.
- **Deploy and smoke scripts** — `scripts/deploy-foundry.sh` and `scripts/smoke-foundry.sh --require-bridge`.

The preview → scoped confirmation token → `dnd5e` API pattern established by the last two is the template every future mutation follows.

---

## Phase 1 — Consolidate the foundation

**Goal:** make the existing surface trustworthy before adding to it.

Every later phase adds mutations, and each would inherit today's gaps. This phase closes them once.

- [x] Enforce write gating in the sidecar, not only in `src/tools/write.ts`.
- [ ] Converge the five legacy raw writes (`update_actor`, `create_actor`, `delete_actor`, `next_turn`, `create_chat_message`) onto the preview → confirmation → `dnd5e` pattern, or quarantine them behind an explicit debug flag.
- [ ] Add a bounded Socket.IO reconnect loop. The disconnect handler currently gives up and the API returns 503 until the container restarts.
- [ ] Allow concurrent bridge operations. Dispatch still serves one parked poll per cycle — true concurrent dispatch (e.g. to more than one GM browser tab at once) is not built. Partially mitigated: a request's response-timeout now starts only when it is actually dispatched, not when it was queued, so requests queued serially behind each other no longer fail purely from waiting their turn (`sidecar/app.js`'s `dispatchPreparedActorRequests`). This is what makes the campaign-knowledge-journal plan's Obsidian importer (its own requests are already serial) safe to run alongside other bridge traffic, without requiring a full concurrent-dispatch redesign.
- [x] Correct remaining stale metadata: reported server version, the activity-adapter wording, and the dead `test:auth` script.
- [x] Make the sidecar image buildable from the repository alone: track its lockfile and deploy both package manifests with the runtime source.
- [x] Add the first tests that exercise something other than pure helpers — tool registration, route mapping, authentication failure, write gating, and timeouts.

**Exit:** no advertised capability is ungated at the sidecar boundary, and the transport contract has tests.

## Phase 2 — Core 5e play operations

**Goal:** cover the operations this table performs every session, through `dnd5e`'s own APIs.

All Tier A, all through the GM bridge, all following the established mutation pattern: verify supported versions, check existence and permissions, validate semantic inputs rather than accepting arbitrary paths, return before/after values and a receipt, and read back the changed document before reporting success.

- [x] **Standard conditions** — preview and apply add/remove through `Actor#toggleStatusEffect`; level-based exhaustion remains intentionally separate.
- [ ] **Concentration** — report who is concentrating on what. Its own mechanic in `dnd5e` 5.x, not a generic condition, and useful as a read long before it is useful as a write.
- [ ] **Rests** — short and long rest through `dnd5e`, with `dialog: false` and hit-dice spending as an explicit input, since no GM is present to answer a prompt. Pin the API signature; it moved across 5.x.
- [ ] **Combat control** — replace the sidecar-computed turn advance with `Combat#nextTurn()`, and add `Combat#setInitiative()`, initiative rolling, previous turn, and combat start/end.
- [x] **Typed damage** — `Actor.applyDamage` accepts typed damage. Wired through with strict enum validation at all three layers; `damageType` on `preview_hp_change` / `apply_hp_change` triggers full resistance/vulnerability/immunity calculation.
- [x] **Spell slots** — adjust slots (including pact magic, now included in prepared summaries). Administrative counter adjustment through the GM bridge with canonical binding and stale-state protection.
- [ ] **Limited-use resources** — adjust item uses, class feature uses, and other limited-use counters.
- [x] **Party overview** — one prepared call returns HP, AC, conditions, and slots for all character actors.

**Exit:** common combat and recovery operations run through `dnd5e` with verifiable receipts.

## Phase 3 — Compendium, content, and rules lookup

**Goal:** find and use installed content without depending on an importer module.

- [ ] **Compendium index search** — index-first via `pack.getIndex({ fields })`, filterable by pack and document type, paginated, with full document load as an explicit second step. Declaring index fields up front is what makes filtering on CR, spell level, or school possible without loading thousands of documents.
- [ ] **Fetch by UUID** — the stable handle everything else cites.
- [ ] **Rules lookup grounded in installed content** — answer rules questions from this world's actual packs. Requires a defined precedence order (world documents, then homebrew packs, then system and SRD packs) and must report which source won and whether it was 2014 or 2024. Cite by UUID so answers are clickable in Foundry. This is retrieval and provenance reporting, not rules reimplementation.
- [ ] **NPC HP policy** — set placed NPC hit points by policy: maximum, average, or rolled. Small, independently useful, and matches how this table already runs.
- [ ] **Clone from compendium** — create actors and items by cloning installed documents, so the project can stand up a complete NPC on its own. Raw creation stays for deliberately minimal placeholders.

**Exit:** a complete NPC can be created from installed content, and a homebrew-aware rules question can be answered with its source cited.

## Phase 4 — Session lifecycle, event log, and memory contract

**Goal:** give the table a durable record of what happened, and a stable contract for the tools that consume it.

- [ ] **Session lifecycle** — `POST /api/mcp/sessions/start` and `/end`, authenticated with the existing `X-API-Key`. The separate audio-recorder application calls start on record-start and end on record-stop; no new auth model is required.
- [ ] **Event tap** — subscribe to Foundry document changes on the socket the sidecar already holds. This is an architectural change: reads currently re-request a full world dump, so there is no delta subscription to build on.
- [ ] **Normalized event schema** — type, ISO wall-clock timestamp, monotonic per-session sequence, actor and scene references, structured payload. The timestamp pair is what allows a transcript segment to be joined to what was mechanically happening in Foundry at that moment; that join is the point of the whole phase.
- [ ] **Deterministic classifiers, in code** — critical hits and fumbles from roll data, HP crossing zero, death saves, combat start and turn and end, condition changes, rests, defeat. No model is required for any of these, and filtering hard at the sidecar is what keeps the log signal rather than noise.
- [ ] **Durable append-only storage** — nothing in this project writes to disk today, and the sidecar image declares no volume, so this needs a Compose volume mount alongside the code.
- [ ] **Query API and recall tools** — list sessions, fetch a session's events filtered by type and time, and fetch recent events.
- [ ] **Pregame/postgame snapshot diff** — capture party state at both session boundaries and diff them for wrap-up. Deliberately snapshot-based rather than derived from the audit log, because most of what happens at a table never passes through this server.
- [ ] **Mutation audit log** — append-only, recording what this server changed, who asked, before and after values, and the confirmation token. A different question from the diff, and it needs its own store.
- [ ] **Published event-schema contract** — versioned, so downstream consumers can depend on it.

The first consumer is a Discord bot with vector memory, answering questions like "when was the last time I rolled a crit?" or "what was that creature we killed last session?" **It lives in its own repository.** This project owes it a stable event stream and query API; the vector store, the bot, and any local-model inference belong on that side of the boundary.

**Exit:** the recorder can open and close a session, and its events can be queried afterward through a documented, versioned contract.

## Phase 5 — Journal and lore writes

**Goal:** write NPC and lore journals with correct visibility.

This is the highest-consequence write on the roadmap, and not for rules reasons. A wrong hit point value is corrected in seconds; DM notes rendered visible to a player cannot be un-seen.

- [x] **Named visibility profiles** — `gm`, `party`, and `players: [...]`, expanding to Foundry ownership maps. `sidecar/journal-visibility.js`'s `resolveVisibilityOwnership()`; `party` is derived from current character ownership, never stored.
- [x] **Visibility is required, and defaults to GM-only.** `parseJournalWrite` rejects a missing or unrecognized `visibility.profile`; the zod schema has no way to express two visibilities in one call, so mixed-visibility content is built by composition (two separately confirmed calls) rather than by a runtime check.
- [x] **Explicit page ownership** — `createJournalEntry`/`addJournalPage`/`updateJournalPage` (`module/scripts/prepared-actor-bridge.mjs`) always write the resolved ownership map explicitly on every page; nothing is left to `INHERIT`.
- [x] **Receipts report resolved names, not IDs.** Every write response's `visibility.visibleTo` and every GM read's `visibility` block name non-GM users, not just their ids (`sidecar/journal-visibility.js`'s `entryVisibility`/`pageVisibility`).
- [x] **Fail loud on name resolution.** `resolvePlayer()` (`sidecar/journal-visibility.js`) refuses on zero matches or ambiguity (a name matching two different users, or a character owned by more than one), naming the ambiguity in the error rather than guessing. Shared by reads (Stage 2) and writes (Stage 4).
- [x] **NPC and journal linking** — bidirectional `flags["foundry-mcp-bridge"].linkedJournalEntryId`/`.linkedActorId` on the Actor and JournalEntry (Stage 6), not the biography field. `@UUID` enrichers are ordinary page content, already supported by the write path and the Obsidian importer's two-pass wikilink resolution.
- [x] **Preview and apply gating**, as with HP changes — `preview_journal_write`/`apply_journal_write` and `preview_link_actor_journal`/`apply_link_actor_journal` follow the same confirmation-token pattern, gated by `FOUNDRY_WRITE_ENABLED` at both the MCP tool and sidecar layers.

**Exit:** an NPC journal can be written with per-player visibility and a receipt naming exactly who can see it.

## Phase 6 — Player-scoped access and approval

**Goal:** let players query their own characters without granting GM reach.

- [ ] Extend bridge pairing to non-GM users, with the token carrying the Foundry user id and role.
- [x] Evaluate every call against that user's document ownership as Foundry already sees it, for journals: `sidecar/journal-visibility.js` reproduces Foundry's own resolution from the world snapshot, and `audit-journal-visibility` proves it against real `testUserPermission()` calls through the GM bridge (see Phase 5's exit criteria). Not yet extended to actors or other document types — this is scoped to what the campaign-knowledge-journal work needed.
- [ ] Add a GM approval queue for player-initiated writes, reusing the existing scoped single-use confirmation helper with the GM as approver. An in-world chat card is the natural approval surface, since the GM is already looking at Foundry.

**Exit:** a player can read their own character, and any write they request waits for GM approval.

### The player-facing consumer: a separate repository, not this one

The campaign-knowledge-journal work (Phases 5-6's journal half) was built with a specific first consumer in mind — a player-facing knowledge service, referred to during design as **Iris** — but that service is explicitly **out of scope for this repo** and belongs in its own. What follows is the contract this repo has already committed to, and the boundary that keeps a bug in that other service from being able to reach anything it shouldn't.

**The boundary is the credential, not the data source.** A player-facing consumer holds only `PLAYER_API_KEY` — read-only, permission-filtered, structurally unable to reach GM routes, actor routes, or any write route (a separate Express router with its own auth check, mounted ahead of the GM-only middleware — see `sidecar/app.js`'s `playerRouter`). This is deliberately not split by subject matter (journal reads to one service, session/event data to another): a question like "what did we learn about X last session?" spans both, and a credential-scoped boundary survives that consumer later reading the Phase 4 event log under the same key, where a subject-matter split would not.

**What this repo already owes it, shipped:**
- `GET /api/mcp/players` — the roster of non-GM users and the character names they own; the stable references everything else takes as `:userRef`.
- `GET /api/mcp/players/:userRef/journal` and `/:userRef/journal/:entryId` — permission-filtered search and detail, indistinguishable between "hidden" and "doesn't exist" (verified by a byte-identical-response test).
- `GET /api/mcp/players/index-feed` — full enumeration (not a changed-since feed — see below) of every journal page visible to at least one non-GM user, each with a `contentHash` for incremental reindexing and the set of user ids who can see it. GM-only content never appears here, server-side, regardless of what the consumer does with the feed.
- `schemaVersion: 1` on every response from the four routes above.
- Honest error semantics: `400` for an unresolvable player reference, `503` when the sidecar's Foundry socket is down, `200` with `total: 0` for "nothing this player can see" — never a distinct status for "hidden" versus "absent".

**What this repo must not own**, if that service is ever built: the Discord (or other platform) identity mapping to a Foundry user id; any vector store, embeddings, or recall index; answer composition (a player-facing service's model should compose prose from what the filtered routes return — content it never receives cannot leak from it); or any write path. The player-scoped surface here is read-only, permanently — a player-initiated write is this phase's still-open GM approval queue item above, a different mechanism with a human in the loop, not something a knowledge service does directly.

**Foundry is the index's source of truth, not an Obsidian vault.** If a player-facing service indexes campaign content for retrieval, it should index what `GET /api/mcp/players/index-feed` returns — post-redaction, permission-live Foundry content — not the DM's original notes. The vault is unredacted by definition; a vault-sourced index has to reconstruct which parts are safe via a separate note-to-journal mapping, and that mapping drifts (renames, splits, merged notes) in a way that is a silent leak: permission gets checked against one document while retrieved text comes from another that was never checked at all. Indexing what `scripts/import-obsidian.mjs` actually wrote — where the retrieval unit (a journal page) and the permission unit (that same page's ownership) are the same object — doesn't have that failure mode. The importer already keeps the door open for authoring-quality retrieval without the vault as the index: it preserves each page's original markdown under `flags["foundry-mcp-bridge"].obsidian.markdown`, so an indexer can embed clean markdown while still keying strictly to Foundry-resolved ids and live permissions.

**The index feed enumerates fully rather than reporting deltas, on purpose.** The dangerous mutation for a permission-scoped index is not an edit, it's a *narrowing* — an entry moving from party-visible to GM-only. A hash-based changed-since feed would report "nothing changed" for exactly that case and leave stale, now-forbidden content sitting in a downstream index. Full enumeration means a consumer diffs the returned id set against its own on every sweep and drops whatever is absent, which handles narrowing and deletion with one mechanism and no tombstone protocol needed. Revisit this once Phase 4's event tap exists — an event-driven feed that explicitly emits narrowing events would be strictly better, but nothing before Phase 4 detects a document change at all, so building one earlier means re-deriving it from full world diffs, which is enumeration relocated, not avoided.

## Phase 7 — Module support tier

**Goal:** add module-aware behavior without inheriting module fragility.

Tier B only, and every item follows the same discipline: one adapter per module, a capability probe at startup, a pinned known-good version range, and explicit degraded errors when a module is absent or unrecognized. Module versions are already reported through system info, so the input exists.

- [ ] **Adapter and capability-probe pattern** — build this first; the rest are instances of it.
- [ ] **`midi-qol`** — completion semantics for activity execution. Midi wraps `Activity#use()`, so attack and save execution already passes through it when active; its workflow is asynchronous and may involve player-facing dialogs, which makes "did this finish, and what happened" the real work. Budget effort here, not on the API coupling.
- [ ] **`dae` and `automated-conditions-5e`** — interpret and report condition automation that fired as a result of a Tier A write.
- [ ] **Plutonium and DDB Importer** — detect newly imported documents, summarize them, and validate them. Demoted from the core plan; the recommended content workflow, not a dependency.

**Exit:** each supported module has one adapter, one version range, and a documented degraded mode.

## Phase 8 — Operational polish

**Goal:** make maintenance after upgrades routine.

- [ ] Log versions, reconnects, mutations, and failures — without logging secrets.
- [ ] Add backup guidance before destructive operations.
- [ ] Verify the deployment's API is reachable only from the intended network and caller.
- [ ] Publish the tested Foundry and `dnd5e` compatibility matrix.
- [ ] Keep `README.md`, `PRIMER.md`, and `AGENTS.md` describing one current architecture.
- [ ] Continue rotating private credentials on the normal schedule; never commit them, include them in examples, or serve them to browser clients.

**Exit:** an upgrade can be deployed and verified without manual guesswork.

---

## Recommended First Tool Set

Keep the initial public surface deliberately small.

### Read

- `ping`
- `system_info`
- `world_summary`
- `search_actors`
- `get_5e_actor_summary`
- `validate_5e_actor`
- `list_actor_items`
- `list_item_activities`
- `get_scenes`
- `get_scene_tokens`
- `get_combat_state`
- `get_chat_log`
- `search_journal`
- `search_compendium`

### Generic utility

- `roll_dice`

### Write

- `create_chat_message`
- `apply_damage`
- `apply_healing`
- `set_initiative`
- `next_turn`
- `add_condition`
- `remove_condition`

Add actor creation, deletion, macro execution, activity execution, and rests only after their safety and execution path are proven.

## Explicit Non-Goals

- Supporting Pathfinder, Call of Cthulhu, or arbitrary Foundry systems
- Reimplementing D&D 5e rules in TypeScript
- Supporting every Foundry or `dnd5e` version
- Depending on module internals or undocumented backends, including Plutonium's
- Reimplementing Plutonium's creature, content, or character importers
- Generating every field of complex `dnd5e` documents from scratch
- Hosting the Discord bot, its vector store, or local model inference in this repository
- Encoding one encounter-balancing opinion — this table sets NPC hit points to maximum while the DMG budget assumes otherwise, so any balancer is profile-driven or is not built
- Exposing unrestricted macro execution by default
- Growing a large generic document-mutation API

## Ordering notes

Phase 1 gates Phases 2, 5, and 6, because each adds mutations that would otherwise inherit the missing sidecar write gate. Phase 3 is read-heavy and can proceed in parallel if that is more useful.

Phase 4's event tap is the prerequisite for both the Discord bot and any future session-recap work, which is why it sits ahead of the lore and access phases despite being the largest. Recap is deliberately absent as a phase: once the snapshot diff, the event log, and journal writes exist, a recap is a prompt composed from them rather than a feature to build.
