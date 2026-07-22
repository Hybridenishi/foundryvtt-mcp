import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { FoundryClient } from "../client.js";

const DEFAULT_LIMIT = 20;
const MAX_LIMIT = 100;

function textResult(value: unknown) {
  return { content: [{ type: "text" as const, text: JSON.stringify(value, null, 2) }] };
}

function errorResult(message: string, details?: unknown) {
  return { content: [{ type: "text" as const, text: JSON.stringify({ error: message, ...(details ? { details } : {}) }) }], isError: true };
}

export function registerReadTools(server: McpServer, client: FoundryClient): void {
  const http = client.httpClient;

  // ── ACTORS ──────────────────────────────────────────────────────
  server.registerTool(
    "search_actors",
    {
      description: "Search Foundry actors by name and optional type.",
      inputSchema: { query: z.string().optional(), type: z.string().optional(), limit: z.number().int().min(1).max(MAX_LIMIT).optional() },
    },
    async ({ query, type, limit }) => {
      try {
        const res = await http.get("/api/mcp/actors", { params: { query, type, limit } });
        return textResult(res.data);
      } catch (e: any) { return errorResult(e.response?.data?.error ?? e.message); }
    },
  );

  server.registerTool(
    "get_actor",
    {
      description: "Get a Foundry actor with full system data and computed derived stats.",
      inputSchema: { actorId: z.string().min(1) },
    },
    async ({ actorId }) => {
      try {
        const res = await http.get(`/api/mcp/actors/${actorId}`);
        return textResult(res.data);
      } catch (e: any) { return errorResult(e.response?.data?.error ?? e.message); }
    },
  );

  // ── ITEMS ───────────────────────────────────────────────────────
  server.registerTool(
    "search_items",
    {
      description: "Search Foundry items by name and optional type.",
      inputSchema: { query: z.string().optional(), type: z.string().optional(), limit: z.number().int().min(1).max(MAX_LIMIT).optional() },
    },
    async ({ query, type, limit }) => {
      try {
        const res = await http.get("/api/mcp/items", { params: { query, type, limit } });
        return textResult(res.data);
      } catch (e: any) { return errorResult(e.response?.data?.error ?? e.message); }
    },
  );

  server.registerTool(
    "get_item",
    { description: "Get a Foundry item with full data.", inputSchema: { itemId: z.string().min(1) } },
    async ({ itemId }) => {
      try {
        const res = await http.get(`/api/mcp/items/${itemId}`);
        return textResult(res.data);
      } catch (e: any) { return errorResult(e.response?.data?.error ?? e.message); }
    },
  );

  // ── SCENES ──────────────────────────────────────────────────────
  server.registerTool(
    "get_scenes",
    { description: "List all Foundry scenes with activation and token counts." },
    async () => {
      try {
        const res = await http.get("/api/mcp/scenes");
        return textResult(res.data);
      } catch (e: any) { return errorResult(e.response?.data?.error ?? e.message); }
    },
  );

  server.registerTool(
    "get_scene_tokens",
    {
      description: "Get all tokens on a scene with positions, names, and actor links.",
      inputSchema: { sceneId: z.string().min(1) },
    },
    async ({ sceneId }) => {
      try {
        const res = await http.get(`/api/mcp/scenes/${sceneId}/tokens`);
        return textResult(res.data);
      } catch (e: any) { return errorResult(e.response?.data?.error ?? e.message); }
    },
  );

  // ── COMBAT ──────────────────────────────────────────────────────
  server.registerTool(
    "get_combat_state",
    {
      description: "Get the active combat state with sorted combatants, initiative, round, and current turn.",
    },
    async () => {
      try {
        const res = await http.get("/api/mcp/combats/active");
        return textResult(res.data);
      } catch (e: any) { return errorResult(e.response?.data?.error ?? e.message); }
    },
  );

  // ── CHAT ────────────────────────────────────────────────────────
  server.registerTool(
    "get_chat_log",
    {
      description: "Get recent Foundry chat messages, optionally filtered by speaker.",
      inputSchema: { limit: z.number().int().min(1).max(MAX_LIMIT).optional(), speaker: z.string().optional() },
    },
    async ({ limit, speaker }) => {
      try {
        const res = await http.get("/api/mcp/chat-log", { params: { limit, speaker } });
        return textResult(res.data);
      } catch (e: any) { return errorResult(e.response?.data?.error ?? e.message); }
    },
  );

  // ── JOURNAL ─────────────────────────────────────────────────────
  server.registerTool(
    "search_journal",
    {
      description: "Full-text search Foundry journal entries by name and content.",
      inputSchema: { query: z.string().min(1), limit: z.number().int().min(1).max(MAX_LIMIT).optional() },
    },
    async ({ query, limit }) => {
      try {
        const res = await http.get("/api/mcp/journal", { params: { query, limit } });
        return textResult(res.data);
      } catch (e: any) { return errorResult(e.response?.data?.error ?? e.message); }
    },
  );

  server.registerTool(
    "get_journal_entry",
    { description: "Get a journal entry with all page content.", inputSchema: { journalId: z.string().min(1) } },
    async ({ journalId }) => {
      try {
        const res = await http.get(`/api/mcp/journal/${journalId}`);
        return textResult(res.data);
      } catch (e: any) { return errorResult(e.response?.data?.error ?? e.message); }
    },
  );

  // ── USERS ───────────────────────────────────────────────────────
  server.registerTool(
    "get_users",
    { description: "List all Foundry users with roles and online status." },
    async () => {
      try {
        const res = await http.get("/api/mcp/users");
        return textResult(res.data);
      } catch (e: any) { return errorResult(e.response?.data?.error ?? e.message); }
    },
  );

  // ── COMPENDIUMS ─────────────────────────────────────────────────
  server.registerTool(
    "list_compendiums",
    { description: "List all compendium packs with document counts." },
    async () => {
      try {
        const res = await http.get("/api/mcp/compendiums");
        return textResult(res.data);
      } catch (e: any) { return errorResult(e.response?.data?.error ?? e.message); }
    },
  );

  server.registerTool(
    "search_compendium",
    {
      description: "Search a compendium pack by name prefix (e.g., 'dnd5e.monsters').",
      inputSchema: { pack: z.string().min(1), query: z.string().min(1), limit: z.number().int().min(1).max(MAX_LIMIT).optional() },
    },
    async ({ pack, query, limit }) => {
      try {
        const res = await http.get(`/api/mcp/compendiums/${pack}/search`, { params: { query, limit } });
        return textResult(res.data);
      } catch (e: any) { return errorResult(e.response?.data?.error ?? e.message); }
    },
  );

  // ── MACROS ──────────────────────────────────────────────────────
  server.registerTool(
    "list_macros",
    { description: "List all macros with execution permissions." },
    async () => {
      try {
        const res = await http.get("/api/mcp/macros");
        return textResult(res.data);
      } catch (e: any) { return errorResult(e.response?.data?.error ?? e.message); }
    },
  );

  server.registerTool(
    "execute_macro",
    { description: "Execute a Foundry macro by ID.", inputSchema: { macroId: z.string().min(1) } },
    async ({ macroId }) => {
      try {
        const res = await http.post(`/api/mcp/macros/${macroId}/execute`);
        return textResult(res.data);
      } catch (e: any) { return errorResult(e.response?.data?.error ?? e.message); }
    },
  );

  // ── META ────────────────────────────────────────────────────────
  server.registerTool(
    "world_summary",
    { description: "Get Foundry world stats: actor/scene/item/combat/user counts." },
    async () => {
      try {
        const res = await http.get("/api/mcp/world-summary");
        return textResult(res.data);
      } catch (e: any) { return errorResult(e.response?.data?.error ?? e.message); }
    },
  );

  server.registerTool(
    "system_info",
    { description: "Get Foundry version, world info, and active module list." },
    async () => {
      try {
        const res = await http.get("/api/mcp/system-info");
        return textResult(res.data);
      } catch (e: any) { return errorResult(e.response?.data?.error ?? e.message); }
    },
  );

  server.registerTool(
    "refresh_world",
    { description: "Verify connectivity to the Foundry MCP Bridge module." },
    async () => {
      try {
        const res = await http.post("/api/mcp/refresh");
        return textResult(res.data);
      } catch (e: any) { return errorResult(e.response?.data?.error ?? e.message); }
    },
  );
}
