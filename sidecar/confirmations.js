// Request validation and confirmation-token issuing/consuming for every
// gated write operation. Pure and Map-based — no Express, no Socket.IO — so
// it can be unit-tested directly, and app.js only ever calls the wrapper
// functions exported here rather than sidecar/confirmation.js's primitives.
const { randomUUID } = require("node:crypto");
const { consumeConfirmation, issueConfirmation } = require("./confirmation");

const HP_CHANGE_CONFIRMATION_TTL = 2 * 60_000;
const TEMPORARY_HP_CONFIRMATION_TTL = 2 * 60_000;
const CONDITION_CHANGE_CONFIRMATION_TTL = 2 * 60_000;
const ACTIVITY_USE_CONFIRMATION_TTL = 2 * 60_000;
const SPELL_SLOT_ADJUSTMENT_CONFIRMATION_TTL = 2 * 60_000;

const hpChangeConfirmations = new Map();
const temporaryHpConfirmations = new Map();
const conditionChangeConfirmations = new Map();
const activityUseConfirmations = new Map();
const spellSlotAdjustmentConfirmations = new Map();

const VALID_DAMAGE_TYPES = new Set([
  "acid", "bludgeoning", "cold", "fire", "force",
  "lightning", "necrotic", "piercing", "poison", "psychic",
  "radiant", "slashing", "thunder",
]);

function normalizeDamageType(raw) {
  if (raw === null || raw === undefined) return null;
  const trimmed = String(raw).trim();
  if (trimmed.length === 0) return null;
  return trimmed.toLowerCase();
}

function parseHpChange(body) {
  const mode = body?.mode;
  const amount = body?.amount;
  if (mode !== "damage" && mode !== "healing") {
    throw new Error("mode must be 'damage' or 'healing'");
  }
  if (!Number.isInteger(amount) || amount < 1 || amount > 100_000) {
    throw new Error("amount must be an integer between 1 and 100000");
  }

  const damageType = normalizeDamageType(body?.damageType);

  if (damageType !== null && mode !== "damage") {
    throw new Error("damageType is only valid for damage mode, not healing");
  }
  if (body?.damageType !== null && body?.damageType !== undefined) {
    const raw = String(body.damageType);
    if (raw.trim().length === 0) {
      throw new Error("damageType must not be empty or whitespace-only");
    }
    if (!VALID_DAMAGE_TYPES.has(damageType)) {
      throw new Error(`damageType '${raw.trim()}' is not a recognized dnd5e damage type`);
    }
  }
  return { mode, amount, ...(damageType ? { damageType } : {}) };
}

function issueHpChangeConfirmation(actorId, change) {
  return issueConfirmation(hpChangeConfirmations, randomUUID(), { actorId, ...change }, HP_CHANGE_CONFIRMATION_TTL);
}

function consumeHpChangeConfirmation(token, actorId, change) {
  consumeConfirmation(hpChangeConfirmations, token, { actorId, ...change }, "HP-change");
}

function parseTemporaryHp(body) {
  const amount = body?.amount;
  if (!Number.isInteger(amount) || amount < 0 || amount > 100_000) {
    throw new Error("amount must be an integer between 0 and 100000");
  }
  return { amount };
}

function issueTemporaryHpConfirmation(actorId, change) {
  return issueConfirmation(temporaryHpConfirmations, randomUUID(), { actorId, ...change }, TEMPORARY_HP_CONFIRMATION_TTL);
}

function consumeTemporaryHpConfirmation(token, actorId, change) {
  consumeConfirmation(temporaryHpConfirmations, token, { actorId, ...change }, "temporary-HP");
}

function parseConditionChange(body) {
  const mode = body?.mode;
  const statusId = body?.statusId;
  if (mode !== "add" && mode !== "remove") throw new Error("mode must be 'add' or 'remove'");
  if (typeof statusId !== "string" || !/^[a-z0-9-]{1,80}$/i.test(statusId)) throw new Error("statusId must be a valid condition identifier");
  return { mode, statusId };
}

function issueConditionChangeConfirmation(actorId, change) {
  return issueConfirmation(conditionChangeConfirmations, randomUUID(), { actorId, ...change }, CONDITION_CHANGE_CONFIRMATION_TTL);
}

