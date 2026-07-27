const assert = require("node:assert/strict");
const test = require("node:test");
const { consumeConfirmation, issueConfirmation } = require("./confirmation");

test("confirmation binds every activity-use field and is one-time", () => {
  const confirmations = new Map();
  const binding = { actorId: "actor-1", itemId: "item-1", activityId: "activity-1", operation: "use-utility", options: "{}" };
  issueConfirmation(confirmations, "token-1", binding, 1_000, { now: 10 });
  assert.throws(() => consumeConfirmation(confirmations, "token-1", { ...binding, activityId: "other" }, "activity-use", { now: 20 }), /does not match/);
  consumeConfirmation(confirmations, "token-1", binding, "activity-use", { now: 20 });
  assert.throws(() => consumeConfirmation(confirmations, "token-1", binding, "activity-use", { now: 20 }), /unexpired/);
});

test("confirmation rejects stale tokens", () => {
  const confirmations = new Map();
  const binding = { actorId: "actor-1" };
  issueConfirmation(confirmations, "token-1", binding, 1, { now: 10 });
  assert.throws(() => consumeConfirmation(confirmations, "token-1", binding, "operation", { now: 12 }), /unexpired/);
});

test("confirmation binds a temporary HP amount", () => {
  const confirmations = new Map();
  const binding = { actorId: "actor-1", amount: 8 };
  issueConfirmation(confirmations, "token-1", binding, 1_000, { now: 10 });
  assert.throws(() => consumeConfirmation(confirmations, "token-1", { ...binding, amount: 9 }, "temporary-HP", { now: 20 }), /does not match/);
  consumeConfirmation(confirmations, "token-1", binding, "temporary-HP", { now: 20 });
});

test("confirmation binds every condition-change field", () => {
  const confirmations = new Map();
  const binding = { actorId: "actor-1", mode: "add", statusId: "blinded" };
  issueConfirmation(confirmations, "token-1", binding, 1_000, { now: 10 });
  assert.throws(() => consumeConfirmation(confirmations, "token-1", { ...binding, mode: "remove" }, "condition-change", { now: 20 }), /does not match/);
  consumeConfirmation(confirmations, "token-1", binding, "condition-change", { now: 20 });
});

// Regression: an HP-change confirmation issued with a bound `damageType` must
// reject an apply that simply omits the field, rather than silently treating
// the omission as "no opinion" and applying untyped damage. Before the fix,
// matching only iterated the keys present in the apply-time binding, so a
// dropped key skipped its own comparison instead of failing it.
test("confirmation rejects an apply that omits an optional bound field", () => {
  const confirmations = new Map();
  const binding = { actorId: "actor-1", mode: "damage", amount: 10, damageType: "fire" };
  issueConfirmation(confirmations, "token-1", binding, 1_000, { now: 10 });
  assert.throws(
    () => consumeConfirmation(confirmations, "token-1", { actorId: "actor-1", mode: "damage", amount: 10 }, "HP-change", { now: 20 }),
    /does not match/,
  );
});

test("confirmation rejects an apply that adds an unbound field", () => {
  const confirmations = new Map();
  const binding = { actorId: "actor-1", mode: "damage", amount: 10 };
  issueConfirmation(confirmations, "token-1", binding, 1_000, { now: 10 });
  assert.throws(
    () => consumeConfirmation(confirmations, "token-1", { ...binding, damageType: "fire" }, "HP-change", { now: 20 }),
    /does not match/,
  );
});

test("confirmation returns the issued payload without exposing it to binding matching", () => {
  const confirmations = new Map();
  const binding = { actorId: "actor-1", operation: "adjust-spell-slots", adjustmentsKey: "[]" };
  issueConfirmation(confirmations, "token-1", binding, 1_000, { now: 10, payload: { selectedStateKey: "trusted-fingerprint" } });
  // A caller cannot forge a match by guessing at the payload shape and
  // including it in the binding it presents.
  assert.throws(
    () => consumeConfirmation(confirmations, "token-1", { ...binding, selectedStateKey: "trusted-fingerprint" }, "spell-slot-adjustment", { now: 20 }),
    /does not match/,
  );
  const payload = consumeConfirmation(confirmations, "token-1", binding, "spell-slot-adjustment", { now: 20 });
  assert.equal(payload.selectedStateKey, "trusted-fingerprint");
});
