# Foundry VTT MCP Server — Custom Build Spec

> **Goal:** Build a minimal, personal MCP server that lets Hermes interact with Foundry VTT v14 over Socket.IO. No distribution ambitions — tracks our live Foundry version and implements only the tools we use.

**Architecture:** Node.js MCP server (stdio transport powered by `@modelcontextprotocol/sdk`) that authenticates with Foundry v14 via a proven 4-step Socket.IO flow, loads world data into memory, and exposes a focused set of read/write/dice tools.

**Tech Stack:** Node.js ≥20, `@modelcontextprotocol/sdk`, `socket.io-client`, `axios`, `zod` (validation)

---

## Auth Flow (Proven Against Foundry v14, July 22 2026)

The standard `foundryvtt-mcp` npm package uses `query: {session}` to pass the session cookie to Socket.IO. **Foundry v14 requires `extraHeaders: {Cookie: 'session=xxx'}` instead.** This is the critical difference.

### 4-Step Flow

```
1. GET /join → session cookie (302 or 200 with Set-Cookie)
2. Socket.IO connect + Cookie header → 'session' event fires → emit 'getJoinData' → resolve user _id
3. POST /join with {action:'join', userid, password} + Cookie → authenticated
4. Socket.IO reconnect + Cookie → 'session' event now has userId → emit 'world' → receive full world data
```

### Step 2 Detail (user resolution)

```js
const session = await getSessionCookie(baseUrl);       // step 1
const socket = io(baseUrl, {
  transports: ['websocket'],
  extraHeaders: { Cookie: `session=${session}` },       // ← CRITICAL: not query: {session}
});

socket.on('session', () => {
  socket.emit('getJoinData', (data) => {
    const user = data.users.find(u => u.name === username);
    // user._id → use for step 3
  });
});
```

### Step 4 Detail (world data load)

```js
// After step 3 succeeds (POST /join returns status:'success')
const socket = io(baseUrl, {
  transports: ['websocket'],
  extraHeaders: { Cookie: `session=${session}` },
});

socket.on('session', (data) => {
  // data.userId is now populated (was null in step 2)
  socket.emit('world', (worldData) => {
    // worldData = { actors: [...], scenes: [...], items: [...], journal: [...],
    //               messages: [...], combats: [...], users: [...], folders: [...] }
  });
});
```

---

## MCP Server Shape

### Stdio Transport

The server runs as a child process of Hermes, communicating over stdin/stdout:

```yaml
# ~/.hermes/config.yaml
mcp_servers:
  foundryvtt:
    command: "node"
    args: ["~/.hermes/mcp-servers/foundryvtt/dist/index.js"]
    env:
      FOUNDRY_URL: "http://100.100.244.3:30000"
      FOUNDRY_USERNAME: "mcp-api"
      FOUNDRY_PASSWORD: "password-for-hermes"
      FOUNDRY_WRITE_ENABLED: "true"
    connect_timeout: 60
```

### Tool Naming Convention

All tools prefixed `mcp_foundryvtt_` → Hermes auto-prefixes with server name:
- `search_actors` → `mcp_foundryvtt_search_actors`
- `roll_dice` → `mcp_foundryvtt_roll_dice`

---

## Tool List

### Read Tools (always available)

| Tool | Description | Parameters |
|---|---|---|
| `search_actors` | Search actors by name/type | `query?`, `type?`, `limit?` (default 20) |
| `get_actor` | Get one actor by ID with full system data | `actor_id` |
| `search_items` | Search items by name/type | `query?`, `type?`, `limit?` |
| `get_scenes` | List all scenes with basic info (name, active, nav name) | — |
| `get_combat_state` | Current combat: combatants, initiative, round, active turn | `scene_id?` |
| `get_chat_log` | Recent chat messages | `limit?` (default 20), `speaker?` |
| `search_journal` | Full-text search journal entries | `query`, `limit?` |
| `get_online_users` | Which users are connected | — |
| `world_summary` | Quick stats: actor count, scene count, combat state | — |

### Dice Tools

| Tool | Description | Parameters |
|---|---|---|
| `roll_dice` | Roll any formula (d20, 4d6kh3, etc.) | `formula`, `label?` |

### Write Tools (gated behind `FOUNDRY_WRITE_ENABLED`)

| Tool | Description | Parameters |
|---|---|---|
| `update_actor` | Patch actor system attributes | `actor_id`, `patch` (e.g. `{"attributes.hp.value": 12}`) |
| `set_initiative` | Set a combatant's initiative | `combatant_id`, `value` |
| `next_turn` | Advance combat to next turn | `combat_id?` |
| `create_chat_message` | Post to chat as mcp-api user | `content`, `type?` ("ooc" or "ic") |

---

## Project Structure

```
foundryvtt-mcp/
├── package.json
├── tsconfig.json
├── src/
│   ├── index.ts              # MCP server entry point: sets up server, registers tools
│   ├── client.ts             # FoundryClient: Socket.IO connection, world data cache, auth
│   ├── auth.ts               # 4-step authentication flow
│   ├── tools/
│   │   ├── read.ts           # search_actors, get_actor, search_items, get_scenes, etc.
│   │   ├── write.ts          # update_actor, set_initiative, next_turn (gated)
│   │   └── dice.ts           # roll_dice (formula parser)
│   ├── types.ts              # Zod schemas for world data, tool params
│   └── logger.ts             # Structured logging (stderr so stdio stays clean for MCP)
├── dist/                     # Compiled output
└── README.md
```

---

## Implementation Steps

### Phase 1: Scaffold (2 tasks)

