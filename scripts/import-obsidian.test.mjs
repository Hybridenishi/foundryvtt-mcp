import assert from "node:assert/strict";
import test from "node:test";
import {
  parseFrontmatter,
  splitSecretSection,
  DEFAULT_SECRET_MARKERS,
  convertMarkdownToHtml,
  buildLinkIndex,
  resolveWikilinksInHtml,
  noteHasWikilinks,
  resolveNoteVisibility,
  visibilityKeyOf,
  toApiVisibility,
  noteContentHash,
  planNoteAction,
  noteTitleAndBasename,
  matchesOnly,
  emptyManifest,
} from "./import-obsidian.mjs";

// ── parseFrontmatter ──────────────────────────────────────────────────────

test("parseFrontmatter extracts scalars, inline lists, and block lists", () => {
  const { frontmatter, body } = parseFrontmatter(`---
title: Leon Blackstone
type: npc
age: "229"
aliases: []
tags:
  - npc
  - noble
foundry-visibility: players
foundry-visibility-players: Alice, Bob
---
## Description
Hello.
`);
  assert.equal(frontmatter.title, "Leon Blackstone");
  assert.equal(frontmatter.type, "npc");
  assert.equal(frontmatter.age, "229");
  assert.deepEqual(frontmatter.aliases, []);
  assert.deepEqual(frontmatter.tags, ["npc", "noble"]);
  assert.equal(frontmatter["foundry-visibility"], "players");
  assert.equal(body.trim(), "## Description\nHello.");
});

test("parseFrontmatter tolerates a note with no frontmatter at all", () => {
  const { frontmatter, body } = parseFrontmatter("# Just a note\nNo frontmatter here.\n");
  assert.deepEqual(frontmatter, {});
  assert.equal(body, "# Just a note\nNo frontmatter here.\n");
});

test("parseFrontmatter parses an inline list with mixed spacing", () => {
  const { frontmatter } = parseFrontmatter("---\ntags: [a,  b , c]\n---\nbody\n");
  assert.deepEqual(frontmatter.tags, ["a", "b", "c"]);
});

// ── splitSecretSection ────────────────────────────────────────────────────

