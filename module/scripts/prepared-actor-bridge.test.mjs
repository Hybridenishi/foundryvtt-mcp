import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { executeUtilityActivityUse, previewHpChange, previewUtilityActivityUse, summarizePreparedActor } from "./prepared-actor-bridge.mjs";

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
  const actor = { id: "actor-1", name: "Test Actor", system: { resources: {}, spells: {}, attributes: { activation: {} } }, items: new Map([[item.id, item]]) };
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

test("utility activity execution delegates to dnd5e and reports observed changes", async () => {
  const { actor, request } = utilityFixture();
  const result = await executeUtilityActivityUse(actor, request);
  assert.equal(result.result.message.id, "message-1");
  assert.equal(result.result.dnd5eUpdates.activity.uses.spent, 1);
  assert.deepEqual(result.observedResourceChanges.activityUses, { before: { spent: 0, max: 1 }, after: { spent: 1, max: 1 } });
});
