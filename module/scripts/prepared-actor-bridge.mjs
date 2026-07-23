const MODULE_ID = "foundry-mcp-bridge";
const BRIDGE_PATH = "/mcp-bridge";
let bridgeToken = null;

const numberOrNull = (value) => Number.isFinite(value) ? value : null;
const clamp = (value, min, max) => Math.min(Math.max(value, min), max);

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

function hpValue(value) {
  return Number.isFinite(value) ? value : 0;
}

function validateHpChange(request) {
  const mode = request?.mode;
  const amount = request?.amount;
  if (mode !== "damage" && mode !== "healing") {
    throw new Error("HP change mode must be 'damage' or 'healing'.");
  }
  if (!Number.isInteger(amount) || amount < 1 || amount > 100_000) {
    throw new Error("HP change amount must be an integer between 1 and 100000.");
  }
  return { mode, amount };
}

export function previewHpChange(actor, request) {
  const { mode, amount } = validateHpChange(request);
  const hp = actor?.system?.attributes?.hp;
  if (!hp || !Number.isFinite(hp.value) || !Number.isFinite(hp.max)) {
    throw new Error("This actor does not have prepared current and maximum HP.");
  }

  const before = {
    value: hpValue(hp.value),
    max: hpValue(hp.max),
    temp: hpValue(hp.temp),
    tempmax: hpValue(hp.tempmax),
  };
  const tempAbsorbed = mode === "damage" ? Math.min(before.temp, amount) : 0;
  const hpDelta = mode === "damage" ? -(amount - tempAbsorbed) : amount;
  const nextValue = clamp(before.value + hpDelta, 0, before.max);
  const after = {
    value: nextValue,
    max: before.max,
    temp: before.temp - tempAbsorbed,
    tempmax: before.tempmax,
  };

  return {
    actorId: actor.id ?? actor._id ?? null,
    actorName: actor.name ?? "Unnamed actor",
    mode,
    requestedAmount: amount,
    directHpChange: true,
    rulesNote: "Direct HP damage/healing uses dnd5e Actor.applyDamage with no damage type; resistance, vulnerability, and immunity are not calculated.",
    before,
    after,
    appliedToTemp: tempAbsorbed,
    appliedToHp: Math.abs(after.value - before.value),
    unspentAmount: mode === "damage"
      ? Math.max(0, amount - tempAbsorbed - before.value)
      : Math.max(0, before.value + amount - before.max),
  };
}

async function applyHpChange(actor, request) {
  const preview = previewHpChange(actor, request);
  if (typeof actor.applyDamage !== "function") {
    throw new Error("The installed dnd5e Actor.applyDamage method is unavailable.");
  }
  await actor.applyDamage(request.mode === "damage" ? request.amount : -request.amount);
  return {
    ...preview,
    after: summarizePreparedActor(actor).hp,
  };
}

async function handleBridgeRequest(request) {
  const actor = globalThis.game?.actors?.get(request.actorId);
  if (!actor) throw new Error(`Actor '${request.actorId}' was not found by the active GM client.`);

  switch (request.type ?? "prepared-actor-summary") {
    case "prepared-actor-summary":
      return summarizePreparedActor(actor);
    case "preview-hp-change":
      return previewHpChange(actor, request);
    case "apply-hp-change":
      return applyHpChange(actor, request);
    default:
      throw new Error(`Unsupported MCP Bridge request type '${request.type}'.`);
  }
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
      ...(bridgeToken ? { "X-MCP-Bridge-Token": bridgeToken } : {}),
      ...(options.headers ?? {}),
    },
  });
}

async function announceBridge(clientId) {
  bridgeToken = null;
  const ready = await bridgeFetch("/ready", {
    method: "POST",
    body: JSON.stringify({ clientId }),
  });
  if (!ready.ok) throw new Error(`unable to pair GM bridge (${ready.status})`);
  const pairing = await ready.json();
  if (typeof pairing.bridgeToken !== "string" || pairing.bridgeToken.length < 20) {
    throw new Error("GM bridge pairing response did not include a valid session token");
  }
  bridgeToken = pairing.bridgeToken;
}

async function runPreparedActorBridge(clientId) {
  while (true) {
    try {
      const poll = await bridgeFetch(`/poll?clientId=${encodeURIComponent(clientId)}`);
      if (poll.status === 204) continue;
      if (!poll.ok) throw new Error(`Bridge poll failed (${poll.status})`);

      const request = await poll.json();
      let response;
      try {
        response = { clientId, requestId: request.requestId, result: await handleBridgeRequest(request) };
      } catch (error) {
        response = { clientId, requestId: request.requestId, error: error instanceof Error ? error.message : String(error) };
      }
      const delivered = await bridgeFetch("/respond", { method: "POST", body: JSON.stringify(response) });
      if (!delivered.ok) throw new Error(`Bridge response failed (${delivered.status})`);
    } catch (error) {
      console.warn("MCP Bridge: prepared actor bridge reconnecting", error);
      await delay(3_000);
      await announceBridge(clientId).catch(() => {});
    }
  }
}

async function registerPreparedActorBridge() {
  if (!globalThis.game?.user?.isGM) return;
  const clientId = crypto.randomUUID();
  try {
    await announceBridge(clientId);

    console.info("MCP Bridge: prepared actor HTTP bridge ready", { module: MODULE_ID, userId: globalThis.game.user.id });
    globalThis.ui?.notifications?.info("MCP Bridge: prepared actor bridge ready");
    void runPreparedActorBridge(clientId);
  } catch (error) {
    console.error("MCP Bridge: prepared actor bridge unavailable", error);
    globalThis.ui?.notifications?.error("MCP Bridge: prepared actor bridge unavailable");
  }
}

if (globalThis.Hooks) globalThis.Hooks.once("ready", registerPreparedActorBridge);
