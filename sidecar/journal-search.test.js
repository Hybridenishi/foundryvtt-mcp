const assert = require("node:assert/strict");
const test = require("node:test");

const {
  knowledgeOf,
  searchJournal,
  buildFoldersById,
  entryDetail,
  journalFolderTree,
  contentHash,
} = require("./journal-search");

function page(overrides = {}) {
  return { _id: "page-1", name: "Overview", type: "text", text: { content: "" }, ...overrides };
}

function entry(overrides = {}) {
  return { _id: "entry-1", name: "Fixture Entry", pages: [page()], ...overrides };
}

// ── knowledgeOf ─────────────────────────────────────────────────────────

test("knowledgeOf reads our own flag first", () => {
  const e = entry({ flags: { "foundry-mcp-bridge": { knowledge: { type: "location", tags: ["city"] } } } });
  const k = knowledgeOf(e, new Map());
  assert.equal(k.type, "location");
  assert.deepEqual(k.tags, ["city"]);
  assert.equal(k.source, "flag");
});

test("knowledgeOf rejects an unrecognized type on our own flag", () => {
  const e = entry({ flags: { "foundry-mcp-bridge": { knowledge: { type: "bogus" } } } });
  assert.equal(knowledgeOf(e, new Map()).type, "other");
});

test("knowledgeOf falls back to Campaign Codex's type flag when ours is absent", () => {
  const e = entry({ flags: { "campaign-codex": { type: "npc" } } });
  const k = knowledgeOf(e, new Map());
  assert.equal(k.type, "person");
  assert.equal(k.source, "campaign-codex-flag");
});

test("knowledgeOf does not guess at a Campaign Codex type it has no confident mapping for", () => {
  const e = entry({ flags: { "campaign-codex": { type: "group" } } });
  assert.equal(knowledgeOf(e, new Map()).type, "other");
});

test("knowledgeOf falls back to folder name when no flag is present", () => {
  const foldersById = new Map([["folder-1", { _id: "folder-1", name: "Locations" }]]);
  const e = entry({ folder: "folder-1" });
  const k = knowledgeOf(e, foldersById);
  assert.equal(k.type, "location");
  assert.equal(k.source, "folder");
});

test("knowledgeOf defaults to other with no flag and no matching folder", () => {
  const foldersById = new Map([["folder-1", { _id: "folder-1", name: "Miscellany" }]]);
  const e = entry({ folder: "folder-1" });
  const k = knowledgeOf(e, foldersById);
  assert.equal(k.type, "other");
  assert.equal(k.source, "default");
});

test("knowledgeOf is absence-tolerant: no flags object, no folder, malformed folder ref", () => {
  assert.equal(knowledgeOf({ _id: "e", name: "n" }, new Map()).type, "other");
  assert.equal(knowledgeOf(entry({ folder: null }), new Map()).type, "other");
  assert.equal(knowledgeOf(entry({ folder: "missing-folder-id" }), new Map()).type, "other");
});

// ── searchJournal ───────────────────────────────────────────────────────

test("searchJournal matches page content and returns a snippet with matchCount", () => {
  const e = entry({ pages: [page({ text: { content: "The harbor district of Ravencroft has been quiet lately." } })] });
  const { total, results } = searchJournal([e], new Map(), { query: "Ravencroft" });
  assert.equal(total, 1);
  assert.equal(results[0].pageHits.length, 1);
  assert.equal(results[0].pageHits[0].matchCount, 1);
  assert.match(results[0].pageHits[0].snippet, /\*\*Ravencroft\*\*/);
});

test("searchJournal counts multiple occurrences on one page", () => {
  const e = entry({ pages: [page({ text: { content: "Ravencroft. Ravencroft again. And Ravencroft once more." } })] });
  const { results } = searchJournal([e], new Map(), { query: "Ravencroft" });
  assert.equal(results[0].pageHits[0].matchCount, 3);
});

test("searchJournal reports hits across multiple pages on the same entry", () => {
  const e = entry({
    pages: [
      page({ _id: "p1", text: { content: "Leon Blackstone runs the shop." } }),
      page({ _id: "p2", text: { content: "Leon Blackstone has a secret." } }),
    ],
  });
  const { results } = searchJournal([e], new Map(), { query: "Leon Blackstone" });
  assert.equal(results[0].pageHits.length, 2);
  assert.deepEqual(results[0].pageHits.map((h) => h.pageId), ["p1", "p2"]);
});

