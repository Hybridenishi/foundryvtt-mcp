import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { applyConditionChange, applyHpChange, executeUtilityActivityUse, previewConditionChange, previewHpChange, previewTemporaryHp, previewUtilityActivityUse, setTemporaryHp, summarizePreparedActor, summarizePreparedParty } from "./prepared-actor-bridge.mjs";

test("bridge source contains no browser-served shared API key", async () => {
  const source = await readFile(new URL("./prepared-actor-bridge.mjs", import.meta.url), "utf8");
  assert.equal(source.includes("mcp-bridge-key-2026"), false);
  assert.match(source, /X-MCP-Bridge-Token/);
});

test("summarizePreparedActor preserves client-prepared combat values", () => {
  const summary = summarizePreparedActor({
    id: "actor-1",
    name: "Prepared Hero",
    type: "character",
    system: {
      details: { level: 15 },
      attributes: { hp: { value: 78, max: 108 }, ac: { value: 15, calc: "default" } },
      abilities: { wis: { value: 16, mod: 3, save: 8, proficient: 1 } },
      spells: { spell1: { value: 3, max: 4 }, spell8: { value: 1, max: 1 }, pact: { value: 0, max: 0 } },
    },
  });

  assert.equal(summary.dataProvenance.prepared, true);
  assert.equal(summary.details.level, 15);
  assert.deepEqual(summary.hp, { value: 78, max: 108, temp: null, tempmax: null });
  assert.equal(summary.ac.value, 15);
  assert.equal(summary.abilities.wis.mod, 3);
  assert.deepEqual(summary.spellSlots.spell1, { value: 3, max: 4, override: null });
  assert.deepEqual(summary.spellSlots.spell8, { value: 1, max: 1, override: null });
  assert.equal(summary.spellSlots.pact, undefined);
});

test("previewHpChange accounts for temporary HP and caps healing", () => {
  const actor = {
    id: "actor-1",
    name: "Test Actor",
    system: { attributes: { hp: { value: 7, max: 12, temp: 3, tempmax: 0 } } },
  };

  const damage = previewHpChange(actor, { mode: "damage", amount: 8 });
  assert.deepEqual(damage.after, { value: 2, max: 12, temp: 0, tempmax: 0 });
  assert.equal(damage.appliedToTemp, 3);
  assert.equal(damage.appliedToHp, 5);

  const healing = previewHpChange(actor, { mode: "healing", amount: 10 });
  assert.deepEqual(healing.after, { value: 12, max: 12, temp: 3, tempmax: 0 });
  assert.equal(healing.unspentAmount, 5);
});

test("typed damage preview includes type, tentative flag, and rulesNote", () => {
  const actor = {
    id: "actor-1",
    name: "Test Actor",
    system: { attributes: { hp: { value: 20, max: 20, temp: 0, tempmax: 0 } } },
  };

  const fire = previewHpChange(actor, { mode: "damage", amount: 10, damageType: "fire" });
  assert.equal(fire.damageType, "fire");
  assert.match(fire.rulesNote, /Typed fire damage/);
  assert.match(fire.rulesNote, /resistance, vulnerability, and immunity are calculated/);
  assert.equal(typeof fire.afterIsTentative, "string", "typed preview must include afterIsTentative warning");
  assert.match(fire.afterIsTentative, /raw calculations BEFORE/);

  // Untyped: no damageType field, old rulesNote, no tentative flag
  const untyped = previewHpChange(actor, { mode: "damage", amount: 10 });
  assert.equal(untyped.damageType, undefined);
  assert.match(untyped.rulesNote, /not calculated/);
  assert.equal(untyped.afterIsTentative, null);
});

test("validateHpChange rejects invalid damageType values", () => {
  const actor = { system: { attributes: { hp: { value: 10, max: 10 } } } };

  // Whitespace-only
  assert.throws(
    () => previewHpChange(actor, { mode: "damage", amount: 5, damageType: "  " }),
    /whitespace/,
  );

  // Unknown type
  assert.throws(
    () => previewHpChange(actor, { mode: "damage", amount: 5, damageType: "banana" }),
    /not a recognized dnd5e damage type/,
  );

  // Healing mode with damageType
  assert.throws(
    () => previewHpChange(actor, { mode: "healing", amount: 5, damageType: "fire" }),
    /only valid for damage mode/,
  );
});

