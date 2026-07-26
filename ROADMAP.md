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

Shipped in v1.4.0 and v1.5.0:

- **Read-only 5e adapter** — `get_5e_actor_summary`, `list_actor_items`, `list_item_activities`, `get_item_activity`, `validate_5e_actor`. Embedded Items and Activities are paginated, rules-source provenance is retained, and the validator reports document shape and rules mix.
- **Prepared-data bridge** — a module running in an active GM browser, paired only after the sidecar validates that browser's authenticated Foundry GM session, then issued a short-lived in-memory token. Returns runtime-derived values the headless socket cannot supply.
- **Confirmation-gated HP changes** — `preview_hp_change` / `apply_hp_change`, applied through `dnd5e`'s `Actor.applyDamage` so temporary HP is consumed correctly.
- **Guarded utility-activity execution** — `preview_item_activity_use` / `execute_item_activity_use`, running `Activity#use()` for real behind a strict eligibility guard.
- **Deploy and smoke scripts** — `scripts/deploy-foundry.sh` and `scripts/smoke-foundry.sh --require-bridge`.

The preview → scoped confirmation token → `dnd5e` API pattern established by the last two is the template every future mutation follows.

---

## Phase 1 — Consolidate the foundation

**Goal:** make the existing surface trustworthy before adding to it.

Every later phase adds mutations, and each would inherit today's gaps. This phase closes them once.

- [ ] Enforce write gating in the sidecar, not only in `src/tools/write.ts`. An API-key holder can currently call `POST /api/mcp/actors/:id/delete` directly.
- [ ] Converge the five legacy raw writes (`update_actor`, `create_actor`, `delete_actor`, `next_turn`, `create_chat_message`) onto the preview → confirmation → `dnd5e` pattern, or quarantine them behind an explicit debug flag.
- [ ] Add a bounded Socket.IO reconnect loop. The disconnect handler currently gives up and the API returns 503 until the container restarts.
- [ ] Allow concurrent bridge operations. Dispatch serves one parked poll per cycle today, which will not survive Phases 2 and 4.
- [ ] Correct stale metadata: reported server version, the leftover fallback API key, the "execution is not implemented" note in the activity adapter, and the dead `test:auth` script.
- [ ] Make the sidecar image buildable from the repository alone. `npm ci` in the Dockerfile needs a lockfile that is not tracked, and the deploy script ships neither it nor `sidecar/package.json`, so a rebuild currently depends on files left on the host by earlier manual setup.
- [ ] Add the first tests that exercise something other than pure helpers — tool registration, route mapping, authentication failure, write gating, and timeouts.

**Exit:** no advertised capability is ungated at the sidecar boundary, and the transport contract has tests.

## Phase 2 — Core 5e play operations

**Goal:** cover the operations this table performs every session, through `dnd5e`'s own APIs.

All Tier A, all through the GM bridge, all following the established mutation pattern: verify supported versions, check existence and permissions, validate semantic inputs rather than accepting arbitrary paths, return before/after values and a receipt, and read back the changed document before reporting success.

- [ ] **Conditions** — apply and remove via `Actor#toggleStatusEffect`. Exhaustion is a 0–6 level, not a boolean, and 2014 and 2024 exhaustion behave differently, so read the actor's rules provenance rather than assuming a mode.
- [ ] **Concentration** — report who is concentrating on what. Its own mechanic in `dnd5e` 5.x, not a generic condition, and useful as a read long before it is useful as a write.
- [ ] **Rests** — short and long rest through `dnd5e`, with `dialog: false` and hit-dice spending as an explicit input, since no GM is present to answer a prompt. Pin the API signature; it moved across 5.x.
- [ ] **Combat control** — replace the sidecar-computed turn advance with `Combat#nextTurn()`, and add `Combat#setInitiative()`, initiative rolling, previous turn, and combat start/end.
- [ ] **Typed damage** — `Actor.applyDamage` accepts typed damage. Until it is wired through, HP changes silently report wrong numbers against a resistant, vulnerable, or immune target.
- [ ] **Spell slots and resources** — adjust slots (including pact magic, currently filtered out of prepared summaries) and limited-use resources.
- [ ] **Party overview** — one call returning prepared HP, AC, conditions, and slots for all player characters, so inspecting the party does not mean fetching four multi-hundred-kilobyte sheets.

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

