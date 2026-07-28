// Journal search and classification — pure functions over the world payload's
// `journal` array, no Express, no Socket.IO, so this is unit-testable
// directly (see journal-search.test.js). Everything here is read-only; the
// permission model (who may see what) is a separate concern, added in a
// later stage as journal-visibility.js. This module does not know about
// ownership at all.
const { createHash } = require("node:crypto");
const { collectionValues, pagination } = require("./actor-utils");

const KNOWLEDGE_TYPES = new Set([
  "location",
  "person",
  "faction",
  "history",
  "item",
  "session",
  "other",
]);

// Our own flag namespace. Written by the write path (a later stage) and
// read here; absent on journal content that predates this feature.
const FLAG_SCOPE = "foundry-mcp-bridge";
// Campaign Codex's flag namespace. Read-only, absence-tolerant fallback so
// pre-existing Campaign Codex content classifies as something other than
// "other" — never written, never depended on beyond this one field.
const CAMPAIGN_CODEX_SCOPE = "campaign-codex";

function contentHash(content) {
  return createHash("sha256").update(stringValue(content)).digest("hex");
}

function stringValue(value) {
  return typeof value === "string" ? value : "";
}

function pageContent(page) {
  return stringValue(page?.text?.content);
}

function folderOf(entry, foldersById) {
  const raw = entry?.folder;
  const folderId = typeof raw === "string" ? raw : raw?._id;
  if (!folderId) return null;
  const folder = foldersById?.get(folderId);
  return { id: folderId, name: folder?.name ?? null };
}

// Resolution order: our own flag, then Campaign Codex's `type` flag (a
// different vocabulary — mapped best-effort, unrecognized values pass
// through and fall to "other" below), then the entry's folder name, then
// "other". Every step is absence-tolerant; nothing here throws on a
// document that doesn't carry the flag.
function knowledgeOf(entry, foldersById) {
  const own = entry?.flags?.[FLAG_SCOPE]?.knowledge;
  if (own && typeof own === "object") {
    const type = KNOWLEDGE_TYPES.has(own.type) ? own.type : "other";
    const tags = Array.isArray(own.tags) ? own.tags.filter((t) => typeof t === "string") : [];
    return { type, tags, source: "flag" };
  }

  const ccType = entry?.flags?.[CAMPAIGN_CODEX_SCOPE]?.type;
  if (typeof ccType === "string") {
    const mapped = mapCampaignCodexType(ccType);
    if (mapped) return { type: mapped, tags: [], source: "campaign-codex-flag" };
  }

  const folder = folderOf(entry, foldersById);
  if (folder?.name) {
    const mapped = mapFolderName(folder.name);
    if (mapped) return { type: mapped, tags: [], source: "folder" };
  }

  return { type: "other", tags: [], source: "default" };
}

function mapCampaignCodexType(ccType) {
  switch (ccType) {
    case "npc": return "person";
    case "location": return "location";
    case "region": return "location";
    case "shop": return "location";
    case "quest": return "history";
    default: return null; // "group", "tag", and anything unrecognized: no confident mapping
  }
}

function mapFolderName(name) {
  const lower = name.toLowerCase();
  if (KNOWLEDGE_TYPES.has(lower)) return lower;
  if (/location|place|region|city|town/.test(lower)) return "location";
  if (/npc|people|person|character/.test(lower)) return "person";
  if (/faction|guild|order|house/.test(lower)) return "faction";
  if (/history|lore|timeline/.test(lower)) return "history";
  if (/session|recap/.test(lower)) return "session";
  return null;
}

// Windows a snippet around the first match in `content`, marking the
// matched term. Falls back to a leading excerpt if the match position
// can't be found cleanly (shouldn't happen given the caller already found
// an index, but keeps this function safe to call standalone).
const SNIPPET_RADIUS = 60;

function snippetAround(content, query, matchIndex) {
  if (matchIndex < 0) return content.slice(0, SNIPPET_RADIUS * 2).trim();
  const start = Math.max(0, matchIndex - SNIPPET_RADIUS);
  const end = Math.min(content.length, matchIndex + query.length + SNIPPET_RADIUS);
  const prefix = start > 0 ? "…" : "";
  const suffix = end < content.length ? "…" : "";
  const before = content.slice(start, matchIndex);
  const match = content.slice(matchIndex, matchIndex + query.length);
  const after = content.slice(matchIndex + query.length, end);
  return `${prefix}${before}**${match}**${after}${suffix}`;
}

