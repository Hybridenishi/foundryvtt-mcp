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

function conditionCatalog() {
  return new Map((globalThis.CONFIG?.statusEffects ?? [])
    .filter((status) => typeof status?.id === "string")
    .map((status) => [status.id, { id: status.id, name: status.name ?? status.id }]));
}

function summarizeConditions(actor) {
  const catalog = conditionCatalog();
  return [...(actor?.statuses ?? [])].map((id) => ({ id, name: catalog.get(id)?.name ?? id }));
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
    conditions: summarizeConditions(actor),
  };
}

export function summarizePreparedParty(actors) {
  return {
    dataProvenance: {
      source: "Foundry client Actor documents",
      prepared: true,
      interpretation: "Values were prepared by the active Foundry client, including system calculations and active effects.",
    },
    actors: [...actors]
      .filter((actor) => actor?.type === "character")
      .map(summarizePreparedActor)
      .sort((left, right) => left.name.localeCompare(right.name)),
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

function validateTemporaryHp(request) {
  const amount = request?.amount;
  if (!Number.isInteger(amount) || amount < 0 || amount > 100_000) {
    throw new Error("Temporary HP amount must be an integer between 0 and 100000.");
  }
  return { amount };
}

export function previewTemporaryHp(actor, request) {
  const { amount } = validateTemporaryHp(request);
  const hp = actor?.system?.attributes?.hp;
  if (!hp || !Number.isFinite(hp.value) || !Number.isFinite(hp.max)) {
    throw new Error("This actor does not have prepared current and maximum HP.");
  }
  const before = summarizePreparedActor(actor).hp;
  return {
    actorId: actor.id ?? actor._id ?? null,
    actorName: actor.name ?? "Unnamed actor",
    operation: "set-temporary-hp",
    requestedTemporaryHp: amount,
    rulesNote: "This operation replaces the actor's current temporary HP with the exact requested value. It does not decide whether a newly granted temporary-HP effect should replace an existing value.",
    before,
    after: { ...before, temp: amount },
  };
}

export async function setTemporaryHp(actor, request) {
  const preview = previewTemporaryHp(actor, request);
  if (typeof actor.update !== "function") {
    throw new Error("The Foundry Actor.update method is unavailable.");
  }
  await actor.update({ "system.attributes.hp.temp": request.amount });
  return { ...preview, after: summarizePreparedActor(actor).hp };
}

function validateConditionChange(request) {
  const mode = request?.mode;
  const statusId = request?.statusId;
  if (mode !== "add" && mode !== "remove") throw new Error("Condition mode must be 'add' or 'remove'.");
  if (typeof statusId !== "string" || !/^[a-z0-9-]{1,80}$/i.test(statusId)) throw new Error("statusId must be a valid condition identifier.");
  if (statusId === "exhaustion") throw new Error("Exhaustion is level-based and is not supported by the generic condition tool.");
  const status = conditionCatalog().get(statusId);
  if (!status) throw new Error(`Condition '${statusId}' is not available in this Foundry world.`);
  return { mode, statusId, status };
}

export function previewConditionChange(actor, request) {
  const { mode, statusId, status } = validateConditionChange(request);
  const before = summarizeConditions(actor);
  const active = before.some((condition) => condition.id === statusId);
  const after = mode === "add"
    ? (active ? before : [...before, status])
    : before.filter((condition) => condition.id !== statusId);
  return {
    actorId: actor.id ?? actor._id ?? null,
    actorName: actor.name ?? "Unnamed actor",
    operation: `${mode}-condition`,
    condition: status,
    before,
    after,
  };
}

export async function applyConditionChange(actor, request) {
  const preview = previewConditionChange(actor, request);
  if (typeof actor.toggleStatusEffect !== "function") throw new Error("The Foundry Actor.toggleStatusEffect method is unavailable.");
  await actor.toggleStatusEffect(request.statusId, { active: request.mode === "add" });
  return { ...preview, after: summarizeConditions(actor) };
}

function resourceSnapshot(actor, item, activity) {
  const serialize = (value) => JSON.parse(JSON.stringify(value ?? null));
  return {
    activityUses: serialize(activity.uses),
    itemUses: serialize(item.system?.uses),
    actorResources: serialize(actor.system?.resources),
    spellSlots: serialize(actor.system?.spells),
    activation: serialize(actor.system?.attributes?.activation),
  };
}

function changedResources(before, after) {
  return Object.fromEntries(
    Object.keys(before).filter((key) => JSON.stringify(before[key]) !== JSON.stringify(after[key]))
      .map((key) => [key, { before: before[key], after: after[key] }]),
  );
}

function resolveUtilityActivity(actor, request) {
  const itemId = request?.itemId;
  const activityId = request?.activityId;
  const item = typeof itemId === "string" ? actor.items?.get(itemId) : null;
  if (!item) throw new Error(`Item '${itemId}' was not found on actor '${actor.id}'.`);

  const activity = typeof activityId === "string" ? item.system?.activities?.get(activityId) : null;
  if (!activity) throw new Error(`Activity '${activityId}' was not found on item '${item.name}'.`);
  if (activity.type !== "utility") {
    throw new Error("This first activity-execution release only supports dnd5e utility activities.");
  }
  if (typeof activity.use !== "function") {
    throw new Error("The installed dnd5e Activity#use method is unavailable.");
  }
  const targetType = activity.target?.affects?.type;
  const targetCount = activity.target?.affects?.count;
  if (activity.target?.template?.type || (activity.target?.prompt && targetType !== "self") || (targetType && targetType !== "self") || (targetCount && targetType !== "self")) {
    throw new Error("This utility activity cannot run without a target or template selection.");
  }
  if (activity.requiresSpellSlot || activity.canScale || activity.requiresConcentration) {
    throw new Error("This utility activity requires a spell slot, scaling, or concentration choice and cannot run unattended.");
  }
  if (!activity.canUse) {
    throw new Error("dnd5e reports that this utility activity cannot currently be used.");
  }
  const activeTokens = typeof actor.getActiveTokens === "function" ? actor.getActiveTokens(true, true) : [];
  if (!activeTokens.length) {
    throw new Error("This actor has no token on an active scene. dnd5e activity execution requires a placed token, even for a self-targeted activity with no other target.");
  }
  return { item, activity };
}

function summarizeUsageResult(results) {
  return {
    message: results?.message ? {
      id: results.message.id ?? null,
      uuid: results.message.uuid ?? null,
      title: results.message.title ?? null,
    } : null,
    effects: (results?.effects ?? []).map((effect) => ({ id: effect?.id ?? null, uuid: effect?.uuid ?? null, name: effect?.name ?? null })),
    templates: (results?.templates ?? []).map((template) => ({ id: template?.id ?? null, uuid: template?.uuid ?? null })),
    dnd5eUpdates: results?.updates ?? null,
  };
}

export function previewUtilityActivityUse(actor, request) {
  const { item, activity } = resolveUtilityActivity(actor, request);
  return {
    actorId: actor.id,
    actorName: actor.name,
    itemId: item.id,
    itemName: item.name,
    activityId: activity.id,
    activityName: activity.name,
    operation: "use-utility",
    options: {},
    execution: "dnd5e Activity#use({}, { configure: false })",
    cautions: [
      "This preview does not execute the activity or calculate its final outcome.",
      "dnd5e will validate and determine any real resource consumption, effects, and chat output at execution time.",
    ],
    observedResources: resourceSnapshot(actor, item, activity),
  };
}

export async function executeUtilityActivityUse(actor, request) {
  const { item, activity } = resolveUtilityActivity(actor, request);
  const preview = previewUtilityActivityUse(actor, request);
  const before = resourceSnapshot(actor, item, activity);
  const results = await activity.use({}, { configure: false });
  if (!results) throw new Error("dnd5e did not execute the utility activity.");
  const after = resourceSnapshot(actor, item, activity);
  return {
    ...preview,
    result: summarizeUsageResult(results),
    observedResourceChanges: changedResources(before, after),
  };
}

async function handleBridgeRequest(request) {
  if (request.type === "prepared-party-summary") {
    return summarizePreparedParty(globalThis.game?.actors?.contents ?? globalThis.game?.actors ?? []);
  }
  const actor = globalThis.game?.actors?.get(request.actorId);
  if (!actor) throw new Error(`Actor '${request.actorId}' was not found by the active GM client.`);

  switch (request.type ?? "prepared-actor-summary") {
    case "prepared-actor-summary":
      return summarizePreparedActor(actor);
    case "preview-hp-change":
      return previewHpChange(actor, request);
    case "apply-hp-change":
      return applyHpChange(actor, request);
    case "preview-temporary-hp":
      return previewTemporaryHp(actor, request);
    case "set-temporary-hp":
      return setTemporaryHp(actor, request);
    case "preview-condition-change":
      return previewConditionChange(actor, request);
    case "apply-condition-change":
      return applyConditionChange(actor, request);
    case "preview-utility-activity-use":
      return previewUtilityActivityUse(actor, request);
    case "use-utility-activity":
      return executeUtilityActivityUse(actor, request);
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