test("splitSecretSection extracts a marked callout, dropping the raw [!type]- syntax and keeping the title as a heading", () => {
  const { publicBody, secretBody, found } = splitSecretSection(
    "## Description\nPublic stuff.\n\n> [!warning]- DM Only\n> Secret one.\n> Secret two.\n\n## Related\n",
  );
  assert.equal(found, true);
  assert.equal(secretBody, "## DM Only\nSecret one.\nSecret two.");
  assert.doesNotMatch(publicBody, /Secret/);
  assert.doesNotMatch(publicBody, /\[!warning\]/);
  assert.match(publicBody, /## Related/);
});

test("splitSecretSection extracts a heading section literally titled to match a marker", () => {
  const { publicBody, secretBody, found } = splitSecretSection(
    "## Description\nPublic.\n\n## DM Notes\nSecret content.\nMore of it.\n\n## Related\nStill public.\n",
  );
  assert.equal(found, true);
  assert.equal(secretBody, "Secret content.\nMore of it.");
  assert.match(publicBody, /## Related/);
  assert.match(publicBody, /Still public/);
  assert.doesNotMatch(publicBody, /Secret content/);
});

test("splitSecretSection concatenates more than one marked section into a single secret body", () => {
  const { secretBody, found } = splitSecretSection(
    "> [!secret] First\n> one.\n\n## DM Notes\ntwo.\n",
  );
  assert.equal(found, true);
  assert.match(secretBody, /one\./);
  assert.match(secretBody, /two\./);
});

test("splitSecretSection reports nothing found and returns the body unchanged when no marker is present", () => {
  const { publicBody, secretBody, found } = splitSecretSection("## Description\nJust public text.\n");
  assert.equal(found, false);
  assert.equal(secretBody, null);
  assert.equal(publicBody, "## Description\nJust public text.\n");
});

test("splitSecretSection heading section respects heading level boundaries, not just the next heading", () => {
  const { publicBody, secretBody } = splitSecretSection(
    "## DM Notes\nsecret\n### Sub-point\nstill secret\n## Next Section\npublic again\n",
  );
  assert.match(secretBody, /still secret/);
  assert.match(publicBody, /public again/);
  assert.doesNotMatch(publicBody, /still secret/);
});

test("splitSecretSection accepts a custom marker set", () => {
  const { secretBody, found } = splitSecretSection("## Spoilers\ncontent\n", [/spoilers/i]);
  assert.equal(found, true);
  assert.match(secretBody, /content/);
});

test("DEFAULT_SECRET_MARKERS matches the confirmed real-world callout title", () => {
  assert.ok(DEFAULT_SECRET_MARKERS.some((re) => re.test("DM Only")));
});

// ── convertMarkdownToHtml ─────────────────────────────────────────────────

test("convertMarkdownToHtml renders headings, paragraphs, and inline bold/italic/code", () => {
  const html = convertMarkdownToHtml("## Title\n\nSome **bold**, *italic*, and `code` text.\n");
  assert.match(html, /<h2>Title<\/h2>/);
  assert.match(html, /<strong>bold<\/strong>/);
  assert.match(html, /<em>italic<\/em>/);
  assert.match(html, /<code>code<\/code>/);
});

test("convertMarkdownToHtml renders unordered and ordered lists", () => {
  assert.match(convertMarkdownToHtml("- one\n- two\n"), /<ul><li>one<\/li><li>two<\/li><\/ul>/);
  assert.match(convertMarkdownToHtml("1. first\n2. second\n"), /<ol><li>first<\/li><li>second<\/li><\/ol>/);
});

test("convertMarkdownToHtml renders a GFM pipe table", () => {
  const html = convertMarkdownToHtml("| A | B |\n|---|---|\n| 1 | 2 |\n");
  assert.match(html, /<table>/);
  assert.match(html, /<th>A<\/th><th>B<\/th>/);
  assert.match(html, /<td>1<\/td><td>2<\/td>/);
});

test("convertMarkdownToHtml renders a non-secret callout as a titled blockquote", () => {
  const html = convertMarkdownToHtml("> [!note] Heads up\n> Something to know.\n");
  assert.match(html, /<blockquote><strong>Heads up<\/strong>/);
  assert.match(html, /Something to know/);
});

test("convertMarkdownToHtml renders a plain blockquote without a callout marker", () => {
  const html = convertMarkdownToHtml("> Just a quote.\n");
  assert.match(html, /<blockquote><p>Just a quote\.<\/p><\/blockquote>/);
});

test("convertMarkdownToHtml renders a horizontal rule", () => {
  assert.match(convertMarkdownToHtml("Text above\n\n---\n\nText below\n"), /<hr>/);
});

test("convertMarkdownToHtml replaces a Dataview code fence with a placeholder and reports it", () => {
  const report = [];
  const html = convertMarkdownToHtml("```dataview\nTABLE foo\n```\n", report);
  assert.match(html, /Dynamic Dataview query omitted/);
  assert.doesNotMatch(html, /TABLE foo/);
  assert.deepEqual(report, [{ type: "dataview-omitted" }]);
});

test("convertMarkdownToHtml preserves a non-Dataview code fence, escaped, not dropped", () => {
  const html = convertMarkdownToHtml("```js\nconst x = 1 < 2;\n```\n");
  assert.match(html, /<pre><code>/);
  assert.match(html, /const x = 1 &lt; 2;/);
});

test("convertMarkdownToHtml leaves wikilinks as literal text — pass 2's job, not this function's", () => {
  const html = convertMarkdownToHtml("See [[Some Note]] for more.\n");
  assert.match(html, /\[\[Some Note\]\]/);
});

test("convertMarkdownToHtml escapes stray HTML-significant characters rather than interpreting them", () => {
  const html = convertMarkdownToHtml("1 < 2 and 3 > 2\n");
  assert.match(html, /1 &lt; 2 and 3 &gt; 2/);
});

// ── Wikilinks ─────────────────────────────────────────────────────────────

function note(overrides = {}) {
  return { vaultPath: "note.md", title: "Note", basename: "Note", aliases: [], ...overrides };
}

test("buildLinkIndex resolves by title, basename, and alias", () => {
  const index = buildLinkIndex([note({ vaultPath: "a.md", title: "Arcane Vanguard", basename: "Arcane Vanguard", aliases: ["The Vanguard"] })]);
  assert.equal(index.get("arcane vanguard").vaultPath, "a.md");
  assert.equal(index.get("the vanguard").vaultPath, "a.md");
});

test("buildLinkIndex marks a name claimed by two different notes as ambiguous", () => {
  const index = buildLinkIndex([
    note({ vaultPath: "a.md", title: "Alice", basename: "Alice" }),
    note({ vaultPath: "b.md", title: "Someone Else", basename: "Someone Else", aliases: ["Alice"] }),
  ]);
  assert.equal(index.get("alice"), "ambiguous");
});

test("resolveWikilinksInHtml replaces a resolved link with an @UUID enricher, preserving a custom label", () => {
  const index = buildLinkIndex([note({ vaultPath: "a.md", title: "Foo" })]);
  const manifestByPath = new Map([["a.md", { entryId: "e1" }]]);
  const report = [];
  const html = resolveWikilinksInHtml("<p>[[Foo|bar]]</p>", index, manifestByPath, report);
  assert.equal(html, "<p>@UUID[JournalEntry.e1]{bar}</p>");
  assert.deepEqual(report, []);
});

test("resolveWikilinksInHtml leaves an unresolved link literal and reports it, never guessing", () => {
  const report = [];
  const html = resolveWikilinksInHtml("<p>[[Nowhere]]</p>", new Map(), new Map(), report);
  assert.equal(html, "<p>[[Nowhere]]</p>");
  assert.deepEqual(report, [{ type: "unresolved-link", target: "Nowhere" }]);
});

test("resolveWikilinksInHtml leaves an ambiguous link literal and reports it", () => {
  const index = buildLinkIndex([
    note({ vaultPath: "a.md", title: "X" }),
    note({ vaultPath: "b.md", title: "Y", aliases: ["X"] }),
  ]);
  const report = [];
  const html = resolveWikilinksInHtml("[[X]]", index, new Map(), report);
  assert.equal(html, "[[X]]");
  assert.equal(report[0].type, "ambiguous-link");
});

test("resolveWikilinksInHtml reports a resolved-but-not-yet-imported target as unresolved rather than guessing an id", () => {
  const index = buildLinkIndex([note({ vaultPath: "a.md", title: "Foo" })]);
  const report = [];
  const html = resolveWikilinksInHtml("[[Foo]]", index, new Map(), report); // empty manifestByPath
  assert.equal(html, "[[Foo]]");
  assert.equal(report[0].type, "unresolved-link");
  assert.match(report[0].reason, /not yet imported/);
});

test("noteHasWikilinks detects presence without needing the full resolution machinery", () => {
  assert.equal(noteHasWikilinks("<p>[[Foo]]</p>"), true);
  assert.equal(noteHasWikilinks("<p>no links here</p>"), false);
});

// ── resolveNoteVisibility ─────────────────────────────────────────────────

test("resolveNoteVisibility defaults to gm when foundry-visibility is absent", () => {
  const v = resolveNoteVisibility({}, new Set());
  assert.equal(v.profile, "gm");
  assert.equal(v.downgraded, false);
});

test("resolveNoteVisibility downgrades an unrecognized value to gm, reporting why", () => {
  const v = resolveNoteVisibility({ "foundry-visibility": "full" }, new Set(["party", "players"]));
  assert.equal(v.profile, "gm");
  assert.equal(v.downgraded, true);
  assert.match(v.reason, /unrecognized/);
});

test("resolveNoteVisibility downgrades a recognized profile not passed to --allow-visibility", () => {
  const v = resolveNoteVisibility({ "foundry-visibility": "party" }, new Set());
  assert.equal(v.profile, "gm");
  assert.equal(v.downgraded, true);
  assert.match(v.reason, /not passed to --allow-visibility/);
});

test("resolveNoteVisibility accepts party when allowed", () => {
  const v = resolveNoteVisibility({ "foundry-visibility": "party" }, new Set(["party"]));
  assert.equal(v.profile, "party");
  assert.equal(v.downgraded, false);
});

test("resolveNoteVisibility resolves players from a comma-separated string or an array", () => {
  const a = resolveNoteVisibility({ "foundry-visibility": "players", "foundry-visibility-players": "Alice, Bob" }, new Set(["players"]));
  assert.deepEqual(a.players, ["Alice", "Bob"]);
  const b = resolveNoteVisibility({ "foundry-visibility": "players", "foundry-visibility-players": ["Alice", "Bob"] }, new Set(["players"]));
  assert.deepEqual(b.players, ["Alice", "Bob"]);
});

test("resolveNoteVisibility downgrades 'players' with no names given, never guessing who", () => {
  const v = resolveNoteVisibility({ "foundry-visibility": "players" }, new Set(["players"]));
  assert.equal(v.profile, "gm");
  assert.equal(v.downgraded, true);
  assert.match(v.reason, /requires foundry-visibility-players/);
});

test("visibilityKeyOf is stable regardless of player order and case", () => {
  const a = visibilityKeyOf({ profile: "players", players: ["Alice", "bob"] });
  const b = visibilityKeyOf({ profile: "players", players: ["Bob", "alice"] });
  assert.equal(a, b);
  assert.equal(visibilityKeyOf({ profile: "gm" }), "gm");
});

test("toApiVisibility carries the players array only for the 'players' profile", () => {
  assert.deepEqual(toApiVisibility({ profile: "gm" }), { profile: "gm" });
  assert.deepEqual(toApiVisibility({ profile: "players", players: ["Alice"] }), { profile: "players", players: ["Alice"] });
});

// ── noteContentHash / planNoteAction ──────────────────────────────────────

test("noteContentHash changes when either the public or secret body changes", () => {
  const a = noteContentHash("public", "secret");
  const b = noteContentHash("public changed", "secret");
  const c = noteContentHash("public", "secret changed");
  assert.notEqual(a, b);
  assert.notEqual(a, c);
  assert.equal(noteContentHash("public", "secret"), a);
});

test("planNoteAction: no manifest entry means create", () => {
  assert.equal(planNoteAction(undefined, "hash1", "gm", false), "create");
});

test("planNoteAction: same hash and visibility means unchanged", () => {
  assert.equal(planNoteAction({ contentHash: "hash1", visibilityKey: "gm" }, "hash1", "gm", false), "unchanged");
});

test("planNoteAction: changed content, same visibility means update", () => {
  assert.equal(planNoteAction({ contentHash: "hash1", visibilityKey: "gm" }, "hash2", "gm", false), "update");
});

test("planNoteAction: changed visibility is refused unless explicitly allowed", () => {
  assert.equal(planNoteAction({ contentHash: "hash1", visibilityKey: "gm" }, "hash1", "party", false), "visibility-change-refused");
  assert.equal(planNoteAction({ contentHash: "hash1", visibilityKey: "gm" }, "hash1", "party", true), "visibility-change");
});

// ── Misc helpers ──────────────────────────────────────────────────────────

test("noteTitleAndBasename derives from the filename without extension", () => {
  const { title, basename } = noteTitleAndBasename("/vault/People/Leon-Blackstone.md");
  assert.equal(title, "Leon-Blackstone");
  assert.equal(basename, "Leon-Blackstone");
});

test("matchesOnly with no pattern matches everything", () => {
  assert.equal(matchesOnly("People/Leon.md", null), true);
});

test("matchesOnly supports a simple glob-lite pattern", () => {
  assert.equal(matchesOnly("People/Leon.md", "People/*"), true);
  assert.equal(matchesOnly("Places/Ravencroft.md", "People/*"), false);
});

test("emptyManifest starts at version 1 with no notes", () => {
  assert.deepEqual(emptyManifest(), { version: 1, notes: {} });
});
