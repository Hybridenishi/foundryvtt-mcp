# Foundry VTT MCP Server

Focused MCP server connecting an MCP-compatible agent to Foundry VTT v14 and D&D 5e.

## Architecture

```
Hermes → MCP Server (stdio) → Sidecar (REST :30001) → Foundry (Socket.IO :30000)
                                               ↕
              Same-origin reverse proxy /mcp-bridge ↔ MCP Bridge module (active GM client)
```

The **sidecar** runs alongside Foundry and handles Socket.IO auth internally. The MCP server talks plain HTTP — no auth handshake, no session cookies, no internal protocol concerns. The optional MCP Bridge module supplies values prepared by Foundry's client runtime, such as derived AC, HP maximum, and spell-slot maxima; it requires an active GM browser session and communicates over a same-origin HTTPS `/mcp-bridge` long-poll route. It also performs confirmation-guarded direct HP, temporary-HP, condition, and spell-slot changes through the Foundry Actor API.

**Auth method:** a private API key (`X-API-Key` header) between Hermes and the sidecar. The GM browser bridge does not use that key.

## Documentation

This file and [`AGENTS.md`](AGENTS.md) are the entry points; everything else lives in [`docs/`](docs/):

| Doc | What it's for |
|---|---|
| [`docs/ROADMAP.md`](docs/ROADMAP.md) | Planned work, by phase |
| [`docs/FINDINGS.md`](docs/FINDINGS.md) | Live-deployment inspection data, architectural findings, and current known gaps |
| [`docs/PRIMER.md`](docs/PRIMER.md) | Developer reference: repo layout, deploy/test workflow |
| [`docs/JOURNAL-API.md`](docs/JOURNAL-API.md) | Precise contract for an external client (search/read/write journal routes, real response examples, error semantics) — for building outside this repo, not for working inside it |
| [`docs/SPEC.md`](docs/SPEC.md) | Original implementation plan — historical, not current |

[`tests/`](tests/) holds both test suites: automated tests (`npm test`) and natural-language agent-behavior scenarios (`tests/scenarios/`), with `tests/README.md` explaining how to run each.

## Quick Start

```bash
npm install
npm run build
npm start
```

### MCP client configuration

```yaml
# Configure these environment values in your MCP client.
mcp_servers:
  foundryvtt:
    command: "node"
    args: ["~/.hermes/mcp-servers/foundryvtt/dist/index.js"]
    env:
      FOUNDRY_URL: "http://foundry-sidecar-host:30001"
      FOUNDRY_API_KEY: "<private-sidecar-api-key>"
      FOUNDRY_WRITE_ENABLED: "true"
    connect_timeout: 30
```

## Tools (48 total)

### Read and service (27 tools)

| Tool | Description |
|---|---|
| `ping` | Confirm server availability |
| `world_summary` | Actor/scene/item/combat/user counts |
| `system_info` | Foundry/system versions, active modules, and prepared-bridge GM responders |
| `search_actors` | Search actors by name + optional type filter |
| `get_actor` | Raw, unprepared actor data for debugging; embedded Items are opt-in |
| `get_5e_actor_summary` | Concise raw 5e snapshot; derived fields may require Foundry UI confirmation |
| `get_prepared_5e_actor_summary` | Prepared 5e values from an active GM Foundry client |
| `get_prepared_party_overview` | Prepared HP, AC, conditions, and spell slots for all character actors |
| `list_actor_items` | Paginated embedded Item list, filterable by name, type, and 2014/2024 source |
| `list_item_activities` | Paginated embedded Activity list, filterable by Item, name, type, and rules source |
| `get_item_activity` | Discovery-only inspection of one activity's targeting, consumption, rolls, and effects; never executes it |
| `validate_5e_actor` | Report document shape and rules mix; not a combat-readiness check |
| `search_items` | Search world-level items by name + optional type filter |
| `get_item` | Full world-level Item document |
| `get_scenes` | All scenes with activation status |
| `get_scene_tokens` | Tokens on a scene (positions, actors, disposition, vision) |
| `get_combat_state` | Active combat: round, turn, sorted combatants, initiative |
| `get_chat_log` | Recent chat messages, optional speaker filter |
| `search_journal` | Search journal entries by name, page content, type, tag, and folder; returns snippets and per-page hits |
| `get_journal_entry` | Journal entry with all page content, classified type, and per-page content hashes |
| `list_journal_folders` | Journal folders, for filtering `search_journal` |
| `audit_journal_visibility` | Verify the sidecar's journal permission filtering agrees exactly with Foundry's own `testUserPermission`; requires an active GM bridge |
| `list_players` | Non-GM users and the character names they own — stable references for the player-scoped tools below |
| `search_player_knowledge` | Search the journal strictly as one named player would see it in Foundry; an empty result never implies the subject doesn't exist |
| `get_player_journal_entry` | One journal entry as one named player would see it; unreadable entries and hidden pages report as not found, identically to a nonexistent id |
| `preview_obsidian_import` | Dry-run report of `scripts/import-obsidian.mjs` over a vault: what would change, what's downgraded to GM-only and why. Read-only — applying an import requires running the script directly |
| `get_users` | All users with roles and online status |
| `refresh_world` | Verify sidecar connectivity |

