// Guards two things the README's tool tables promise: the exact set of
// registered tools (README's "Tools (42 total)" header and its three
// sub-tables), and that every write tool refuses to run when writes are
// disabled rather than silently reaching the sidecar.
import { test } from "node:test";
import assert from "node:assert/strict";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { FoundryClient } from "./client.js";
import { registerDiceTool } from "./tools/dice.js";
import { registerReadTools } from "./tools/read.js";
import { registerWriteTools } from "./tools/write.js";

const READ_TOOLS = [
  "search_actors", "get_actor", "get_5e_actor_summary", "get_prepared_5e_actor_summary",
  "get_prepared_party_overview", "list_actor_items", "list_item_activities", "get_item_activity",
  "validate_5e_actor", "search_items", "get_item", "get_scenes", "get_scene_tokens",
  "get_combat_state", "get_chat_log", "search_journal", "get_journal_entry", "list_journal_folders",
  "list_players", "search_player_knowledge", "get_player_journal_entry", "get_users",
  "world_summary", "system_info", "refresh_world",
];
const DICE_TOOLS = ["roll_dice"];
const PREVIEW_TOOLS = [
  "preview_hp_change", "preview_temporary_hp", "preview_condition_change",
  "preview_item_activity_use", "preview_spell_slot_adjustment",
];
const WRITE_TOOLS = [
  "apply_hp_change", "set_temporary_hp", "apply_condition_change", "apply_spell_slot_adjustment",
  "execute_item_activity_use", "update_actor", "create_actor", "delete_actor", "next_turn", "create_chat_message",
];

// The SDK exposes no public API to list registered tools — `_registeredTools`
// is a TypeScript-private field only, a plain object at runtime — so this
// reaches into it directly. Pragmatic for asserting our own registration
// code without standing up a full stdio transport and client, but sensitive
// to that internal name across SDK versions.
function registeredTools(server: McpServer): Record<string, { handler: (args: unknown, extra: unknown) => unknown }> {
  return (server as unknown as { _registeredTools: Record<string, { handler: (args: unknown, extra: unknown) => unknown }> })._registeredTools;
}

function buildServer(writeEnabled: boolean) {
  const server = new McpServer({ name: "test", version: "0.0.0" });
  server.registerTool("ping", { description: "Confirm availability." }, async () => ({ content: [{ type: "text" as const, text: "pong" }] }));
  // Constructing FoundryClient performs no network I/O — only connect() does —
  // so an unreachable baseUrl is fine for registration-only tests.
  const client = new FoundryClient({ baseUrl: "http://127.0.0.1:1", apiKey: "test" });
  registerReadTools(server, client);
  registerDiceTool(server);
  registerWriteTools(server, client, writeEnabled);
  return server;
}

test("registers exactly the documented 42 tools", () => {
  const names = Object.keys(registeredTools(buildServer(true))).sort();
  const expected = ["ping", ...READ_TOOLS, ...DICE_TOOLS, ...PREVIEW_TOOLS, ...WRITE_TOOLS].sort();
  assert.deepEqual(names, expected);
  assert.equal(names.length, 42);
});

test("every write tool refuses to run when FOUNDRY_WRITE_ENABLED is false", async () => {
  const tools = registeredTools(buildServer(false));
  for (const name of WRITE_TOOLS) {
    const result = await tools[name].handler({}, {}) as { isError?: boolean; content: { text: string }[] };
    assert.equal(result.isError, true, `${name} should report an error when writes are disabled`);
    assert.match(result.content[0].text, /disabled/i, `${name}'s error should say writes are disabled`);
  }
});

test("write tools run past the disabled check when FOUNDRY_WRITE_ENABLED is true", async () => {
  // Not a full integration test (the sidecar at 127.0.0.1:1 is unreachable) —
  // just confirms the disabled-check gate is the only thing standing between
  // these tools and an actual sidecar call.
  const tools = registeredTools(buildServer(true));
  const result = await tools.delete_actor.handler({ actorId: "actor-1" }, {}) as { isError?: boolean; content: { text: string }[] };
  assert.equal(result.isError, true);
  assert.doesNotMatch(result.content[0].text, /disabled/i);
});
