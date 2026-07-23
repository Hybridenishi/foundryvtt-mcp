# Foundry MCP — Developer Primer

## Architecture

```
Hermes → MCP Server (TS/stdio) → HTTP → Sidecar (Express:30001) → Socket.IO → Foundry:30000
  │                                      │
  │  ~/.hermes/mcp-servers/foundryvtt/   │  Docker on Atomsk
  │  TypeScript, MCP SDK                 │  Node.js Express
  └──────────────────────────────────────┘
```

Two-layer bridge:

| Layer | Location | Repo | Role |
|-------|----------|------|------|
| **MCP Server** | `~/.hermes/mcp-servers/foundryvtt/` | `github.com/Hybridenishi/foundryvtt-mcp` `src/` | TypeScript MCP server. Hermes runs it as child process over stdio. Registers tools (`search_actors`, `create_actor`, etc.) and calls the sidecar over HTTP. |
| **Sidecar** | Atomsk Docker: `foundry-sidecar` (:30001) | Same repo, `sidecar/` | Express proxy. Authenticates with Foundry via Socket.IO (4-step handshake), then exposes REST endpoints. All writes go through `socket.emit("modifyDocument", ...)`. |
| **MCP Bridge module** | Foundry data: `modules/foundry-mcp-bridge/` | Same repo, `module/` | Runs in an active GM's Foundry browser client and returns prepared, runtime-derived Actor values over a module Socket.IO channel. Read-only in the initial proof of concept. |

## Repo: `github.com/Hybridenishi/foundryvtt-mcp`

```
├── src/                    # MCP server (TypeScript)
│   ├── index.ts            # Entry point, tool registration
│   ├── client.ts           # HTTP client (axios) → sidecar
│   ├── types.ts            # Zod schemas
│   ├── logger.ts           # stderr logger
│   └── tools/
│       ├── read.ts         # search_actors, get_actor, search_items, etc.
│       ├── write.ts        # create_actor, delete_actor, update_actor, chat
│       └── dice.ts         # roll_dice (rpg-dice-roller)
├── sidecar/                # Express sidecar (plain JS)
│   ├── index.js            # Main server — modifyDocument protocol
│   ├── Dockerfile          # Node:22-alpine
│   └── package.json
├── module/                 # Foundry v14 client-side MCP Bridge module
│   ├── module.json
│   └── scripts/prepared-actor-bridge.mjs
├── SPEC.md                 # Full implementation plan
└── AGENTS.md               # Claude/AI instructions
```

**Build:** `npm install && npm run build` (outputs to `dist/`)
**Deploy MCP server:** copy `dist/` to `~/.hermes/mcp-servers/foundryvtt/dist/`
**Deploy sidecar:** copy `sidecar/index.js`, `sidecar/actor-utils.js`, and `sidecar/Dockerfile` to Atomsk, then rebuild Docker container
**Deploy MCP Bridge module:** copy `module/module.json` and `module/scripts/prepared-actor-bridge.mjs` to Atomsk's `foundry-mcp-bridge` module, then reload Foundry as an active GM

## How to Test Against Atomsk

### Quick connectivity test
```bash
# Sidecar health (both GET and POST are supported)
curl -s -H "X-API-Key: mcp-bridge-key-2026" \
  http://100.100.244.3:30001/api/mcp/refresh
# → {"ok":true,"connected":true}

# List actors
curl -s -H "X-API-Key: mcp-bridge-key-2026" \
  http://100.100.244.3:30001/api/mcp/actors
```

### Endpoints available on sidecar (:30001)

| Method | Path | Description |
|--------|------|-------------|
| GET | `/api/mcp/refresh` | Health check |
| POST | `/api/mcp/refresh` | Refresh current world snapshot |
| GET | `/api/mcp/world-summary` | Actor/scene/item counts |
| GET | `/api/mcp/system-info` | Foundry/system metadata, content rules sources, modules |
| GET | `/api/mcp/actors` | List actors (?query, ?type, ?limit) |
| GET | `/api/mcp/actors/:id` | Raw actor without Items by default (`?includeItems=true` for debugging) |
| GET | `/api/mcp/actors/:id/5e-summary` | Concise D&D 5e actor summary |
| GET | `/api/mcp/actors/:id/prepared` | Prepared D&D 5e summary; requires active GM browser bridge |
| GET | `/api/mcp/actors/:id/items` | Paginated embedded Item list |
| GET | `/api/mcp/actors/:id/activities` | Paginated embedded Activity list |
| GET | `/api/mcp/actors/:id/5e-validation` | 5e actor validation report |
| POST | `/api/mcp/actors/create` | Create actor `{name, type?, system?}` |
| POST | `/api/mcp/actors/:id/update` | Update `{system: {...}}` |
| POST | `/api/mcp/actors/:id/delete` | Delete actor |
| GET | `/api/mcp/items` | List items |
| GET | `/api/mcp/items/:id` | Single world-level item |
| GET | `/api/mcp/scenes` | List scenes |
| GET | `/api/mcp/scenes/:id/tokens` | Tokens on a scene |
| GET | `/api/mcp/combats/active` | Combat state |
| POST | `/api/mcp/combats/next-turn` | Advance combat |
| GET | `/api/mcp/chat-log` | Chat messages |
| POST | `/api/mcp/chat` | Post to chat `{content, type?}` |
| GET | `/api/mcp/journal` | Journal entries |
| GET | `/api/mcp/journal/:id` | One journal entry with pages |
| GET | `/api/mcp/users` | User list |

