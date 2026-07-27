const test = require("node:test");
const assert = require("node:assert/strict");
const { readFileSync, readdirSync } = require("node:fs");
const { bridgeTokenMatches } = require("./bridge-auth");

test("bridgeTokenMatches accepts only the exact per-client token", () => {
  const token = "c4f79a65-3e72-4c0b-bde2-1fd45b3d7070";
  assert.equal(bridgeTokenMatches(token, token), true);
  assert.equal(bridgeTokenMatches(`${token}x`, token), false);
  assert.equal(bridgeTokenMatches("not-the-token", token), false);
  assert.equal(bridgeTokenMatches(undefined, token), false);
});

test("sidecar source requires private API and Foundry-account credentials", () => {
  // Scan every sidecar source file, not just index.js — write gating and the
  // route table now live in app.js, and a shared secret could just as easily
  // land in any of them.
  const combinedSource = readdirSync(__dirname)
    .filter((name) => name.endsWith(".js") && !name.endsWith(".test.js"))
    .map((name) => readFileSync(`${__dirname}/${name}`, "utf8"))
    .join("\n");
  assert.equal(combinedSource.includes("mcp-bridge-key-2026"), false);
  assert.equal(combinedSource.includes("password-for-hermes"), false);

  const index = readFileSync(`${__dirname}/index.js`, "utf8");
  assert.match(index, /API_KEY must be set/);
  assert.match(index, /FOUNDRY_PASSWORD must be set/);

  const app = readFileSync(`${__dirname}/app.js`, "utf8");
  assert.match(app, /function requireWriteEnabled/);
  assert.match(app, /actors\/:id\/delete", requireWriteEnabled/);
});