function consumeConditionChangeConfirmation(token, actorId, change) {
  consumeConfirmation(conditionChangeConfirmations, token, { actorId, ...change }, "condition-change");
}

function activityUseBinding(actorId, itemId, activityId) {
  return { actorId, itemId, activityId, operation: "use-utility", options: "{}" };
}

function issueActivityUseConfirmation(actorId, itemId, activityId) {
  return issueConfirmation(
    activityUseConfirmations,
    randomUUID(),
    activityUseBinding(actorId, itemId, activityId),
    ACTIVITY_USE_CONFIRMATION_TTL,
  );
}

function consumeActivityUseConfirmation(token, actorId, itemId, activityId) {
  consumeConfirmation(activityUseConfirmations, token, activityUseBinding(actorId, itemId, activityId), "activity-use");
}

// Spell slot adjustment — canonical binding + stale-state protection
const SLOT_IDS = new Set(["pact", ...Array.from({ length: 9 }, (_, i) => `spell${i + 1}`)]);

function canonicalAdjustments(adjustments) {
  return [...adjustments]
    .map(({ slot, value }) => ({ slot, value }))
    .sort((a, b) => a.slot.localeCompare(b.slot));
}

function adjustmentsKey(adjustments) {
  return JSON.stringify(canonicalAdjustments(adjustments));
}

function selectedStateKey(selectedSlots) {
  return JSON.stringify(selectedSlots.map(({ slot, value, max, override }) => ({
    slot, value, max, override,
  })));
}

function parseSpellSlotAdjustment(body) {
  const adjustments = body?.adjustments;
  if (!Array.isArray(adjustments) || adjustments.length === 0) {
    throw new Error("adjustments must be a non-empty array");
  }
  const seen = new Set();
  for (const adj of adjustments) {
    if (!adj || Object.keys(adj).some((k) => k !== "slot" && k !== "value")) {
      throw new Error("Each adjustment must contain only slot and value");
    }
    if (!SLOT_IDS.has(adj.slot)) throw new Error(`slot must be pact or spell1 through spell9, got '${adj.slot}'`);
    if (!Number.isInteger(adj.value) || adj.value < 0 || adj.value > 100_000) throw new Error("value must be an integer between 0 and 100000");
    if (seen.has(adj.slot)) throw new Error(`Duplicate slot '${adj.slot}'`);
    seen.add(adj.slot);
  }
  return { adjustments, adjustmentsKey: adjustmentsKey(adjustments) };
}

function spellSlotAdjustmentBinding(actorId, adjustments) {
  return {
    actorId,
    operation: "adjust-spell-slots",
    adjustmentsKey: adjustmentsKey(adjustments),
  };
}

function issueSpellSlotAdjustmentConfirmation(actorId, adjustments, selectedSlots) {
  return issueConfirmation(
    spellSlotAdjustmentConfirmations,
    randomUUID(),
    spellSlotAdjustmentBinding(actorId, adjustments),
    SPELL_SLOT_ADJUSTMENT_CONFIRMATION_TTL,
    { payload: { selectedStateKey: selectedStateKey(selectedSlots) } },
  );
}

function consumeSpellSlotAdjustmentConfirmation(token, actorId, adjustments) {
  // Returns the payload recorded at preview time: a trusted fingerprint of the
  // slot state the bridge observed then, passed through so apply can reject a
  // state that changed since.
  return consumeConfirmation(
    spellSlotAdjustmentConfirmations,
    token,
    spellSlotAdjustmentBinding(actorId, adjustments),
    "spell-slot-adjustment",
  );
}

module.exports = {
  parseHpChange,
  issueHpChangeConfirmation,
  consumeHpChangeConfirmation,
  parseTemporaryHp,
  issueTemporaryHpConfirmation,
  consumeTemporaryHpConfirmation,
  parseConditionChange,
  issueConditionChangeConfirmation,
  consumeConditionChangeConfirmation,
  issueActivityUseConfirmation,
  consumeActivityUseConfirmation,
  parseSpellSlotAdjustment,
  adjustmentsKey,
  issueSpellSlotAdjustmentConfirmation,
  consumeSpellSlotAdjustmentConfirmation,
};
