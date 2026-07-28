// Request validation and confirmation-token issuing/consuming for every
// gated write operation. Pure and Map-based — no Express, no Socket.IO — so
// it can be unit-tested directly, and app.js only ever calls the wrapper
// functions exported here rather than sidecar/confirmation.js's primitives.
const { randomUUID, createHash } = require("node:crypto");
const { consumeConfirmation, issueConfirmation } = require("./confirmation");
const { KNOWLEDGE_TYPES } = require("./journal-search");

const HP_CHANGE_CONFIRMATION_TTL = 2 * 60_000;
const TEMPORARY_HP_CONFIRMATION_TTL = 2 * 60_000;
const CONDITION_CHANGE_CONFIRMATION_TTL = 2 * 60_000;
const ACTIVITY_USE_CONFIRMATION_TTL = 2 * 60_000;
const SPELL_SLOT_ADJUSTMENT_CONFIRMATION_TTL = 2 * 60_000;
const ACTOR_JOURNAL_LINK_CONFIRMATION_TTL = 2 * 60_000;

const hpChangeConfirmations = new Map();
const temporaryHpConfirmations = new Map();
const conditionChangeConfirmations = new Map();
const activityUseConfirmations = new Map();
const spellSlotAdjustmentConfirmations = new Map();
const actorJournalLinkConfirmations = new Map();

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

// Actor <-> journal linking — a bidirectional flags["foundry-mcp-bridge"]
// cross-reference (docs/ROADMAP.md Phase 5's NPC/journal linking item),
// deliberately not the biography field, which DDB Importer and Plutonium
// overwrite on re-import. Low-stakes compared to a visibility change (it
// links two documents the caller can already read by other means, and
// changes no ownership), but AGENTS.md's write pattern applies to every
// mutation, so this follows the same preview -> confirm -> apply shape as
// everything else rather than being a special case.
function parseActorJournalLink(body) {
  const entryId = body?.entryId;
  if (typeof entryId !== "string" || entryId.length === 0) throw new Error("entryId is required");
  return { entryId };
}

function actorJournalLinkBinding(actorId, entryId) {
  return { actorId, entryId, operation: "link-actor-journal" };
}

function issueActorJournalLinkConfirmation(actorId, entryId) {
  return issueConfirmation(
    actorJournalLinkConfirmations,
    randomUUID(),
    actorJournalLinkBinding(actorId, entryId),
    ACTOR_JOURNAL_LINK_CONFIRMATION_TTL,
  );
}

function consumeActorJournalLinkConfirmation(token, actorId, entryId) {
  consumeConfirmation(actorJournalLinkConfirmations, token, actorJournalLinkBinding(actorId, entryId), "actor-journal-link");
}

// Journal writes — preview/apply gating for create-entry, add-page, and
// update-page, following the same shape as every other guarded operation:
// a scoped, single-use confirmation token binds the request's identity
// (`sidecar/confirmation.js`'s `bindingMatches()` compares with `===`, so
// every bound value must be a primitive — hence hashing name/content/
// visibility rather than binding them directly, the same choice
// `adjustmentsKey` makes below for spell slots). The *resolved* ownership
// map and resolved names are carried in the confirmation's payload, not the
// binding, and apply uses that payload verbatim rather than re-resolving —
// closing the window where a user rename between preview and apply would
// otherwise produce a different audience than the one the DM read at
// preview time.
const JOURNAL_WRITE_CONFIRMATION_TTL = 2 * 60_000;
const journalWriteConfirmations = new Map();

const JOURNAL_WRITE_OPERATIONS = new Set(["create-entry", "add-page", "update-page"]);
const VISIBILITY_PROFILES = new Set(["gm", "party", "players"]);

