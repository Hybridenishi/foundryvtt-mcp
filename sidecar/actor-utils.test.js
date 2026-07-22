const assert = require("node:assert/strict");
const test = require("node:test");

const {
  listActorActivities,
  listActorItems,
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
          attack1: { _id: "attack1", name: "Slash", type: "attack", activation: { type: "action" }, attack: {}, damage: {} },
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

test("validateActor reports mixed rules sources and custom activity types", () => {
  const result = validateActor(actor);
  assert.equal(result.isDnd5eLike, true);
  assert.equal(result.mixedRulesSources, true);
  assert.equal(result.activityCount, 2);
  assert.deepEqual(result.warnings.find((warning) => warning.code === "custom-activity-types")?.types, ["ddbmacro"]);
});
