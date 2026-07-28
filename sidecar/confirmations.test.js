const assert = require("node:assert/strict");
const test = require("node:test");
const {
  parseHpChange,
  parseTemporaryHp,
  parseConditionChange,
  parseSpellSlotAdjustment,
  adjustmentsKey,
  parseJournalWrite,
  canonicalJson,
  digest,
  issueJournalWriteConfirmation,
  consumeJournalWriteConfirmation,
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

// ── canonicalJson / digest ────────────────────────────────────────────

test("canonicalJson is key-order-independent", () => {
  assert.equal(canonicalJson({ a: 1, b: 2 }), canonicalJson({ b: 2, a: 1 }));
});

test("canonicalJson distinguishes genuinely different values, including nested objects and arrays", () => {
  assert.notEqual(canonicalJson({ a: 1 }), canonicalJson({ a: 2 }));
  assert.notEqual(canonicalJson([{ a: 1 }, { b: 2 }]), canonicalJson([{ b: 2 }, { a: 1 }])); // array order matters
  assert.equal(canonicalJson(null), canonicalJson(undefined)); // both null-coerced
});

test("digest is a stable sha256 hex string that agrees with canonicalJson's equivalence", () => {
  assert.equal(digest({ a: 1, b: 2 }), digest({ b: 2, a: 1 }));
  assert.notEqual(digest({ a: 1 }), digest({ a: 2 }));
  assert.match(digest({ a: 1 }), /^[0-9a-f]{64}$/);
});

// ── parseJournalWrite ─────────────────────────────────────────────────

function validCreateBody(overrides = {}) {
  return {
    operation: "create-entry",
    name: "Leon Blackstone",
    pages: [{ name: "Overview", content: "<p>A shopkeeper.</p>" }],
    visibility: { profile: "gm" },
    ...overrides,
  };
}

test("parseJournalWrite accepts a minimal valid create-entry", () => {
  const parsed = parseJournalWrite(validCreateBody());
  assert.equal(parsed.operation, "create-entry");
  assert.equal(parsed.name, "Leon Blackstone");
  assert.equal(parsed.entryId, null);
  assert.equal(parsed.pageId, null);
});

test("parseJournalWrite rejects an unknown operation", () => {
  assert.throws(() => parseJournalWrite(validCreateBody({ operation: "delete-entry" })), /operation must be/);
});

test("parseJournalWrite requires entryId for add-page and update-page", () => {
  assert.throws(
    () => parseJournalWrite({ operation: "add-page", pages: [{ name: "P", content: "c" }], visibility: { profile: "gm" } }),
    /entryId is required/,
  );
});

test("parseJournalWrite requires pageId for update-page", () => {
  assert.throws(
    () => parseJournalWrite({ operation: "update-page", entryId: "e1", pages: [{ name: "P", content: "c" }], visibility: { profile: "gm" } }),
    /pageId is required/,
  );
});

test("parseJournalWrite requires name for create-entry", () => {
  assert.throws(() => parseJournalWrite(validCreateBody({ name: undefined })), /name is required/);
  assert.throws(() => parseJournalWrite(validCreateBody({ name: "   " })), /name is required/);
});

test("parseJournalWrite rejects missing visibility, and an unknown profile", () => {
  assert.throws(() => parseJournalWrite(validCreateBody({ visibility: undefined })), /visibility.profile is required/);
  assert.throws(() => parseJournalWrite(validCreateBody({ visibility: { profile: "everyone" } })), /visibility.profile is required/);
});

test("parseJournalWrite requires a non-empty players array for the 'players' profile", () => {
  assert.throws(() => parseJournalWrite(validCreateBody({ visibility: { profile: "players", players: [] } })), /non-empty array/);
  assert.throws(() => parseJournalWrite(validCreateBody({ visibility: { profile: "players" } })), /non-empty array/);
});

test("parseJournalWrite rejects a players key on a non-'players' profile", () => {
  assert.throws(
    () => parseJournalWrite(validCreateBody({ visibility: { profile: "gm", players: ["Alice"] } })),
    /only valid with the 'players' profile/,
  );
});

test("parseJournalWrite rejects update-page or add-page with more than one page", () => {
  const twoPages = [{ name: "A", content: "a" }, { name: "B", content: "b" }];
  assert.throws(
    () => parseJournalWrite({ operation: "update-page", entryId: "e1", pageId: "p1", pages: twoPages, visibility: { profile: "gm" } }),
    /takes exactly one page/,
  );
  assert.throws(
    () => parseJournalWrite({ operation: "add-page", entryId: "e1", pages: twoPages, visibility: { profile: "gm" } }),
    /takes exactly one page/,
  );
});

test("parseJournalWrite rejects an unrecognized knowledge.type", () => {
  assert.throws(() => parseJournalWrite(validCreateBody({ knowledge: { type: "bogus" } })), /not recognized/);
});

test("parseJournalWrite accepts a recognized knowledge.type and tags", () => {
  const parsed = parseJournalWrite(validCreateBody({ knowledge: { type: "person", tags: ["npc"] } }));
  assert.deepEqual(parsed.knowledge, { type: "person", tags: ["npc"] });
});

// ── journal-write confirmation binding ──────────────────────────────────

test("a journal-write confirmation issued for one visibility is rejected by an apply for a different visibility", () => {
  const request = validCreateBody();
  const parsed = parseJournalWrite(request);
  const ownershipA = { default: 0, alice: 2 };
  const ownershipB = { default: 0, alice: 2, bob: 2 };

  const { confirmationToken } = issueJournalWriteConfirmation(parsed, ownershipA, [{ userId: "alice", name: "Alice" }]);
  assert.throws(
    () => consumeJournalWriteConfirmation(confirmationToken, parsed, ownershipB),
    /does not match/,
  );
});

test("a journal-write confirmation is rejected by an apply that omits any bound field, not silently defaulted", () => {
  const request = validCreateBody();
  const parsed = parseJournalWrite(request);
  const ownership = { default: 0, alice: 2 };
  const { confirmationToken } = issueJournalWriteConfirmation(parsed, ownership, [{ userId: "alice", name: "Alice" }]);

  const differentPages = parseJournalWrite(validCreateBody({ pages: [{ name: "Overview", content: "<p>Different.</p>" }] }));
  assert.throws(
    () => consumeJournalWriteConfirmation(confirmationToken, differentPages, ownership),
    /does not match/,
  );
});

test("consumeJournalWriteConfirmation returns exactly the payload recorded at preview — ownership and names", () => {
  const parsed = parseJournalWrite(validCreateBody());
  const ownership = { default: 0, alice: 2 };
  const resolvedNames = [{ userId: "alice", name: "Alice" }];
  const { confirmationToken } = issueJournalWriteConfirmation(parsed, ownership, resolvedNames);

  const payload = consumeJournalWriteConfirmation(confirmationToken, parsed, ownership);
  assert.deepEqual(payload.resolvedOwnership, ownership);
  assert.deepEqual(payload.resolvedNames, resolvedNames);
});

test("a journal-write confirmation token can only be consumed once", () => {
  const parsed = parseJournalWrite(validCreateBody());
  const ownership = { default: 0 };
  const { confirmationToken } = issueJournalWriteConfirmation(parsed, ownership, []);
  consumeJournalWriteConfirmation(confirmationToken, parsed, ownership);
  assert.throws(() => consumeJournalWriteConfirmation(confirmationToken, parsed, ownership), /valid, unexpired/);
});
