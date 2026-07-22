# Foundry VTT MCP Server

Personal MCP server for connecting Hermes to Foundry VTT v14 over Socket.IO.

## Critical Rules

1. **Use `extraHeaders: {Cookie}` NOT `query: {session}`** — Foundry v14 requires session cookies in HTTP headers, not URL query params. The standard `foundryvtt-mcp` npm package gets this wrong for v14.
2. **TypeScript with strict mode** — tsconfig already configured
3. **MCP SDK stdio transport** — communicate over stdin/stdout with `@modelcontextprotocol/sdk`
4. **Keep it minimal** — only the tools we actually use, not 20+ generic ones

## Auth Flow (Proven)

```
1. GET /join → session cookie
2. Socket.IO connect + Cookie header → 'session' event → emit 'getJoinData' → resolve user _id
3. POST /join with {action:'join', userid, password} + Cookie → authenticated
4. Socket.IO reconnect + Cookie → 'session' event (now with userId) → emit 'world' → receive world data
```

## Commands
- `npm run build` — compile TypeScript
- `npm start` — run the compiled server

## See SPEC.md for full implementation plan
