import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { addJournalPage, applyConditionChange, applyHpChange, applySpellSlotAdjustment, auditJournalVisibility, createJournalEntry, executeUtilityActivityUse, handleBridgeRequest, linkActorAndJournal, previewConditionChange, previewHpChange, previewSpellSlotAdjustment, previewTemporaryHp, previewUtilityActivityUse, setTemporaryHp, summarizePreparedActor, summarizePreparedParty, updateJournalPage } from "./prepared-actor-bridge.mjs";

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
  assert.deepEqual(summary.spellSlots.pact, { value: 0, max: 0, override: null });
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
  assert.equal(result.unspentAmount, 5, "unspentAmount should be the 5 resisted damage");
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
  assert.equal(damageResult.unspentAmount, 0);

  // Untyped healing
  appliedDamage = null;
  actor.system.attributes.hp.value = 30;
  await applyHpChange(actor, { mode: "healing", amount: 5 });
  assert.equal(appliedDamage, -5);
});

test("applyHpChange healing receipt shows directional hpDelta", async () => {
  const actor = {
    id: "actor-1",
    name: "Test Actor",
    system: { attributes: { hp: { value: 10, max: 30, temp: 0, tempmax: 0 } } },
    async applyDamage(damages) {
      // Heal 15 HP
      this.system.attributes.hp.value = 25;
    },
  };

  const result = await applyHpChange(actor, { mode: "healing", amount: 20 });
  assert.equal(result.before.value, 10);
  assert.equal(result.after.value, 25);
  assert.equal(result.appliedToHp, 15, "healing receipt must show hpDelta as after-before");
  assert.equal(result.unspentAmount, 5, "5 HP of healing exceeded max (10+20=30, capped at 25, 5 unspent)");
});

