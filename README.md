# Foundry VTT MCP Server

Personal MCP server connecting [Hermes Agent](https://github.com/NousResearch/hermes-agent) to Foundry VTT v14. Built for personal use — tracks our live Foundry version.

## Architecture

```
Hermes → MCP Server (stdio) → Sidecar (REST :30001) → Foundry (Socket.IO :30000)
                                               ↕
                    Traefik /mcp-bridge ↔ MCP Bridge module (active GM client)
```

The **sidecar** runs alongside Foundry on Atomsk and handles Socket.IO auth internally. The MCP server talks plain HTTP — no auth handshake, no session cookies, no internal protocol concerns. The optional MCP Bridge module supplies values prepared by Foundry's client runtime, such as derived AC, HP maximum, and spell-slot maxima; it requires an active GM browser session and communicates over a same-origin HTTPS `/mcp-bridge` long-poll route.

**Auth method:** API key (`X-API-Key` header, shared secret between MCP server and sidecar).

## Quick Start

```bash
npm install
npm run build
npm start
```

### Hermes Config

```yaml
# ~/.hermes/config.yaml
mcp_servers:
  foundryvtt:
    command: "node"
    args: ["~/.hermes/mcp-servers/foundryvtt/dist/index.js"]
    env:
      FOUNDRY_URL: "http://100.100.244.3:30001"
      FOUNDRY_API_KEY: "mcp-bridge-key-2026"
      FOUNDRY_WRITE_ENABLED: "true"
    connect_timeout: 30
```

## Tools (26 total)

### Read and service (20 tools)

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

### Write (5 tools, gated by `FOUNDRY_WRITE_ENABLED`)

| Tool | Description |
|---|---|
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

**Key files on Atomsk:**
- `/mnt/user/appdata/compose/foundry-sidecar/index.js` — sidecar server
- `/mnt/user/appdata/compose/foundry-sidecar/actor-utils.js` — 5e actor summaries, listings, and validation
- `/mnt/user/appdata/compose/foundry-sidecar/Dockerfile` — sidecar image definition
- `/mnt/user/appdata/compose/foundry-stack/docker-compose.yml` — compose config
- `/mnt/user/appdata/foundry/Data/modules/foundry-mcp-bridge/` — active-GM prepared-data bridge module
- `/mnt/user/appdata/traefik/config/dynamic/foundry-mcp-bridge.yml` — same-origin HTTPS route from Foundry to the sidecar

**Environment:**
```
FOUNDRY_URL=http://foundry:30000   # Docker service name
FOUNDRY_USERNAME=mcp-api
FOUNDRY_PASSWORD=password-for-hermes
PORT=30001
API_KEY=mcp-bridge-key-2026
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

`/mcp-bridge` is an internal browser-to-sidecar transport, not a general MCP API. Its current key is explicitly a disposable test credential and must not ship in a public release.
| GET | `/api/mcp/actors/:id/items` | Paginated embedded Item list |
| GET | `/api/mcp/actors/:id/activities` | Paginated embedded Activity list |
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