test("validateHpChange normalizes trimmed damageType", () => {
  const actor = {
    id: "actor-1",
    name: "Test Actor",
    system: { attributes: { hp: { value: 20, max: 20, temp: 0, tempmax: 0 } } },
  };

  // Leading/trailing whitespace → trimmed
  const result = previewHpChange(actor, { mode: "damage", amount: 10, damageType: " Fire " });
  assert.equal(result.damageType, "fire", "damageType should be trimmed and lowercased");
});

test("applyHpChange with typed damage derives breakdown from actual state change", async () => {
  // Simulate a fire-resistant actor: applyDamage halves fire damage
  let appliedDamage = null;
  const actor = {
    id: "actor-1",
    name: "Test Actor",
    system: { attributes: { hp: { value: 20, max: 20, temp: 0, tempmax: 0 } } },
    async applyDamage(damages) {
      appliedDamage = damages;
      // Simulate fire resistance: only take half
      this.system.attributes.hp.value = 15;
    },
  };

  const result = await applyHpChange(actor, { mode: "damage", amount: 10, damageType: "fire" });
  assert.deepEqual(appliedDamage, [{ value: 10, type: "fire" }]);
  assert.equal(result.damageType, "fire");

  // Breakdown must be derived from actual state, not raw math
  assert.equal(result.before.value, 20, "before should be actual pre-damage state");
  assert.equal(result.after.value, 15, "after should be actual post-damage state (resistance halved)");
  assert.equal(result.appliedToHp, 5, "appliedToHp should be actual HP lost (5, not 10)");
  assert.equal(result.unspentAmount, 0, "all damage was absorbed");
  assert.match(result.rulesNote, /Typed fire damage applied/);

  // No afterIsTentative on apply — this is the actual result
  assert.ok(!("afterIsTentative" in result), "apply response should not have afterIsTentative");
});

test("applyHpChange with typed damage and temp HP derives correct breakdown", async () => {
  const actor = {
    id: "actor-1",
    name: "Test Actor",
    system: { attributes: { hp: { value: 20, max: 20, temp: 5, tempmax: 0 } } },
    async applyDamage(damages) {
      // No resistance — full damage. Temp absorbs 5, remaining 5 goes to HP.
      this.system.attributes.hp.temp = 0;
      this.system.attributes.hp.value = 15;
    },
  };

  const result = await applyHpChange(actor, { mode: "damage", amount: 10, damageType: "piercing" });
  assert.equal(result.before.temp, 5);
  assert.equal(result.after.temp, 0);
  assert.equal(result.appliedToTemp, 5, "temp HP should have absorbed 5");
  assert.equal(result.before.value, 20);
  assert.equal(result.after.value, 15);
  assert.equal(result.appliedToHp, 5, "HP lost should be 5 (10 total - 5 temp)");
  assert.equal(result.unspentAmount, 0);
});

test("applyHpChange untyped backward compatibility still works", async () => {
  let appliedDamage = null;
  const actor = {
    id: "actor-1",
    name: "Test Actor",
    system: { attributes: { hp: { value: 20, max: 20, temp: 0, tempmax: 0 } } },
    async applyDamage(damages) {
      appliedDamage = damages;
      this.system.attributes.hp.value = 10;
    },
  };

  // Untyped damage
  const damageResult = await applyHpChange(actor, { mode: "damage", amount: 10 });
  assert.equal(appliedDamage, 10);
  assert.equal(damageResult.appliedToHp, 10);
  assert.equal(damageResult.damageType, undefined);

  // Untyped healing
  appliedDamage = null;
  actor.system.attributes.hp.value = 30;
  await applyHpChange(actor, { mode: "healing", amount: 5 });
  assert.equal(appliedDamage, -5);
});

test("temporary HP preview is explicit and setting it returns prepared readback", async () => {
  const actor = {
    id: "actor-1",
    name: "Test Actor",
    system: { attributes: { hp: { value: 7, max: 12, temp: 3, tempmax: 0 } } },
    async update(change) {
      assert.deepEqual(change, { "system.attributes.hp.temp": 9 });
      this.system.attributes.hp.temp = 9;
    },
  };

  assert.deepEqual(previewTemporaryHp(actor, { amount: 0 }).after, { value: 7, max: 12, temp: 0, tempmax: 0 });
  const result = await setTemporaryHp(actor, { amount: 9 });
  assert.deepEqual(result.before, { value: 7, max: 12, temp: 3, tempmax: 0 });
  assert.deepEqual(result.after, { value: 7, max: 12, temp: 9, tempmax: 0 });
  assert.throws(() => previewTemporaryHp(actor, { amount: -1 }), /between 0 and 100000/);
});