test("applyHpChange rejects actors without prepared HP", async () => {
  const noHp = { id: "no-hp", name: "Ghost", system: { attributes: {} } };
  await assert.rejects(
    () => applyHpChange(noHp, { mode: "damage", amount: 5 }),
    /does not have prepared current and maximum HP/,
  );
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

// --- Spell Slot Adjustment Tests ---

function spellcasterFixture(overrides = {}) {
  return {
    id: "caster-1",
    name: "Test Caster",
    type: "character",
    system: {
      spells: {
        spell1: { value: 4, max: 4, override: null },
        spell3: { value: 3, max: 3, override: null },
        pact: { value: 2, max: 2, override: null },
        ...overrides,
      },
    },
  };
}

test("previewSpellSlotAdjustment returns before/after for valid single adjustment", () => {
  const actor = spellcasterFixture();
  const preview = previewSpellSlotAdjustment(actor, {
    adjustments: [{ slot: "spell1", value: 3 }],
  });
  assert.equal(preview.operation, "adjust-spell-slots");
  assert.equal(preview.adjustments.length, 1);
  assert.deepEqual(preview.adjustments[0].before, { slot: "spell1", value: 4, max: 4, override: null });
  assert.deepEqual(preview.adjustments[0].after, { slot: "spell1", value: 3, max: 4, override: null });
  assert.ok(preview.selectedSlots, "preview must include internal selectedSlots field");
});

test("previewSpellSlotAdjustment supports pact magic", () => {
  const actor = spellcasterFixture();
  const preview = previewSpellSlotAdjustment(actor, {
    adjustments: [{ slot: "pact", value: 1 }],
  });
  assert.equal(preview.adjustments[0].slot, "pact");
  assert.equal(preview.adjustments[0].before.value, 2);
  assert.equal(preview.adjustments[0].after.value, 1);
});

test("previewSpellSlotAdjustment supports multi-slot adjustment", () => {
  const actor = spellcasterFixture();
  const preview = previewSpellSlotAdjustment(actor, {
    adjustments: [
      { slot: "spell1", value: 2 },
      { slot: "pact", value: 0 },
    ],
  });
  assert.equal(preview.adjustments.length, 2);
  // Sorted by slot
  assert.equal(preview.adjustments[0].slot, "pact");
  assert.equal(preview.adjustments[1].slot, "spell1");
});

test("previewSpellSlotAdjustment rejects non-character actors", () => {
  const actor = { ...spellcasterFixture(), type: "npc" };
  assert.throws(
    () => previewSpellSlotAdjustment(actor, { adjustments: [{ slot: "spell1", value: 3 }] }),
    /character actors only/,
  );
});

test("previewSpellSlotAdjustment rejects invalid slot names", () => {
  const actor = spellcasterFixture();
  assert.throws(
    () => previewSpellSlotAdjustment(actor, { adjustments: [{ slot: "spell0", value: 3 }] }),
    /slot must be pact or spell1 through spell9/,
  );
  assert.throws(
    () => previewSpellSlotAdjustment(actor, { adjustments: [{ slot: "spell10", value: 3 }] }),
    /slot must be pact or spell1 through spell9/,
  );
  assert.throws(
    () => previewSpellSlotAdjustment(actor, { adjustments: [{ slot: "mana", value: 3 }] }),
    /slot must be pact or spell1 through spell9/,
  );
});

test("previewSpellSlotAdjustment rejects duplicate slots", () => {
  const actor = spellcasterFixture();
  assert.throws(
    () => previewSpellSlotAdjustment(actor, {
      adjustments: [
        { slot: "spell1", value: 3 },
        { slot: "spell1", value: 2 },
      ],
    }),
    /Duplicate slot/,
  );
});

test("previewSpellSlotAdjustment rejects empty adjustments array", () => {
  const actor = spellcasterFixture();
  assert.throws(
    () => previewSpellSlotAdjustment(actor, { adjustments: [] }),
    /non-empty array/,
  );
});

test("previewSpellSlotAdjustment rejects value exceeding max", () => {
  const actor = spellcasterFixture();
  assert.throws(
    () => previewSpellSlotAdjustment(actor, { adjustments: [{ slot: "spell1", value: 5 }] }),
    /exceeds its prepared maximum/,
  );
});

test("previewSpellSlotAdjustment rejects no-op (value unchanged)", () => {
  const actor = spellcasterFixture();
  assert.throws(
    () => previewSpellSlotAdjustment(actor, { adjustments: [{ slot: "spell1", value: 4 }] }),
    /unchanged/,
  );
});

test("previewSpellSlotAdjustment rejects zero-max pool", () => {
  const actor = spellcasterFixture({ spell2: { value: 0, max: 0, override: null } });
  assert.throws(
    () => previewSpellSlotAdjustment(actor, { adjustments: [{ slot: "spell2", value: 0 }] }),
    /no available slots.*max is 0/,
  );
});

test("previewSpellSlotAdjustment rejects unavailable pool", () => {
  const actor = spellcasterFixture();
  assert.throws(
    () => previewSpellSlotAdjustment(actor, { adjustments: [{ slot: "spell7", value: 0 }] }),
    /unavailable/,
  );
});

test("previewSpellSlotAdjustment rejects unknown adjustment fields", () => {
  const actor = spellcasterFixture();
  assert.throws(
    () => previewSpellSlotAdjustment(actor, { adjustments: [{ slot: "spell1", value: 3, extra: true }] }),
    /only slot and value/,
  );
});

test("previewSpellSlotAdjustment rejects non-integer values", () => {
  const actor = spellcasterFixture();
  assert.throws(
    () => previewSpellSlotAdjustment(actor, { adjustments: [{ slot: "spell1", value: 1.5 }] }),
    /integer/,
  );
});

test("applySpellSlotAdjustment updates slots and returns read-back receipt", async () => {
  const actor = {
    ...spellcasterFixture(),
    async update(data) {
      for (const [path, val] of Object.entries(data)) {
        const parts = path.split(".");
        // path = "system.spells.spell1.value"
        this.system.spells[parts[2]].value = val;
      }
    },
  };
  const result = await applySpellSlotAdjustment(actor, {
    adjustments: [{ slot: "spell1", value: 2 }],
    expectedSelectedStateKey: JSON.stringify([{ slot: "spell1", value: 4, max: 4, override: null }]),
  });
  assert.equal(result.before.length, 1);
  assert.deepEqual(result.before[0].before, { slot: "spell1", value: 4, max: 4, override: null });
  assert.equal(result.after[0].slot, "spell1");
  assert.equal(result.after[0].value, 2);
});

test("applySpellSlotAdjustment rejects stale state (value changed since preview)", async () => {
  const actor = {
    ...spellcasterFixture(),
    async update() {},
  };
  // Actor currently has spell1=2, but token says it was 4 at preview time
  actor.system.spells.spell1.value = 2;
  await assert.rejects(
    () => applySpellSlotAdjustment(actor, {
      adjustments: [{ slot: "spell1", value: 1 }],
      expectedSelectedStateKey: JSON.stringify([{ slot: "spell1", value: 4, max: 4, override: null }]),
    }),
    /state changed since preview/,
  );
});

test("applySpellSlotAdjustment rejects stale max", async () => {
  const actor = {
    ...spellcasterFixture(),
    async update() {},
  };
  actor.system.spells.spell1.max = 5;
  await assert.rejects(
    () => applySpellSlotAdjustment(actor, {
      adjustments: [{ slot: "spell1", value: 3 }],
      expectedSelectedStateKey: JSON.stringify([{ slot: "spell1", value: 4, max: 4, override: null }]),
    }),
    /state changed since preview/,
  );
});

test("applySpellSlotAdjustment rejects if update unavailable", async () => {
  const actor = { ...spellcasterFixture() }; // no update method
  await assert.rejects(
    () => applySpellSlotAdjustment(actor, {
      adjustments: [{ slot: "spell1", value: 3 }],
      expectedSelectedStateKey: JSON.stringify([{ slot: "spell1", value: 4, max: 4, override: null }]),
    }),
    /Actor.update method is unavailable/,
  );
});

test("applySpellSlotAdjustment rejects mismatched read-back", async () => {
  const actor = {
    ...spellcasterFixture(),
    async update(data) {
      // Don't actually update — read-back will fail
    },
  };
  await assert.rejects(
    () => applySpellSlotAdjustment(actor, {
      adjustments: [{ slot: "spell1", value: 2 }],
      expectedSelectedStateKey: JSON.stringify([{ slot: "spell1", value: 4, max: 4, override: null }]),
    }),
    /does not match/,
  );
});

test("applySpellSlotAdjustment multi-slot update works atomically", async () => {
  const actor = {
    ...spellcasterFixture(),
    async update(data) {
      for (const [path, val] of Object.entries(data)) {
        const parts = path.split(".");
        this.system.spells[parts[2]].value = val;
      }
    },
  };
  const result = await applySpellSlotAdjustment(actor, {
    adjustments: [
      { slot: "spell1", value: 1 },
      { slot: "pact", value: 0 },
    ],
    expectedSelectedStateKey: JSON.stringify([
      { slot: "pact", value: 2, max: 2, override: null },
      { slot: "spell1", value: 4, max: 4, override: null },
    ]),
  });
  assert.equal(result.before.length, 2);
  assert.equal(result.after.length, 2);
  assert.equal(actor.system.spells.spell1.value, 1);
  assert.equal(actor.system.spells.pact.value, 0);
});

// ── auditJournalVisibility ──────────────────────────────────────────────

function fakeUser(id, name, isGM) {
  return { id, name, isGM };
}

function fakePage(id, readableBy) {
  return { id, testUserPermission: (user) => readableBy.has(user.id) };
}

function fakeEntry(id, readableBy, pages = []) {
  return { id, testUserPermission: (user) => readableBy.has(user.id), pages };
}

test("auditJournalVisibility computes a row per non-GM user for every entry and page, via each document's own testUserPermission", () => {
  const gm = fakeUser("gm-1", "GM", true);
  const alice = fakeUser("alice", "Alice", false);
  const bob = fakeUser("bob", "Bob", false);

  const entry = fakeEntry("e1", new Set(["alice"]), [fakePage("p1", new Set(["alice", "bob"]))]);
  const { rows } = auditJournalVisibility([entry], [gm, alice, bob]);

  // Two users x (one entry row + one page row) = 4 rows. GM never appears.
  assert.equal(rows.length, 4);
  assert.equal(rows.some((r) => r.userId === "gm-1"), false);

  const entryRowAlice = rows.find((r) => r.pageId === null && r.userId === "alice");
  const entryRowBob = rows.find((r) => r.pageId === null && r.userId === "bob");
  assert.equal(entryRowAlice.readable, true);
  assert.equal(entryRowBob.readable, false);

  const pageRowAlice = rows.find((r) => r.pageId === "p1" && r.userId === "alice");
  const pageRowBob = rows.find((r) => r.pageId === "p1" && r.userId === "bob");
  assert.equal(pageRowAlice.readable, true);
  assert.equal(pageRowBob.readable, true);
});

test("auditJournalVisibility tolerates an entry with no pages and a world with no entries", () => {
  const alice = fakeUser("alice", "Alice", false);
  assert.deepEqual(auditJournalVisibility([], [alice]).rows, []);
  const { rows } = auditJournalVisibility([fakeEntry("e1", new Set())], [alice]);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].pageId, null);
});

