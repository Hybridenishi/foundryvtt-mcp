# Foundry VTT MCP Server

Personal MCP server connecting an MCP client to Foundry VTT v14 and D&D 5e over Socket.IO.

Planned work: [`ROADMAP.md`](ROADMAP.md). Inspection data, architectural findings, and current-state gaps: [`FINDINGS.md`](FINDINGS.md). `SPEC.md` is the original implementation plan and is historical — do not treat it as current.

## Critical Rules

1. **Use `extraHeaders: {Cookie}` NOT `query: {session}`** — Foundry v14 requires session cookies in HTTP headers, not URL query params. The standard `foundryvtt-mcp` npm package gets this wrong for v14.
2. **TypeScript with strict mode** — tsconfig already configured.
3. **MCP SDK stdio transport** — communicate over stdin/stdout with `@modelcontextprotocol/sdk`. The logger writes to stderr so stdout stays clean.
4. **Keep it minimal** — only the tools this table actually uses. A tool that is advertised but unimplemented is worse than a missing one.

## Coupling policy

Prefer the layer with the longest maintenance horizon:

- **Tier A — Foundry core and `dnd5e` system APIs.** Default for everything.
- **Tier B — documented module hooks and public module APIs.** Optional, one adapter per module, capability-probed at startup, pinned to a known-good version range, degrading with an explicit error rather than crashing.
- **Tier C — module internals and undocumented backends.** Never, including Plutonium's.

Writing to a world where `midi-qol`, `dae`, and `automated-conditions-5e` are active is not module coupling. Calling the Tier A API is what lets their hooks fire; writing around them desynchronizes the world.

## Write pattern

Every mutation follows the pattern established by `apply_hp_change` and `execute_item_activity_use`:

1. A read-only **preview** that returns a scoped, single-use, short-lived confirmation token (`sidecar/confirmation.js`).
2. An **apply** step requiring that exact token, gated by `FOUNDRY_WRITE_ENABLED`.
3. Execution through the `dnd5e` API via the active GM bridge, never raw `modifyDocument`, so the system owns rules behavior.
4. A **receipt** with before and after values, read back from the changed document before reporting success.

`sidecar/confirmation.js` takes a caller-supplied binding object, so adding a gated operation means a new Map and a new binding shape — not a new mechanism. New bridge capabilities extend the `handleBridgeRequest` switch in `module/scripts/prepared-actor-bridge.mjs`.

The five legacy writes (`update_actor`, `create_actor`, `delete_actor`, `next_turn`, `create_chat_message`) predate this pattern and still use raw `modifyDocument`. Do not copy them; see Phase 1.

## Secrets

Credentials come from private environment configuration only. Never commit them, include them in examples, or serve them to browser clients. Tests scan source files to assert that shared credential strings are absent — keep it that way.

## Auth Flow (Proven)

```
1. GET /join → session cookie
2. Socket.IO connect + Cookie header → 'session' event → emit 'getJoinData' → resolve user _id
3. POST /join with {action:'join', userid, password} + Cookie → authenticated
4. Socket.IO reconnect + Cookie → 'session' event (now with userId) → emit 'world' → receive world data
```

## Commands

- `npm run build` — compile TypeScript
- `npm test` — build, then sidecar and module unit tests (`node --test`)
- `npm start` — run the compiled server
- `npm run deploy:foundry` — deploy sidecar and module to the configured host
- `npm run smoke:foundry -- --require-bridge` — verify a live deployment including the GM bridge
