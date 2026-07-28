// Reproduces Foundry's own document-ownership resolution for JournalEntry
// and JournalEntryPage — nothing else. No tags, no invented "party" storage,
// no role shortcuts beyond the GM bypass Foundry itself has. See
// docs/ROADMAP.md Phase 5/6 for why permission is evaluated here in the
// sidecar rather than delegated to Foundry through the GM bridge: the
// bridge only exists while a GM browser tab is open, which would make every
// player question wait on that tab (or fail without it). This module is a
// deliberate cache of Foundry's ownership model, meant to be proven equal to
// it by a conformance audit added in a later stage.
//
// Deny by default is structural: every unrecognized shape returns null (or,
// for a boolean check, false), and every numeric comparison treats a null
// level as -Infinity. There is no code path where "I don't understand this
// document" produces a readable result.
const { collectionValues } = require("./actor-utils");

const OWNERSHIP = Object.freeze({ INHERIT: -1, NONE: 0, LIMITED: 1, OBSERVER: 2, OWNER: 3 });
// Matches sidecar/index.js's own GM_ROLE constant — Foundry's role
// hierarchy (NONE/PLAYER/TRUSTED/ASSISTANT/GAMEMASTER) is a stable platform
// constant, not deployment config, so this is duplicated rather than shared
// across two otherwise-independent modules. Keep both in sync if it changes.
const GM_ROLE = 4;
// LIMITED is deliberately not readable or listable here: returning even a
// name for a LIMITED entry is itself the existence leak this module exists
// to prevent.
const READABLE = OWNERSHIP.OBSERVER;

function isGm(user) {
  return Boolean(user) && Number.isFinite(Number(user.role)) && Number(user.role) >= GM_ROLE;
}

// Reads one ownership map for one user: an explicit per-user integer level,
// else the map's integer `default`, else null (deny). Never throws on a
// malformed map.
function rawLevel(ownership, userId) {
  if (!ownership || typeof ownership !== "object") return null;
  const explicit = ownership[userId];
  if (Number.isInteger(explicit)) return explicit;
  const fallback = ownership.default;
  return Number.isInteger(fallback) ? fallback : null;
}

// A JournalEntry has no parent to inherit from, so an explicit INHERIT
// level on an entry is treated the same as no level at all: deny.
function entryLevel(entry, user) {
  if (!user || typeof user._id !== "string") return null;
  if (isGm(user)) return OWNERSHIP.OWNER;
  const level = rawLevel(entry?.ownership, user._id);
  return level === OWNERSHIP.INHERIT ? null : level;
}

// A page with no ownership, or an explicit INHERIT, asks the entry — it
// never falls through to "no ownership means visible". A page with any
// other explicit level (including 0) uses that level outright, and never
// falls back to the entry, which is what lets a GM page under an otherwise
// visible entry stay hidden.
function pageLevel(entry, page, user) {
  if (!user || typeof user._id !== "string") return null;
  if (isGm(user)) return OWNERSHIP.OWNER;
  const own = rawLevel(page?.ownership, user._id);
  if (own === null || own === OWNERSHIP.INHERIT) return entryLevel(entry, user);
  return own;
}

function canReadEntry(entry, user) {
  return (entryLevel(entry, user) ?? -Infinity) >= READABLE;
}

function canReadPage(entry, page, user) {
  return canReadEntry(entry, user) && (pageLevel(entry, page, user) ?? -Infinity) >= READABLE;
}

// Resolves any Foundry document's ownership map to the user ids explicitly
// granted Owner — used for "which non-GM user owns this character Actor",
// the same OWNERSHIP levels apply to every Foundry document type, not just
// journals, so this one helper is intentionally not journal-specific
// despite living in this file. Only explicit per-user Owner grants count;
// a permissive `default: 3` (unusual, and not how player-character
// ownership is normally configured) is deliberately not treated as
// "everyone owns this".
function ownerUserIds(doc) {
  const ownership = doc?.ownership;
  if (!ownership || typeof ownership !== "object") return [];
  return Object.entries(ownership)
    .filter(([key, level]) => key !== "default" && level === OWNERSHIP.OWNER)
    .map(([userId]) => userId);
}

// Resolves a player reference — a Foundry user id, a user name, or the name
// of a character Actor that user owns — to exactly one non-GM user. Fails
// loud: an unmatched or ambiguous reference returns a null user and a
// reason, rather than guessing, matching the write path's name-resolution
// discipline (docs/ROADMAP.md Phase 5).
function resolvePlayer(users, actors, ref) {
  const nonGm = collectionValues(users).filter((u) => !isGm(u));
  if (typeof ref !== "string" || ref.length === 0) return { user: null, reason: "empty reference" };

  const byId = nonGm.find((u) => u._id === ref);
  if (byId) return { user: byId, reason: null };

  const refLower = ref.toLowerCase();
  const matchedIds = new Set();
  for (const u of nonGm) {
    if ((u.name || "").toLowerCase() === refLower) matchedIds.add(u._id);
  }
  for (const actor of collectionValues(actors)) {
    if (actor?.type !== "character" || (actor.name || "").toLowerCase() !== refLower) continue;
    for (const userId of ownerUserIds(actor)) {
      if (nonGm.some((u) => u._id === userId)) matchedIds.add(userId);
    }
  }

  if (matchedIds.size === 0) return { user: null, reason: "no matching player" };
  if (matchedIds.size > 1) {
    const names = [...matchedIds].map((id) => nonGm.find((u) => u._id === id)?.name).filter(Boolean);
    return { user: null, reason: `ambiguous — matches ${names.join(", ")}` };
  }
  const [matchedId] = matchedIds;
  return { user: nonGm.find((u) => u._id === matchedId), reason: null };
}