// ── handleBridgeRequest — the actor-less dispatch restructure ────────────

test("handleBridgeRequest routes audit-journal-visibility without requiring an actorId", async () => {
  const alice = fakeUser("alice", "Alice", false);
  const entry = fakeEntry("e1", new Set(["alice"]));
  const previousGame = globalThis.game;
  globalThis.game = { journal: [entry], users: [alice], actors: { get: () => undefined } };
  try {
    const result = await handleBridgeRequest({ type: "audit-journal-visibility" });
    assert.equal(result.rows.length, 1);
  } finally {
    globalThis.game = previousGame;
  }
});

test("handleBridgeRequest routes prepared-party-summary without requiring an actorId", async () => {
  const previousGame = globalThis.game;
  globalThis.game = { actors: { contents: [], get: () => undefined } };
  try {
    const result = await handleBridgeRequest({ type: "prepared-party-summary" });
    assert.deepEqual(result.actors, []);
  } finally {
    globalThis.game = previousGame;
  }
});

test("handleBridgeRequest still requires a real actor for actor-keyed operations", async () => {
  const previousGame = globalThis.game;
  globalThis.game = { actors: { get: () => undefined } };
  try {
    await assert.rejects(
      () => handleBridgeRequest({ type: "prepared-actor-summary", actorId: "missing" }),
      /was not found/,
    );
  } finally {
    globalThis.game = previousGame;
  }
});

