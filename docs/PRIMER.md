# Foundry MCP — Developer Reference

## Architecture

```
MCP client → MCP Server (TS/stdio) → HTTP → Sidecar (Express:30001) → Socket.IO → Foundry:30000
                    │                                      │
                    │  TypeScript, MCP SDK                 │  Node.js Express
                    └──────────────────────────────────────┘
```

Two-layer bridge:

| Layer | Location | Repo | Role |
|-------|----------|------|------|
| **MCP Server** | Your MCP client's configured server directory | `src/` | TypeScript MCP server. It runs as a child process over stdio, registers tools (`search_actors`, `create_actor`, etc.), and calls the sidecar over HTTP. |
| **Sidecar** | Your Foundry host's Docker deployment (`foundry-sidecar`, port 30001 by default) | `sidecar/` | Express proxy. Authenticates with Foundry via Socket.IO (4-step handshake), then exposes REST endpoints. All writes go through `socket.emit("modifyDocument", ...)`. |
| **MCP Bridge module** | Foundry data: `modules/foundry-mcp-bridge/` | Same repo, `module/` | Runs in an active GM's Foundry browser client and returns prepared, runtime-derived Actor values through the same-origin `/mcp-bridge` HTTP route. It also performs narrowly confirmation-guarded HP, temporary-HP, standard-condition, spell-slot, and utility-activity-execution changes. |

## Repo: `github.com/Hybridenishi/foundryvtt-mcp`

```
├── src/                    # MCP server (TypeScript)
│   ├── index.ts            # Entry point, tool registration
│   ├── client.ts           # HTTP client (axios) → sidecar
│   ├── logger.ts           # stderr logger
│   ├── register.test.ts    # Tool-registration test (compiled to dist/, run via `npm test`)
│   └── tools/
│       ├── read.ts         # search_actors, get_actor, search_items, etc.
│       ├── write.ts        # preview/apply tools, plus the legacy raw writes
│       └── dice.ts         # roll_dice (rpg-dice-roller)
├── sidecar/                # Express sidecar (plain JS)
│   ├── index.js            # Env parsing, Foundry Socket.IO auth/connection lifecycle, listen()
│   ├── app.js               # createApp(deps) — the Express route table, independent of a live Foundry
│   ├── confirmations.js     # Per-operation request validators + confirmation-token issue/consume wrappers
│   ├── confirmation.js      # The generic confirmation primitive: binding/payload storage and symmetric matching
│   ├── actor-utils.js       # Raw-actor summarization and pagination helpers
│   ├── journal-search.js    # Journal search, classification, and detail assembly — ownership-agnostic
│   ├── journal-visibility.js # Foundry ownership resolution and the player-scoped, permission-filtered views built on it
│   ├── bridge-auth.js       # Constant-time bridge-token comparison
│   ├── *.test.js             # node --test unit and route tests for the files above
│   ├── package-lock.json    # Tracked so the Dockerfile's `npm ci` is reproducible on a fresh host
│   └── Dockerfile          # Node:22-alpine
├── module/                 # Foundry v14 client-side MCP Bridge module
│   ├── module.json
│   ├── scripts/prepared-actor-bridge.mjs
│   └── scripts/prepared-actor-bridge.test.mjs
├── scripts/                # Operator tooling — run locally, not deployed
│   ├── deploy-foundry.sh   # Deploy the sidecar and bridge module to a host
│   ├── smoke-foundry.sh    # Post-deploy health/bridge/visibility-audit check
│   ├── import-obsidian.mjs # Obsidian vault -> Foundry journal migration; see README's "Obsidian import"
│   └── import-obsidian.test.mjs
├── traefik/                # Optional Traefik example for the same-origin bridge route
│   └── foundry-mcp-bridge.yml
├── tests/                  # Natural-language agent-behavior scenarios; see tests/README.md
│   ├── scenarios/
│   └── regressions/
├── docs/
│   ├── ROADMAP.md          # Planned work, by phase
│   ├── FINDINGS.md         # Deployment inspection data and architectural findings
│   ├── SPEC.md             # Original implementation plan (historical)
│   └── PRIMER.md           # This file
├── spell-slot-management-spec.md  # Design spec for the spell-slot feature
└── AGENTS.md               # Claude/AI instructions
```

**Adding a sidecar file** requires three edits, not one: the hardcoded preflight list in `scripts/deploy-foundry.sh`, the `COPY` line in `sidecar/Dockerfile`, and the scp block in the deploy script. A file missing from any of them will pass local tests and fail on the host.

**Build:** `npm install && npm run build` (outputs to `dist/`)
**Deploy MCP server:** copy `dist/` to the directory configured by your MCP client.
**Deploy sidecar:** use `npm run deploy:foundry` after setting the documented `FOUNDRY_*` deployment paths.
**Deploy MCP Bridge module:** the deploy script copies the module files; configure a same-origin `/mcp-bridge` route in your reverse proxy, then reload Foundry as an active GM.

## How to Test a Deployment

