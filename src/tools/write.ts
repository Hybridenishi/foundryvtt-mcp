import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { FoundryClient } from "../client.js";

function textResult(value: unknown) {
  return { content: [{ type: "text" as const, text: JSON.stringify(value, null, 2) }] };
}

function errorResult(message: string, details?: unknown) {
  return { content: [{ type: "text" as const, text: JSON.stringify({ error: message, ...(details ? { details } : {}) }) }], isError: true };
}

function disabledResult() {
  return errorResult("Write tools are disabled. Set FOUNDRY_WRITE_ENABLED=true to enable them.");
}

export function registerWriteTools(server: McpServer, client: FoundryClient, writeEnabled: boolean): void {
  const http = client.httpClient;

  server.registerTool(
    "preview_hp_change",
    {
      description: "Preview a direct D&D 5e HP damage or healing change through the active GM bridge. This does not modify Foundry and returns a short-lived confirmation token for apply_hp_change. When damageType is provided (damage mode only), dnd5e calculates resistance, vulnerability, and immunity — previewed after values are raw BEFORE those calculations and may differ from the actual result.",
      inputSchema: {
        actorId: z.string().min(1),
        mode: z.enum(["damage", "healing"]),
        amount: z.number().int().min(1).max(100_000),
        damageType: z.enum([
          "acid", "bludgeoning", "cold", "fire", "force",
          "lightning", "necrotic", "piercing", "poison", "psychic",
          "radiant", "slashing", "thunder",
        ]).optional().describe("dnd5e damage type (damage mode only; e.g., 'fire', 'piercing')"),
      },
      annotations: { readOnlyHint: true },
    },
    async ({ actorId, mode, amount, damageType }) => {
      try {
        const res = await http.post(`/api/mcp/actors/${actorId}/hp-change/preview`, { mode, amount, ...(damageType ? { damageType } : {}) });
        return textResult(res.data);
      } catch (e: any) { return errorResult(e.response?.data?.error ?? e.message); }
    },
  );

  server.registerTool(
    "apply_hp_change",
    {
      description: "Apply a previously previewed direct D&D 5e HP damage or healing change through the active GM bridge. Requires FOUNDRY_WRITE_ENABLED=true and the exact short-lived confirmation token from preview_hp_change. When damageType is provided (damage mode only), dnd5e calculates resistance, vulnerability, and immunity — the apply response derives its breakdown from the actual state change, not the preview's raw math.",
      inputSchema: {
        actorId: z.string().min(1),
        mode: z.enum(["damage", "healing"]),
        amount: z.number().int().min(1).max(100_000),
        damageType: z.enum([
          "acid", "bludgeoning", "cold", "fire", "force",
          "lightning", "necrotic", "piercing", "poison", "psychic",
          "radiant", "slashing", "thunder",
        ]).optional().describe("dnd5e damage type (damage mode only; must match preview)"),
        confirmationToken: z.string().uuid(),
      },
      annotations: { destructiveHint: false },
    },
    async ({ actorId, mode, amount, damageType, confirmationToken }) => {
      if (!writeEnabled) return disabledResult();
      try {
        const res = await http.post(`/api/mcp/actors/${actorId}/hp-change`, { mode, amount, ...(damageType ? { damageType } : {}), confirmationToken });
        return textResult(res.data);
      } catch (e: any) { return errorResult(e.response?.data?.error ?? e.message); }
    },
  );

  server.registerTool(
    "preview_temporary_hp",
    {
      description: "Preview replacing an actor's temporary HP with an exact value through the active GM bridge. This does not modify Foundry and returns a short-lived confirmation token for set_temporary_hp. Use amount 0 to clear temporary HP.",
      inputSchema: {
        actorId: z.string().min(1),
        amount: z.number().int().min(0).max(100_000),
      },
      annotations: { readOnlyHint: true },
    },
    async ({ actorId, amount }) => {
      try {
        const res = await http.post(`/api/mcp/actors/${actorId}/temporary-hp/preview`, { amount });
        return textResult(res.data);
      } catch (e: any) { return errorResult(e.response?.data?.error ?? e.message); }
    },
  );

  server.registerTool(
    "set_temporary_hp",
    {
      description: "Replace an actor's temporary HP with a previously previewed exact value through the active GM bridge. Requires FOUNDRY_WRITE_ENABLED=true and the exact short-lived confirmation token from preview_temporary_hp. Use amount 0 to clear temporary HP.",
      inputSchema: {
        actorId: z.string().min(1),
        amount: z.number().int().min(0).max(100_000),
        confirmationToken: z.string().uuid(),
      },
      annotations: { destructiveHint: false },
    },
    async ({ actorId, amount, confirmationToken }) => {
      if (!writeEnabled) return disabledResult();
      try {
        const res = await http.post(`/api/mcp/actors/${actorId}/temporary-hp`, { amount, confirmationToken });
        return textResult(res.data);
      } catch (e: any) { return errorResult(e.response?.data?.error ?? e.message); }
    },
  );

  server.registerTool(
    "preview_condition_change",
    {
      description: "Preview adding or removing one standard D&D 5e condition through the active GM bridge. This does not modify Foundry and returns a short-lived confirmation token for apply_condition_change. Exhaustion is level-based and is intentionally unsupported by this generic tool.",
      inputSchema: {
        actorId: z.string().min(1),
        mode: z.enum(["add", "remove"]),
        statusId: z.string().regex(/^[a-z0-9-]{1,80}$/i),
      },
      annotations: { readOnlyHint: true },
    },
    async ({ actorId, mode, statusId }) => {
      try {
        const res = await http.post(`/api/mcp/actors/${actorId}/conditions/preview`, { mode, statusId });
        return textResult(res.data);
      } catch (e: any) { return errorResult(e.response?.data?.error ?? e.message); }
    },
  );

  server.registerTool(
    "apply_condition_change",
    {
      description: "Apply one exact, previewed standard D&D 5e condition change through the active GM bridge. Requires FOUNDRY_WRITE_ENABLED=true and the short-lived confirmation token from preview_condition_change. Exhaustion is intentionally unsupported.",
      inputSchema: {
        actorId: z.string().min(1),
        mode: z.enum(["add", "remove"]),
        statusId: z.string().regex(/^[a-z0-9-]{1,80}$/i),
        confirmationToken: z.string().uuid(),
      },
      annotations: { destructiveHint: false },
    },
    async ({ actorId, mode, statusId, confirmationToken }) => {
      if (!writeEnabled) return disabledResult();
      try {
        const res = await http.post(`/api/mcp/actors/${actorId}/conditions`, { mode, statusId, confirmationToken });
        return textResult(res.data);
      } catch (e: any) { return errorResult(e.response?.data?.error ?? e.message); }
    },
  );

  server.registerTool(
    "preview_item_activity_use",
    {
      description: "Preview one exact embedded dnd5e utility activity for execution through the active GM bridge. This read-only check supports only unambiguous utility activities with no external target (an explicit self target is allowed), no template, scaling, spell slot, or concentration. The actor must also have a token on an active scene; dnd5e's Activity#use requires one even for self-targeted activities. It does not roll, consume resources, create chat output, or change Foundry; it returns a short-lived token for execute_item_activity_use.",
      inputSchema: {
        actorId: z.string().min(1),
        itemId: z.string().min(1),
        activityId: z.string().min(1),
      },
      annotations: { readOnlyHint: true },
    },
    async ({ actorId, itemId, activityId }) => {
      try {
        const res = await http.post(`/api/mcp/actors/${actorId}/items/${itemId}/activities/${activityId}/use/preview`);
        return textResult(res.data);
      } catch (e: any) { return errorResult(e.response?.data?.error ?? e.message); }
    },
  );

  server.registerTool(
    "execute_item_activity_use",
    {
      description: "Execute exactly one previewed dnd5e utility activity through the active GM bridge. Requires FOUNDRY_WRITE_ENABLED=true and the exact, short-lived, one-time confirmation token. dnd5e performs the activity; this tool reports the resulting chat message, system-reported updates, and observed resource changes.",
      inputSchema: {
        actorId: z.string().min(1),
        itemId: z.string().min(1),
        activityId: z.string().min(1),
        confirmationToken: z.string().uuid(),
      },
      annotations: { destructiveHint: false },
    },
    async ({ actorId, itemId, activityId, confirmationToken }) => {
      if (!writeEnabled) return disabledResult();
      try {
        const res = await http.post(`/api/mcp/actors/${actorId}/items/${itemId}/activities/${activityId}/use`, { confirmationToken });
        return textResult(res.data);
      } catch (e: any) { return errorResult(e.response?.data?.error ?? e.message); }
    },
  );

  server.registerTool(
    "update_actor",
    {
      description: "Update an actor's system attributes (e.g., hp, currency, stats). Requires FOUNDRY_WRITE_ENABLED=true.",
      inputSchema: {
        actorId: z.string().min(1),
        system: z.record(z.string(), z.unknown()).refine(v => Object.keys(v).length > 0, "system must not be empty"),
      },
      annotations: { destructiveHint: false },
    },
    async ({ actorId, system }) => {
      if (!writeEnabled) return disabledResult();
      try {
        const res = await http.post(`/api/mcp/actors/${actorId}/update`, { system });
        return textResult(res.data);
      } catch (e: any) { return errorResult(e.response?.data?.error ?? e.message); }
    },
  );

  server.registerTool(
    "create_actor",
    {
      description: "Create a minimal actor placeholder. Use Plutonium for complete 5e characters and creatures. Requires FOUNDRY_WRITE_ENABLED=true.",
      inputSchema: {
        name: z.string().min(1),
        type: z.string().optional(),
        system: z.record(z.string(), z.unknown()).optional(),
      },
      annotations: { destructiveHint: false },
    },
    async ({ name, type, system }) => {
      if (!writeEnabled) return disabledResult();
      try {
        const res = await http.post("/api/mcp/actors/create", { name, type, system });
        return textResult(res.data);
      } catch (e: any) { return errorResult(e.response?.data?.error ?? e.message); }
    },
  );

  server.registerTool(
    "delete_actor",
    {
      description: "Delete an actor by ID. Requires FOUNDRY_WRITE_ENABLED=true. Destructive — cannot be undone.",
      inputSchema: { actorId: z.string().min(1) },
      annotations: { destructiveHint: true },
    },
    async ({ actorId }) => {
      if (!writeEnabled) return disabledResult();
      try {
        const res = await http.post(`/api/mcp/actors/${actorId}/delete`);
        return textResult(res.data);
      } catch (e: any) { return errorResult(e.response?.data?.error ?? e.message); }
    },
  );

  server.registerTool(
    "next_turn",
    {
      description: "Advance combat through the sidecar's current internal update. Requires FOUNDRY_WRITE_ENABLED=true.",
      inputSchema: { combatId: z.string().optional() },
      annotations: { destructiveHint: false },
    },
    async ({ combatId }) => {
      if (!writeEnabled) return disabledResult();
      try {
        const res = await http.post("/api/mcp/combats/next-turn", combatId ? { combatId } : {});
        return textResult(res.data);
      } catch (e: any) { return errorResult(e.response?.data?.error ?? e.message); }
    },
  );

  server.registerTool(
    "create_chat_message",
    {
      description: "Post a message to Foundry chat. Requires FOUNDRY_WRITE_ENABLED=true.",
      inputSchema: { content: z.string().min(1), type: z.union([z.string(), z.number().int()]).optional() },
      annotations: { destructiveHint: false },
    },
    async ({ content, type }) => {
      if (!writeEnabled) return disabledResult();
      try {
        const res = await http.post("/api/mcp/chat", { content, ...(type !== undefined ? { type } : {}) });
        return textResult(res.data);
      } catch (e: any) { return errorResult(e.response?.data?.error ?? e.message); }
    },
  );
}