// Deterministic, key-order-independent JSON — so a hash taken over an
// object is the same hash regardless of what order its keys were built in.
function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value).sort().map((k) => `${JSON.stringify(k)}:${canonicalJson(value[k])}`).join(",")}}`;
  }
  return JSON.stringify(value ?? null);
}

function digest(value) {
  return createHash("sha256").update(canonicalJson(value)).digest("hex");
}

function parseJournalWrite(body) {
  const operation = body?.operation;
  if (!JOURNAL_WRITE_OPERATIONS.has(operation)) {
    throw new Error("operation must be 'create-entry', 'add-page', or 'update-page'");
  }

  const entryId = body?.entryId;
  if (operation !== "create-entry" && (typeof entryId !== "string" || entryId.length === 0)) {
    throw new Error("entryId is required for add-page and update-page");
  }
  const pageId = body?.pageId;
  if (operation === "update-page" && (typeof pageId !== "string" || pageId.length === 0)) {
    throw new Error("pageId is required for update-page");
  }

  const name = body?.name;
  if (operation === "create-entry" && (typeof name !== "string" || name.trim().length === 0)) {
    throw new Error("name is required for create-entry");
  }

  const pages = body?.pages;
  if (!Array.isArray(pages) || pages.length === 0 || pages.length > 20) {
    throw new Error("pages must be a non-empty array of at most 20 pages");
  }
  for (const page of pages) {
    if (!page || typeof page.name !== "string" || page.name.trim().length === 0) {
      throw new Error("Each page requires a name");
    }
    if (typeof page.content !== "string") throw new Error("Each page requires content");
  }
  if ((operation === "add-page" || operation === "update-page") && pages.length !== 1) {
    throw new Error(`${operation} takes exactly one page`);
  }

  const knowledge = body?.knowledge;
  if (knowledge !== undefined && knowledge !== null) {
    if (typeof knowledge !== "object") throw new Error("knowledge must be an object if provided");
    if (knowledge.type !== undefined && !KNOWLEDGE_TYPES.has(knowledge.type)) {
      throw new Error(`knowledge.type '${knowledge.type}' is not recognized. Valid types: ${[...KNOWLEDGE_TYPES].sort().join(", ")}`);
    }
    if (knowledge.tags !== undefined && (!Array.isArray(knowledge.tags) || knowledge.tags.some((t) => typeof t !== "string"))) {
      throw new Error("knowledge.tags must be an array of strings");
    }
  }

  const visibility = body?.visibility;
  if (!visibility || typeof visibility !== "object" || !VISIBILITY_PROFILES.has(visibility.profile)) {
    throw new Error("visibility.profile is required and must be 'gm', 'party', or 'players'");
  }
  if (visibility.profile === "players") {
    if (!Array.isArray(visibility.players) || visibility.players.length === 0 || visibility.players.some((p) => typeof p !== "string" || p.trim().length === 0)) {
      throw new Error("visibility.players must be a non-empty array of strings for the 'players' profile");
    }
  } else if (visibility.players !== undefined) {
    throw new Error("visibility.players is only valid with the 'players' profile");
  }

  return {
    operation,
    entryId: operation === "create-entry" ? null : entryId,
    pageId: operation === "update-page" ? pageId : null,
    name: operation === "create-entry" ? name : null,
    folder: typeof body?.folder === "string" ? body.folder : null,
    knowledge: knowledge ?? null,
    pages,
    visibility,
  };
}

// The binding is the operation's identity, matched exactly at apply time;
// the visibilityKey is a hash of the *resolved* ownership map, not the
// requested profile, so a party whose membership changed between preview
// and apply is caught here rather than silently re-resolved to a different
// audience.
function journalWriteBinding(request, resolvedOwnership) {
  return {
    operation: request.operation,
    entryId: request.entryId ?? "",
    pageId: request.pageId ?? "",
    nameKey: digest(request.name ?? null),
    contentKey: digest(request.pages),
    visibilityKey: digest(resolvedOwnership),
  };
}

function issueJournalWriteConfirmation(request, resolvedOwnership, resolvedNames) {
  return issueConfirmation(
    journalWriteConfirmations,
    randomUUID(),
    journalWriteBinding(request, resolvedOwnership),
    JOURNAL_WRITE_CONFIRMATION_TTL,
    { payload: { resolvedOwnership, resolvedNames } },
  );
}

// Returns the payload recorded at preview time — the resolved ownership map
// and resolved names — passed through so apply executes with exactly what
// was previewed, rather than a freshly (and possibly differently) resolved
// map.
function consumeJournalWriteConfirmation(token, request, resolvedOwnership) {
  return consumeConfirmation(
    journalWriteConfirmations,
    token,
    journalWriteBinding(request, resolvedOwnership),
    "journal-write",
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
  parseActorJournalLink,
  issueActorJournalLinkConfirmation,
  consumeActorJournalLinkConfirmation,
  parseJournalWrite,
  canonicalJson,
  digest,
  issueJournalWriteConfirmation,
  consumeJournalWriteConfirmation,
};
