import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { FoundryClient } from "../client.js";

const DEFAULT_LIMIT = 20;
const MAX_LIMIT = 100;

const execFileAsync = promisify(execFile);
// dist/tools/read.js -> ../../scripts/import-obsidian.mjs
const IMPORTER_SCRIPT_PATH = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "scripts", "import-obsidian.mjs");

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
      description: "Get a raw, unprepared Foundry actor document for debugging. Embedded items are omitted unless includeItems=true. Null derived fields do not prove that Foundry gameplay is broken; use the 5e summary and item tools for normal play.",
      inputSchema: { actorId: z.string().min(1), includeItems: z.boolean().optional() },
    },
    async ({ actorId, includeItems }) => {
      try {
        const res = await http.get(`/api/mcp/actors/${actorId}`, { params: { includeItems } });
        return textResult(res.data);
      } catch (e: any) { return errorResult(e.response?.data?.error ?? e.message); }
    },
  );

  server.registerTool(
    "get_5e_actor_summary",
    {
      description: "Get a concise D&D 5e actor summary from a raw world-document snapshot. Derived values such as AC, HP maximum, level, spell slots, and ability modifiers may be null before Foundry prepares the Actor; never infer that combat is broken from those nulls alone.",
      inputSchema: { actorId: z.string().min(1) },
    },
    async ({ actorId }) => {
      try {
        const res = await http.get(`/api/mcp/actors/${actorId}/5e-summary`);
        return textResult(res.data);
      } catch (e: any) { return errorResult(e.response?.data?.error ?? e.message); }
    },
  );

  server.registerTool(
    "get_prepared_5e_actor_summary",
    {
      description: "Get authoritative, prepared D&D 5e actor values from an active GM's Foundry client: HP maximum, AC, level, modifiers, saving throws, and spell-slot maxima. This requires the Foundry MCP Bridge module enabled and an active GM browser session.",
      inputSchema: { actorId: z.string().min(1) },
    },
    async ({ actorId }) => {
      try {
        const res = await http.get(`/api/mcp/actors/${actorId}/prepared`);
        return textResult(res.data);
      } catch (e: any) { return errorResult(e.response?.data?.error ?? e.message); }
    },
  );

  server.registerTool(
    "get_prepared_party_overview",
    {
      description: "Get prepared HP, AC, conditions, and spell slots for all character actors from an active GM's Foundry client. This is a concise read-only party view and requires the Foundry MCP Bridge module with an active GM browser session.",
      annotations: { readOnlyHint: true },
    },
    async () => {
      try {
        const res = await http.get("/api/mcp/party/prepared");
        return textResult(res.data);
      } catch (e: any) { return errorResult(e.response?.data?.error ?? e.message); }
    },
  );

  server.registerTool(
    "list_actor_items",
    {
      description: "List an actor's embedded D&D 5e items in pages. Filter by name, item type, or source rules edition.",
      inputSchema: {
        actorId: z.string().min(1),
        query: z.string().optional(),
        type: z.string().optional(),
        rules: z.string().optional(),
        limit: z.number().int().min(1).max(MAX_LIMIT).optional(),
        offset: z.number().int().min(0).optional(),
      },
    },
    async ({ actorId, query, type, rules, limit, offset }) => {
      try {
        const res = await http.get(`/api/mcp/actors/${actorId}/items`, { params: { query, type, rules, limit, offset } });
        return textResult(res.data);
      } catch (e: any) { return errorResult(e.response?.data?.error ?? e.message); }
    },
  );

  server.registerTool(
    "list_item_activities",
    {
      description: "List D&D 5e activities on an actor's embedded items in pages. Filter by item, name, activity type, or source rules edition.",
      inputSchema: {
        actorId: z.string().min(1),
        itemId: z.string().optional(),
        query: z.string().optional(),
        type: z.string().optional(),
        rules: z.string().optional(),
        limit: z.number().int().min(1).max(MAX_LIMIT).optional(),
        offset: z.number().int().min(0).optional(),
      },
    },
    async ({ actorId, itemId, query, type, rules, limit, offset }) => {
      try {
        const res = await http.get(`/api/mcp/actors/${actorId}/activities`, { params: { itemId, query, type, rules, limit, offset } });
        return textResult(res.data);
      } catch (e: any) { return errorResult(e.response?.data?.error ?? e.message); }
    },
  );

  server.registerTool(
    "get_item_activity",
    {
      description: "Inspect one existing D&D 5e activity on an actor item. Returns targeting, activation, consumption configuration, attack/save, damage/healing, and effect metadata. Discovery only: configuration does not prove final resource costs or roll outcomes, and this tool never rolls, consumes resources, creates chat messages, or changes Foundry data.",
      inputSchema: {
        actorId: z.string().min(1),
        itemId: z.string().min(1),
        activityId: z.string().min(1),
      },
      annotations: { readOnlyHint: true },
    },
    async ({ actorId, itemId, activityId }) => {
      try {
        const res = await http.get(`/api/mcp/actors/${actorId}/items/${itemId}/activities/${activityId}`);
        return textResult(res.data);
      } catch (e: any) { return errorResult(e.response?.data?.error ?? e.message); }
    },
  );

  server.registerTool(
    "validate_5e_actor",
    {
      description: "Inspect a D&D 5e actor's raw world-document snapshot for document size, item/activity counts, 2014/2024 source mix, and module-provided activity types. This is not a combat-readiness check: null derived fields require Foundry UI or prepared-data confirmation.",
      inputSchema: { actorId: z.string().min(1) },
    },
    async ({ actorId }) => {
      try {
        const res = await http.get(`/api/mcp/actors/${actorId}/5e-validation`);
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
  // GM-scoped: these return everything, including GM-only material. There
  // is no permission filtering here — a player-scoped equivalent that
  // filters by what a named player can actually see is a later addition.
  server.registerTool(
    "search_journal",
    {
      description:
        "Search campaign journal entries as the GM: matches entry names, page names, and page content. Returns snippets, per-page hit counts, and each entry's classified type/tags. This is the GM view and may include GM-only material.",
      inputSchema: {
        query: z.string().min(1),
        type: z.enum(["location", "person", "faction", "history", "item", "session", "other"]).optional(),
        tag: z.string().optional(),
        folder: z.string().optional().describe("Journal folder name or id"),
        limit: z.number().int().min(1).max(MAX_LIMIT).optional(),
        offset: z.number().int().min(0).optional(),
      },
    },
    async ({ query, type, tag, folder, limit, offset }) => {
      try {
        const res = await http.get("/api/mcp/journal", { params: { query, type, tag, folder, limit, offset } });
        return textResult(res.data);
      } catch (e: any) { return errorResult(e.response?.data?.error ?? e.message); }
    },
  );

  server.registerTool(
    "get_journal_entry",
    {
      description: "Get one campaign journal entry with all page content, as the GM, including each page's classified type and a content hash.",
      inputSchema: { journalId: z.string().min(1) },
    },
    async ({ journalId }) => {
      try {
        const res = await http.get(`/api/mcp/journal/${journalId}`);
        return textResult(res.data);
      } catch (e: any) { return errorResult(e.response?.data?.error ?? e.message); }
    },
  );

  server.registerTool(
    "list_journal_folders",
    { description: "List Foundry journal folders, for filtering search_journal by folder." },
    async () => {
      try {
        const res = await http.get("/api/mcp/journal/folders");
        return textResult(res.data);
      } catch (e: any) { return errorResult(e.response?.data?.error ?? e.message); }
    },
  );

  server.registerTool(
    "audit_journal_visibility",
    {
      description:
        "Verify that this server's journal permission filtering agrees exactly with Foundry's own testUserPermission for every journal entry, page, and non-GM user. Requires an active GM bridge. Any disagreement is reported as a failure — this is what keeps search_player_knowledge and get_player_journal_entry trustworthy over time, and should be run after any Foundry or dnd5e version upgrade.",
      annotations: { readOnlyHint: true },
    },
    async () => {
      try {
        const res = await http.post("/api/mcp/journal/visibility-audit");
        if (res.data?.ok === false) {
          return errorResult(
            `Journal visibility audit found ${res.data.disagreements?.length ?? 0} disagreement(s) between the sidecar and Foundry's own permission check.`,
            res.data,
          );
        }
        return textResult(res.data);
      } catch (e: any) { return errorResult(e.response?.data?.error ?? e.message); }
    },
  );

  // ── PLAYER-SCOPED JOURNAL ──────────────────────────────────────────
  // Permission-filtered equivalents of the GM journal tools above: results
  // are strictly what the named player has at least Observer permission on
  // in Foundry. An empty result must never be read as "this doesn't exist"
  // — only as "this player has no visibility into it". Use these, never the
  // GM tools above, when answering a question on a specific player's behalf.
  server.registerTool(
    "list_players",
    {
      description: "List non-GM Foundry users and the player-character names they own. These are the stable references search_player_knowledge and get_player_journal_entry accept as `player`.",
      annotations: { readOnlyHint: true },
    },
    async () => {
      try {
        const res = await http.get("/api/mcp/players");
        return textResult(res.data);
      } catch (e: any) { return errorResult(e.response?.data?.error ?? e.message); }
    },
  );

  server.registerTool(
    "search_player_knowledge",
    {
      description:
        "Search the campaign journal strictly as one named player would see it in Foundry: only entries and pages that player has at least Observer permission on. An empty result means nothing was found for that player — it does NOT mean the subject doesn't exist in the world, only that this player has no visibility into it. Never infer non-existence from an empty result, and never fall back to search_journal (the GM view) to answer on a player's behalf.",
      inputSchema: {
        player: z.string().min(1).describe("Foundry user id, user name, or the name of a character that player owns"),
        query: z.string().min(1),
        limit: z.number().int().min(1).max(MAX_LIMIT).optional(),
        offset: z.number().int().min(0).optional(),
      },
      annotations: { readOnlyHint: true },
    },
    async ({ player, query, limit, offset }) => {
      try {
        const res = await http.get(`/api/mcp/players/${encodeURIComponent(player)}/journal`, { params: { query, limit, offset } });
        return textResult(res.data);
      } catch (e: any) { return errorResult(e.response?.data?.error ?? e.message); }
    },
  );

  server.registerTool(
    "get_player_journal_entry",
    {
      description:
        "Get one journal entry strictly as one named player would see it: pages that player cannot observe are absent, and if the player cannot observe the entry at all — or none of its pages — this reports 'not found', identically to a nonexistent id. Never fall back to get_journal_entry (the GM view) to answer on a player's behalf.",
      inputSchema: {
        player: z.string().min(1).describe("Foundry user id, user name, or the name of a character that player owns"),
        journalId: z.string().min(1),
      },
      annotations: { readOnlyHint: true },
    },
    async ({ player, journalId }) => {
      try {
        const res = await http.get(`/api/mcp/players/${encodeURIComponent(player)}/journal/${encodeURIComponent(journalId)}`);
        return textResult(res.data);
      } catch (e: any) { return errorResult(e.response?.data?.error ?? e.message); }
    },
  );

  // ── OBSIDIAN IMPORT (dry run only) ─────────────────────────────────
  server.registerTool(
    "preview_obsidian_import",
    {
      description:
        "Run a dry-run report of scripts/import-obsidian.mjs over an Obsidian vault: what would be created, updated, or skipped, which notes would be downgraded to GM-only and why, and the resolved visibility breakdown. Read-only — this never writes to Foundry, and this tool provides no way to apply the import; that requires a human to run the script directly with --apply and type the confirmation number themselves. Runs locally against the filesystem, not through the sidecar.",
      inputSchema: {
        vaultPath: z.string().min(1).optional().describe("Path to the Obsidian vault. Defaults to the OBSIDIAN_VAULT_PATH environment variable if omitted."),
        allowVisibility: z.array(z.enum(["party", "players"])).optional().describe("Visibility profiles to report as accepted rather than downgraded, mirroring --allow-visibility. Omit to see what would happen with no profiles allowed."),
        only: z.string().optional().describe("Restrict to vault-relative paths matching this pattern (supports '*' wildcards), mirroring --only."),
        limit: z.number().int().min(1).max(1000).optional().describe("Consider at most this many notes, mirroring --limit."),
      },
      annotations: { readOnlyHint: true },
    },
    async ({ vaultPath, allowVisibility, only, limit }) => {
      const resolvedVaultPath = vaultPath ?? process.env.OBSIDIAN_VAULT_PATH;
      if (!resolvedVaultPath) return errorResult("No vault path given and OBSIDIAN_VAULT_PATH is not set.");
      const scriptArgs = [IMPORTER_SCRIPT_PATH, resolvedVaultPath, "--json"];
      if (allowVisibility && allowVisibility.length > 0) scriptArgs.push("--allow-visibility", allowVisibility.join(","));
      if (only) scriptArgs.push("--only", only);
      if (limit !== undefined) scriptArgs.push("--limit", String(limit));
      try {
        const { stdout } = await execFileAsync(process.execPath, scriptArgs);
        return textResult(JSON.parse(stdout));
      } catch (e: any) {
        return errorResult(e.stderr?.trim() || e.message);
      }
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
    { description: "Verify connectivity to the Foundry sidecar and refresh its live world snapshot." },
    async () => {
      try {
        const res = await http.post("/api/mcp/refresh");
        return textResult(res.data);
      } catch (e: any) { return errorResult(e.response?.data?.error ?? e.message); }
    },
  );
}
