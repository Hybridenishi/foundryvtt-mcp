# Foundry VTT MCP Server

Personal MCP server connecting [Hermes Agent](https://github.com/NousResearch/hermes-agent) to Foundry VTT v14. Built for personal use — tracks our live Foundry version.

## Architecture

```
Hermes → MCP Server (stdio) → Sidecar (REST :30001) → Foundry (Socket.IO :30000)
```

The **sidecar** runs alongside Foundry on Atomsk and handles Socket.IO auth internally. The MCP server talks plain HTTP — no auth handshake, no session cookies, no internal protocol concerns.

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

## Tools (24 total)

### Read (12 tools)

| Tool | Description |
|---|---|
| `ping` | Confirm server availability |
| `world_summary` | Actor/scene/item/combat/user counts |
| `system_info` | Foundry version, world info, active modules |
| `search_actors` | Search actors by name + optional type filter |
| `get_actor` | Full actor document with derived stats (AC, HP, saves, skills) |
| `search_items` | Search items by name + optional type filter |
| `get_item` | Full item document |
| `get_scenes` | All scenes with activation status |
| `get_scene_tokens` | Tokens on a scene (positions, actors, disposition, vision) |
| `get_combat_state` | Active combat: round, turn, sorted combatants, initiative |
| `get_chat_log` | Recent chat messages, optional speaker filter |
| `search_journal` | Full-text search journal entries by name + content |
| `get_journal_entry` | Journal entry with all page content |
| `get_users` | All users with roles and online status |
| `list_compendiums` | All compendium packs with document counts |
| `search_compendium` | Search a pack by name (e.g., `dnd5e.monsters?query=dragon`) |
| `list_macros` | All macros with execution permissions |
| `execute_macro` | Execute a macro by ID |
| `refresh_world` | Verify sidecar connectivity |

### Dice (1 tool)

| Tool | Description |
|---|---|
| `roll_dice` | Any formula: `1d20+5`, `4d6kh3`, `d%`, `adv`, `dis` |

### Write (4 tools, gated by `FOUNDRY_WRITE_ENABLED`)

| Tool | Description |
|---|---|
| `update_actor` | Patch actor system attributes (`system.hp.value`, `system.currency.gp`, etc.) |
| `set_initiative` | Set a combatant's initiative |
| `next_turn` | Advance combat (fires hooks, effects, sounds — uses `combat.nextTurn()`) |
| `create_chat_message` | Post to Foundry chat |

## Sidecar

The sidecar is a small Node.js Express server that runs in Docker alongside Foundry. It:

1. Authenticates with Foundry via the proven 4-step Socket.IO flow (using `extraHeaders: {Cookie}` — **not** `query: {session}`, which Foundry v14 rejects)
2. Exposes REST endpoints that proxy to Foundry's Socket.IO protocol
3. Auto-restarts on failure (Docker `restart: unless-stopped`)

**Key files on Atomsk:**
- `/mnt/user/appdata/compose/foundry-sidecar/index.js` — sidecar code
- `/mnt/user/appdata/compose/foundry-stack/docker-compose.yml` — compose config

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
| GET | `/api/mcp/world-summary` | Counts |
| GET | `/api/mcp/system-info` | Version, modules |
| GET | `/api/mcp/actors` | Search actors |
| GET | `/api/mcp/actors/:id` | One actor |
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
| GET | `/api/mcp/macros` | All macros |
| POST | `/api/mcp/macros/:id/execute` | Execute macro |

## Foundry v14 Notes

- **Session cookies must use `extraHeaders: {Cookie}`** — not `query: {session}`. Foundry v14 rejects query-param sessions (the standard `foundryvtt-mcp` npm package gets this wrong).
- **`modifyDocument` requires `broadcast: true`** and `userId` fields in the request.
- **Combat `turn`** is an index into Foundry's computed sort order, not the cached combatants array.
- **`world` and `modifyDocument`** are internal Socket.IO protocols — point releases may alter payloads.
- **Array fields in document updates** are replaced wholesale, not merged.

## Maintenance

When Foundry updates:
1. The sidecar may need auth flow adjustments (isolated in `connect()`)
2. The MCP server usually needs no changes (it just talks HTTP)
3. If `modifyDocument` payload shape changes, update the `POST` handlers in the sidecar
