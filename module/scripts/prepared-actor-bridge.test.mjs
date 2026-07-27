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

test("previewHpChange with damageType includes type in output and rulesNote", () => {
  const actor = {
    id: "actor-1",
    name: "Test Actor",
    system: { attributes: { hp: { value: 20, max: 20, temp: 0, tempmax: 0 } } },
  };

  const fire = previewHpChange(actor, { mode: "damage", amount: 10, damageType: "fire" });
  assert.equal(fire.damageType, "fire");
  assert.match(fire.rulesNote, /Typed fire damage/);
  assert.match(fire.rulesNote, /resistance, vulnerability, and immunity are calculated/);

  // Untyped: no damageType field, old rulesNote
  const untyped = previewHpChange(actor, { mode: "damage", amount: 10 });
  assert.equal(untyped.damageType, undefined);
  assert.match(untyped.rulesNote, /not calculated/);
});

test("validateHpChange rejects damageType on healing mode", () => {
  assert.throws(
    () => previewHpChange({ system: { attributes: { hp: { value: 10, max: 10 } } } }, { mode: "healing", amount: 5, damageType: "fire" }),
    /only valid for damage mode/,
  );
});

test("applyHpChange with damageType calls applyDamage with typed array", async () => {
  let appliedDamage = null;
  const actor = {
    id: "actor-1",
    name: "Test Actor",
    system: { attributes: { hp: { value: 20, max: 20, temp: 0, tempmax: 0 } } },
    async applyDamage(damages) {
      appliedDamage = damages;
      this.system.attributes.hp.value = 10; // simulate resistance halving
    },
  };

  const result = await applyHpChange(actor, { mode: "damage", amount: 10, damageType: "fire" });
  assert.deepEqual(appliedDamage, [{ value: 10, type: "fire" }]);
  assert.equal(result.damageType, "fire");

  // Untyped: still passes a number (backward compatible)
  appliedDamage = null;
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