- [ ] **Named visibility profiles** — `gm`, `party`, and `players: [...]`, expanding to Foundry ownership maps. Foundry supports per-user ownership natively, so per-player secrets and blanket visibility are the same mechanism at different settings.
- [ ] **Visibility is required, and defaults to GM-only.** A single call may not produce mixed-visibility content; the caller declares which bucket each piece belongs to.
- [ ] **Explicit page ownership** — pages inherit from the parent entry unless overridden, which is the likeliest way notes leak. GM pages set ownership explicitly rather than relying on a default.
- [ ] **Receipts report resolved names, not IDs.** "Visible to Alice and Bob" can be checked at a glance; an ownership map keyed by user ID cannot, and an unverifiable receipt on a spoiler-sensitive write is worth nothing.
- [ ] **Fail loud on name resolution.** Players are named by player or character name. An ambiguous or unmatched name refuses the write rather than guessing.
- [ ] **NPC and journal linking** — `@UUID` enrichers in page content plus a module flag on the actor, maintained in both directions. Not the biography field, which DDB Importer and Plutonium overwrite on re-import.
- [ ] **Preview and apply gating**, as with HP changes.

**Exit:** an NPC journal can be written with per-player visibility and a receipt naming exactly who can see it.

## Phase 6 — Player-scoped access and approval

**Goal:** let players query their own characters without granting GM reach.

- [ ] Extend bridge pairing to non-GM users, with the token carrying the Foundry user id and role.
- [ ] Evaluate every call against that user's document ownership as Foundry already sees it. No parallel permission model.
- [ ] Add a GM approval queue for player-initiated writes, reusing the existing scoped single-use confirmation helper with the GM as approver. An in-world chat card is the natural approval surface, since the GM is already looking at Foundry.

**Exit:** a player can read their own character, and any write they request waits for GM approval.

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

### 4. Modern 5e actions are activity-based

In current `dnd5e`, attacks, damage, saves, healing, spellcasting, summoning, and other actions are represented by activities attached to Items. A useful 5e integration must understand:

```text
Actor -> embedded Item -> Activity
```

Creating a complete NPC is consequently more than filling in ability scores and HP. Its attacks, spells, features, uses, effects, and recovery behavior generally come from embedded Items and their activities.

### 5. Prefer compendium documents over hand-built complex payloads

Minimal raw creation is useful for placeholder actors. For complete monsters, spells, weapons, and features, importing or cloning a compatible compendium document is preferable to generating the full `dnd5e` schema by hand.

This reduces schema errors and lets the installed system supply defaults, migrations, embedded activities, and derived behavior.

### 6. Rule-aware actions should use Foundry/dnd5e behavior

The sidecar currently performs raw `modifyDocument` operations through an internal Socket.IO protocol. That is acceptable for constrained, headless CRUD, but it is a fragile basis for rule-aware behavior.

Foundry documents expose supported operations such as `Combat.nextTurn()` and `Combat.setInitiative()`. The `dnd5e` system likewise owns activity use, rolls, rests, damage handling, and derived data. Calling those operations inside Foundry is preferable to reimplementing them in the MCP server.

This creates an architectural decision:

- Keep the current headless sidecar for reads and narrowly validated document changes.
- Add a small in-world Foundry bridge module if the MCP needs to execute activities, rests, system rolls, or other client-side public APIs.

The bridge-module decision should be tested with one thin proof of concept after the basic contract is repaired.

### 7. Do not build separate MCP adapters for 2014 and 2024 rules

The official `dnd5e` system already supports legacy and modern content and behavior, and the live characters mix both sources on the same Actor. The MCP should preserve and expose each Item's `system.source.rules` value while letting `dnd5e` apply the rules.

The world default and Item provenance should influence compendium/content selection. The MCP should not independently implement proficiency, resistance, exhaustion, resting, or other edition-sensitive rules.

### 8. Pin and verify versions

The `dnd5e` 5.3 release includes breaking internal data changes, including advancement storage, senses, and chat-message types. Supporting “Foundry 14” alone is not a precise enough compatibility promise.

At startup, the bridge should report and verify:

```json
{
  "foundryVersion": "14.365",
  "systemId": "dnd5e",
  "systemVersion": "5.3.3",
  "defaultRulesMode": "world-setting-if-available",
  "contentRules": ["2014", "2024"]
}
```

Unknown versions may remain readable, but 5e writes should fail safely unless explicitly allowed.

### 9. Generic dice rolls and 5e rolls are different tools

The existing local dice roller is useful for standalone formulas. It does not have the actor's roll data, effects, activity configuration, system settings, or `dnd5e` roll behavior.

Keep `roll_dice` as a generic utility. Add separate rule-aware tools such as `roll_skill_check`, `roll_save`, or `use_activity` only when they can be executed through the installed system.

### 10. Secrets and mutations need tightening

The API key and Foundry password currently have committed fallback values. Real credentials should be rotated and required through environment variables.

Macro execution also needs special treatment: a macro can mutate nearly anything in the world, so it should not be exposed as an unrestricted read operation. It should be disabled by default or limited to an explicit allowlist.

