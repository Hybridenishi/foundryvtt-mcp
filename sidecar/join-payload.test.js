/**
 * Foundry v14 reads the join payload's user field as `userId` (camelCase).
 *
 * Sending `userid` leaves `req.body.userId` undefined, so Foundry looks up a user whose id is
 * `undefined`, `canJoin()` throws, and the login is rejected with HTTP 401
 * `JOIN.ErrorUserDoesNotExist` — indistinguishable from a wrong password. The sidecar crashed on
 * startup for weeks on exactly that. Keep the field name pinned.
 */
const test = require("node:test");
const assert = require("node:assert/strict");
const { readFileSync } = require("node:fs");

const source = readFileSync(`${__dirname}/index.js`, "utf8");

test("the /join payload sends userId, not userid", () => {
  assert.match(source, /action: "join",\s*userId/, "join payload must send userId");
  assert.equal(
    /action: "join",\s*userid\b/.test(source),
    false,
    "lowercase userid is not read by Foundry v14 — the login 401s",
  );
});