// ── Journal writes — createJournalEntry / addJournalPage / updateJournalPage

function fakeJournalPage(overrides = {}) {
  const page = {
    id: overrides.id ?? "page-1",
    uuid: `JournalEntry.${overrides.entryId ?? "entry-1"}.JournalEntryPage.${overrides.id ?? "page-1"}`,
    name: overrides.name ?? "Page",
    ownership: overrides.ownership ?? { default: 0 },
    async update(data) {
      if (data.name !== undefined) page.name = data.name;
      if (data.ownership !== undefined) page.ownership = data.ownership;
    },
  };
  return page;
}

function fakeJournalEntry(overrides = {}) {
  const pages = overrides.pages ?? [];
  const entry = {
    id: overrides.id ?? "entry-1",
    uuid: `JournalEntry.${overrides.id ?? "entry-1"}`,
    name: overrides.name ?? "Entry",
    ownership: overrides.ownership ?? { default: 0 },
    pages: {
      contents: pages,
      get: (id) => pages.find((p) => p.id === id),
    },
    async createEmbeddedDocuments(docType, data) {
      const created = data.map((d, i) => fakeJournalPage({ entryId: entry.id, id: `new-page-${pages.length + i}`, name: d.name, ownership: d.ownership }));
      pages.push(...created);
      return created;
    },
  };
  return entry;
}

test("createJournalEntry writes explicit ownership on the entry and on every page — never left to inherit", async () => {
  const previousJournalEntry = globalThis.JournalEntry;
  let capturedData;
  globalThis.JournalEntry = {
    create: async (data) => {
      capturedData = data;
      return fakeJournalEntry({
        id: "new-entry",
        name: data.name,
        ownership: data.ownership,
        pages: data.pages.map((p, i) => fakeJournalPage({ id: `p${i}`, name: p.name, ownership: p.ownership })),
      });
    },
  };
  try {
    const receipt = await createJournalEntry({
      name: "Leon Blackstone",
      pages: [{ name: "Overview", content: "<p>Hi</p>" }],
      ownership: { default: 0, alice: 2 },
    });
    assert.equal(capturedData.ownership.default, 0);
    assert.equal(capturedData.pages[0].ownership.alice, 2);
    assert.equal(capturedData.pages[0].text.content, "<p>Hi</p>");
    assert.equal(receipt.entryId, "new-entry");
    assert.equal(receipt.pages[0].ownership.alice, 2);
  } finally {
    globalThis.JournalEntry = previousJournalEntry;
  }
});

