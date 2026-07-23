# Foundry VTT D&D 5e MCP Roadmap

## Objective

Build a small, dependable personal MCP server for one supported environment:

- Foundry Virtual Tabletop v14 Build 365
- The official `dnd5e` game system v5.3.3
- Mixed 2014 and 2024 content, preserving each Item's rules source

This project will not attempt to become a system-neutral Foundry integration. Foundry-level concepts such as documents, scenes, journals, chat, and combat remain reusable internally, but the public MCP tools should speak in D&D 5e terms.

## Where to Start

Start with **a deployed-baseline and contract milestone**, not new 5e write tools.

The local MCP server currently advertises operations that the checked-in sidecar does not implement. Until the local source is reconciled with the working homeserver deployment, it is difficult to tell whether a failure is caused by transport, a missing route, an outdated local file, or incorrect 5e data.

The baseline inspection has established the Foundry and `dnd5e` versions, live route surface, installed bridge-module source, and representative character schemas. The first implementation milestone should now:

1. Disable or replace the inert `foundry-mcp-bridge` module.
2. Establish a one-to-one contract between every advertised MCP tool and a tested sidecar endpoint.
3. Add a small automated smoke test that verifies that contract.
4. Add sanitized, minimal fixtures derived from the imported characters.

The currently exposed API key and password are explicitly treated as disposable **test-environment credentials**. They must be replaced by environment-managed secrets and rotated before any stable or production-like deployment.

Once that baseline is trustworthy, add 5e-aware reads before 5e-aware writes.

## Live Baseline Snapshot (2026-07-22)

The homeserver sidecar at port 30001 was inspected with read-only requests. No world mutations were performed.

### Connection and world summary

- Sidecar health: connected
- Actors: 7
  - Characters: 4
  - NPCs: 3
- Scenes: 1
- World Items: 0
- Users: 6
- Journal index entries returned: 1

The three NPCs are minimal and contain no embedded Items. The four imported player characters are rich `dnd5e` documents:

| Character | Full payload | Embedded Items | Notable activity types | 2014 Items | 2024 Items |
|---|---:|---:|---|---:|---:|
| Yuka Arnaaluk | ~646 KiB | 112 | attack, damage, enchant, heal, save, transform, utility | 82 | 29 |
| Mortala | ~2.43 MiB | 380 | attack, cast, damage, DDB macro, enchant, heal, save, summon, transform, utility | 236 | 143 |
| Exodus | ~360 KiB | 66 | attack, check, damage, enchant, heal, save, summon, utility | 52 | 13 |
| Jackie Daytona | ~293 KiB | 54 | attack, damage, heal, save, utility | 15 | 38 |

Each character also has one Item whose rules source is blank. Across the four sheets there are 612 embedded Items. Mortala alone has 343 embedded spells, so returning full Actor documents by default will consume excessive MCP context. The first 5e read adapter should provide summaries and paginated/filterable Item and Activity listings.

The live data confirms that `system.activities` is an object keyed by activity ID, not an array, and that Item activities include fields added by Midi-QOL and DDB Importer. Adapters should preserve unknown activity fields and normalize only the subset needed for tool responses.

### Verified live route contract

| Operation | Live result |
|---|---:|
| `GET /refresh` | 200 |
| `GET /world-summary` | 200 |
| `GET /system-info` | 200 |
| `GET /actors` | 200 |
| `GET /actors/:id` | 200 |
| `GET /items` | 200 |
| `GET /scenes` | 200 |
| `GET /scenes/:id/tokens` | 404 |
| `GET /combats/active` | 200 |
| `GET /chat-log` | 200 |
| `GET /journal` | 200 |
| `GET /journal/:id` | 404 |
| `GET /users` | 200 |
| `GET /compendiums` | 404 |
| `GET /macros` | 404 |
| `POST /refresh` | 404 |

Mutation routes were not probed merely to discover their status because doing so could alter the live world.

### Verified versions and remaining discovery gap

