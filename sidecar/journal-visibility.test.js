const assert = require("node:assert/strict");
const test = require("node:test");

const {
  OWNERSHIP,
  isGm,
  entryLevel,
  pageLevel,
  canReadEntry,
  canReadPage,
  ownerUserIds,
  resolvePlayer,
  visibleJournalFor,
  entryVisibility,
  pageVisibility,
  describeSearchResult,
  describeEntryDetail,
} = require("./journal-visibility");

const GM = { _id: "gm-1", name: "GM", role: 4 };
const ALICE = { _id: "alice", name: "Alice", role: 1 };
const BOB = { _id: "bob", name: "Bob", role: 1 };

function entry(overrides = {}) {
  return { _id: "e1", name: "Entry", pages: [], ...overrides };
}
function page(overrides = {}) {
  return { _id: "p1", name: "Page", type: "text", text: { content: "" }, ...overrides };
}

// ── isGm ────────────────────────────────────────────────────────────────

test("isGm is true only at or above the GM role, and false for malformed input", () => {
  assert.equal(isGm(GM), true);
  assert.equal(isGm(ALICE), false);
  assert.equal(isGm(null), false);
  assert.equal(isGm(undefined), false);
  assert.equal(isGm({ role: "4" }), true); // numeric-string role still resolves
  assert.equal(isGm({ role: "bogus" }), false);
});

// ── entryLevel / canReadEntry — the level table ──────────────────────────

test("entryLevel reads an explicit per-user level over default", () => {
  const e = entry({ ownership: { default: 0, alice: 2 } });
  assert.equal(entryLevel(e, ALICE), OWNERSHIP.OBSERVER);
  assert.equal(entryLevel(e, BOB), OWNERSHIP.NONE);
});

test("GM always resolves to OWNER regardless of the ownership map", () => {
  const e = entry({ ownership: { default: 0 } });
  assert.equal(entryLevel(e, GM), OWNERSHIP.OWNER);
  assert.equal(canReadEntry(e, GM), true);
});

test("LIMITED is not readable — the entry is excluded, not name-only visible", () => {
  const e = entry({ ownership: { default: OWNERSHIP.LIMITED } });
  assert.equal(canReadEntry(e, ALICE), false);
});

test("OBSERVER and OWNER are both readable", () => {
  assert.equal(canReadEntry(entry({ ownership: { default: OWNERSHIP.OBSERVER } }), ALICE), true);
  assert.equal(canReadEntry(entry({ ownership: { default: OWNERSHIP.OWNER } }), ALICE), true);
});

test("an entry has no parent to inherit from: explicit INHERIT denies, like no ownership at all", () => {
  assert.equal(canReadEntry(entry({ ownership: { default: OWNERSHIP.INHERIT } }), ALICE), false);
  assert.equal(canReadEntry(entry({}), ALICE), false);
});

test("malformed ownership shapes deny rather than throw", () => {
  assert.equal(canReadEntry(entry({ ownership: null }), ALICE), false);
  assert.equal(canReadEntry(entry({ ownership: "yes" }), ALICE), false);
  assert.equal(canReadEntry(entry({ ownership: { default: "high" } }), ALICE), false);
  assert.equal(canReadEntry(entry({ ownership: { default: 2 } }), undefined), false);
  assert.equal(canReadEntry(entry({ ownership: { default: 2 } }), {}), false); // no _id
});

// ── pageLevel / canReadPage — INHERIT is a lookup, never a default ───────

test("a page with no ownership asks the entry", () => {
  const e = entry({ ownership: { default: OWNERSHIP.OBSERVER } });
  const p = page({});
  assert.equal(canReadPage(e, p, ALICE), true);
});

test("a page with explicit INHERIT asks the entry, same as no ownership", () => {
  const e = entry({ ownership: { default: OWNERSHIP.OBSERVER } });
  const p = page({ ownership: { default: OWNERSHIP.INHERIT } });
  assert.equal(canReadPage(e, p, ALICE), true);
});

