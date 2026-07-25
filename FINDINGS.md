# Findings — Foundry VTT D&D 5e MCP

Background material for [`ROADMAP.md`](ROADMAP.md): the live-deployment inspection that established the supported environment, the architectural findings that shaped the design, and the current state of the checked-in code.

This document is a record, not a plan. It changes when something is re-inspected or a finding is superseded.

---

## Supported environment

| Component | Version |
|---|---|
| Foundry Virtual Tabletop | 14 build 365 |
| Game system | `dnd5e` 5.3.3 |
| Bridge module | `foundry-mcp-bridge` 1.5.0 |

Obtained from Foundry's served manifests and join page. Content is a deliberate mixture of 2014 and 2024 rules sources; there is no single useful edition value for this world (see [Finding 7](#7-do-not-build-separate-adapters-for-2014-and-2024-rules)).

---

## Representative baseline snapshot (2026-07-22)

A representative sidecar deployment on port 30001 was inspected with read-only requests. No world mutations were performed.

### Connection and world summary

- Sidecar health: connected
- Actors: 7 (4 characters, 3 NPCs)
- Scenes: 1
- World Items: 0
- Users: 6
- Journal index entries returned: 1

The three NPCs are minimal and contain no embedded Items. The four imported player characters are rich `dnd5e` documents:

| Character | Full payload | Embedded Items | Notable activity types | 2014 Items | 2024 Items |
|---|---:|---:|---|---:|---:|
| Character A | ~646 KiB | 112 | attack, damage, enchant, heal, save, transform, utility | 82 | 29 |
| Character B | ~2.43 MiB | 380 | attack, cast, damage, DDB macro, enchant, heal, save, summon, transform, utility | 236 | 143 |
| Character C | ~360 KiB | 66 | attack, check, damage, enchant, heal, save, summon, utility | 52 | 13 |
| Character D | ~293 KiB | 54 | attack, damage, heal, save, utility | 15 | 38 |

Each character also has one Item whose rules source is blank. Across the four sheets there are 612 embedded Items, and the largest sheet alone has 343 embedded spells — which is why returning full Actor documents by default is not viable and why the read adapter paginates.

Two structural facts confirmed by the live data:

- `system.activities` is an object keyed by activity ID, not an array.
- Item activities carry fields added by Midi-QOL and DDB Importer. Adapters preserve unknown activity fields and normalize only the subset needed for tool responses.

The rules mix is uneven per character, not just in aggregate: Character D is predominantly 2024 while A and C are predominantly 2014.

### Route contract at time of inspection

The live surface on the reference deployment, before the Phase 1 contract repair:

| Operation | Result |
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

Mutation routes were not probed merely to discover their status, because doing so could alter the live world.

Since resolved: `POST /refresh`, scene-token detail, journal-entry detail, and world Item detail are implemented. The compendium and macro tools were removed from the MCP surface rather than left advertised-but-missing; compendium search returns in Phase 3 as a core-API capability.

### Prepared vs unprepared data

The Socket.IO world payload exposes **unprepared source data**. Fields such as AC, HP maximum, character level, ability modifiers, and spell slots may be null even where Foundry derives them correctly at runtime. Accurate prepared values require an active in-world GM bridge, and the prepared route returns an explicit bridge-unavailable error rather than falling back to raw values.

---

## Active modules in the reference world

Rule- and automation-sensitive modules present:

- `automated-conditions-5e`
- `dae`
- `ddb-importer`
- `midi-qol`
- `socketlib`
- `tidy5e-sheet`
- Plutonium `2.16.2.v14` (requires `lib-wrapper`; compatibility: Foundry ≥14 verified 14.364, `dnd5e` ≥5.3.0 verified 5.3.3)

Their presence is why rule-aware operations go through Foundry and `dnd5e` APIs. Changing raw HP, effects, activities, or combat fields directly bypasses automation the live world expects.

Plutonium's custom backend endpoint is explicitly internal and undocumented, so nothing in the core plan depends on it.

---

## Architectural findings

### 1. The two-layer architecture is reasonable

```text
MCP client -> MCP server (TypeScript/stdio) -> HTTP sidecar -> Foundry (Socket.IO)
```

It keeps Foundry authentication and internal transport isolated in the sidecar, leaving the TypeScript process free to focus on tool descriptions, input validation, and stable results.

### 2. Foundry core is system-neutral; Actor and Item system data are not

Foundry's document types are generic, but the contents and behavior of `Actor.system` and `Item.system` are defined by the installed game system, which supplies data models, migrations, derived values, and custom behavior. Arbitrary `system` JSON is not a stable cross-system API, so a focused 5e adapter is smaller and safer than a generic one.

### 3. Modern 5e actions are activity-based

Attacks, damage, saves, healing, spellcasting, and summoning are represented by activities attached to Items:

```text
Actor -> embedded Item -> Activity
```

Creating a complete NPC is therefore more than ability scores and HP — attacks, spells, features, uses, effects, and recovery behavior come from embedded Items and their activities.

### 4. Prefer existing documents over hand-built payloads

Minimal raw creation is useful for placeholder actors. For complete monsters, spells, weapons, and features, cloning or importing a compatible compendium document avoids schema errors and lets the installed system supply defaults, migrations, embedded activities, and derived behavior.

### 5. Rule-aware actions should use Foundry/dnd5e behavior

Raw `modifyDocument` over Socket.IO is acceptable for constrained headless CRUD but is a fragile basis for rule-aware behavior. Foundry exposes supported operations such as `Combat.nextTurn()` and `Combat.setInitiative()`, and `dnd5e` owns activity use, rolls, rests, damage handling, and derived data. Calling those inside Foundry beats reimplementing them.