### Dice (1 tool)

| Tool | Description |
|---|---|
| `roll_dice` | Any formula: `1d20+5`, `4d6kh3`, `d%`, `adv`, `dis` |

### Previews (7 read-only tools)

| Tool | Description |
|---|---|
| `preview_hp_change` | Calculate direct damage/healing through the GM bridge and return a short-lived confirmation token; does not change Foundry |
| `preview_temporary_hp` | Preview replacing temporary HP with an exact value through the GM bridge and return a short-lived confirmation token; does not change Foundry |
| `preview_condition_change` | Preview adding or removing one standard condition through the GM bridge; exhaustion is intentionally excluded |
| `preview_spell_slot_adjustment` | Preview exact spell-slot values through the GM bridge; returns a short-lived confirmation token. Administrative counter adjustment — does not cast spells. Supports pact magic, character actors only |
| `preview_item_activity_use` | Read-only eligibility check for one exact, unambiguous embedded dnd5e utility activity with no external target; returns a short-lived confirmation token |
| `preview_journal_write` | Preview creating a journal entry, or adding/updating one page, with a required, explicit visibility (`gm`/`party`/`players:[...]`); returns the resolved audience by name and a short-lived confirmation token |
| `preview_link_actor_journal` | Preview linking an actor to a journal entry (not the biography field); reads current link flags from the world snapshot — no GM bridge required |

### Write (12 tools, gated by `FOUNDRY_WRITE_ENABLED`)

| Tool | Description |
|---|---|
| `execute_item_activity_use` | Execute exactly one previewed dnd5e utility activity through the GM bridge; dnd5e controls consumption, effects, and chat output |
| `set_temporary_hp` | Replace an actor's temporary HP with a previewed exact value through the GM bridge; use 0 to clear it |
| `apply_hp_change` | Apply an exactly matching, previewed direct HP damage/healing change through dnd5e's `Actor.applyDamage` |
| `apply_spell_slot_adjustment` | Apply an exactly matching, previewed spell-slot adjustment through the GM bridge. Stale-state protected — rejects if slots changed since preview |
| `apply_condition_change` | Apply an exactly previewed standard-condition change through the GM bridge |
| `apply_journal_write` | Apply an exactly previewed journal write through the GM bridge; the receipt names every player who can see the result, read back from the written document |
| `apply_link_actor_journal` | Apply an exactly previewed actor-journal link through the GM bridge; sets bidirectional flags on both documents and reads them back as the receipt |
| `update_actor` | Patch actor system attributes (`system.hp.value`, `system.currency.gp`, etc.) |
| `create_actor` | Create a minimal actor; use Plutonium for complete 5e characters and creatures |
| `delete_actor` | Delete an actor by ID |
| `next_turn` | Advance combat through the sidecar's current internal combat operation |
| `create_chat_message` | Post to Foundry chat |

## Sidecar

The sidecar is a small Node.js Express server that runs in Docker alongside Foundry. It:

1. Authenticates with Foundry via the proven 4-step Socket.IO flow (using `extraHeaders: {Cookie}` — **not** `query: {session}`, which Foundry v14 rejects)
2. Exposes REST endpoints that proxy to Foundry's Socket.IO protocol
3. Auto-restarts on failure (Docker `restart: unless-stopped`)