### Deploy sidecar changes
```bash
# 1. Edit sidecar files locally
# 2. Copy sidecar runtime files and Docker build definition to Atomsk
scp sidecar/index.js sidecar/actor-utils.js sidecar/Dockerfile root@atomsk:/mnt/user/appdata/compose/foundry-sidecar/

# 3. Rebuild + restart
ssh root@atomsk "cd /mnt/user/appdata/compose/foundry-stack && \
  docker compose build foundry-sidecar && \
  docker compose up -d foundry-sidecar"

# 4. Wait ~12s for auth, then test
sleep 12 && curl -s -H "X-API-Key: mcp-bridge-key-2026" \
  http://100.100.244.3:30001/api/mcp/refresh
```

### Deploy MCP Bridge module changes
```bash
scp module/module.json root@atomsk:/mnt/user/appdata/foundry/Data/modules/foundry-mcp-bridge/
scp module/scripts/prepared-actor-bridge.mjs root@atomsk:/mnt/user/appdata/foundry/Data/modules/foundry-mcp-bridge/scripts/
```

Reload Foundry in an active GM browser session after copying the module files. The prepared-data route times out rather than falling back to raw values when no GM bridge responds.

**Important:** The sidecar uses Docker build cache. If your changes don't seem to take effect, use `--no-cache`:
```bash
ssh root@atomsk "cd /mnt/user/appdata/compose/foundry-stack && \
  docker compose build --no-cache foundry-sidecar && \
  docker compose up -d foundry-sidecar"
```

## modifyDocument Protocol (Socket.IO)

The sidecar talks to Foundry via `socket.emit("modifyDocument", payload, callback)`. These formats were reverse-engineered from Foundry v14 source.

### Create
```js
socket.emit("modifyDocument", {
  type: "Actor",
  action: "create",
  operation: { data: [{ name, type: "npc", system: {...} }] }
}, callback);
// Data goes through _createDocuments → Actor.cleanData() → same path as Actor.create()
```

### Update
```js
socket.emit("modifyDocument", {
  type: "Actor",
  action: "update",
  operation: { updates: [{ _id, ...fields }], diff: true, recursive: true }
}, callback);
```

### Delete
```js
socket.emit("modifyDocument", {
  type: "Actor",
  action: "delete",
  operation: { ids: [actorId] }  // ← MUST be {ids: [...]}, NOT bare array, NOT {_ids: [...]}
}, callback);
```

### Chat
```js
socket.emit("modifyDocument", {
  type: "ChatMessage",
  action: "create",
  operation: { data: [{ content, type: 1, author: mcpUserId }] }
  // ↑ type must be INTEGER, author must be the mcp-api user's _id
}, callback);
```

## D&D 5e Data Model — Critical Gotchas

These were discovered the hard way (2026-07-22).

### AC formula
```json
// ✅ CORRECT — flat AC
{ "ac": { "flat": 12, "formula": "" } }

// ❌ BROKEN — text in formula field is parsed as dice math
{ "ac": { "flat": 12, "formula": "leather" } }
// → "Unresolved StringTerm leather requested for evaluation"
```

The formula is evaluated by D&D 5e's dice roller. Empty string = use flat value. Valid formulas look like `"1d8+2"` or `"@abilities.dex.mod + @attributes.ac.armor"`.

### Skills
```json
// ❌ BROKEN — bare values confuse the sheet
{ "skills": { "prc": { "value": 1 } } }

// ✅ CORRECT — create without skills, add later via items/features
// or use full structure with ability, value, total, passive
```

### Ability scores
```json
// ✅ NPC abilities — just value (mod/save are computed)
{ "str": { "value": 14 } }
```

### NPC minimal creation payload
```json
{
  "name": "Name",
  "type": "npc",
  "system": {
    "attributes": {
      "hp": { "value": 5, "max": 5 },
      "ac": { "flat": 10, "formula": "" }
    },
    "abilities": {
      "str": { "value": 10 }, "dex": { "value": 10 },
      "con": { "value": 10 }, "int": { "value": 10 },
      "wis": { "value": 10 }, "cha": { "value": 10 }
    },
    "details": {
      "race": "Human",
      "cr": 0,
      "type": { "value": "humanoid" }
    }
  }
}
```

### Full Roll Formula Reference
See: https://github.com/foundryvtt/dnd5e/wiki/Roll-Formulas

Key paths: `@abilities.str.mod`, `@attributes.hp.value`, `@details.level`, `@prof`, `@currency.gp`, `@scale.*.**`

## Plutonium

Installed at `/mnt/user/appdata/foundry/Data/modules/plutonium` but **not activated** in the Azora world. Integrates with 5e.tools dataset for importing properly-structured monsters, items, spells, etc.

If activated, it provides a massive library of correct D&D 5e data — the best source for creating NPCs with proper system data. Import via Foundry UI or programmatically.

Docs: https://wiki.tercept.net/en/Plutonium

## Test Script Pattern

```bash
#!/bin/bash
# Quick create → verify → delete cycle

API="http://100.100.244.3:30001"
KEY="X-API-Key: mcp-bridge-key-2026"

# Create
RESULT=$(curl -s -H "$KEY" -H "Content-Type: application/json" \
  -X POST "$API/api/mcp/actors/create" \
  -d '{"name":"Test NPC","type":"npc"}')
ACTOR_ID=$(echo "$RESULT" | python3 -c "import json,sys; print(json.load(sys.stdin)['result']['result'][0]['_id'])")
echo "Created: $ACTOR_ID"

# Verify in list
curl -s -H "$KEY" "$API/api/mcp/actors" | python3 -c "import json,sys; actors=json.load(sys.stdin); print(f'Found' if any(a['_id']=='$ACTOR_ID' for a in actors) else 'MISSING')"

# Clean up
curl -s -H "$KEY" -X POST "$API/api/mcp/actors/$ACTOR_ID/delete" > /dev/null
echo "Deleted"
```