test("a GM-only page under a visible entry stays hidden — explicit page ownership never falls back", () => {
  const e = entry({ ownership: { default: OWNERSHIP.OBSERVER } });
  const p = page({ ownership: { default: OWNERSHIP.NONE } });
  assert.equal(canReadPage(e, p, ALICE), false);
});

test("a page default of OBSERVER under a GM-only entry is exposed — deliberately asserted", () => {
  // This is the leak the write path must never produce: a GM page's
  // ownership must be written explicitly (0 per user), never left to
  // inherit, and the entry's own denial does not protect a page that
  // grants its own broader access. Proving this is real is what justifies
  // that rule.
  const e = entry({ ownership: { default: OWNERSHIP.NONE } });
  const p = page({ ownership: { default: OWNERSHIP.OBSERVER } });
  assert.equal(canReadEntry(e, ALICE), false);
  assert.equal(canReadPage(e, p, ALICE), false, "canReadPage requires entry-level access too");
  // But pageLevel alone (the lower-level primitive) does resolve OBSERVER —
  // canReadPage's extra canReadEntry() check is what actually prevents the
  // leak; this asserts the mechanism, not just the outcome.
  assert.equal(pageLevel(e, p, ALICE), OWNERSHIP.OBSERVER);
});

test("GM bypasses page ownership entirely", () => {
  const e = entry({ ownership: { default: OWNERSHIP.NONE } });
  const p = page({ ownership: { default: OWNERSHIP.NONE } });
  assert.equal(canReadPage(e, p, GM), true);
});

// ── ownerUserIds ──────────────────────────────────────────────────────────

test("ownerUserIds returns only explicit per-user Owner grants, never a permissive default", () => {
  assert.deepEqual(ownerUserIds({ ownership: { default: 3, alice: 3, bob: 2 } }), ["alice"]);
  assert.deepEqual(ownerUserIds({ ownership: { default: 0 } }), []);
  assert.deepEqual(ownerUserIds({}), []);
  assert.deepEqual(ownerUserIds(null), []);
});

// ── resolvePlayer — id, name, character name, ambiguous, unmatched ───────

const USERS = [GM, ALICE, BOB];
const ACTORS = [
  { _id: "actor-hero", name: "Hero", type: "character", ownership: { default: 0, alice: 3 } },
  { _id: "actor-decoy", name: "Alice", type: "character", ownership: { default: 0, bob: 3 } }, // a character literally named "Alice", owned by Bob
];

test("resolvePlayer matches by exact user id", () => {
  const { user, reason } = resolvePlayer(USERS, ACTORS, "alice");
  assert.equal(user._id, "alice");
  assert.equal(reason, null);
});

test("resolvePlayer matches by user name, case-insensitively", () => {
  assert.equal(resolvePlayer(USERS, ACTORS, "bob").user._id, "bob");
  assert.equal(resolvePlayer(USERS, ACTORS, "BOB").user._id, "bob");
});

test("resolvePlayer matches by an owned character's name", () => {
  const { user } = resolvePlayer(USERS, [ACTORS[0]], "Hero");
  assert.equal(user._id, "alice");
});

test("resolvePlayer refuses rather than guesses when a user name and a different user's character name collide", () => {
  const { user, reason } = resolvePlayer(USERS, ACTORS, "Alice");
  assert.equal(user, null);
  assert.match(reason, /ambiguous/);
  assert.match(reason, /Alice/);
  assert.match(reason, /Bob/);
});

test("resolvePlayer never matches a GM", () => {
  assert.equal(resolvePlayer(USERS, ACTORS, "GM").user, null);
  assert.equal(resolvePlayer(USERS, ACTORS, "gm-1").user, null);
});

test("resolvePlayer reports no-match and empty-reference distinctly, without guessing", () => {
  assert.match(resolvePlayer(USERS, ACTORS, "nobody").reason, /no matching player/);
  assert.match(resolvePlayer(USERS, ACTORS, "").reason, /empty/);
  assert.equal(resolvePlayer(USERS, ACTORS, undefined).user, null);
});

// ── visibleJournalFor — the empty-entry vs hidden-content-entry rule ─────