**Task 1.1 — Project init**
- `npm init`, install deps: `@modelcontextprotocol/sdk`, `socket.io-client`, `axios`, `zod`, `typescript`, `@types/node`
- Configure `tsconfig.json` (target ES2022, module NodeNext, outDir dist)
- Write `src/logger.ts` (simple stderr logger that respects `LOG_LEVEL` env)
- Verify: `npm run build` produces `dist/` with compiled JS

**Task 1.2 — Hello-world MCP server**
- Implement `src/index.ts`: minimal MCP server with one tool `ping` that returns `"pong"`
- Wire up stdio transport via `@modelcontextprotocol/sdk`
- Test: run `node dist/index.js` and verify it responds to `list_tools` and `call_tool`

### Phase 2: Auth + Connection (3 tasks)

**Task 2.1 — Auth module**
- Implement `src/auth.ts` with the 4-step flow
- Export: `authenticateFoundry(baseUrl, username, password) → {session, userId}`
- Key detail: use `extraHeaders: {Cookie}` not `query: {session}` (the Foundry v14 fix)
- Test: standalone test script that authenticates and logs success

**Task 2.2 — FoundryClient**
- Implement `src/client.ts`:
  - `connect()` → auth + load world data + cache in memory
  - `disconnect()` → clean Socket.IO shutdown
  - `getWorldData()` → return cached snapshot
  - `refreshWorldData()` → re-emit 'world' → update cache
- World data cache validated with Zod schemas from `types.ts`
- Test: connects, loads world, logs actor/scene/item counts

**Task 2.3 — Server startup wiring**
- In `src/index.ts`, on server start:
  - Read env vars (FOUNDRY_URL, FOUNDRY_USERNAME, FOUNDRY_PASSWORD, FOUNDRY_WRITE_ENABLED)
  - Create FoundryClient, call `connect()`
  - On success: register tools, log ready
  - On failure: log error, exit

### Phase 3: Core Tools (4 tasks)

**Task 3.1 — Read tools (part 1)**
- `search_actors(query?, type?, limit?)` — filter world data cache
- `get_actor(actorId)` — one actor by ID with full system data
- `search_items(query?, type?, limit?)` — filter items

**Task 3.2 — Read tools (part 2)**
- `get_scenes()` — list all scenes
- `get_combat_state(scene_id?)` — active combat info
- `get_chat_log(limit?, speaker?)` — recent messages
- `search_journal(query, limit?)` — full-text search journal
- `get_online_users()` — activeUsers array
- `world_summary()` — quick counts

**Task 3.3 — Dice tool**
- `roll_dice(formula, label?)` — parse dice notation, execute rolls
- Support: `XdY`, `+/-`, `khN`/`klN` (keep highest/lowest), `d%`, advantage shorthand
- Return: total, individual rolls, formula, optional label

**Task 3.4 — Write tools**
- `update_actor(actorId, patch)` — emit `modifyDocument` over Socket.IO
  - patch = `{"attributes.hp.value": 12, "currency.gp": 50}`
  - Validate actor exists, paths are valid in system data
- `set_initiative(combatantId, value)` — emit modifier over Socket.IO
- `next_turn(combat_id?)` — advance combat
- `create_chat_message(content, type?)` — emit chat message
- ALL gated: refuse if FOUNDRY_WRITE_ENABLED !== 'true'

### Phase 4: Polish (2 tasks)

**Task 4.1 — Error handling + reconnection**
- Socket.IO disconnect → attempt reconnect with backoff (3 retries, 1s/2s/4s)
- Tool calls when disconnected → return error, don't crash
- Auth failure → exit with clear message
- Write tool called without write enabled → clear error
- Actor/item not found → descriptive error, not generic

**Task 4.2 — README + install script**
- Document env vars, auth flow, tool list
- Install script: `npm install && npm run build`
- Hermes config snippet for mcp_servers

---

## Testing Strategy

### Unit Tests (Jest/Vitest)
- Dice formula parser: test edge cases (4d6kh3, 1d20+5, d%, 2d20kh1)
- Actor/item search filters: test query matching, type filtering, limit
- Zod schema validation: valid world data passes, malformed data caught

### Integration Test
- Standalone script that connects to real Foundry, authenticates, loads world, searches actors
- Run with test env vars pointing to Foundry

---

## Risks & Decisions

| Risk | Mitigation |
|---|---|
| Foundry v15 changes Socket.IO protocol again | Auth module is isolated; swap auth.ts if needed |
| World data grows too large for memory cache | Add limits to search filters; page large result sets |
| MCP tool calls timeout on slow networks | Set generous timeouts (60s connect, 30s per call) |
| npx cache clears our patches | This is a permanent install at `~/.hermes/mcp-servers/`, not in npx cache |

### Open Decisions
- **TypeScript vs plain JS?** TS adds build step but catches more bugs. Worth it for the Zod types integration.
- **Dice roller library?** `rpg-dice-roller` npm package handles all notation. Pull it in instead of writing a parser.
- **Repository location?** `github.com/Hybridenishi/foundryvtt-mcp` — personal, no distribution plans.

---

## Claude Collaboration Strategy

The plan is designed to be handed off. Each phase is self-contained with clear inputs/outputs:

1. **I spec + review** — write the plan (done), review Claude's code against the spec
2. **Claude builds** — implement tasks sequentially, commit after each
3. **I verify** — after each phase, I test against the real Foundry server on Atomsk (the only way to prove Socket.IO auth actually works)

Workflow:
```
Futaba: "Here's Phase 2. The auth module needs these exact headers. Test it against 100.100.244.3:30000."
Claude:  [implements auth.ts + client.ts]
Futaba:  [runs integration test against live Foundry] → passes/fails → feeds back
```

This keeps Claude focused on implementation while I handle the integration testing against real hardware you can't give Claude access to (Tailscale network, Foundry credentials).
