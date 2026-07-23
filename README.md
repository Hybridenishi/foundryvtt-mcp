# Foundry VTT MCP Server

Focused MCP server connecting an MCP-compatible agent to Foundry VTT v14 and D&D 5e.

## Architecture

```
Hermes → MCP Server (stdio) → Sidecar (REST :30001) → Foundry (Socket.IO :30000)
                                               ↕
              Same-origin reverse proxy /mcp-bridge ↔ MCP Bridge module (active GM client)
```

The **sidecar** runs alongside Foundry and handles Socket.IO auth internally. The MCP server talks plain HTTP — no auth handshake, no session cookies, no internal protocol concerns. The optional MCP Bridge module supplies values prepared by Foundry's client runtime, such as derived AC, HP maximum, and spell-slot maxima; it requires an active GM browser session and communicates over a same-origin HTTPS `/mcp-bridge` long-poll route. It also performs confirmation-guarded direct HP changes through the dnd5e Actor API.

**Auth method:** a private API key (`X-API-Key` header) between Hermes and the sidecar. The GM browser bridge does not use that key.

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

## Tools (29 total)

### Read and service (21 tools)

| Tool | Description |
|---|---|
| `ping` | Confirm server availability |
| `world_summary` | Actor/scene/item/combat/user counts |
| `system_info` | Foundry/system versions, active modules, and prepared-bridge GM responders |
| `search_actors` | Search actors by name + optional type filter |
| `get_actor` | Raw, unprepared actor data for debugging; embedded Items are opt-in |
| `get_5e_actor_summary` | Concise raw 5e snapshot; derived fields may require Foundry UI confirmation |
| `get_prepared_5e_actor_summary` | Prepared 5e values from an active GM Foundry client |
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
| `search_journal` | Full-text search journal entries by name + content |
| `get_journal_entry` | Journal entry with all page content |
| `get_users` | All users with roles and online status |
| `refresh_world` | Verify sidecar connectivity |

### Dice (1 tool)

| Tool | Description |
|---|---|
| `roll_dice` | Any formula: `1d20+5`, `4d6kh3`, `d%`, `adv`, `dis` |

### HP preview (1 read-only tool)

| Tool | Description |
|---|---|
| `preview_hp_change` | Calculate direct damage/healing through the GM bridge and return a short-lived confirmation token; does not change Foundry |

### Write (6 tools, gated by `FOUNDRY_WRITE_ENABLED`)

| Tool | Description |
|---|---|
| `update_actor` | Patch actor system attributes (`system.hp.value`, `system.currency.gp`, etc.) |
| `create_actor` | Create a minimal actor; use Plutonium for complete 5e characters and creatures |
| `delete_actor` | Delete an actor by ID |
| `next_turn` | Advance combat through the sidecar's current internal combat operation |
| `create_chat_message` | Post to Foundry chat |
| `apply_hp_change` | Apply an exactly matching, previewed direct HP damage/healing change through dnd5e's `Actor.applyDamage` |

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
```

## Endpoints (sidecar)

| Method | Path | Description |
|---|---|---|
| GET | `/api/mcp/refresh` | Health check |
| POST | `/api/mcp/refresh` | Verify and refresh the current world snapshot |
| GET | `/api/mcp/world-summary` | Counts |
| GET | `/api/mcp/system-info` | Foundry/system metadata, active modules, and prepared-bridge responders |
| GET | `/api/mcp/actors` | Search actors |
| GET | `/api/mcp/actors/:id` | Raw actor without embedded Items by default (`?includeItems=true` for debugging) |
| GET | `/api/mcp/actors/:id/5e-summary` | Concise D&D 5e actor summary |
| GET | `/api/mcp/actors/:id/prepared` | Prepared D&D 5e actor summary; requires an active GM client with the bridge module |
| POST | `/api/mcp/actors/:id/hp-change/preview` | Read-only direct HP damage/healing preview; returns one-time confirmation token |
| POST | `/api/mcp/actors/:id/hp-change` | Apply an exactly matching, previewed direct HP change through the active GM client |

`/mcp-bridge` is an internal browser-to-sidecar transport, not a general MCP API. A GM browser pairs by presenting its existing Foundry session cookie; the sidecar validates that session and issues an in-memory, per-client token that expires when the bridge goes idle. No shared API key is shipped in the module. The separate sidecar API key must be supplied privately through environment configuration and must never be committed.
| GET | `/api/mcp/actors/:id/items` | Paginated embedded Item list |
| GET | `/api/mcp/actors/:id/activities` | Paginated embedded Activity list |
| GET | `/api/mcp/actors/:id/items/:itemId/activities/:activityId` | Concise discovery-only detail for one embedded Activity |
| GET | `/api/mcp/actors/:id/5e-validation` | 5e actor validation report |
| POST | `/api/mcp/actors/:id/update` | Update actor system |
| GET | `/api/mcp/items` | Search items |
| GET | `/api/mcp/items/:id` | One item |
| GET | `/api/mcp/scenes` | All scenes |
| GET | `/api/mcp/scenes/:id/tokens` | Scene tokens |
| GET | `/api/mcp/combats/active` | Active combat |
| POST | `/api/mcp/combats/next-turn` | Advance turn |
| GET | `/api/mcp/chat-log` | Chat messages |
| POST | `/api/mcp/chat` | Post message |
| GET | `/api/mcp/journal` | Search journal |
| GET | `/api/mcp/journal/:id` | One entry |
| GET | `/api/mcp/users` | All users |

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
gh release create v1.5.0 release/foundry-mcp-bridge.zip module/module.json \
  --title "MCP Bridge v1.5.0" --notes "Activity discovery for embedded D&D 5e activities, plus GM-session pairing and confirmation-guarded direct HP changes."
```

The ZIP contains `module.json` and `scripts/` at its root, as required by Foundry's module installer.