**Deployment components:**
- `sidecar/` — Dockerized sidecar server
- `module/` — active-GM prepared-data bridge module
- `traefik/foundry-mcp-bridge.yml` — an optional Traefik example for the same-origin bridge route

Any reverse proxy may be used. It must route the Foundry origin's `/mcp-bridge` path to the sidecar while preserving the browser's Foundry session cookie.

**Environment:**
```
FOUNDRY_URL=http://foundry:30000   # Docker service name
FOUNDRY_USERNAME=<foundry-service-account-name>
FOUNDRY_PASSWORD=<private-foundry-account-password>
PORT=30001
API_KEY=<private-sidecar-api-key>
FOUNDRY_WRITE_ENABLED=true             # Must be set here as well as in the MCP client to enable mutations
PLAYER_API_KEY=<private-player-scoped-api-key>   # Optional. Reaches only /api/mcp/players/* — never GM routes, never writes
```

## Endpoints (sidecar)

| Method | Path | Description |
|---|---|---|
| GET | `/api/mcp/refresh` | Health check |
| POST | `/api/mcp/refresh` | Verify and refresh the current world snapshot |
| GET | `/api/mcp/write-status` | Cheap publish preflight for an external client — writeEnabled, Foundry connectivity, and GM-bridge availability, with no outbound call to Foundry |
| GET | `/api/mcp/world-summary` | Counts |
| GET | `/api/mcp/system-info` | Foundry/system metadata, active modules, and prepared-bridge responders |
| GET | `/api/mcp/actors` | Search actors |
| GET | `/api/mcp/actors/:id` | Raw actor without embedded Items by default (`?includeItems=true` for debugging) |
| GET | `/api/mcp/actors/:id/5e-summary` | Concise D&D 5e actor summary |
| GET | `/api/mcp/actors/:id/prepared` | Prepared D&D 5e actor summary; requires an active GM client with the bridge module |
| GET | `/api/mcp/party/prepared` | Prepared concise overview of all character actors; requires an active GM client |
| POST | `/api/mcp/actors/:id/hp-change/preview` | Read-only direct HP damage/healing preview; returns one-time confirmation token |
| POST | `/api/mcp/actors/:id/hp-change` | Apply an exactly matching, previewed direct HP change through the active GM client |
| POST | `/api/mcp/actors/:id/temporary-hp/preview` | Read-only exact temporary-HP replacement preview; returns one-time confirmation token |
| POST | `/api/mcp/actors/:id/temporary-hp` | Apply an exactly matching, previewed temporary-HP replacement through the active GM client |
| POST | `/api/mcp/actors/:id/conditions/preview` | Read-only standard-condition change preview; returns one-time confirmation token |
| POST | `/api/mcp/actors/:id/conditions` | Apply an exactly matching, previewed standard-condition change through the active GM client |
| POST | `/api/mcp/actors/:id/spell-slots/preview` | Read-only exact spell-slot adjustment preview; returns one-time confirmation token; character actors only |
| POST | `/api/mcp/actors/:id/spell-slots` | Apply an exactly matching, previewed spell-slot adjustment through the active GM client; stale-state protected |
| POST | `/api/mcp/actors/:id/items/:itemId/activities/:activityId/use/preview` | Validate one exact unambiguous dnd5e utility activity and issue a one-time confirmation token |
| POST | `/api/mcp/actors/:id/items/:itemId/activities/:activityId/use` | Execute an exactly matching previewed dnd5e utility activity through the active GM client |
| POST | `/api/mcp/actors/:id/link-journal/preview` | Read-only actor-journal link preview; reads current link flags from the world snapshot (no GM bridge needed); issues a one-time confirmation token |
| POST | `/api/mcp/actors/:id/link-journal` | Apply an exactly matching, previewed actor-journal link through the active GM client; sets bidirectional flags on both documents |
| GET | `/api/mcp/actors/:id/items` | Paginated embedded Item list |
| GET | `/api/mcp/actors/:id/activities` | Paginated embedded Activity list |
| GET | `/api/mcp/actors/:id/items/:itemId/activities/:activityId` | Concise discovery-only detail for one embedded Activity |
| GET | `/api/mcp/actors/:id/5e-validation` | 5e actor validation report |
| POST | `/api/mcp/actors/create` | Create a minimal actor |
| POST | `/api/mcp/actors/:id/update` | Update actor system |
| POST | `/api/mcp/actors/:id/delete` | Delete an actor |
| GET | `/api/mcp/items` | Search items |
| GET | `/api/mcp/items/:id` | One item |
| GET | `/api/mcp/scenes` | All scenes |
| GET | `/api/mcp/scenes/:id/tokens` | Scene tokens |
| GET | `/api/mcp/combats/active` | Active combat |
| POST | `/api/mcp/combats/next-turn` | Advance turn |
| GET | `/api/mcp/chat-log` | Chat messages |
| POST | `/api/mcp/chat` | Post message |
| GET | `/api/mcp/journal` | Search journal (name, page content, type, tag, folder); each result includes a `visibility` block naming which non-GM users can see it |
| GET | `/api/mcp/journal/:id` | One entry, all pages, with content hashes and per-page `visibility` |
| GET | `/api/mcp/journal/folders` | Journal folder tree |
| POST | `/api/mcp/journal/visibility-audit` | Diff the sidecar's permission computation against Foundry's own `testUserPermission`, via the active GM bridge; `ok:false` on any disagreement |
| POST | `/api/mcp/journal/write/preview` | Read-only journal write preview; resolves `visibility` to a Foundry ownership map and returns the audience by name plus a one-time confirmation token |
| POST | `/api/mcp/journal/write` | Apply an exactly matching, previewed journal write (create entry / add page / update page) through the active GM client; requires `FOUNDRY_WRITE_ENABLED=true` |
| GET | `/api/mcp/players` | Non-GM users and the character names they own — accepts `API_KEY` or `PLAYER_API_KEY` |
| GET | `/api/mcp/players/index-feed` | Every journal page visible to at least one non-GM user, with a content hash and its visible-user-id set; full enumeration, not a delta feed — accepts `API_KEY` or `PLAYER_API_KEY` |
| GET | `/api/mcp/players/:userRef/journal` | Journal search filtered to exactly what `:userRef` (a user id, user name, or owned character name) can see in Foundry — accepts `API_KEY` or `PLAYER_API_KEY` |
| GET | `/api/mcp/players/:userRef/journal/:entryId` | One entry as `:userRef` would see it; unreadable or entirely-hidden entries 404 identically to a nonexistent id — accepts `API_KEY` or `PLAYER_API_KEY` |
| GET | `/api/mcp/users` | All users |