### Quick connectivity test
```bash
# Sidecar health (both GET and POST are supported)
curl -s -H "X-API-Key: <private-sidecar-api-key>" \
  http://foundry-sidecar-host:30001/api/mcp/refresh
# → {"ok":true,"connected":true}

# List actors
curl -s -H "X-API-Key: <private-sidecar-api-key>" \
  http://foundry-sidecar-host:30001/api/mcp/actors
```

### Endpoints available on sidecar (:30001)

See [`README.md`'s "Endpoints (sidecar)" table](../README.md#endpoints-sidecar) for the full, current route list — kept in exactly one place so it can't drift out of sync with itself across two files. Route handlers themselves live in `sidecar/app.js`. For a precise, versioned contract with real response examples aimed at a client built *outside* this repo, see [`docs/JOURNAL-API.md`](JOURNAL-API.md).

### Repeatable deploy and smoke checks

Set `FOUNDRY_DEPLOY_TARGET`, `FOUNDRY_COMPOSE_DIR`, `FOUNDRY_SIDECAR_DIR`, and `FOUNDRY_MODULE_DIR` for your host, then run `npm run deploy:foundry`. The script backs up and copies the sidecar/module runtime files, validates the remote Compose configuration, rebuilds only the sidecar, and checks its private API from inside the container. It does not print secrets or mutate Foundry world data.

Set `FOUNDRY_WRITE_ENABLED=true` in both the MCP client and the sidecar container only when enabling mutations. The sidecar independently rejects every mutation route when that setting is absent or false.

`PLAYER_API_KEY` is a second, optional sidecar credential scoped to `/api/mcp/players/*` only — it cannot reach any GM route or any write route, by construction (a separate Express router with its own auth check, mounted ahead of the GM-only middleware), not by convention. Leave it unset until a player-facing consumer (e.g. the Iris knowledge service described in the campaign-knowledge-journal plan) actually needs it; the routes simply stay reachable by the regular `API_KEY` alone until then.

The `traefik/` directory is an optional example only. Any reverse proxy is suitable if it preserves the Foundry browser session cookie while forwarding the same-origin `/mcp-bridge` route to the sidecar.

After the deploy, hard-refresh Foundry in an active GM browser session, then run `npm run smoke:foundry -- --require-bridge`. This second check requires an authenticated GM bridge responder and reports Foundry/system versions plus responder count. Add `--audit-journal-visibility` (which implies `--require-bridge`) to also run the journal-visibility conformance audit through the bridge and exit `3` on any disagreement between the sidecar's permission computation and Foundry's own — worth running after every Foundry or dnd5e version upgrade, since that is exactly the kind of change that could silently shift ownership resolution.

Reload Foundry in an active GM browser session after copying the module files. The bridge pairs only after the sidecar validates the browser's authenticated Foundry session as a GM, then uses an in-memory per-client token that expires after 45 seconds of inactivity. No bridge credential belongs in the module source. The prepared-data route returns an explicit bridge-unavailable error rather than falling back to raw values when no GM bridge responds.

The HP preview route is read-only. The apply route requires `FOUNDRY_WRITE_ENABLED=true` in both the MCP client and sidecar environments, plus the exact, unexpired confirmation token returned by its preview. Direct damage uses dnd5e's `Actor.applyDamage`, including temporary HP; an optional `damageType` triggers dnd5e's own resistance, vulnerability, and immunity calculation, otherwise the damage is untyped. Neither path runs activity automation.

Temporary HP uses the same guarded workflow but is an explicit replacement: preview the exact value, then set it with the matching token. It accepts `0` to clear temporary HP and intentionally does not infer how a spell or feature should resolve competing temporary-HP grants.

Standard conditions use the same preview-and-apply guard through Foundry's `Actor.toggleStatusEffect`; generic condition changes deliberately refuse exhaustion because it has edition-sensitive levels.

Spell-slot adjustment follows the same shape but is an intentional exception to the dnd5e-API rule: it uses `actor.update()` directly, since dnd5e has no dedicated spell-slot mutation API. It is exact-value only (not deltas), character actors only, and the apply step additionally rejects if the actor's slot state changed since the matching preview — see `AGENTS.md`'s "Write pattern" section for why.

Utility-activity execution (`preview_item_activity_use` / `execute_item_activity_use`) is narrower than the other guarded writes: it only supports unambiguous, self-targeted dnd5e utility activities with no external target, template, scaling, spell slot, or concentration requirement, and the actor must have a token on an active scene. `Activity#use()` runs for real through the GM client, so dnd5e — not this bridge — owns validation, resource consumption, effects, and chat output.

**Important:** The sidecar uses Docker build cache. If your changes don't seem to take effect, use `--no-cache`:
```bash
ssh user@foundry-host "cd /path/to/compose-directory && \
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

When installed and activated, Plutonium integrates with the 5e.tools dataset for importing properly structured monsters, items, spells, and other content.

If activated, it provides a massive library of correct D&D 5e data — the best source for creating NPCs with proper system data. Import via Foundry UI or programmatically.

Docs: https://wiki.tercept.net/en/Plutonium

## Test Script Pattern

```bash
#!/bin/bash
# Quick create → verify → delete cycle

API="http://foundry-sidecar-host:30001"
KEY="X-API-Key: <private-sidecar-api-key>"

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