// The player-facing view of the whole journal collection: entries the user
// cannot read are dropped entirely, and each surviving entry's pages are
// replaced with only the readable ones. An entry with pages the user cannot
// read at all is dropped too — but an entry with *no pages at all* (real
// shape: Campaign Codex stores its content in a flag, not in pages) is kept,
// since there is nothing being hidden from it. This is the one rule that
// keeps "an entry that exists but has nothing to show" distinct from "an
// entry whose content was deliberately hidden from this user" without
// leaking which case applies — the latter is excluded outright, the former
// is shown with an empty pages array, exactly as the GM view already allows
// for a name-only match.
function visibleJournalFor(entries, user) {
  const result = [];
  for (const entry of collectionValues(entries)) {
    if (!canReadEntry(entry, user)) continue;
    const allPages = collectionValues(entry.pages);
    const pages = allPages.filter((page) => canReadPage(entry, page, user));
    if (allPages.length > 0 && pages.length === 0) continue;
    result.push({ ...entry, pages });
  }
  return result;
}

function nameOf(user) {
  return { userId: user._id, name: user.name };
}

// Resolves an ownership map to the GM-facing "who besides me can see this"
// block: the non-GM users who can read it, by name. GM users are excluded
// since every GM can already see everything — the useful question is who
// else can.
function entryVisibility(entry, users) {
  const visibleTo = collectionValues(users).filter((u) => !isGm(u) && canReadEntry(entry, u)).map(nameOf);
  return { gmOnly: visibleTo.length === 0, visibleTo };
}

function pageVisibility(entry, page, users) {
  const visibleTo = collectionValues(users).filter((u) => !isGm(u) && canReadPage(entry, page, u)).map(nameOf);
  return { gmOnly: visibleTo.length === 0, visibleTo };
}

// Attaches a `visibility` block to a journal-search.js search result and to
// each of its pageHits, by matching back to the raw entry/page objects.
// journal-search.js stays ownership-agnostic; this is the one seam where
// search results and ownership are combined, and it is used only for the
// GM-facing routes.
function describeSearchResult(rawEntry, result, users) {
  const rawPagesById = new Map(collectionValues(rawEntry?.pages).map((p) => [p._id, p]));
  return {
    ...result,
    visibility: entryVisibility(rawEntry, users),
    pageHits: result.pageHits.map((hit) => ({
      ...hit,
      visibility: pageVisibility(rawEntry, rawPagesById.get(hit.pageId), users),
    })),
  };
}

function describeEntryDetail(rawEntry, detail, users) {
  if (!detail) return detail;
  const rawPagesById = new Map(collectionValues(rawEntry?.pages).map((p) => [p._id, p]));
  return {
    ...detail,
    visibility: entryVisibility(rawEntry, users),
    pages: detail.pages.map((page) => ({
      ...page,
      visibility: pageVisibility(rawEntry, rawPagesById.get(page._id), users),
    })),
  };
}

// "party" is derived, never stored: every non-GM user who owns at least one
// character Actor, restricted to non-GM ids even if a character's
// ownership map somehow names one (ownerUserIds itself does not know about
// roles). Because it is derived, a receipt naming the resolved set is not
// optional — the DM has no other way to know who "party" actually meant at
// the moment of writing.
function resolvePartyUserIds(actors, users) {
  const nonGmIds = new Set(collectionValues(users).filter((u) => !isGm(u)).map((u) => u._id));
  const ids = new Set();
  for (const actor of collectionValues(actors)) {
    if (actor?.type !== "character") continue;
    for (const id of ownerUserIds(actor)) {
      if (nonGmIds.has(id)) ids.add(id);
    }
  }
  return [...ids];
}

// Resolves a visibility profile (docs/ROADMAP.md Phase 5) to a Foundry
// ownership map. `default` is never anything but NONE — not even for
// `party` — because a permissive default would silently grant access to
// any user created later (a new player, a re-imported account); every
// member is enumerated explicitly instead, which costs nothing and closes
// that. Throws on an unresolvable `players` reference rather than guessing
// — the same fail-loud discipline as resolvePlayer, which this delegates
// to for each name.
function resolveVisibilityOwnership(visibility, users, actors) {
  if (visibility.profile === "gm") {
    return { ownership: { default: OWNERSHIP.NONE }, resolvedUserIds: [] };
  }

  let resolvedUserIds;
  if (visibility.profile === "party") {
    resolvedUserIds = resolvePartyUserIds(actors, users);
  } else if (visibility.profile === "players") {
    const ids = new Set();
    for (const ref of visibility.players ?? []) {
      const { user, reason } = resolvePlayer(users, actors, ref);
      if (!user) throw new Error(`Cannot resolve player '${ref}': ${reason}.`);
      ids.add(user._id);
    }
    resolvedUserIds = [...ids];
  } else {
    throw new Error(`Unknown visibility profile '${visibility.profile}'.`);
  }

  const ownership = { default: OWNERSHIP.NONE };
  for (const id of resolvedUserIds) ownership[id] = OWNERSHIP.OBSERVER;
  return { ownership, resolvedUserIds };
}

module.exports = {
  OWNERSHIP,
  GM_ROLE,
  isGm,
  entryLevel,
  pageLevel,
  canReadEntry,
  canReadPage,
  ownerUserIds,
  resolvePlayer,
  resolvePartyUserIds,
  resolveVisibilityOwnership,
  visibleJournalFor,
  entryVisibility,
  pageVisibility,
  describeSearchResult,
  describeEntryDetail,
};