`/mcp-bridge` is an internal browser-to-sidecar transport, not a general MCP API. A GM browser pairs by presenting its existing Foundry session cookie; the sidecar validates that session and issues an in-memory, per-client token that expires when the bridge goes idle. No shared API key is shipped in the module. The separate sidecar API key must be supplied privately through environment configuration and must never be committed.

## Obsidian import

`scripts/import-obsidian.mjs` migrates an Obsidian vault into Foundry journal entries, driving the same gated `preview`/`write` routes as `preview_journal_write`/`apply_journal_write` — there is no second write mechanism.

**Everything defaults to GM-only.** A note becomes player-visible only if its frontmatter explicitly requests it *and* the command line opts into that profile — the note is downgraded, never upgraded, on any ambiguity:

```yaml
---
type: person              # -> knowledge.type
tags: [noble, ravencroft]  # -> knowledge.tags
foundry-visibility: party  # gm (default) | party | players
foundry-visibility-players: Alice, Bob   # required when foundry-visibility: players
aliases: [Firstname, Lastname] # for wikilink resolution
---
```

A GM-only section — either an Obsidian callout whose type or title matches (`> [!warning]- DM Only` is the confirmed convention; configurable via `--secret-marker`) or a heading literally titled to match (e.g. `## DM Notes`) — is automatically split into its own GM-only page. This isn't optional: a single Foundry page can't hold two ownership levels.