test("visibleJournalFor drops an entry the user cannot read at all", () => {
  const e = entry({ ownership: { default: OWNERSHIP.NONE } });
  assert.deepEqual(visibleJournalFor([e], ALICE), []);
});

test("visibleJournalFor keeps a readable entry with zero pages — nothing is being hidden from it", () => {
  const e = entry({ ownership: { default: OWNERSHIP.OBSERVER }, pages: [] });
  const result = visibleJournalFor([e], ALICE);
  assert.equal(result.length, 1);
  assert.deepEqual(result[0].pages, []);
});

test("visibleJournalFor drops a readable entry whose pages exist but are all hidden", () => {
  const e = entry({
    ownership: { default: OWNERSHIP.OBSERVER },
    pages: [page({ _id: "p1", ownership: { default: OWNERSHIP.NONE } })],
  });
  assert.deepEqual(visibleJournalFor([e], ALICE), []);
});

test("visibleJournalFor keeps only the readable subset of a mixed entry's pages", () => {
  const e = entry({
    ownership: { default: OWNERSHIP.OBSERVER },
    pages: [
      page({ _id: "public", ownership: { default: OWNERSHIP.OBSERVER } }),
      page({ _id: "secret", ownership: { default: OWNERSHIP.NONE } }),
    ],
  });
  const result = visibleJournalFor([e], ALICE);
  assert.equal(result.length, 1);
  assert.deepEqual(result[0].pages.map((p) => p._id), ["public"]);
});

// ── entryVisibility / pageVisibility / describe* — GM-facing resolution ──

test("entryVisibility names the non-GM users who can read, and excludes GMs from the list", () => {
  const e = entry({ ownership: { default: 0, alice: 2, bob: 2 } });
  const v = entryVisibility(e, [GM, ALICE, BOB]);
  assert.equal(v.gmOnly, false);
  assert.deepEqual(v.visibleTo.map((u) => u.name).sort(), ["Alice", "Bob"]);
});

test("entryVisibility reports gmOnly with an empty list when no non-GM user can read it", () => {
  const e = entry({ ownership: { default: 0 } });
  const v = entryVisibility(e, [GM, ALICE, BOB]);
  assert.equal(v.gmOnly, true);
  assert.deepEqual(v.visibleTo, []);
});

test("pageVisibility resolves per page, independent of the entry's own visibility", () => {
  const e = entry({ ownership: { default: 2, alice: 2 } });
  const p = page({ ownership: { default: 0 } });
  const v = pageVisibility(e, p, [GM, ALICE, BOB]);
  assert.equal(v.gmOnly, true);
});

test("describeSearchResult attaches visibility to the entry and to each pageHit by id", () => {
  const rawEntry = entry({
    ownership: { default: 0, alice: 2 },
    pages: [page({ _id: "p1", ownership: { default: 0, alice: 2 } })],
  });
  const searchResult = { entryId: "e1", entryName: "Entry", uuid: "JournalEntry.e1", pageHits: [{ pageId: "p1" }] };
  const described = describeSearchResult(rawEntry, searchResult, [GM, ALICE, BOB]);
  assert.deepEqual(described.visibility.visibleTo.map((u) => u.name), ["Alice"]);
  assert.deepEqual(described.pageHits[0].visibility.visibleTo.map((u) => u.name), ["Alice"]);
});

test("describeEntryDetail attaches visibility to the entry and to every page", () => {
  const rawEntry = entry({
    ownership: { default: 2 },
    pages: [page({ _id: "p1", ownership: { default: 0 } })],
  });
  const detail = { _id: "e1", name: "Entry", uuid: "JournalEntry.e1", pages: [{ _id: "p1", name: "Page" }] };
  const described = describeEntryDetail(rawEntry, detail, [GM, ALICE]);
  assert.equal(described.visibility.gmOnly, false);
  assert.equal(described.pages[0].visibility.gmOnly, true);
});

test("describeEntryDetail passes through null unchanged", () => {
  assert.equal(describeEntryDetail(undefined, null, [GM]), null);
});