test("createJournalEntry stores the knowledge flag under the module's own namespace when provided", async () => {
  const previousJournalEntry = globalThis.JournalEntry;
  let capturedData;
  globalThis.JournalEntry = {
    create: async (data) => {
      capturedData = data;
      return fakeJournalEntry({ id: "e1", name: data.name, ownership: data.ownership, pages: [] });
    },
  };
  try {
    await createJournalEntry({
      name: "X",
      pages: [{ name: "P", content: "c" }],
      ownership: { default: 0 },
      knowledge: { type: "person", tags: ["npc"] },
    });
    assert.deepEqual(capturedData.flags["foundry-mcp-bridge"].knowledge, { type: "person", tags: ["npc"] });
  } finally {
    globalThis.JournalEntry = previousJournalEntry;
  }
});

test("createJournalEntry requires a name, at least one page, and a resolved ownership map", async () => {
  await assert.rejects(() => createJournalEntry({ pages: [{ name: "P", content: "c" }], ownership: {} }), /name is required/);
  await assert.rejects(() => createJournalEntry({ name: "X", pages: [], ownership: {} }), /At least one page/);
  await assert.rejects(() => createJournalEntry({ name: "X", pages: [{ name: "P", content: "c" }] }), /resolved ownership map is required/);
});

test("addJournalPage creates one page under an existing entry with the given ownership and reads it back", async () => {
  const entry = fakeJournalEntry({ id: "entry-1", pages: [] });
  const previousGame = globalThis.game;
  globalThis.game = { journal: { get: (id) => (id === "entry-1" ? entry : undefined) } };
  try {
    const receipt = await addJournalPage({ entryId: "entry-1", pages: [{ name: "Secret", content: "<p>shh</p>" }], ownership: { default: 0 } });
    assert.equal(receipt.entryId, "entry-1");
    assert.equal(receipt.pageName, "Secret");
    assert.equal(entry.pages.contents.length, 1);
  } finally {
    globalThis.game = previousGame;
  }
});

test("addJournalPage throws if the entry does not exist", async () => {
  const previousGame = globalThis.game;
  globalThis.game = { journal: { get: () => undefined } };
  try {
    await assert.rejects(
      () => addJournalPage({ entryId: "missing", pages: [{ name: "P", content: "c" }], ownership: { default: 0 } }),
      /was not found/,
    );
  } finally {
    globalThis.game = previousGame;
  }
});

test("updateJournalPage updates name, content, and ownership on an existing page, and reads it back", async () => {
  const page = fakeJournalPage({ id: "page-1", name: "Old", ownership: { default: 0 } });
  const entry = fakeJournalEntry({ id: "entry-1", pages: [page] });
  const previousGame = globalThis.game;
  globalThis.game = { journal: { get: (id) => (id === "entry-1" ? entry : undefined) } };
  try {
    const receipt = await updateJournalPage({
      entryId: "entry-1",
      pageId: "page-1",
      pages: [{ name: "New", content: "<p>updated</p>" }],
      ownership: { default: 0, alice: 2 },
    });
    assert.equal(receipt.pageName, "New");
    assert.equal(page.name, "New");
    assert.equal(page.ownership.alice, 2);
  } finally {
    globalThis.game = previousGame;
  }
});

test("updateJournalPage throws if the page does not exist on the entry", async () => {
  const entry = fakeJournalEntry({ id: "entry-1", pages: [] });
  const previousGame = globalThis.game;
  globalThis.game = { journal: { get: () => entry } };
  try {
    await assert.rejects(
      () => updateJournalPage({ entryId: "entry-1", pageId: "missing", pages: [{ name: "P", content: "c" }], ownership: { default: 0 } }),
      /was not found/,
    );
  } finally {
    globalThis.game = previousGame;
  }
});

// ── Actor <-> journal linking ────────────────────────────────────────────