```bash
# Dry run — the default. Nothing is written.
npm run import:obsidian -- /path/to/vault

# Same, machine-readable (also what preview_obsidian_import uses internally)
npm run import:obsidian -- /path/to/vault --json

# Actually write. Requires typing the exact count of newly player-visible
# notes to proceed.
API_KEY=<private-sidecar-api-key> FOUNDRY_SIDECAR_URL=http://foundry-sidecar-host:30001 \
  npm run import:obsidian -- /path/to/vault --apply --allow-visibility party,players

# Re-verify a prior import's ownership still matches the manifest
npm run import:obsidian -- /path/to/vault --verify
```

Idempotent: a `<vault-parent>/obsidian-import-manifest.json` (never inside this repo) tracks each note's resolved entry/page ids, content hash, and visibility. Unchanged notes are skipped; changed content becomes an `update-page`; a **changed visibility is reported and refused** unless `--allow-visibility-change` is also passed — a visibility change on re-import is exactly the accident that would publish the campaign bible. `--limit N` and `--only <pattern>` scope a first run to a handful of notes before running the whole vault. Wikilinks (`[[Foo]]`, `[[Foo|bar]]`) resolve to `@UUID[...]` enrichers once their target has been imported; unresolved or ambiguous links are left literal and reported, never guessed.

The `preview_obsidian_import` MCP tool runs the same dry run and returns the same report conversationally — it has no `--apply` equivalent and cannot write; applying an import is a human running the script directly.

## Deploy and verify a Foundry host

The deployment scripts copy only the checked-in sidecar and bridge-module files. They back up every replaced remote file with a timestamp, validate Docker Compose, rebuild only `foundry-sidecar`, and never print credentials. Set the deployment paths for your host first:

```bash
export FOUNDRY_DEPLOY_TARGET="user@foundry-host"
export FOUNDRY_COMPOSE_DIR="/path/to/compose-directory"
export FOUNDRY_SIDECAR_DIR="/path/to/sidecar-directory"
export FOUNDRY_MODULE_DIR="/path/to/foundry/Data/modules/foundry-mcp-bridge"

# Optional: copy the included Traefik example. Omit for another reverse proxy.
export FOUNDRY_PROXY_CONFIG_DIR="/path/to/traefik/dynamic-config"
```

```bash
# Sidecar health and Foundry connection only; safe before a GM refresh.
npm run deploy:foundry

# After hard-refreshing Foundry in an active GM browser session.
npm run smoke:foundry -- --require-bridge

# Also verify the journal permission model still agrees with Foundry's own
# testUserPermission — worth running after any Foundry/dnd5e upgrade.
npm run smoke:foundry -- --audit-journal-visibility
```

The smoke script uses the sidecar container's private API key internally, reports Foundry/system versions plus responder count, and does not mutate world data.

## Foundry v14 Notes

- **Session cookies must use `extraHeaders: {Cookie}`** — not `query: {session}`. Foundry v14 rejects query-param sessions (the standard `foundryvtt-mcp` npm package gets this wrong).
- **`modifyDocument` requires `broadcast: true`** and `userId` fields in the request.
- **Combat `turn`** is an index into Foundry's computed sort order, not the cached combatants array. The current `next_turn` endpoint remains an internal update and should be replaced by a rule-aware execution path before stable release.
- **`world` and `modifyDocument`** are internal Socket.IO protocols — point releases may alter payloads.
- **Array fields in document updates** are replaced wholesale, not merged.

## Maintenance

When Foundry updates:
1. The sidecar may need auth flow adjustments (isolated in `connect()`)
2. The MCP server usually needs no changes (it just talks HTTP)
3. If `modifyDocument` payload shape changes, update the `POST` handlers in the sidecar

## Foundry Module Releases

The bridge module has a Foundry-compatible manifest and can be installed or updated from:

`https://github.com/Hybridenishi/foundryvtt-mcp/releases/latest/download/module.json`

Create its release asset after validating the build:

```bash
npm run package:module
gh release create v1.7.0 release/foundry-mcp-bridge.zip module/module.json \
  --title "MCP Bridge v1.7.0" --notes "Prepared party overview, safe standard-condition changes, server-side write gating, typed damage, and spell-slot adjustment."
```

The ZIP contains `module.json` and `scripts/` at its root, as required by Foundry's module installer.
