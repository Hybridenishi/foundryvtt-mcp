import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { FoundryClient } from "../client.js";

type Document = Record<string, unknown>;

function textResult(value: unknown) {
  return { content: [{ type: "text" as const, text: JSON.stringify(value, null, 2) }] };
}

function documentId(document: Document): string | undefined {
  return typeof document._id === "string" ? document._id : typeof document.id === "string" ? document.id : undefined;
}

function emit(socket: ReturnType<FoundryClient["exposeSocket"]>, event: string, data: unknown): void {
  socket.emit(event, data);
}

function enabled(writeEnabled: boolean) {
  return writeEnabled ? undefined : textResult({ error: "Write tools are disabled. Set FOUNDRY_WRITE_ENABLED=true to enable them." });
}

function hasPath(value: unknown, path: string): boolean {
  let current: unknown = value;
  for (const part of path.split(".")) {
    if (current === null || typeof current !== "object" || !(part in current)) return false;
    current = (current as Document)[part];
  }
  return true;
}

function validActorPatchPaths(actor: Document, patch: Record<string, unknown>): string[] {
  const system = actor.system;
  return Object.keys(patch).filter((path) => {
    if (hasPath(actor, path)) return false;
    const systemPath = path.startsWith("system.") ? path.slice("system.".length) : path;
    return !hasPath(system, systemPath);
  });
}

export function registerWriteTools(server: McpServer, client: FoundryClient, writeEnabled: boolean): void {
  server.registerTool(
    "update_actor",
    {
      description: "Update an actor with Foundry document update paths. Requires FOUNDRY_WRITE_ENABLED=true.",
      inputSchema: { actorId: z.string().min(1), patch: z.record(z.string(), z.unknown()).refine((value) => Object.keys(value).length > 0, "patch must not be empty") },
      annotations: { destructiveHint: false },
    },
    ({ actorId, patch }) => {
      const denied = enabled(writeEnabled);
      if (denied) return denied;
      const actor = client.getWorldData().actors.find((entry) => documentId(entry) === actorId);
      if (!actor) return textResult({ error: `Actor '${actorId}' was not found.` });
      const invalidPaths = validActorPatchPaths(actor, patch);
      if (invalidPaths.length > 0) {
        return textResult({ error: "Patch contains paths that do not exist on this actor.", invalidPaths });
      }
      emit(client.exposeSocket(), "modifyDocument", { type: "Actor", action: "update", operation: { updates: [{ _id: actorId, ...patch }] } });
      return textResult({ ok: true, actorId, patch });
    },
  );

  server.registerTool(
    "set_initiative",
    {
      description: "Set an active combatant's initiative. Requires FOUNDRY_WRITE_ENABLED=true.",
      inputSchema: { combatantId: z.string().min(1), value: z.number().finite() },
      annotations: { destructiveHint: false },
    },
    ({ combatantId, value }) => {
      const denied = enabled(writeEnabled);
      if (denied) return denied;
      const combat = client.getWorldData().combats.find((entry) =>
        Array.isArray(entry.combatants) && entry.combatants.some((combatant) => {
          const item = combatant as Document;
          return documentId(item) === combatantId;
        }),
      );
      const combatId = combat && documentId(combat);
      if (!combat || !combatId) return textResult({ error: `Combatant '${combatantId}' was not found.` });
      emit(client.exposeSocket(), "modifyDocument", {
        type: "Combat", action: "update", operation: { updates: [{ _id: combatId, [`combatants.${combatantId}.initiative`]: value }] },
      });
      return textResult({ ok: true, combatId, combatantId, initiative: value });
    },
  );

  server.registerTool(
    "next_turn",
    { description: "Advance a combat to its next turn. Requires FOUNDRY_WRITE_ENABLED=true.", inputSchema: { combat_id: z.string().optional() }, annotations: { destructiveHint: false } },
    ({ combat_id }) => {
      const denied = enabled(writeEnabled);
      if (denied) return denied;
      const combat = client.getWorldData().combats.find((entry) => documentId(entry) === combat_id) ??
        client.getWorldData().combats.find((entry) => entry.active === true);
      const combatId = combat && documentId(combat);
      if (!combat || !combatId) return textResult({ error: combat_id ? `Combat '${combat_id}' was not found.` : "No active combat was found." });
      const combatants = Array.isArray(combat.combatants) ? combat.combatants : [];
      if (combatants.length === 0) return textResult({ error: "The combat has no combatants." });
      const currentTurn = typeof combat.turn === "number" ? combat.turn : -1;
      const turn = (currentTurn + 1) % combatants.length;
      const updates: Document = { _id: combatId, turn };
      if (turn === 0) updates.round = (typeof combat.round === "number" ? combat.round : 0) + 1;
      emit(client.exposeSocket(), "modifyDocument", { type: "Combat", action: "update", operation: { updates: [updates] } });
      return textResult({ ok: true, combatId, round: updates.round ?? combat.round, turn });
    },
  );

  server.registerTool(
    "create_chat_message",
    {
      description: "Create a Foundry chat message. Requires FOUNDRY_WRITE_ENABLED=true.",
      inputSchema: { content: z.string().min(1), type: z.union([z.string(), z.number().int()]).optional() },
      annotations: { destructiveHint: false },
    },
    ({ content, type }) => {
      const denied = enabled(writeEnabled);
      if (denied) return denied;
      emit(client.exposeSocket(), "modifyDocument", {
        type: "ChatMessage", action: "create", operation: { data: [{ content, ...(type === undefined ? {} : { type }) }] },
      });
      return textResult({ ok: true, content, type });
    },
  );
}
