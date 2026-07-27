const assert = require("node:assert/strict");
const test = require("node:test");
const {
  parseHpChange,
  parseTemporaryHp,
  parseConditionChange,
  parseSpellSlotAdjustment,
  adjustmentsKey,
} = require("./confirmations");

// ── parseHpChange ────────────────────────────────────────────────────

test("parseHpChange accepts damage and healing without a damageType", () => {
  assert.deepEqual(parseHpChange({ mode: "damage", amount: 10 }), { mode: "damage", amount: 10 });
  assert.deepEqual(parseHpChange({ mode: "healing", amount: 5 }), { mode: "healing", amount: 5 });
});

test("parseHpChange rejects an invalid mode or out-of-range amount", () => {
  assert.throws(() => parseHpChange({ mode: "heal", amount: 10 }), /mode must be/);
  assert.throws(() => parseHpChange({ mode: "damage", amount: 0 }), /amount must be/);
  assert.throws(() => parseHpChange({ mode: "damage", amount: 100_001 }), /amount must be/);
  assert.throws(() => parseHpChange({ mode: "damage", amount: 1.5 }), /amount must be/);
});

test("parseHpChange normalizes a trimmed, mixed-case damageType", () => {
  assert.deepEqual(parseHpChange({ mode: "damage", amount: 10, damageType: " Fire " }), { mode: "damage", amount: 10, damageType: "fire" });
});

test("parseHpChange rejects an unrecognized or whitespace-only damageType", () => {
  assert.throws(() => parseHpChange({ mode: "damage", amount: 10, damageType: "banana" }), /not a recognized dnd5e damage type/);
  assert.throws(() => parseHpChange({ mode: "damage", amount: 10, damageType: "   " }), /must not be empty or whitespace-only/);
});

test("parseHpChange rejects damageType on healing mode", () => {
  assert.throws(() => parseHpChange({ mode: "healing", amount: 10, damageType: "fire" }), /only valid for damage mode/);
});

// ── parseTemporaryHp ─────────────────────────────────────────────────

test("parseTemporaryHp accepts zero and positive integers", () => {
  assert.deepEqual(parseTemporaryHp({ amount: 0 }), { amount: 0 });
  assert.deepEqual(parseTemporaryHp({ amount: 12 }), { amount: 12 });
});

test("parseTemporaryHp rejects negative, non-integer, or out-of-range amounts", () => {
  assert.throws(() => parseTemporaryHp({ amount: -1 }), /amount must be/);
  assert.throws(() => parseTemporaryHp({ amount: 1.5 }), /amount must be/);
  assert.throws(() => parseTemporaryHp({ amount: 100_001 }), /amount must be/);
});

// ── parseConditionChange ─────────────────────────────────────────────

test("parseConditionChange accepts add and remove with a valid statusId", () => {
  assert.deepEqual(parseConditionChange({ mode: "add", statusId: "blinded" }), { mode: "add", statusId: "blinded" });
  assert.deepEqual(parseConditionChange({ mode: "remove", statusId: "blinded" }), { mode: "remove", statusId: "blinded" });
});

test("parseConditionChange rejects an invalid mode or malformed statusId", () => {
  assert.throws(() => parseConditionChange({ mode: "toggle", statusId: "blinded" }), /mode must be/);
  assert.throws(() => parseConditionChange({ mode: "add", statusId: "not a valid id!" }), /statusId must be/);
  assert.throws(() => parseConditionChange({ mode: "add", statusId: "" }), /statusId must be/);
});

// ── parseSpellSlotAdjustment ─────────────────────────────────────────

test("parseSpellSlotAdjustment accepts one or more valid adjustments", () => {
  const result = parseSpellSlotAdjustment({ adjustments: [{ slot: "spell1", value: 2 }, { slot: "pact", value: 1 }] });
  assert.equal(result.adjustments.length, 2);
  assert.equal(typeof result.adjustmentsKey, "string");
});

test("parseSpellSlotAdjustment rejects an empty or non-array adjustments field", () => {
  assert.throws(() => parseSpellSlotAdjustment({ adjustments: [] }), /non-empty array/);
  assert.throws(() => parseSpellSlotAdjustment({ adjustments: "spell1" }), /non-empty array/);
  assert.throws(() => parseSpellSlotAdjustment({}), /non-empty array/);
});

test("parseSpellSlotAdjustment rejects an invalid slot id", () => {
  assert.throws(() => parseSpellSlotAdjustment({ adjustments: [{ slot: "spell10", value: 1 }] }), /slot must be pact or spell1 through spell9/);
});

test("parseSpellSlotAdjustment rejects a duplicate slot", () => {
  assert.throws(
    () => parseSpellSlotAdjustment({ adjustments: [{ slot: "spell1", value: 1 }, { slot: "spell1", value: 2 }] }),
    /Duplicate slot/,
  );
});

test("parseSpellSlotAdjustment rejects an out-of-range value and extra fields", () => {
  assert.throws(() => parseSpellSlotAdjustment({ adjustments: [{ slot: "spell1", value: -1 }] }), /value must be/);
  assert.throws(() => parseSpellSlotAdjustment({ adjustments: [{ slot: "spell1", value: 100_001 }] }), /value must be/);
  assert.throws(
    () => parseSpellSlotAdjustment({ adjustments: [{ slot: "spell1", value: 1, override: 2 }] }),
    /must contain only slot and value/,
  );
});

test("adjustmentsKey is order-independent so a reordered, equivalent request keeps the same binding", () => {
  const a = [{ slot: "spell2", value: 1 }, { slot: "pact", value: 2 }];
  const b = [{ slot: "pact", value: 2 }, { slot: "spell2", value: 1 }];
  assert.equal(adjustmentsKey(a), adjustmentsKey(b));
});

test("adjustmentsKey distinguishes a genuinely different request", () => {
  const a = [{ slot: "spell2", value: 1 }];
  const b = [{ slot: "spell2", value: 2 }];
  assert.notEqual(adjustmentsKey(a), adjustmentsKey(b));
});