- Foundry Virtual Tabletop: Version 14 Build 365
- Game system: `dnd5e` 5.3.3
- Deployed bridge module: `foundry-mcp-bridge` 1.0.0

These values were obtained from Foundry's served manifests and join page. The sidecar's live `/system-info` response still omits them and must be expanded before the MCP can enforce compatibility automatically.

There is not a single useful rules-edition value for the imported content: every player sheet contains a mixture of Items marked `system.source.rules = "2014"` and `"2024"`. A world default may still affect system behavior, but the MCP must preserve and report Item-level rules provenance.

### Relevant active modules

The live world reports `foundry-mcp-bridge` 1.0.0 as active. Its manifest points to `api.js`, which was inspected through Foundry's static module path. The module attempts to register Express routes through `game.express` and contains useful examples of public Actor, Combat, ChatMessage, compendium, and Macro operations.

However, direct checks against those routes on Foundry port 30000 return 404. The module is marked active but its REST API is not registered; the sidecar on port 30001 is the component currently serving working requests. The likely reason is that normal Foundry module JavaScript runs in a client context where an Express application is not a supported public API.

The module also hardcodes the test API key in `api.js`. Because module JavaScript is served as a static asset, the credential can be retrieved without authenticating to the MCP API. This is accepted only for the current disposable test environment. Before a stable or production-like deployment, rotate the key, remove it from committed/served source, and supply it only to the server-side sidecar through environment configuration.

Several rule- and automation-sensitive 5e modules are also active, including:

- `automated-conditions-5e`
- `dae`
- `ddb-importer`
- `midi-qol`
- `socketlib`
- `tidy5e-sheet`

Their presence strengthens the case for executing rule-aware operations through Foundry and `dnd5e` APIs. Directly changing raw HP, effects, activities, or combat fields may bypass automation expected by the live world.

### Plutonium import strategy

Plutonium is installed and active in the live world. Its served manifest reports:

- Plutonium: `2.16.2.v14`
- Foundry compatibility: minimum 14, verified 14.364, maximum 14.999
- `dnd5e` compatibility: minimum 5.3.0, verified 5.3.3, maximum 5.3.999
- Required dependency: `lib-wrapper`

This is a strong compatibility match for the live Foundry 14 Build 365 and `dnd5e` 5.3.3 stack.

Plutonium should be the **importer of record** for creatures, character content, classes, spells, features, and Items. The MCP should not duplicate Plutonium's data conversion or character-building logic. The preferred workflow is:

```text
Plutonium UI / Rivet -> imports Actor or Item -> MCP discovers it -> MCP summarizes, validates, and uses it
```

For player characters, Plutonium recommends importing directly to the Actor sheet so its specialized workflows can run. It also recommends importing only content that is needed instead of bulk-populating a world or compendium, because imported content becomes stale and large collections hurt performance.

Plutonium's custom backend endpoint is explicitly internal and undocumented. The MCP should not depend on it. Automating Plutonium imports may be considered later, but only as an experimental, version-pinned adapter with a fallback to the normal Plutonium UI or Rivet workflow.

## Findings

### 1. The two-layer architecture is reasonable

The current shape is appropriate for a personal server:

```text
Hermes -> MCP server (TypeScript/stdio) -> HTTP sidecar -> Foundry (Socket.IO)
```

It keeps Foundry authentication and internal transport isolated in the sidecar. The TypeScript MCP process can focus on tool descriptions, input validation, and stable results.

### 2. The checked-in layers do not currently have a complete contract

The MCP server registers 26 tools, while the checked-in sidecar is missing routes used by several of them, including:

- Item details
- Scene tokens
- Journal entry details
- Compendium listing and search
- Macro listing and execution
- Setting initiative
- `refresh_world` also calls `POST /refresh`, while the sidecar implements `GET /refresh`

The README tool totals and route list are also out of sync with the implementation.

### 3. Foundry core is system-neutral; Actor and Item system data are not

Foundry's core document types are generic, but the contents and behavior of `Actor.system` and `Item.system` are defined by the installed game system. The `dnd5e` system supplies data models, migrations, derived values, and custom behavior.

