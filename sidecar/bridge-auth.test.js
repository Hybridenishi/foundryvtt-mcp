const test = require("node:test");
const assert = require("node:assert/strict");
const { readFileSync } = require("node:fs");
const { bridgeTokenMatches } = require("./bridge-auth");

test("bridgeTokenMatches accepts only the exact per-client token", () => {
  const token = "c4f79a65-3e72-4c0b-bde2-1fd45b3d7070";
  assert.equal(bridgeTokenMatches(token, token), true);
  assert.equal(bridgeTokenMatches(`${token}x`, token), false);
  assert.equal(bridgeTokenMatches("not-the-token", token), false);
  assert.equal(bridgeTokenMatches(undefined, token), false);
});

test("sidecar source requires private API and Foundry-account credentials", () => {
  const source = readFileSync(`${__dirname}/index.js`, "utf8");
  assert.equal(source.includes("mcp-bridge-key-2026"), false);
  assert.equal(source.includes("password-for-hermes"), false);
  assert.match(source, /API_KEY must be set/);
  assert.match(source, /FOUNDRY_PASSWORD must be set/);
});
