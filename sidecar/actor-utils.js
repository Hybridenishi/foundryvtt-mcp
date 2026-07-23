const DEFAULT_LIMIT = 20;
const MAX_LIMIT = 100;

const RAW_DOCUMENT_PROVENANCE = Object.freeze({
  source: "Foundry world-document snapshot",
  prepared: false,
  interpretation: "Derived dnd5e values may be absent or null in this snapshot. Do not infer that combat, HP, AC, level, spell slots, or ability modifiers are broken; confirm those in Foundry's character sheet or through a prepared-data bridge.",
});

const CORE_ACTIVITY_TYPES = new Set([
  "attack",
  "cast",
  "check",
  "damage",
  "enchant",
  "forward",
  "heal",
  "save",
  "summon",
  "transform",
  "utility",
]);

function collectionValues(value) {
  if (Array.isArray(value)) return value;
  if (value && typeof value === "object") return Object.values(value);
  return [];
}

function stringValue(value) {
  return typeof value === "string" ? value : "";
}

function numberValue(value, fallback = null) {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

function boundedNumber(value, fallback, min, max) {
  const parsed = Number.parseInt(String(value), 10);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.max(min, Math.min(max, parsed));
}

function pagination(query = {}) {
  return {
    limit: boundedNumber(query.limit, DEFAULT_LIMIT, 1, MAX_LIMIT),
    offset: boundedNumber(query.offset, 0, 0, Number.MAX_SAFE_INTEGER),
  };
}

function rulesSource(item) {
  const rules = item?.system?.source?.rules;
  return typeof rules === "string" && rules.length > 0 ? rules : null;
}

function actorItems(actor) {
  return collectionValues(actor?.items);
}

function itemActivities(item) {
  const activities = item?.system?.activities;
  if (!activities || typeof activities !== "object") return [];

  if (Array.isArray(activities)) {
    return activities.filter((activity) => activity && typeof activity === "object");
  }

  return Object.entries(activities)
    .filter(([, activity]) => activity && typeof activity === "object")
    .map(([id, activity]) => ({ ...activity, _id: activity._id ?? id }));
}

function countBy(values) {
  return values.reduce((counts, value) => {
    const key = value || "unspecified";
    counts[key] = (counts[key] ?? 0) + 1;
    return counts;
  }, {});
}

function summarizeAbility(ability = {}) {
  return {
    value: numberValue(ability.value),
    mod: numberValue(ability.mod),
    save: numberValue(ability.save),
    proficient: ability.proficient === 1 || ability.proficient === true,
  };
}

function summarizeSpellSlots(spells = {}) {
  return Object.fromEntries(
    Object.entries(spells)
      .filter(([, slot]) => slot && typeof slot === "object")
      .map(([key, slot]) => [key, {
        value: numberValue(slot.value),
        max: numberValue(slot.max),
        override: numberValue(slot.override),
      }]),
  );
}

function summarizeActor(actor) {
  const system = actor?.system ?? {};
  const attributes = system.attributes ?? {};
  const abilities = system.abilities ?? {};
  const items = actorItems(actor);
  const activities = items.flatMap(itemActivities);

  return {
    dataProvenance: RAW_DOCUMENT_PROVENANCE,
    _id: actor?._id ?? actor?.id ?? null,
    name: actor?.name ?? "Unnamed actor",
    type: actor?.type ?? null,
    details: {
      level: numberValue(system.details?.level),
      challengeRating: system.details?.cr ?? null,
      race: system.details?.race ?? null,
    },
    hp: {
      value: numberValue(attributes.hp?.value),
      max: numberValue(attributes.hp?.max),
      temp: numberValue(attributes.hp?.temp),
      tempmax: numberValue(attributes.hp?.tempmax),
    },
    ac: {
      value: numberValue(attributes.ac?.value),
      flat: numberValue(attributes.ac?.flat),
      calculation: attributes.ac?.calc ?? attributes.ac?.calculation ?? null,
    },
    movement: attributes.movement ?? {},
    senses: attributes.senses ?? {},
    abilities: Object.fromEntries(
      Object.entries(abilities).map(([key, ability]) => [key, summarizeAbility(ability)]),
    ),
    spellSlots: summarizeSpellSlots(system.spells),
    resources: system.resources ?? {},
    itemCounts: countBy(items.map((item) => item.type)),
    activityCounts: countBy(activities.map((activity) => activity.type)),
    rulesSources: countBy(items.map(rulesSource)),
  };
}

function summarizeItem(item) {
  return {
    _id: item?._id ?? item?.id ?? null,
    name: item?.name ?? "Unnamed item",
    type: item?.type ?? null,
    img: item?.img ?? null,
    rules: rulesSource(item),
    equipped: item?.system?.equipped ?? null,
    quantity: numberValue(item?.system?.quantity, 1),
    activityCount: itemActivities(item).length,
  };
}

function listActorItems(actor, query = {}) {
  const nameQuery = stringValue(query.query).toLowerCase();
  const type = stringValue(query.type);
  const rules = stringValue(query.rules);
  const { limit, offset } = pagination(query);

  const matches = actorItems(actor).filter((item) => {
    if (nameQuery && !stringValue(item.name).toLowerCase().includes(nameQuery)) return false;
    if (type && item.type !== type) return false;
    if (rules && rulesSource(item) !== rules) return false;
    return true;
  });

  return {
    actorId: actor?._id ?? actor?.id ?? null,
    total: matches.length,
    offset,
    limit,
    items: matches.slice(offset, offset + limit).map(summarizeItem),
  };
}

function summarizeActivity(item, activity) {
  const consumption = activity.consumption ?? {};
  const targets = collectionValues(consumption.targets);

  return {
    _id: activity._id ?? null,
    name: activity.name ?? activity.type ?? "Unnamed activity",
    type: activity.type ?? null,
    item: {
      _id: item?._id ?? item?.id ?? null,
      name: item?.name ?? "Unnamed item",
      type: item?.type ?? null,
      rules: rulesSource(item),
    },
    activation: {
      type: activity.activation?.type ?? null,
      value: activity.activation?.value ?? null,
      condition: activity.activation?.condition ?? null,
    },
    uses: {
      spent: numberValue(activity.uses?.spent),
      max: activity.uses?.max ?? null,
    },
    requirements: {
      spellSlotConfig: consumption.spellSlot ?? null,
      consumptionTargets: targets.length,
    },
    capabilities: {
      attack: Boolean(activity.attack),
      damage: Boolean(activity.damage),
      healing: Boolean(activity.healing),
      save: Boolean(activity.save),
      effects: collectionValues(activity.effects).length,
    },
  };
}

function summarizeRollParts(parts) {
  return collectionValues(parts).map((part) => ({
    number: numberValue(part?.number),
    denomination: part?.denomination ?? null,
    bonus: part?.bonus ?? null,
    types: collectionValues(part?.types),
    custom: part?.custom ?? null,
  }));
}

function summarizeActivityDetails(item, activity) {
  const consumption = activity.consumption ?? {};
  const target = activity.target ?? {};
  const range = activity.range ?? {};
  const duration = activity.duration ?? {};
  const attack = activity.attack ?? null;
  const save = activity.save ?? null;
  const damage = activity.damage ?? null;
  const healing = activity.healing ?? null;

  return {
    ...summarizeActivity(item, activity),
    range: {
      value: range.value ?? null,
      units: range.units ?? null,
      special: range.special ?? null,
    },
    target: {
      affects: target.affects ?? null,
      type: target.template?.type ?? target.type ?? null,
      value: target.template?.size ?? target.value ?? null,
      units: target.template?.units ?? target.units ?? null,
      count: target.affects?.count ?? null,
      prompt: target.prompt ?? false,
    },
    duration: {
      value: duration.value ?? null,
      units: duration.units ?? null,
      special: duration.special ?? null,
      concentration: duration.concentration ?? false,
    },
    consumption: {
      spellSlotConfig: consumption.spellSlot ?? null,
      targets: collectionValues(consumption.targets).map((entry) => ({
        target: entry?.target ?? null,
        value: entry?.value ?? null,
        scaling: entry?.scaling ?? null,
      })),
      interpretation: "Configuration only. Do not infer whether execution will spend a spell slot or another resource from these fields.",
    },
    attack: attack && {
      ability: attack.ability ?? null,
      type: attack.type ?? null,
      bonus: attack.bonus ?? null,
      criticalThreshold: attack.critical?.threshold ?? null,
    },
    save: save && {
      ability: collectionValues(save.ability),
      dc: save.dc?.value ?? null,
      calculation: save.dc?.calculation ?? null,
      onSave: save.onSave ?? null,
    },
    damage: damage && {
      includeBase: damage.includeBase ?? null,
      parts: summarizeRollParts(damage.parts),
      onSave: damage.onSave ?? null,
      interpretation: "Configuration only. This discovery response does not calculate a final damage formula or roll result.",
    },
    healing: healing && { parts: summarizeRollParts(healing.parts) },
    effects: collectionValues(activity.effects).map((effect) => ({
      _id: effect?._id ?? effect?.id ?? null,
      name: effect?.name ?? null,
      transfer: effect?.transfer ?? null,
    })),
    execution: {
      supported: false,
      note: "Activity execution is not implemented. This endpoint is discovery-only and does not roll, create chat messages, consume resources, or change Foundry data.",
    },
    cautions: [
      "Activity configuration is not execution. Use the dnd5e activity result once activity execution is implemented to determine final resource costs and roll outcomes.",
    ],
  };
}

function getActorActivity(actor, itemId, activityId) {
  const item = actorItems(actor).find((candidate) => (candidate?._id ?? candidate?.id) === itemId);
  if (!item) return null;
  const activity = itemActivities(item).find((candidate) => candidate?._id === activityId);
  return activity ? summarizeActivityDetails(item, activity) : null;
}

function listActorActivities(actor, query = {}) {
  const nameQuery = stringValue(query.query).toLowerCase();
  const itemId = stringValue(query.itemId);
  const type = stringValue(query.type);
  const rules = stringValue(query.rules);
  const { limit, offset } = pagination(query);

  const activities = actorItems(actor).flatMap((item) => itemActivities(item).map((activity) => ({ item, activity })));
  const matches = activities.filter(({ item, activity }) => {
    if (itemId && (item._id ?? item.id) !== itemId) return false;
    if (type && activity.type !== type) return false;
    if (rules && rulesSource(item) !== rules) return false;
    if (nameQuery) {
      const haystack = `${item.name ?? ""} ${activity.name ?? ""}`.toLowerCase();
      if (!haystack.includes(nameQuery)) return false;
    }
    return true;
  });

  return {
    actorId: actor?._id ?? actor?.id ?? null,
    total: matches.length,
    offset,
    limit,
    activities: matches.slice(offset, offset + limit).map(({ item, activity }) => summarizeActivity(item, activity)),
  };
}

function validateActor(actor) {
  const items = actorItems(actor);
  const activities = items.flatMap(itemActivities);
  const activityTypes = countBy(activities.map((activity) => activity.type));
  const customActivityTypes = Object.keys(activityTypes).filter((type) => !CORE_ACTIVITY_TYPES.has(type));
  const rulesSources = countBy(items.map(rulesSource));
  const byteSize = Buffer.byteLength(JSON.stringify(actor), "utf8");
  const warnings = [];

  if (byteSize > 512 * 1024) {
    warnings.push({
      code: "large-document",
      message: "This actor is large; use summary, item, and activity tools instead of raw actor output.",
    });
  }
  if (items.length > 200) {
    warnings.push({
      code: "large-item-inventory",
      message: "This actor has more than 200 embedded Items; use filters and pagination.",
    });
  }
  if (rulesSources.unspecified) {
    warnings.push({
      code: "unspecified-rules-source",
      message: `${rulesSources.unspecified} Item(s) do not declare a 2014 or 2024 rules source.`,
    });
  }
  if (customActivityTypes.length > 0) {
    warnings.push({
      code: "custom-activity-types",
      message: `Module-provided or custom activity types detected: ${customActivityTypes.join(", ")}.`,
      types: customActivityTypes,
    });
  }

  return {
    dataProvenance: RAW_DOCUMENT_PROVENANCE,
    actorId: actor?._id ?? actor?.id ?? null,
    name: actor?.name ?? "Unnamed actor",
    type: actor?.type ?? null,
    isDnd5eLike: Boolean(actor?.system?.abilities && actor?.system?.attributes),
    byteSize,
    itemCount: items.length,
    activityCount: activities.length,
    itemTypes: countBy(items.map((item) => item.type)),
    activityTypes,
    rulesSources,
    mixedRulesSources: Boolean(rulesSources["2014"] && rulesSources["2024"]),
    itemsWithoutActivities: items.filter((item) => itemActivities(item).length === 0).length,
    warnings,
  };
}

function withoutItems(actor) {
  const { items: _items, ...actorWithoutItems } = actor;
  return actorWithoutItems;
}

module.exports = {
  CORE_ACTIVITY_TYPES,
  RAW_DOCUMENT_PROVENANCE,
  collectionValues,
  itemActivities,
  getActorActivity,
  listActorActivities,
  listActorItems,
  pagination,
  summarizeActor,
  summarizeActivityDetails,
  validateActor,
  withoutItems,
};
