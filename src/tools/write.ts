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

const journalVisibilitySchema = z.discriminatedUnion("profile", [
  z.object({ profile: z.literal("gm") }),
  z.object({ profile: z.literal("party") }),
  z.object({ profile: z.literal("players"), players: z.array(z.string().min(1)).min(1).max(20) }),
]).describe(
  "Required — there is no default. Who may read everything in this call: 'gm' is GM-only; 'party' is every non-GM user who currently owns a character actor; 'players' names them explicitly, each by Foundry user id, user name, or the name of a character they own. Everything in one call gets exactly one visibility; build a mixed-visibility entry with a second, separately confirmed call rather than mixing visibilities in one.",
);

const journalPageSchema = z.object({
  name: z.string().min(1),
  content: z.string().describe("HTML. @UUID[...] enrichers are preserved."),
});

const journalKnowledgeSchema = z.object({
  type: z.enum(["location", "person", "faction", "history", "item", "session", "other"]).optional(),
  tags: z.array(z.string()).max(20).optional(),
}).optional();

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
    "preview_spell_slot_adjustment",
    {
      description: "Preview an exact D&D 5e spell-slot adjustment through the active GM bridge. This does not modify Foundry and returns a short-lived confirmation token for apply_spell_slot_adjustment. This is an administrative counter adjustment — it does not cast spells, validate spellcasting requirements, or create chat output. Supports pact magic. Character actors only.",
      inputSchema: {
        actorId: z.string().min(1),
        adjustments: z.array(z.object({
          slot: z.enum(["pact", "spell1", "spell2", "spell3", "spell4", "spell5", "spell6", "spell7", "spell8", "spell9"]),
          value: z.number().int().min(0).max(100_000),
        })).min(1).max(10),
      },
      annotations: { readOnlyHint: true },
    },
    async ({ actorId, adjustments }) => {
      try {
        const res = await http.post(`/api/mcp/actors/${actorId}/spell-slots/preview`, { adjustments });
        return textResult(res.data);
      } catch (e: any) { return errorResult(e.response?.data?.error ?? e.message); }
    },
  );

  server.registerTool(
    "apply_spell_slot_adjustment",
    {
      description: "Apply an exact, previewed D&D 5e spell-slot adjustment through the active GM bridge. Requires FOUNDRY_WRITE_ENABLED=true and the exact short-lived confirmation token from preview_spell_slot_adjustment. This is an administrative counter adjustment — it does not cast spells. Stale-state protected: rejects if slots changed since preview. Character actors only.",
      inputSchema: {
        actorId: z.string().min(1),
        adjustments: z.array(z.object({
          slot: z.enum(["pact", "spell1", "spell2", "spell3", "spell4", "spell5", "spell6", "spell7", "spell8", "spell9"]),
          value: z.number().int().min(0).max(100_000),
        })).min(1).max(10),
        confirmationToken: z.string().uuid(),
      },
      annotations: { destructiveHint: false },
    },
    async ({ actorId, adjustments, confirmationToken }) => {
      if (!writeEnabled) return disabledResult();
      try {
        const res = await http.post(`/api/mcp/actors/${actorId}/spell-slots`, { adjustments, confirmationToken });
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

  server.registerTool(
    "preview_link_actor_journal",
    {
      description:
        "Preview linking an actor to a journal entry, deliberately not the actor's biography field (DDB Importer and Plutonium overwrite that on re-import). Read-only, and needs no active GM bridge (it reads current link flags from the world snapshot, not from Foundry live): returns both documents' current link flags and a short-lived confirmation token for apply_link_actor_journal, which does require the bridge to actually write them.",
      inputSchema: { actorId: z.string().min(1), entryId: z.string().min(1) },
      annotations: { readOnlyHint: true },
    },
    async ({ actorId, entryId }) => {
      try {
        const res = await http.post(`/api/mcp/actors/${actorId}/link-journal/preview`, { entryId });
        return textResult(res.data);
      } catch (e: any) { return errorResult(e.response?.data?.error ?? e.message); }
    },
  );

  server.registerTool(
    "apply_link_actor_journal",
    {
      description:
        "Apply an exactly previewed actor-journal link through the active GM bridge. Requires FOUNDRY_WRITE_ENABLED=true and the exact short-lived token from preview_link_actor_journal. Sets flags[\"foundry-mcp-bridge\"].linkedJournalEntryId on the actor and .linkedActorId on the journal entry, bidirectionally, and reads both back as the receipt.",
      inputSchema: { actorId: z.string().min(1), entryId: z.string().min(1), confirmationToken: z.string().uuid() },
      annotations: { destructiveHint: false },
    },
    async ({ actorId, entryId, confirmationToken }) => {
      if (!writeEnabled) return disabledResult();
      try {
        const res = await http.post(`/api/mcp/actors/${actorId}/link-journal`, { entryId, confirmationToken });
        return textResult(res.data);
      } catch (e: any) { return errorResult(e.response?.data?.error ?? e.message); }
    },
  );

  server.registerTool(
    "preview_journal_write",
    {
      description:
        "Preview creating a campaign journal entry, or adding/updating one page on an existing entry, with an explicit visibility. Read-only: returns the exact resolved audience by player name plus a short-lived confirmation token for apply_journal_write. Visibility is required and there is no default. Everything in one call gets exactly one visibility — build a mixed-visibility entry (e.g. a public overview plus a GM-only secret page) with a second, separately previewed and confirmed call, never by mixing visibilities in one.",
      inputSchema: {
        operation: z.enum(["create-entry", "add-page", "update-page"]),
        entryId: z.string().min(1).optional().describe("Required for add-page and update-page"),
        pageId: z.string().min(1).optional().describe("Required for update-page"),
        name: z.string().min(1).optional().describe("Entry name; required for create-entry"),
        folder: z.string().optional().describe("Journal folder name or id, for create-entry"),
        knowledge: journalKnowledgeSchema,
        pages: z.array(journalPageSchema).min(1).max(20).describe("Exactly one page for add-page and update-page"),
        visibility: journalVisibilitySchema,
      },
      annotations: { readOnlyHint: true },
    },
    async ({ operation, entryId, pageId, name, folder, knowledge, pages, visibility }) => {
      try {
        const res = await http.post("/api/mcp/journal/write/preview", { operation, entryId, pageId, name, folder, knowledge, pages, visibility });
        return textResult(res.data);
      } catch (e: any) { return errorResult(e.response?.data?.error ?? e.message); }
    },
  );

  server.registerTool(
    "apply_journal_write",
    {
      description:
        "Apply an exactly previewed journal write through the active GM bridge. Requires FOUNDRY_WRITE_ENABLED=true and the exact short-lived token from preview_journal_write. The receipt names every player who can see the result, read back from the written document — report that receipt to the user verbatim; an unverified visibility claim on a spoiler-sensitive write is worthless. Rejected if anything about the request (including the resolved audience) differs from what was previewed.",
      inputSchema: {
        operation: z.enum(["create-entry", "add-page", "update-page"]),
        entryId: z.string().min(1).optional(),
        pageId: z.string().min(1).optional(),
        name: z.string().min(1).optional(),
        folder: z.string().optional(),
        knowledge: journalKnowledgeSchema,
        pages: z.array(journalPageSchema).min(1).max(20),
        visibility: journalVisibilitySchema,
        confirmationToken: z.string().uuid(),
      },
      annotations: { destructiveHint: false },
    },
    async ({ operation, entryId, pageId, name, folder, knowledge, pages, visibility, confirmationToken }) => {
      if (!writeEnabled) return disabledResult();
      try {
        const res = await http.post("/api/mcp/journal/write", { operation, entryId, pageId, name, folder, knowledge, pages, visibility, confirmationToken });
        return textResult(res.data);
      } catch (e: any) { return errorResult(e.response?.data?.error ?? e.message); }
    },
  );
}