## Implementation Roadmap

### Phase 0 - Capture the working deployment

**Goal:** Establish a known-good reference deployment.

- [x] Record the deployed Foundry and `dnd5e` versions.
- [ ] Record the deployed Node, sidecar build, and MCP build versions.
- [ ] Copy or diff the deployed sidecar against `sidecar/index.js` (SSH credentials were unavailable during inspection; the live routes strongly match the checked-in sidecar).
- [x] Inspect the active `foundry-mcp-bridge` module manifest and entry source.
- [x] Record which read-only MCP routes work in the deployed environment.
- Export and sanitize fixtures for:
  - [x] Player-character schema, Item-type, Activity-type, and rules-source summaries
  - One NPC
  - One weapon with an attack activity
  - One spell
  - One class or monster feature
  - One active combat, if available
- Store fixtures under a test-only directory with names and private content removed.
- [done] Rotate the sidecar/service-account credentials, remove browser-served credentials, and publish the v1.4.0 stable release.

**Exit criteria:** The repository contains no unexplained difference from the deployed implementation, and the supported version tuple is documented.

### Phase 1 - Repair and test the transport contract

**Goal:** Make every advertised tool either work or disappear.

- Install dependencies and restore a passing TypeScript build.
- Create a route/tool contract inventory.
- Implement missing sidecar routes that are actually needed.
- Remove tools that are not useful enough to maintain.
- Correct the refresh method mismatch.
- Make `/system-info` return Foundry, system, default-rules setting, detected Item rules sources, and module versions.
- Make health checks reflect the real Socket.IO state.
- Add disconnect detection and bounded reconnection.
- Add timeouts and error handling to Socket.IO callbacks.
- Require secrets through environment variables and provide a safe `.env.example`.
- Add automated tests for route mapping, authentication errors, timeouts, and write gating.

**Exit criteria:** Build and tests pass; every registered MCP tool has a matching, tested implementation.

**Current progress:** The local contract includes `POST /refresh`, world Item detail, scene-token detail, and journal-entry detail. Unimplemented compendium and macro tools, plus the unverified initiative write, were removed from the MCP surface. A reference deployment health check connected successfully to Foundry v14 / dnd5e 5.3.3 and its system-info route reported the active module list and content-rule sources.

### Phase 2 - Add a read-only D&D 5e adapter

**Goal:** Return useful 5e concepts without changing the world.

- Add runtime guards for `systemId === "dnd5e"` and the supported version range.
- Define small normalized response schemas instead of duplicating the entire `dnd5e` data model.
- Add `get_5e_actor_summary` with:
  - Actor type, level or challenge rating
  - HP, temporary HP, AC, movement, senses
  - Abilities, saves, skills, proficiency
  - Conditions, immunities, resistances, vulnerabilities
  - Spell slots and commonly used resources when present
- Add `list_actor_items` and `list_item_activities`.
- Finish compendium listing and searching.
- Preserve an optional raw-document read for debugging.
- Test normalization with the sanitized live fixtures.

**Exit criteria:** Hermes can accurately inspect a character or NPC and discover its usable activities without knowing raw Foundry paths.

**Current progress:** v1.5.0 adds `get_item_activity` alongside `get_5e_actor_summary`, `list_actor_items`, `list_item_activities`, and `validate_5e_actor`. Embedded Items and Activities are paginated, source-rule provenance is retained, and the validator warns about large documents and custom Activity types. `get_item_activity` is deliberately discovery-only: it reports activation, targeting, consumption, attack/save, damage/healing, and effect metadata without rolling, consuming resources, creating chat messages, or changing Foundry data. Its configuration cautions explicitly prevent inferring final resource costs or roll outcomes. Representative imported characters confirmed that large sheets can contain hundreds of Items and Activities, with mixed 2014 and 2024 sources. Natural-language acceptance testing confirmed that the MCP client selects `search_actors`, `list_item_activities`, and `get_item_activity` directly. The Socket.IO world payload exposes unprepared source data: fields such as AC, HP maximum, character level, ability modifiers, and spell slots may be null even when Foundry can derive them at runtime. Accurate prepared data requires an active in-world bridge.

### Phase 3 - Prove the rule-aware execution path

**Goal:** Decide whether a Foundry bridge module is warranted.

Implement one end-to-end proof of concept, preferably one of:

- Read prepared Actor data (derived HP, AC, level, modifiers, and slots) through a GM client.
- Advance combat through `Combat.nextTurn()`.
- Set initiative through `Combat.setInitiative()`.
- Execute one Item activity and return its chat/roll result.

Compare two approaches:

1. Raw headless Socket.IO document modification.
2. A minimal in-world bridge module calling public Foundry/dnd5e APIs.