test("prepared party summary includes character conditions", () => {
  globalThis.CONFIG = { statusEffects: [{ id: "blinded", name: "Blinded" }] };
  const party = summarizePreparedParty([
    { id: "npc-1", name: "Ignore", type: "npc", system: {} },
    { id: "actor-1", name: "Zoe", type: "character", statuses: new Set(["blinded"]), system: { attributes: { hp: { value: 7, max: 12 } } } },
  ]);
  assert.equal(party.actors.length, 1);
  assert.deepEqual(party.actors[0].conditions, [{ id: "blinded", name: "Blinded" }]);
  delete globalThis.CONFIG;
});

test("condition changes use Foundry's status-effect API and exclude exhaustion", async () => {
  globalThis.CONFIG = { statusEffects: [{ id: "blinded", name: "Blinded" }, { id: "exhaustion", name: "Exhaustion" }] };
  const actor = {
    id: "actor-1", name: "Test Actor", statuses: new Set(),
    async toggleStatusEffect(statusId, options) { assert.equal(statusId, "blinded"); assert.deepEqual(options, { active: true }); this.statuses.add(statusId); },
  };
  assert.deepEqual(previewConditionChange(actor, { mode: "add", statusId: "blinded" }).after, [{ id: "blinded", name: "Blinded" }]);
  const result = await applyConditionChange(actor, { mode: "add", statusId: "blinded" });
  assert.deepEqual(result.after, [{ id: "blinded", name: "Blinded" }]);
  assert.throws(() => previewConditionChange(actor, { mode: "add", statusId: "exhaustion" }), /level-based/);
  delete globalThis.CONFIG;
});

function utilityFixture() {
  const activity = {
    id: "utility-1", name: "Activate Trinket", type: "utility", canUse: true,
    target: {}, uses: { spent: 0, max: 1 },
    async use(usage, dialog) {
      assert.deepEqual(usage, {});
      assert.deepEqual(dialog, { configure: false });
      this.uses.spent = 1;
      return { message: { id: "message-1", uuid: "ChatMessage.message-1", title: "Activate Trinket" }, effects: [], templates: [], updates: { activity: { uses: { spent: 1 } } } };
    },
  };
  const item = { id: "item-1", name: "Test Trinket", system: { uses: { spent: 0, max: 1 }, activities: new Map([[activity.id, activity]]) } };
  const actor = {
    id: "actor-1", name: "Test Actor",
    system: { resources: {}, spells: {}, attributes: { activation: {} } },
    items: new Map([[item.id, item]]),
    getActiveTokens: () => [{}],
  };
  return { actor, request: { itemId: item.id, activityId: activity.id } };
}

test("utility activity preview is read-only and rejects unsupported execution shapes", () => {
  const { actor, request } = utilityFixture();
  const preview = previewUtilityActivityUse(actor, request);
  assert.equal(preview.operation, "use-utility");
  assert.equal(preview.observedResources.activityUses.spent, 0);
  assert.throws(() => previewUtilityActivityUse(actor, { ...request, activityId: "missing" }), /was not found/);
  actor.items.get("item-1").system.activities.get("utility-1").target = { prompt: true };
  assert.throws(() => previewUtilityActivityUse(actor, request), /target or template selection/);
  actor.items.get("item-1").system.activities.get("utility-1").target = { prompt: true, affects: { type: "self", count: "1" } };
  assert.equal(previewUtilityActivityUse(actor, request).activityId, "utility-1");
  actor.items.get("item-1").system.activities.get("utility-1").target = { affects: { type: "creature", count: "1" } };
  assert.throws(() => previewUtilityActivityUse(actor, request), /target or template selection/);
});

test("utility activity preview rejects an actor with no token on an active scene", () => {
  const { actor, request } = utilityFixture();
  actor.getActiveTokens = () => [];
  assert.throws(() => previewUtilityActivityUse(actor, request), /no token on an active scene/);
});

test("utility activity execution delegates to dnd5e and reports observed changes", async () => {
  const { actor, request } = utilityFixture();
  const result = await executeUtilityActivityUse(actor, request);
  assert.equal(result.result.message.id, "message-1");
  assert.equal(result.result.dnd5eUpdates.activity.uses.spent, 1);
  assert.deepEqual(result.observedResourceChanges.activityUses, { before: { spent: 0, max: 1 }, after: { spent: 1, max: 1 } });
});
