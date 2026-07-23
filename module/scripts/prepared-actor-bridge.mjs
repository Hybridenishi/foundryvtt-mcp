const MODULE_ID = "foundry-mcp-bridge";
const BRIDGE_PATH = "/mcp-bridge";
// Disposable test-environment credential. A release-ready module must load
// this from a GM-only setting instead of shipping it in public source.
const BRIDGE_API_KEY = "mcp-bridge-key-2026";

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

function delay(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

async function bridgeFetch(path, options = {}) {
  return fetch(`${BRIDGE_PATH}${path}`, {
    ...options,
    credentials: "same-origin",
    headers: {
      "Content-Type": "application/json",
      "X-MCP-Bridge-Key": BRIDGE_API_KEY,
      ...(options.headers ?? {}),
    },
  });
}

async function runPreparedActorBridge(clientId) {
  while (true) {
    try {
      const poll = await bridgeFetch(`/poll?clientId=${encodeURIComponent(clientId)}`);
      if (poll.status === 204) continue;
      if (!poll.ok) throw new Error(`Bridge poll failed (${poll.status})`);

      const request = await poll.json();
      const actor = globalThis.game?.actors?.get(request.actorId);
      const response = actor
        ? { clientId, requestId: request.requestId, summary: summarizePreparedActor(actor) }
        : { clientId, requestId: request.requestId, error: `Actor '${request.actorId}' was not found by the active GM client.` };
      const delivered = await bridgeFetch("/respond", { method: "POST", body: JSON.stringify(response) });
      if (!delivered.ok) throw new Error(`Bridge response failed (${delivered.status})`);
    } catch (error) {
      console.warn("MCP Bridge: prepared actor bridge reconnecting", error);
      await delay(3_000);
      await bridgeFetch("/ready", {
        method: "POST",
        body: JSON.stringify({ clientId, userId: globalThis.game?.user?.id ?? null }),
      }).catch(() => {});
    }
  }
}

async function registerPreparedActorBridge() {
  if (!globalThis.game?.user?.isGM) return;
  const clientId = crypto.randomUUID();
  try {
    const ready = await bridgeFetch("/ready", {
      method: "POST",
      body: JSON.stringify({ clientId, userId: globalThis.game.user.id }),
    });
    if (!ready.ok) throw new Error(`unable to announce readiness (${ready.status})`);

    console.info("MCP Bridge: prepared actor HTTP bridge ready", { module: MODULE_ID, userId: globalThis.game.user.id });
    globalThis.ui?.notifications?.info("MCP Bridge: prepared actor bridge ready");
    void runPreparedActorBridge(clientId);
  } catch (error) {
    console.error("MCP Bridge: prepared actor bridge unavailable", error);
    globalThis.ui?.notifications?.error("MCP Bridge: prepared actor bridge unavailable");
  }
}

if (globalThis.Hooks) globalThis.Hooks.once("ready", registerPreparedActorBridge);