Evaluate reliability, the need for an active Foundry client, permissions, result reporting, and deployment complexity.

**Exit criteria:** The project records a clear architectural decision before implementing additional rule-aware mutations.

**Current progress:** The initial module Socket.IO responder was proved non-viable because its client-to-client events do not reach the headless sidecar. The prepared-Actor bridge instead uses a same-origin HTTPS `/mcp-bridge` long-poll route through a reverse proxy. v1.4.0 pairs only after the sidecar validates the browser's authenticated Foundry GM session, then issues a short-lived per-client in-memory token; no browser-served credential is used. Live validation confirmed correct prepared combat values from an active GM browser. When no GM browser is active, the tool returns an explicit bridge-unavailable error and never falls back to raw snapshot data.

### Phase 4 - Add safe 5e mutations

**Goal:** Cover common play operations with narrow, validated tools.

Recommended initial tools:

- `apply_damage`
- `apply_healing`
- `set_temporary_hp`
- `adjust_resource`
- `add_condition`
- `remove_condition`
- `set_initiative`
- `next_turn`

Requirements for every mutation:

- Verify the supported Foundry and `dnd5e` versions.
- Check actor/document existence and user permissions.
- Validate semantic inputs instead of accepting arbitrary paths.
- Return before/after values and a mutation receipt.
- Read back the changed document before reporting success.
- Produce a clear error when the installed system rejects the operation.

Keep the generic `update_actor` escape hatch disabled by default.

**Exit criteria:** Common combat-state changes work predictably and are covered by live smoke tests.

**Current progress:** v1.4.0 includes `preview_hp_change` and confirmation-gated `apply_hp_change`. The preview is read-only and returns a one-time two-minute token scoped to the actor, mode, and amount. Apply is gated by `FOUNDRY_WRITE_ENABLED` and runs via the active GM bridge using dnd5e 5.3.3's `Actor.applyDamage`, so direct damage consumes temporary HP. In an isolated test world, disposable-actor checks verified temporary-HP absorption, normal HP damage, healing, prepared readback, and cleanup. The follow-up `preview_temporary_hp` / `set_temporary_hp` flow uses the same safeguards but explicitly replaces the prepared temporary-HP value (including clearing it with `0`); it intentionally does not infer how a spell or feature resolves competing temporary-HP grants. Neither path models typed damage, resistance, vulnerability, immunity, or activity automation; those remain future activity-level operations.

### Phase 5 - Plutonium handoff and activity workflows

**Goal:** Let Plutonium create complete 5e content, then operate on the imported documents.

- Detect an Actor or Item created through Plutonium or Rivet.
- Add `validate_5e_actor` to report Item counts, Activity counts, rules-source mix, missing activities, and unsupported custom activity types.
- Provide a concise post-import summary and stable document IDs.
- Support the normal Plutonium workflow of importing character content directly to an Actor.
- Inspect and select embedded activities.
- Execute attacks, saves, damage, healing, and spell activities.
- Add short-rest and long-rest operations through `dnd5e` behavior.
- Preserve legacy/modern provenance from `system.source.rules`.
- Keep compendium tools for already-installed packs, not as a replacement for Plutonium's importer.
- Keep raw creation only for deliberately minimal placeholders.
- Treat direct Plutonium API automation as optional and version-pinned because its backend/API surface is undocumented and internal.

**Exit criteria:** After a Plutonium/Rivet import, Hermes can find the new document, validate it, summarize it, and use its existing 5e activities without reconstructing system internals.

### Phase 6 - Operational polish

**Goal:** Make maintenance after upgrades routine.

- Maintain the deployment script and post-deployment smoke test as Foundry/Docker layouts evolve.
- Log versions, reconnects, mutations, and failures without logging secrets.
- Add backup guidance before destructive operations.
- Continue rotating private credentials on the normal secrets-management schedule; never commit them, include them in examples, or serve them to browser clients.
- Verify that the stable deployment's API is reachable only from the intended network and caller.
- Update `README.md`, `PRIMER.md`, and `SPEC.md` to describe one current architecture.
- Document the tested Foundry/`dnd5e` compatibility matrix.

**Exit criteria:** An upgrade can be deployed and verified without manual guesswork.

**Current progress:** v1.4.0 is published as a stable module release. The sidecar and module use private environment-managed service credentials, while an active GM bridge pairs through its authenticated Foundry session and receives only a short-lived in-memory token. `scripts/deploy-foundry.sh` backs up and deploys the checked-in runtime files, validates Compose, rebuilds the sidecar, and performs a read-only health smoke check. After a GM hard refresh, `scripts/smoke-foundry.sh --require-bridge` verifies the active bridge responder without reading credentials or changing world data.

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