function countOccurrences(haystackLower, needleLower) {
  if (!needleLower) return 0;
  let count = 0;
  let index = haystackLower.indexOf(needleLower);
  while (index !== -1) {
    count += 1;
    index = haystackLower.indexOf(needleLower, index + needleLower.length);
  }
  return count;
}

// Searches one entry's pages against `query`. Returns [] when nothing in
// the pages matches — a name-only match (entry name matches but no page
// does) is a valid, common result and is represented by an empty array,
// not an error.
function searchPages(entry, query) {
  const queryLower = query.toLowerCase();
  const hits = [];
  for (const page of collectionValues(entry?.pages)) {
    const content = pageContent(page);
    const contentLower = content.toLowerCase();
    const matchCount = countOccurrences(contentLower, queryLower);
    if (matchCount === 0) continue;
    const matchIndex = contentLower.indexOf(queryLower);
    hits.push({
      pageId: page._id,
      pageName: page.name ?? null,
      type: page.type ?? null,
      matchCount,
      snippet: snippetAround(content, query, matchIndex),
      contentHash: contentHash(content),
    });
  }
  return hits;
}

// Top-level journal search: filters by type/tag/folder first (cheap,
// structural), then matches `query` against entry name and page content,
// then paginates. Returns { total, returned, results } where `total` is the
// count of matching entries before pagination and `results` carries
// pageHits per entry.
function searchJournal(entries, foldersById, options = {}) {
  const query = stringValue(options.query);
  const queryLower = query.toLowerCase();
  const typeFilter = stringValue(options.type) || null;
  const tagFilter = stringValue(options.tag) || null;
  const folderFilter = stringValue(options.folder) || null;
  const { limit, offset } = pagination(options);

  const matched = [];
  for (const entry of entries) {
    const knowledge = knowledgeOf(entry, foldersById);
    if (typeFilter && knowledge.type !== typeFilter) continue;
    if (tagFilter && !knowledge.tags.includes(tagFilter)) continue;

    const folder = folderOf(entry, foldersById);
    if (folderFilter) {
      const matchesFolder = folder?.id === folderFilter || folder?.name === folderFilter;
      if (!matchesFolder) continue;
    }

    const nameLower = stringValue(entry.name).toLowerCase();
    const nameMatched = queryLower.length > 0 && nameLower.includes(queryLower);
    const pageHits = queryLower.length > 0 ? searchPages(entry, query) : [];

    if (queryLower.length > 0 && !nameMatched && pageHits.length === 0) continue;

    matched.push({
      entryId: entry._id,
      entryName: entry.name,
      uuid: `JournalEntry.${entry._id}`,
      folder,
      knowledge: { type: knowledge.type, tags: knowledge.tags },
      nameMatched,
      pageHits,
    });
  }

  const total = matched.length;
  const results = matched.slice(offset, offset + limit);
  return { total, returned: results.length, results };
}

function buildFoldersById(folders) {
  const map = new Map();
  for (const folder of collectionValues(folders)) {
    if (folder?._id) map.set(folder._id, folder);
  }
  return map;
}

// Full detail for one entry, including per-page content, uuid, and
// contentHash — the hash is what lets a future indexer (e.g. the Iris
// knowledge service, see docs/ROADMAP.md) do incremental reindexing instead
// of re-embedding on every sweep.
function entryDetail(entry, foldersById) {
  if (!entry) return null;
  const knowledge = knowledgeOf(entry, foldersById);
  const folder = folderOf(entry, foldersById);
  return {
    _id: entry._id,
    name: entry.name,
    uuid: `JournalEntry.${entry._id}`,
    folder,
    knowledge: { type: knowledge.type, tags: knowledge.tags },
    pages: collectionValues(entry.pages).map((page) => ({
      _id: page._id,
      uuid: `JournalEntry.${entry._id}.JournalEntryPage.${page._id}`,
      name: page.name,
      type: page.type,
      content: pageContent(page),
      contentHash: contentHash(pageContent(page)),
    })),
  };
}

// Folder tree scoped to JournalEntry folders. Foundry folders carry a
// `type` field distinguishing what kind of document they hold; only
// journal folders are relevant here.
function journalFolderTree(folders) {
  const journalFolders = collectionValues(folders).filter((f) => f?.type === "JournalEntry");
  return journalFolders.map((f) => ({
    id: f._id,
    name: f.name,
    parentId: typeof f.folder === "string" ? f.folder : f.folder?._id ?? null,
  }));
}

module.exports = {
  KNOWLEDGE_TYPES,
  knowledgeOf,
  searchJournal,
  buildFoldersById,
  entryDetail,
  journalFolderTree,
  contentHash,
};
