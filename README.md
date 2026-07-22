# Foundry VTT MCP Server

A personal Model Context Protocol (MCP) server that connects [Hermes Agent](https://github.com/NousResearch/hermes-agent) to Foundry VTT v14 over Socket.IO. Built for personal use — tracks our live Foundry version and implements only the tools we need.

## Status

⚙️ **Spec phase** — implementation not started. See [SPEC.md](SPEC.md) for the full plan.

## Quick Start (when built)

```bash
npm install && npm run build
```

### Hermes Config

```yaml
mcp_servers:
  foundryvtt:
    command: "node"
    args: ["~/.hermes/mcp-servers/foundryvtt/dist/index.js"]
    env:
      FOUNDRY_URL: "http://100.100.244.3:30000"
      FOUNDRY_USERNAME: "mcp-api"
      FOUNDRY_PASSWORD: "<password>"
      FOUNDRY_WRITE_ENABLED: "true"
    connect_timeout: 60
```

## Auth Flow

Foundry v14 uses Cookie headers for Socket.IO session auth — not URL query params. The proven 4-step flow:

1. `GET /join` → session cookie
2. Socket.IO connect + `Cookie` header → `getJoinData` → user ID
3. `POST /join` with credentials → authenticated
4. Socket.IO reconnect → `world` data loaded

## Tools (planned)

| Category | Tools |
|---|---|
| Read | search_actors, get_actor, search_items, get_scenes, get_combat_state, get_chat_log, search_journal, get_online_users, world_summary |
| Dice | roll_dice |
| Write | update_actor, set_initiative, next_turn, create_chat_message |

## License

MIT — personal project, no distribution ambitions.