function fakeActorWithFlags(overrides = {}) {
  const flags = {};
  return {
    id: overrides.id ?? "actor-1",
    name: overrides.name ?? "Actor",
    async setFlag(scope, key, value) { (flags[scope] ??= {})[key] = value; },
    getFlag(scope, key) { return flags[scope]?.[key]; },
  };
}

function fakeJournalEntryWithFlags(overrides = {}) {
  const flags = {};
  return {
    id: overrides.id ?? "entry-1",
    uuid: `JournalEntry.${overrides.id ?? "entry-1"}`,
    name: overrides.name ?? "Entry",
    async setFlag(scope, key, value) { (flags[scope] ??= {})[key] = value; },
    getFlag(scope, key) { return flags[scope]?.[key]; },
  };
}

// Preview is intentionally not a bridge operation — see the comment on
// linkActorAndJournal above — so there is no previewActorJournalLink here
// to test; the sidecar previews this locally from its world snapshot
// (sidecar/app.test.js covers that).

test("linkActorAndJournal sets flags on both the actor and the entry, bidirectionally, and reads them back", async () => {
  const actor = fakeActorWithFlags({ id: "actor-1" });
  const entry = fakeJournalEntryWithFlags({ id: "entry-1" });
  const previousGame = globalThis.game;
  globalThis.game = { journal: { get: (id) => (id === "entry-1" ? entry : undefined) } };
  try {
    const receipt = await linkActorAndJournal(actor, { entryId: "entry-1" });
    assert.equal(receipt.linkedJournalEntryId, "entry-1");
    assert.equal(receipt.linkedActorId, "actor-1");
    assert.equal(actor.getFlag("foundry-mcp-bridge", "linkedJournalEntryId"), "entry-1");
    assert.equal(entry.getFlag("foundry-mcp-bridge", "linkedActorId"), "actor-1");
  } finally {
    globalThis.game = previousGame;
  }
});

test("linkActorAndJournal throws if the journal entry does not exist", async () => {
  const actor = fakeActorWithFlags();
  const previousGame = globalThis.game;
  globalThis.game = { journal: { get: () => undefined } };
  try {
    await assert.rejects(() => linkActorAndJournal(actor, { entryId: "missing" }), /was not found/);
  } finally {
    globalThis.game = previousGame;
  }
});

test("handleBridgeRequest routes link-actor-journal through the actor-keyed path, requiring a real actor", async () => {
  const previousGame = globalThis.game;
  globalThis.game = { actors: { get: () => undefined } };
  try {
    await assert.rejects(
      () => handleBridgeRequest({ type: "link-actor-journal", actorId: "missing", entryId: "entry-1" }),
      /Actor 'missing' was not found/,
    );
  } finally {
    globalThis.game = previousGame;
  }
});

test("handleBridgeRequest routes link-actor-journal end to end once the actor resolves", async () => {
  const actor = fakeActorWithFlags({ id: "actor-1" });
  const entry = fakeJournalEntryWithFlags({ id: "entry-1" });
  const previousGame = globalThis.game;
  globalThis.game = { actors: { get: (id) => (id === "actor-1" ? actor : undefined) }, journal: { get: (id) => (id === "entry-1" ? entry : undefined) } };
  try {
    const receipt = await handleBridgeRequest({ type: "link-actor-journal", actorId: "actor-1", entryId: "entry-1" });
    assert.equal(receipt.linkedActorId, "actor-1");
  } finally {
    globalThis.game = previousGame;
  }
});

test("handleBridgeRequest routes create-journal-entry without requiring an actorId", async () => {
  const previousGame = globalThis.game;
  const previousJournalEntry = globalThis.JournalEntry;
  globalThis.game = { actors: { get: () => undefined } };
  globalThis.JournalEntry = {
    create: async (data) => fakeJournalEntry({ id: "e1", name: data.name, ownership: data.ownership, pages: [] }),
  };
  try {
    const receipt = await handleBridgeRequest({
      type: "create-journal-entry",
      name: "X",
      pages: [{ name: "P", content: "c" }],
      ownership: { default: 0 },
    });
    assert.equal(receipt.entryId, "e1");
  } finally {
    globalThis.game = previousGame;
    globalThis.JournalEntry = previousJournalEntry;
  }
});