The MCP server should therefore avoid pretending that arbitrary `system` JSON is a stable cross-system API. A focused 5e adapter will be smaller and safer.

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

**Goal:** Establish the homeserver as the known-good reference.

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
- [deferred] Rotate test credentials and remove the publicly served hardcoded value before the stable release.

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

**Current progress:** The local contract includes `POST /refresh`, world Item detail, scene-token detail, and journal-entry detail. Unimplemented compendium and macro tools, plus the unverified initiative write, were removed from the MCP surface. The sidecar was deployed and rebuilt on Atomsk on 2026-07-22; its health check connected successfully to Foundry v14 / dnd5e 5.3.3 and its system-info route reported the active module list and content-rule sources.

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

**Current progress:** Implementations provide `get_5e_actor_summary`, `list_actor_items`, `list_item_activities`, and `validate_5e_actor`. Embedded Items and Activities are paginated, source-rule provenance is retained, and the validator warns about large documents and custom Activity types. The deployed routes were verified against Exodus, Jackie Daytona, Mortala, and Yuka Arnaaluk on 2026-07-22. Mortala has 380 Items / 462 Activities; all four characters contain a mix of 2014 and 2024 Items.

### Phase 3 - Prove the rule-aware execution path

**Goal:** Decide whether a Foundry bridge module is warranted.

Implement one end-to-end proof of concept, preferably one of:

- Advance combat through `Combat.nextTurn()`.
- Set initiative through `Combat.setInitiative()`.
- Execute one Item activity and return its chat/roll result.

Compare two approaches:

1. Raw headless Socket.IO document modification.
2. A minimal in-world bridge module calling public Foundry/dnd5e APIs.

Evaluate reliability, the need for an active Foundry client, permissions, result reporting, and deployment complexity.

**Exit criteria:** The project records a clear architectural decision before implementing additional rule-aware mutations.

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

- Add a single deployment script or documented deployment command.
- Add a post-deployment smoke test.
- Log versions, reconnects, mutations, and failures without logging secrets.
- Add backup guidance before destructive operations.
- Replace all test credentials with environment-managed secrets, rotate keys/passwords, and remove them from source, documentation examples, served assets, and deployment history where practical.
- Verify that the stable deployment's API is reachable only from the intended network and caller.
- Update `README.md`, `PRIMER.md`, and `SPEC.md` to describe one current architecture.
- Document the tested Foundry/`dnd5e` compatibility matrix.

**Exit criteria:** An upgrade can be deployed and verified without manual guesswork.

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
- Exposing unrestricted macro execution by default
- Generating every field of complex `dnd5e` documents from scratch
- Reimplementing Plutonium's creature, content, or character importers
- Depending on Plutonium's undocumented internal backend API for core operation
- Growing a large generic document-mutation API

## Reference Documentation

- [Foundry VTT v14 API](https://foundryvtt.com/api/)
- [Foundry public versus private API guidance](https://foundryvtt.com/api/#reading-these-api-docs)
- [Foundry system data models](https://foundryvtt.com/article/system-data-models/)
- [Foundry Actor API](https://foundryvtt.com/api/v14/classes/foundry.documents.Actor.html)
- [Foundry Combat API](https://foundryvtt.com/api/v14/classes/foundry.documents.Combat.html)
- [`dnd5e` wiki](https://github.com/foundryvtt/dnd5e/wiki)
- [`dnd5e` activities](https://github.com/foundryvtt/dnd5e/wiki/Activities)
- [`dnd5e` roll formulas](https://github.com/foundryvtt/dnd5e/wiki/Roll-Formulas)
- [`dnd5e` releases](https://github.com/foundryvtt/dnd5e/releases)
- [Plutonium overview](https://wiki.tercept.net/en/Plutonium)
- [Plutonium feature and import guide](https://wiki.tercept.net/en/Plutonium/Features-Guide)
- [Plutonium configuration](https://wiki.tercept.net/en/Plutonium/Features-Guide/Configuration)
