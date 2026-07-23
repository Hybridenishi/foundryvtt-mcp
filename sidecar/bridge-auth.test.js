const test = require("node:test");
const assert = require("node:assert/strict");
const { bridgeTokenMatches } = require("./bridge-auth");

test("bridgeTokenMatches accepts only the exact per-client token", () => {
  const token = "c4f79a65-3e72-4c0b-bde2-1fd45b3d7070";
  assert.equal(bridgeTokenMatches(token, token), true);
  assert.equal(bridgeTokenMatches(`${token}x`, token), false);
  assert.equal(bridgeTokenMatches("not-the-token", token), false);
  assert.equal(bridgeTokenMatches(undefined, token), false);
});
