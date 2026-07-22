import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { FoundryClient } from "../client.js";

type Document = Record<string, unknown>;

const DEFAULT_LIMIT = 20;
const MAX_LIMIT = 100;

function textResult(value: unknown) {
  return { content: [{ type: "text" as const, text: JSON.stringify(value, null, 2) }] };
}

function documentId(document: Document): string | undefined {
  return typeof document._id === "string" ? document._id : typeof document.id === "string" ? document.id : undefined;
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function objectValue(value: unknown): Document | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? (value as Document) : undefined;
}

function limited(limit: number | undefined): number {
  return Math.min(limit ?? DEFAULT_LIMIT, MAX_LIMIT);
}

function matches(document: Document, query: string | undefined, type: string | undefined): boolean {
  const name = stringValue(document.name) ?? "";
  const documentType = stringValue(document.type) ?? "";
  return (!query || name.toLocaleLowerCase().includes(query.toLocaleLowerCase())) && (!type || documentType === type);
}

function summary(document: Document) {
  return { _id: documentId(document), name: stringValue(document.name), type: stringValue(document.type) };
}

function searchDocuments(documents: Document[], query: string | undefined, type: string | undefined, limit: number | undefined) {
  return documents.filter((document) => matches(document, query, type)).slice(0, limited(limit)).map(summary);
}

function journalText(document: Document): string {
  const pages = Array.isArray(document.pages) ? document.pages : [];
  const pageText = pages
    .map((page) => {
      const pageObject = objectValue(page);
      const text = objectValue(pageObject?.text);
      return `${stringValue(pageObject?.name) ?? ""} ${stringValue(text?.content) ?? ""}`;
    })
    .join(" ");
  return `${stringValue(document.name) ?? ""} ${stringValue(document.content) ?? ""} ${pageText}`;
}

export function registerReadTools(server: McpServer, client: FoundryClient): void {
  server.registerTool(
    "search_actors",
    {
      description: "Search cached Foundry actors by name and optional type.",
      inputSchema: { query: z.string().optional(), type: z.string().optional(), limit: z.number().int().min(1).max(MAX_LIMIT).optional() },
    },
    ({ query, type, limit }) => textResult(searchDocuments(client.getWorldData().actors, query, type, limit)),
  );

  server.registerTool(
    "get_actor",
    { description: "Get a Foundry actor, including its complete system data.", inputSchema: { actorId: z.string().min(1) } },
    ({ actorId }) => {
      const actor = client.getWorldData().actors.find((entry) => documentId(entry) === actorId);
      if (!actor) return textResult({ error: `Actor '${actorId}' was not found.` });
      return textResult(actor);
    },
  );

  server.registerTool(
    "search_items",
    {
      description: "Search cached Foundry items by name and optional type.",
      inputSchema: { query: z.string().optional(), type: z.string().optional(), limit: z.number().int().min(1).max(MAX_LIMIT).optional() },
    },
    ({ query, type, limit }) => textResult(searchDocuments(client.getWorldData().items, query, type, limit)),
  );

  server.registerTool(
    "get_scenes",
    { description: "List Foundry scenes and their activation and navigation settings." },
    () => textResult(client.getWorldData().scenes.map((scene) => ({
      _id: documentId(scene), name: stringValue(scene.name), active: scene.active === true,
      navigation: scene.navigation === true, navName: stringValue(scene.navName), navOrder: scene.navOrder,
    }))),
  );

  server.registerTool(
    "get_combat_state",
    { description: "Get the active combat state, optionally for one scene.", inputSchema: { scene_id: z.string().optional() } },
    ({ scene_id }) => {
      const combats = client.getWorldData().combats.filter((combat) =>
        combat.active === true && (!scene_id || combat.scene === scene_id || combat.sceneId === scene_id),
      );
      return textResult(combats.map((combat) => ({
        _id: documentId(combat), scene_id: combat.scene ?? combat.sceneId, round: combat.round, turn: combat.turn,
        combatants: Array.isArray(combat.combatants) ? combat.combatants.map((combatant) => {
          const item = objectValue(combatant) ?? {};
          return { _id: documentId(item), name: item.name, actorId: item.actorId, initiative: item.initiative, defeated: item.defeated };
        }) : [],
      })));
    },
  );

  server.registerTool(
    "get_chat_log",
    {
      description: "Get the most recent cached Foundry chat messages, optionally filtered by speaker.",
      inputSchema: { limit: z.number().int().min(1).max(MAX_LIMIT).optional(), speaker: z.string().optional() },
    },
    ({ limit, speaker }) => {
      const messages = client.getWorldData().messages.filter((message) => {
        if (!speaker) return true;
        const source = objectValue(message.speaker);
        const fields = [message.user, source?.alias, source?.actor, source?.token].filter((value): value is string => typeof value === "string");
        return fields.some((value) => value.toLocaleLowerCase().includes(speaker.toLocaleLowerCase()));
      });
      return textResult(messages.slice(-limited(limit)).reverse());
    },
  );

  server.registerTool(
    "search_journal",
    { description: "Full-text search cached Foundry journal entries.", inputSchema: { query: z.string().min(1), limit: z.number().int().min(1).max(MAX_LIMIT).optional() } },
    ({ query, limit }) => {
      const normalized = query.toLocaleLowerCase();
      const results = client.getWorldData().journal.filter((entry) => journalText(entry).toLocaleLowerCase().includes(normalized))
        .slice(0, limited(limit));
      return textResult(results);
    },
  );

  server.registerTool(
    "get_online_users",
    { description: "List currently active Foundry users." },
    () => {
      const world = client.getWorldData();
      const reportedActive = Array.isArray(world.activeUsers) ? world.activeUsers : undefined;
      const users = reportedActive
        ? reportedActive.map((entry) => typeof entry === "string" ? world.users.find((user) => documentId(user) === entry) : objectValue(entry)).filter((entry): entry is Document => entry !== undefined)
        : world.users.filter((user) => user.active === true);
      return textResult(users.map((user) => ({
      _id: documentId(user), name: user.name, role: user.role, active: user.active,
      })));
    },
  );

  server.registerTool(
    "world_summary",
    { description: "Get counts of cached Foundry world documents." },
    () => {
      const world = client.getWorldData();
      return textResult({ actors: world.actors.length, scenes: world.scenes.length, items: world.items.length, combats: world.combats.length, users: world.users.length });
    },
  );
}