test("searchJournal returns a name-only match with an empty pageHits array, not an error", () => {
  const e = entry({ name: "Ravencroft", pages: [page({ text: { content: "Nothing relevant here." } })] });
  const { total, results } = searchJournal([e], new Map(), { query: "Ravencroft" });
  assert.equal(total, 1);
  assert.equal(results[0].nameMatched, true);
  assert.deepEqual(results[0].pageHits, []);
});

test("searchJournal excludes entries matching neither name nor any page", () => {
  const e = entry({ name: "Unrelated", pages: [page({ text: { content: "Nothing relevant." } })] });
  const { total, results } = searchJournal([e], new Map(), { query: "Ravencroft" });
  assert.equal(total, 0);
  assert.deepEqual(results, []);
});

test("searchJournal filters by type", () => {
  const location = entry({ _id: "e-loc", flags: { "foundry-mcp-bridge": { knowledge: { type: "location" } } } });
  const person = entry({ _id: "e-person", flags: { "foundry-mcp-bridge": { knowledge: { type: "person" } } } });
  const { results } = searchJournal([location, person], new Map(), { query: "Fixture", type: "location" });
  assert.deepEqual(results.map((r) => r.entryId), ["e-loc"]);
});

test("searchJournal filters by tag", () => {
  const tagged = entry({ _id: "e-tagged", flags: { "foundry-mcp-bridge": { knowledge: { type: "location", tags: ["coastal"] } } } });
  const untagged = entry({ _id: "e-untagged", flags: { "foundry-mcp-bridge": { knowledge: { type: "location", tags: [] } } } });
  const { results } = searchJournal([tagged, untagged], new Map(), { query: "Fixture", tag: "coastal" });
  assert.deepEqual(results.map((r) => r.entryId), ["e-tagged"]);
});

test("searchJournal filters by folder name or id", () => {
  const foldersById = new Map([["folder-1", { _id: "folder-1", name: "Locations" }]]);
  const inFolder = entry({ _id: "e-in", folder: "folder-1" });
  const outOfFolder = entry({ _id: "e-out" });
  const byId = searchJournal([inFolder, outOfFolder], foldersById, { query: "Fixture", folder: "folder-1" });
  assert.deepEqual(byId.results.map((r) => r.entryId), ["e-in"]);
  const byName = searchJournal([inFolder, outOfFolder], foldersById, { query: "Fixture", folder: "Locations" });
  assert.deepEqual(byName.results.map((r) => r.entryId), ["e-in"]);
});

test("searchJournal with no query returns all entries (subject to other filters) with no pageHits computed", () => {
  const e = entry();
  const { total, results } = searchJournal([e], new Map(), {});
  assert.equal(total, 1);
  assert.deepEqual(results[0].pageHits, []);
  assert.equal(results[0].nameMatched, false);
});

test("searchJournal clamps limit/offset via the shared pagination() helper", () => {
  const entries = Array.from({ length: 5 }, (_, i) => entry({ _id: `e-${i}`, name: `Fixture ${i}` }));
  const { total, returned, results } = searchJournal(entries, new Map(), { query: "Fixture", limit: 2, offset: 1 });
  assert.equal(total, 5);
  assert.equal(returned, 2);
  assert.deepEqual(results.map((r) => r.entryId), ["e-1", "e-2"]);
});

// ── entryDetail / journalFolderTree / contentHash ───────────────────────

test("entryDetail includes uuid, knowledge, and per-page contentHash", () => {
  const e = entry({ pages: [page({ text: { content: "Some content." } })] });
  const detail = entryDetail(e, new Map());
  assert.equal(detail.uuid, "JournalEntry.entry-1");
  assert.equal(detail.pages[0].uuid, "JournalEntry.entry-1.JournalEntryPage.page-1");
  assert.equal(detail.pages[0].contentHash, contentHash("Some content."));
});

test("entryDetail returns null for a missing entry rather than throwing", () => {
  assert.equal(entryDetail(undefined, new Map()), null);
});

test("journalFolderTree only includes JournalEntry-type folders", () => {
  const folders = [
    { _id: "f1", name: "Locations", type: "JournalEntry", folder: null },
    { _id: "f2", name: "Scenes Folder", type: "Scene", folder: null },
  ];
  const tree = journalFolderTree(folders);
  assert.deepEqual(tree.map((f) => f.id), ["f1"]);
});

test("buildFoldersById tolerates a missing or empty folders collection", () => {
  assert.equal(buildFoldersById(undefined).size, 0);
  assert.equal(buildFoldersById([]).size, 0);
});
