const MODULE_ID = "foundry-mcp-bridge";
export const MODULE_SOCKET = `module.${MODULE_ID}`;
export const PREPARED_ACTOR_READY = "prepared-actor-bridge-ready";
export const PREPARED_ACTOR_REQUEST = "prepared-actor-request";
export const PREPARED_ACTOR_RESPONSE = "prepared-actor-response";

const numberOrNull = (value) => Number.isFinite(value) ? value : null;

function summarizeAbilities(abilities = {}) {
  return Object.fromEntries(Object.entries(abilities).map(([key, ability]) => [key, {
    value: numberOrNull(ability?.value),
    mod: numberOrNull(ability?.mod),
    save: numberOrNull(ability?.save),
    proficient: ability?.proficient === 1 || ability?.proficient === true,
  }]));
}

function summarizeSpellSlots(spells = {}) {
  return Object.fromEntries(
    Object.entries(spells)
      .filter(([key, slot]) => /^spell[1-9]$/.test(key) && slot && typeof slot === "object")
      .map(([key, slot]) => [key, {
        value: numberOrNull(slot.value),
        max: numberOrNull(slot.max),
        override: numberOrNull(slot.override),
      }]),
  );
}

export function summarizePreparedActor(actor) {
  const system = actor?.system ?? {};
  const attributes = system.attributes ?? {};

  return {
    dataProvenance: {
      source: "Foundry client Actor document",
      prepared: true,
      interpretation: "Values were prepared by the active Foundry client, including system calculations and active effects.",
    },
    _id: actor?.id ?? actor?._id ?? null,
    name: actor?.name ?? "Unnamed actor",
    type: actor?.type ?? null,
    details: {
      level: numberOrNull(system.details?.level),
      challengeRating: numberOrNull(system.details?.cr),
    },
    hp: {
      value: numberOrNull(attributes.hp?.value),
      max: numberOrNull(attributes.hp?.max),
      temp: numberOrNull(attributes.hp?.temp),
      tempmax: numberOrNull(attributes.hp?.tempmax),
    },
    ac: {
      value: numberOrNull(attributes.ac?.value),
      flat: numberOrNull(attributes.ac?.flat),
      calculation: attributes.ac?.calc ?? attributes.ac?.calculation ?? null,
    },
    abilities: summarizeAbilities(system.abilities),
    spellSlots: summarizeSpellSlots(system.spells),
  };
}

function emitResponse(message) {
  globalThis.game?.socket?.emit(MODULE_SOCKET, message);
}

function registerPreparedActorBridge() {
  if (!globalThis.game?.user?.isGM) return;

  console.info("MCP Bridge: prepared actor bridge ready", { module: MODULE_ID, userId: globalThis.game.user.id });
  globalThis.ui?.notifications?.info("MCP Bridge: prepared actor bridge ready");

  emitResponse({
    type: PREPARED_ACTOR_READY,
    responderUserId: globalThis.game.user?.id ?? null,
    readyAt: Date.now(),
  });

  globalThis.game?.socket?.on(MODULE_SOCKET, (message) => {
    if (message?.type !== PREPARED_ACTOR_REQUEST) return;

    const actor = globalThis.game.actors?.get(message.actorId);
    if (!actor) {
      emitResponse({
        type: PREPARED_ACTOR_RESPONSE,
        requestId: message.requestId,
        error: `Actor '${message.actorId}' was not found by the active GM client.`,
      });
      return;
    }

    emitResponse({
      type: PREPARED_ACTOR_RESPONSE,
      requestId: message.requestId,
      responderUserId: globalThis.game.user.id,
      summary: summarizePreparedActor(actor),
    });
  });
}

if (globalThis.Hooks) globalThis.Hooks.once("ready", registerPreparedActorBridge);
