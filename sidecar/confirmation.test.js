const assert = require("node:assert/strict");
const test = require("node:test");
const { consumeConfirmation, issueConfirmation } = require("./confirmation");

test("confirmation binds every activity-use field and is one-time", () => {
  const confirmations = new Map();
  const binding = { actorId: "actor-1", itemId: "item-1", activityId: "activity-1", operation: "use-utility", options: "{}" };
  issueConfirmation(confirmations, "token-1", binding, 1_000, 10);
  assert.throws(() => consumeConfirmation(confirmations, "token-1", { ...binding, activityId: "other" }, "activity-use", 20), /does not match/);
  consumeConfirmation(confirmations, "token-1", binding, "activity-use", 20);
  assert.throws(() => consumeConfirmation(confirmations, "token-1", binding, "activity-use", 20), /unexpired/);
});

test("confirmation rejects stale tokens", () => {
  const confirmations = new Map();
  const binding = { actorId: "actor-1" };
  issueConfirmation(confirmations, "token-1", binding, 1, 10);
  assert.throws(() => consumeConfirmation(confirmations, "token-1", binding, "operation", 12), /unexpired/);
});
