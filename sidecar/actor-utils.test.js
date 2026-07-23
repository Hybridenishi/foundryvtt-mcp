const assert = require("node:assert/strict");
const test = require("node:test");

const {
  listActorActivities,
  listActorItems,
  getActorActivity,
  summarizeActor,
  validateActor,
} = require("./actor-utils");

const actor = {
  _id: "actor-1",
  name: "Fixture Hero",
  type: "character",
  system: {
    attributes: { hp: { value: 14, max: 20, temp: 3 }, ac: { value: 16 } },
    abilities: { str: { value: 12, mod: 1, save: 3, proficient: 1 } },
    details: { level: 4 },
    spells: { spell1: { value: 2, max: 3 } },
  },
  items: [
    {
      _id: "weapon-1",
      name: "Testing Sword",
      type: "weapon",
      system: {
        source: { rules: "2014" },
        activities: {
          attack1: {
            _id: "attack1", name: "Slash", type: "attack", activation: { type: "action", value: 1 },
            range: { value: 5, units: "ft" }, target: { affects: { type: "creature", count: "1" } },
            consumption: { targets: [{ target: "itemUses", value: "1", scaling: { mode: "none" } }] },
            attack: { ability: "str", type: { value: "melee" }, bonus: "2", critical: { threshold: 19 } },
            save: { ability: ["dex"], dc: { value: 14, calculation: "spellcasting" }, onSave: "half" },
            damage: { parts: [{ number: 1, denomination: 8, bonus: "@mod", types: ["slashing"] }], onSave: "half" },
            effects: [{ _id: "effect-1", name: "Testing Effect", transfer: false }],
          },
        },
      },
    },
    {
      _id: "spell-1",
      name: "Testing Spark",
      type: "spell",
      system: {
        source: { rules: "2024" },
        activities: {
          custom1: { _id: "custom1", name: "Special Spark", type: "ddbmacro", consumption: { spellSlot: true } },
        },
      },
    },
  ],
};

test("summarizeActor returns concise combat and inventory metadata", () => {
  const summary = summarizeActor(actor);
  assert.equal(summary.hp.value, 14);
  assert.equal(summary.ac.value, 16);
  assert.equal(summary.dataProvenance.prepared, false);
  assert.deepEqual(summary.itemCounts, { weapon: 1, spell: 1 });
  assert.deepEqual(summary.rulesSources, { "2014": 1, "2024": 1 });
});

test("listActorItems filters by type and preserves paging metadata", () => {
  const result = listActorItems(actor, { type: "spell", limit: 10, offset: 0 });
  assert.equal(result.total, 1);
  assert.equal(result.items[0].name, "Testing Spark");
  assert.equal(result.items[0].rules, "2024");
});

test("listActorActivities links an activity to its parent item", () => {
  const result = listActorActivities(actor, { type: "attack" });
  assert.equal(result.total, 1);
  assert.equal(result.activities[0].item._id, "weapon-1");
  assert.equal(result.activities[0].capabilities.damage, true);
});

test("getActorActivity returns concise discovery metadata without execution", () => {
  const activity = getActorActivity(actor, "weapon-1", "attack1");
  assert.equal(activity.item.name, "Testing Sword");
  assert.equal(activity.activation.type, "action");
  assert.equal(activity.range.value, 5);
  assert.equal(activity.target.count, "1");
  assert.equal(activity.consumption.targets[0].target, "itemUses");
  assert.equal(activity.attack.criticalThreshold, 19);
  assert.deepEqual(activity.damage.parts[0].types, ["slashing"]);
  assert.equal(activity.effects[0].name, "Testing Effect");
  assert.equal(activity.execution.supported, false);
  assert.equal(getActorActivity(actor, "weapon-1", "missing"), null);
});

test("validateActor reports mixed rules sources and custom activity types", () => {
  const result = validateActor(actor);
  assert.equal(result.isDnd5eLike, true);
  assert.equal(result.dataProvenance.prepared, false);
  assert.equal(result.mixedRulesSources, true);
  assert.equal(result.activityCount, 2);
  assert.deepEqual(result.warnings.find((warning) => warning.code === "custom-activity-types")?.types, ["ddbmacro"]);
});