**Decision (Phase 3 of the previous roadmap, now closed):** keep the headless sidecar for reads and narrowly validated document changes; use an in-world GM bridge for anything rule-aware.

The bridge's first design — a module Socket.IO responder — was proved non-viable, because its client-to-client events never reach the headless sidecar. The working design is a same-origin HTTPS `/mcp-bridge` long-poll through a reverse proxy that preserves the browser's Foundry session cookie.

Both proofs of concept passed live:

- **Prepared reads.** Correct derived combat values returned from an active GM browser.
- **Activity execution.** An unambiguous self-targeted `dnd5e` utility activity (Cunning Action's Midi Use) executed end to end: `Activity#use()` ran for real, posted a chat card, and reported no resource consumption or effects, matching the activity's own configuration.

The first execution attempt failed with Foundry's internal `PlaceableObject` construction error because the actor had no token on the active scene — `Activity#use()` requires a placed token to resolve self-targeting even with no external target or template. The guard now checks `actor.getActiveTokens()` and rejects at preview time with a clear message.

### 6. Generic dice rolls and 5e rolls are different tools

The local dice roller is useful for standalone formulas but has no access to actor roll data, effects, activity configuration, system settings, or `dnd5e` roll behavior. `roll_dice` stays a generic utility; rule-aware rolls are separate tools executed through the installed system.

### 7. Do not build separate adapters for 2014 and 2024 rules

`dnd5e` already supports legacy and modern content, and live characters mix both sources on one Actor. The MCP preserves and exposes each Item's `system.source.rules` and lets `dnd5e` apply the rules. It does not independently implement proficiency, resistance, exhaustion, resting, or other edition-sensitive rules.

The subsystems where the editions genuinely diverge — exhaustion, weapon mastery, spell preparation, rest and hit-dice recovery — are where *within-character* inconsistency actually costs something at the table. Raw 2014/2024 counts matter much less than conflicts inside those subsystems.

### 8. Pin and verify versions

`dnd5e` 5.3 includes breaking internal data changes to advancement storage, senses, and chat-message types. "Foundry 14" alone is not a precise enough compatibility promise. The bridge reports and verifies:

```json
{
  "foundryVersion": "14.365",
  "systemId": "dnd5e",
  "systemVersion": "5.3.3",
  "defaultRulesMode": "world-setting-if-available",
  "contentRules": ["2014", "2024"]
}
```

Unknown versions may remain readable, but 5e writes fail safely unless explicitly allowed.

### 9. Secrets and mutations need tightening

The API key and Foundry password once had committed fallback values. Credentials are now supplied only through private environment configuration, and the browser bridge uses authenticated GM-session pairing with a short-lived per-client token — no reusable credential is served to Foundry clients.

Macro execution needs special treatment whenever it returns: a macro can mutate nearly anything, so it must not be exposed as an unrestricted read operation.

---

## Current-state gaps

Observed in the checked-in code. These are what [Phase 1](ROADMAP.md#phase-1--consolidate-the-foundation) exists to close.

**No sidecar write gate.** `FOUNDRY_WRITE_ENABLED` is enforced only in `src/tools/write.ts`. Anyone holding the sidecar API key can call `POST /api/mcp/actors/:id/delete` (`sidecar/index.js:647`) directly. The only sidecar-side gating is the confirmation-token requirement on the two bridge write pairs.

**Two divergent write patterns.** The newer paths — `preview_hp_change`/`apply_hp_change` and `preview_item_activity_use`/`execute_item_activity_use` — use preview → scoped confirmation token → `dnd5e` API via the GM bridge. The five legacy writes (`update_actor`, `create_actor`, `delete_actor`, `next_turn`, `create_chat_message`) use raw `modifyDocument` with no preview, no confirmation, and no bridge. `next-turn` (`sidecar/index.js:658-670`) computes the turn and round increment in the sidecar itself rather than calling `Combat#nextTurn`, bypassing dnd5e hooks entirely.

**No reconnect.** The socket `disconnect` handler (`sidecar/index.js:222`) sets `connected = false` and stops. Recovery requires a container restart.

**No persistence, no audit trail.** Nothing anywhere writes to disk. All sidecar state — bridge clients, tokens, in-flight requests, both confirmation stores — lives in in-memory Maps lost on restart. No mutation is recorded anywhere: not what changed, not who asked, not what it was before. The MCP server logs to stderr only; the sidecar uses bare `console.log`. The sidecar Dockerfile declares no volume.

**Full world dump per request.** `getWorld()` (`sidecar/index.js:229`) re-emits `"world"` on every request. There is no cache and no delta subscription, which is the main obstacle to the Phase 4 event tap.

**Single-consumer bridge dispatch.** `dispatchPreparedActorRequests()` (`sidecar/index.js:81-91`) serves the first client with a parked poll, one request per poll cycle. With an 8s request timeout against a 25s poll window, concurrent bridge operations serialize and can time out. Phases 2 and 4 add many more bridge operations, so this will bite.

**Helper-only test coverage.** `node --test` runs roughly a dozen pure-function unit tests across `sidecar/*.test.js` and `module/scripts/*.test.mjs`. Nothing tests `src/`, the Express routes, the bridge handshake, or the Socket.IO auth flow. There is no CI. Two tests do guard something valuable: they scan source files to assert no shared credential strings are present.

**Stale metadata.** The MCP server reports version `1.0.0` (`src/index.ts:25`) against package 1.5.0; a hardcoded fallback API key remains at `src/index.ts:18` even though the sidecar and module tests forbid that same string in their own sources; `sidecar/actor-utils.js:289-295` still declares activity execution unimplemented; `package.json` declares a `test:auth` script pointing at a file that does not exist.

---

## Reference documentation

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
