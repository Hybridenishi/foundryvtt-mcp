#!/usr/bin/env node
// Obsidian -> Foundry journal importer. Drives the SAME gated
// POST /api/mcp/journal/write/preview -> /write routes as the MCP tools —
// no second write mechanism, so every Stage 4 guarantee (required
// visibility, confirmation binding, receipts naming the resolved audience)
// still applies here. See docs/ROADMAP.md and the campaign-knowledge-journal
// plan for the full design; this file is deliberately self-contained (no
// new runtime dependencies) since the project keeps that list short.
//
// Everything below the CLI/`main()` section is pure and exported for
// scripts/import-obsidian.test.mjs. Nothing above the "CLI" marker touches
// the filesystem or network.
import { createHash } from "node:crypto";
import { readFile, readdir, writeFile, stat } from "node:fs/promises";
import { dirname, join, relative, extname, basename } from "node:path";
import readline from "node:readline";

// ── Frontmatter ──────────────────────────────────────────────────────────

// A small, deliberately narrow YAML-subset parser — Obsidian frontmatter in
// this vault is flat scalars, inline lists (`[a, b]`), and block lists
// (`key:\n  - a\n  - b`). Not a general YAML parser; anything it can't make
// sense of is left as a raw string rather than thrown away.
export function parseFrontmatter(raw) {
  const match = raw.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?/);
  if (!match) return { frontmatter: {}, body: raw };
  const body = raw.slice(match[0].length);
  const lines = match[1].split(/\r?\n/);
  const frontmatter = {};
  let i = 0;
  while (i < lines.length) {
    const kv = lines[i].match(/^([A-Za-z0-9_-]+):\s*(.*)$/);
    if (!kv) { i++; continue; }
    const [, key, rest] = kv;
    if (rest.trim() === "") {
      const items = [];
      let j = i + 1;
      while (j < lines.length && /^\s*-\s*(.*)$/.test(lines[j])) {
        items.push(lines[j].replace(/^\s*-\s*/, "").trim().replace(/^["']|["']$/g, ""));
        j++;
      }
      frontmatter[key] = items.length > 0 ? items : "";
      i = items.length > 0 ? j : i + 1;
      continue;
    }
    const trimmed = rest.trim();
    if (trimmed.startsWith("[") && trimmed.endsWith("]")) {
      const inner = trimmed.slice(1, -1).trim();
      frontmatter[key] = inner.length === 0 ? [] : inner.split(",").map((s) => s.trim().replace(/^["']|["']$/g, ""));
    } else {
      frontmatter[key] = trimmed.replace(/^["']|["']$/g, "");
    }
    i++;
  }
  return { frontmatter, body };
}

// ── Secret-section splitting ─────────────────────────────────────────────

// Default markers recognized in a callout type/title or a heading title.
// Configurable via --secret-marker since other vaults may use different
// callout conventions than the one confirmed in this vault
// (`> [!warning]- DM Only`).
export const DEFAULT_SECRET_MARKERS = [/dm[\s-]*only/i, /gm[\s-]*only/i, /\bsecret\b/i, /\bdm notes\b/i];

// Every GM-only section found (there may be more than one) is concatenated
// into a single secret body — they all become one GM-only page, per
// ROADMAP:115's "explicit page ownership" discipline: one page, one
// ownership map, not a page per section.
export function splitSecretSection(body, secretMarkers = DEFAULT_SECRET_MARKERS) {
  const lines = body.split(/\r?\n/);
  const isMarked = (text) => Boolean(text) && secretMarkers.some((re) => re.test(text));
  const secretChunks = [];
  const publicLines = [];
  let i = 0;
  while (i < lines.length) {
    const calloutMatch = lines[i].match(/^>\s*\[!([\w-]+)\]([-+]?)\s*(.*)$/);
    if (calloutMatch && (isMarked(calloutMatch[1]) || isMarked(calloutMatch[3]))) {
      let end = i + 1;
      while (end < lines.length && /^>/.test(lines[end])) end++;
      // The callout's own `[!type]-` marker syntax is consumed as the split
      // trigger, not printed into the page — only its title (if any) and
      // the quoted body content become the secret page, with the title
      // rendered as an ordinary heading.
      const title = calloutMatch[3]?.trim();
      const rest = lines.slice(i + 1, end).map((l) => l.replace(/^>\s?/, "")).join("\n").trim();
      secretChunks.push([title ? `## ${title}` : null, rest].filter(Boolean).join("\n").trim());
      i = end;
      continue;
    }
    const headingMatch = lines[i].match(/^(#{1,6})\s+(.*)$/);
    if (headingMatch && isMarked(headingMatch[2])) {
      const level = headingMatch[1].length;
      let end = i + 1;
      while (end < lines.length) {
        const next = lines[end].match(/^(#{1,6})\s+/);
        if (next && next[1].length <= level) break;
        end++;
      }
      secretChunks.push(lines.slice(i + 1, end).join("\n").trim());
      i = end;
      continue;
    }
    publicLines.push(lines[i]);
    i++;
  }
  return {
    publicBody: publicLines.join("\n"),
    secretBody: secretChunks.length > 0 ? secretChunks.join("\n\n---\n\n") : null,
    found: secretChunks.length > 0,
  };
}

// ── Markdown -> HTML ──────────────────────────────────────────────────────
// Hand-rolled for the subset confirmed to appear in real notes: headings,
// bold/italic/code, lists, blockquotes (including non-secret callouts,
// rendered as a titled blockquote — secret ones never reach here, already
// split out above), tables, horizontal rules, paragraphs, and Dataview code
// fences (replaced with a placeholder — they have no static content, being
// rendered live by Obsidian from other notes). Wikilinks are deliberately
// left as literal `[[...]]` text here; resolveWikilinksInHtml does that
// replacement in pass 2, once every note has an id to link to. Unknown
// constructs are escaped, not dropped.

function escapeHtml(text) {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function inlineMarkdown(text) {
  let out = escapeHtml(text);
  out = out.replace(/`([^`]+)`/g, "<code>$1</code>");
  out = out.replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>");
  out = out.replace(/__([^_]+)__/g, "<strong>$1</strong>");
  out = out.replace(/(?<![*\w])\*([^*]+)\*(?!\*)/g, "<em>$1</em>");
  out = out.replace(/(?<!\w)_([^_]+)_(?!\w)/g, "<em>$1</em>");
  out = out.replace(/\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g, '<a href="$2">$1</a>');
  return out;
}

function isTableSeparator(line) {
  return /^\s*\|?[\s:|-]+\|?\s*$/.test(line) && line.includes("-");
}

export function convertMarkdownToHtml(markdown, report = []) {
  const lines = markdown.split(/\r?\n/);
  const out = [];
  let paragraphBuf = [];
  let i = 0;

  function flushParagraph() {
    if (paragraphBuf.length === 0) return;
    out.push(`<p>${inlineMarkdown(paragraphBuf.join(" ").trim())}</p>`);
    paragraphBuf = [];
  }

  while (i < lines.length) {
    const line = lines[i];

    if (line.trim() === "") { flushParagraph(); i++; continue; }

    const fenceMatch = line.match(/^```\s*(\w*)\s*$/);
    if (fenceMatch) {
      flushParagraph();
      const lang = fenceMatch[1];
      const codeLines = [];
      let end = i + 1;
      while (end < lines.length && !/^```\s*$/.test(lines[end])) { codeLines.push(lines[end]); end++; }
      if (lang.toLowerCase() === "dataview") {
        out.push("<p><em>[Dynamic Dataview query omitted on import — see the Obsidian vault for the live table.]</em></p>");
        report.push({ type: "dataview-omitted" });
      } else {
        out.push(`<pre><code>${escapeHtml(codeLines.join("\n"))}</code></pre>`);
      }
      i = end + 1;
      continue;
    }

    const headingMatch = line.match(/^(#{1,6})\s+(.*)$/);
    if (headingMatch) {
      flushParagraph();
      const level = headingMatch[1].length;
      out.push(`<h${level}>${inlineMarkdown(headingMatch[2].trim())}</h${level}>`);
      i++; continue;
    }

    if (/^(-{3,}|\*{3,}|_{3,})\s*$/.test(line.trim())) {
      flushParagraph();
      out.push("<hr>");
      i++; continue;
    }

    if (/^\s*\|.*\|\s*$/.test(line) && i + 1 < lines.length && isTableSeparator(lines[i + 1])) {
      flushParagraph();
      const headerCells = line.trim().replace(/^\||\|$/g, "").split("|").map((c) => c.trim());
      const rows = [];
      let end = i + 2;
      while (end < lines.length && /^\s*\|.*\|\s*$/.test(lines[end])) {
        rows.push(lines[end].trim().replace(/^\||\|$/g, "").split("|").map((c) => c.trim()));
        end++;
      }
      out.push("<table>");
      out.push(`<tr>${headerCells.map((c) => `<th>${inlineMarkdown(c)}</th>`).join("")}</tr>`);
      for (const row of rows) out.push(`<tr>${row.map((c) => `<td>${inlineMarkdown(c)}</td>`).join("")}</tr>`);
      out.push("</table>");
      i = end; continue;
    }

    if (/^>/.test(line)) {
      flushParagraph();
      const quoteLines = [];
      let end = i;
      while (end < lines.length && /^>/.test(lines[end])) { quoteLines.push(lines[end].replace(/^>\s?/, "")); end++; }
      const calloutMatch = quoteLines[0]?.match(/^\[!([\w-]+)\]([-+]?)\s*(.*)$/);
      if (calloutMatch) {
        const title = calloutMatch[3];
        const rest = quoteLines.slice(1).join(" ").trim();
        out.push(`<blockquote>${title ? `<strong>${inlineMarkdown(title)}</strong> ` : ""}${inlineMarkdown(rest)}</blockquote>`);
      } else {
        out.push(`<blockquote><p>${inlineMarkdown(quoteLines.join(" ").trim())}</p></blockquote>`);
      }
      i = end; continue;
    }

    const listMatch = line.match(/^\s*([-*]|\d+\.)\s+(.*)$/);
    if (listMatch) {
      flushParagraph();
      const ordered = /\d+\./.test(listMatch[1]);
      const tag = ordered ? "ol" : "ul";
      const items = [];
      let end = i;
      while (end < lines.length) {
        const m = lines[end].match(/^\s*([-*]|\d+\.)\s+(.*)$/);
        if (!m) break;
        items.push(m[2]);
        end++;
      }
      out.push(`<${tag}>${items.map((it) => `<li>${inlineMarkdown(it)}</li>`).join("")}</${tag}>`);
      i = end; continue;
    }

    paragraphBuf.push(line.trim());
    i++;
  }
  flushParagraph();
  return out.join("\n");
}

// ── Wikilinks ─────────────────────────────────────────────────────────────

const WIKILINK_RE = /\[\[([^\]|#]+)(#([^\]|]+))?(\|([^\]]+))?\]\]/g;

function normalizeLinkKey(name) {
  return name.trim().toLowerCase();
}

// notes: [{ vaultPath, title, basename, aliases }]. A name matching two
// different notes (by title, basename, or alias) is marked "ambiguous"
// rather than resolved to either — pass 2 reports and leaves it literal.
export function buildLinkIndex(notes) {
  const index = new Map();
  const add = (key, note) => {
    const norm = normalizeLinkKey(key);
    if (!norm) return;
    const existing = index.get(norm);
    if (existing === "ambiguous") return;
    if (existing && existing.vaultPath !== note.vaultPath) { index.set(norm, "ambiguous"); return; }
    index.set(norm, note);
  };
  for (const note of notes) {
    add(note.title, note);
    add(note.basename, note);
    for (const alias of note.aliases ?? []) add(alias, note);
  }
  return index;
}

// manifestByPath: Map<vaultPath, {entryId}> — the id a target note resolved
// to, from THIS run or a prior one. Unresolvable and ambiguous links are
// left as literal `[[...]]` text and reported, never guessed.
export function resolveWikilinksInHtml(html, linkIndex, manifestByPath, report) {
  return html.replace(new RegExp(WIKILINK_RE), (raw, target, _h, _heading, _l, label) => {
    const key = normalizeLinkKey(target);
    const entry = linkIndex.get(key);
    if (!entry || entry === "ambiguous") {
      report.push({ type: entry === "ambiguous" ? "ambiguous-link" : "unresolved-link", target });
      return raw;
    }
    const manifestEntry = manifestByPath.get(entry.vaultPath);
    if (!manifestEntry) {
      report.push({ type: "unresolved-link", target, reason: "target note not yet imported" });
      return raw;
    }
    const displayLabel = label || target;
    return `@UUID[JournalEntry.${manifestEntry.entryId}]{${escapeHtml(displayLabel)}}`;
  });
}

export function noteHasWikilinks(html) {
  return new RegExp(WIKILINK_RE).test(html);
}

// ── Visibility resolution ────────────────────────────────────────────────

const FOUNDRY_VISIBILITY_PROFILES = new Set(["gm", "party", "players"]);

// Everything defaults to gm — no frontmatter, unparseable frontmatter, or
// an unrecognized value all resolve here, and a value the command line
// didn't opt into via --allow-visibility is downgraded, never upgraded.
// This is the one function responsible for "there is no path from 'didn't
// understand this note' to 'players can read it'".
export function resolveNoteVisibility(frontmatter, allowedProfiles) {
  const raw = frontmatter["foundry-visibility"];
  if (raw === undefined || raw === null || raw === "") {
    return { profile: "gm", downgraded: false, reason: null };
  }
  const value = Array.isArray(raw) ? raw[0] : raw;
  const lower = String(value).trim().toLowerCase();
  if (!FOUNDRY_VISIBILITY_PROFILES.has(lower)) {
    return { profile: "gm", downgraded: true, reason: `unrecognized foundry-visibility '${value}'` };
  }
  if (lower !== "gm" && !allowedProfiles.has(lower)) {
    return { profile: "gm", downgraded: true, reason: `foundry-visibility '${lower}' requested but not passed to --allow-visibility` };
  }
  if (lower === "players") {
    const playersRaw = frontmatter["foundry-visibility-players"];
    const players = Array.isArray(playersRaw)
      ? playersRaw
      : typeof playersRaw === "string" && playersRaw.length > 0
        ? playersRaw.split(",").map((s) => s.trim()).filter(Boolean)
        : [];
    if (players.length === 0) {
      return { profile: "gm", downgraded: true, reason: "foundry-visibility: players requires foundry-visibility-players to name them" };
    }
    return { profile: "players", players, downgraded: false, reason: null };
  }
  return { profile: lower, downgraded: false, reason: null };
}

export function visibilityKeyOf(visibility) {
  if (visibility.profile !== "players") return visibility.profile;
  return `players:${[...visibility.players].map((p) => p.toLowerCase()).sort().join(",")}`;
}

export function toApiVisibility(visibility) {
  return visibility.profile === "players"
    ? { profile: "players", players: visibility.players }
    : { profile: visibility.profile };
}

// ── Content hashing / idempotency ────────────────────────────────────────

export function noteContentHash(publicBody, secretBody) {
  return createHash("sha256").update(publicBody + " " + (secretBody ?? "")).digest("hex");
}

// Decides what a note needs, given its current content/visibility and
// whatever the manifest recorded last time. A visibility change is
// reported, never silently applied, unless the caller explicitly opted in
// (--allow-visibility-change) — a visibility change on re-import is exactly
// the accident that publishes the campaign bible.
export function planNoteAction(manifestEntry, contentHash, visibilityKey, allowVisibilityChange) {
  if (!manifestEntry) return "create";
  if (manifestEntry.visibilityKey !== visibilityKey) {
    return allowVisibilityChange ? "visibility-change" : "visibility-change-refused";
  }
  if (manifestEntry.contentHash !== contentHash) return "update";
  return "unchanged";
}

// ── Note discovery ────────────────────────────────────────────────────────

export function noteTitleAndBasename(vaultPath) {
  const base = basename(vaultPath, extname(vaultPath));
  return { title: base, basename: base };
}

export function matchesOnly(vaultPath, onlyPattern) {
  if (!onlyPattern) return true;
  // A small glob-lite: '*' matches any run of non-separator characters.
  // Not a general glob engine — enough for "--only People/*" and similar.
  const escaped = onlyPattern.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, "[^/]*");
  return new RegExp(`(^|/)${escaped}$`).test(vaultPath) || new RegExp(`^${escaped}`).test(vaultPath);
}

export async function walkVault(rootDir) {
  const results = [];
  async function walk(dir) {
    const entries = await readdir(dir, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.name.startsWith(".")) continue; // .obsidian/, dotfiles
      const full = join(dir, entry.name);
      if (entry.isDirectory()) { await walk(full); continue; }
      if (entry.name.toLowerCase().endsWith(".md")) results.push(full);
    }
  }
  await walk(rootDir);
  return results;
}

// ── Manifest ──────────────────────────────────────────────────────────────

export function emptyManifest() {
  return { version: 1, notes: {} };
}

export async function readManifest(manifestPath) {
  try {
    const raw = await readFile(manifestPath, "utf8");
    return JSON.parse(raw);
  } catch (err) {
    if (err.code === "ENOENT") return emptyManifest();
    throw err;
  }
}

export async function writeManifest(manifestPath, manifest) {
  await writeFile(manifestPath, JSON.stringify(manifest, null, 2), "utf8");
}

// ═══════════════════════════════ CLI ═══════════════════════════════════
// Everything below drives the pure functions above against a real vault and
// a real sidecar. Not unit-tested directly (matching this project's existing
// boundary — sidecar/index.js's live-Foundry glue isn't unit-tested either);
// verified by running against a real deployment.

function parseArgs(argv) {
  const args = { vaultPath: null, apply: false, allowVisibility: new Set(), allowVisibilityChange: false, limit: null, only: null, json: false, verify: false, rebuildManifest: false, secretMarkers: null, manifestPath: null };
  const rest = [];
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    switch (arg) {
      case "--apply": args.apply = true; break;
      case "--allow-visibility-change": args.allowVisibilityChange = true; break;
      case "--json": args.json = true; break;
      case "--verify": args.verify = true; break;
      case "--rebuild-manifest": args.rebuildManifest = true; break;
      case "--allow-visibility": for (const p of argv[++i].split(",")) args.allowVisibility.add(p.trim().toLowerCase()); break;
      case "--limit": args.limit = Number.parseInt(argv[++i], 10); break;
      case "--only": args.only = argv[++i]; break;
      case "--manifest": args.manifestPath = argv[++i]; break;
      case "--secret-marker": (args.secretMarkers ??= []).push(new RegExp(argv[++i], "i")); break;
      default: rest.push(arg);
    }
  }
  args.vaultPath = rest[0] ?? null;
  return args;
}

async function promptConfirmation(expectedNumber) {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  const answer = await new Promise((resolve) => rl.question(`Type the number ${expectedNumber} to proceed: `, resolve));
  rl.close();
  return answer.trim() === String(expectedNumber);
}

async function sidecarFetch(baseUrl, apiKey, path, { method = "GET", body } = {}) {
  const res = await fetch(`${baseUrl}${path}`, {
    method,
    headers: { "X-API-Key": apiKey, ...(body ? { "Content-Type": "application/json" } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error ?? `${method} ${path} failed with ${res.status}`);
  return data;
}

async function previewAndApply(baseUrl, apiKey, writeBody, apply) {
  const preview = await sidecarFetch(baseUrl, apiKey, "/api/mcp/journal/write/preview", { method: "POST", body: writeBody });
  if (!apply) return { preview, applied: null };
  const applied = await sidecarFetch(baseUrl, apiKey, "/api/mcp/journal/write", {
    method: "POST",
    body: { ...writeBody, confirmationToken: preview.confirmation.confirmationToken },
  });
  return { preview, applied };
}

async function loadNotes(vaultPath, only, limit) {
  const paths = await walkVault(vaultPath);
  const filtered = paths.filter((p) => matchesOnly(relative(vaultPath, p), only));
  const limited = limit ? filtered.slice(0, limit) : filtered;
  const notes = [];
  for (const fullPath of limited) {
    const vaultRelPath = relative(vaultPath, fullPath);
    const raw = await readFile(fullPath, "utf8");
    const { frontmatter, body } = parseFrontmatter(raw);
    const { title, basename: base } = noteTitleAndBasename(fullPath);
    notes.push({
      vaultPath: vaultRelPath,
      fullPath,
      raw,
      frontmatter,
      body,
      title: typeof frontmatter.title === "string" && frontmatter.title ? frontmatter.title : title,
      basename: base,
      aliases: Array.isArray(frontmatter.aliases) ? frontmatter.aliases : [],
    });
  }
  return notes;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (!args.vaultPath) {
    console.error("Usage: import-obsidian.mjs <vaultPath> [--apply] [--allow-visibility party,players] [--allow-visibility-change] [--limit N] [--only <pattern>] [--secret-marker <regex>] [--manifest <path>] [--json] [--verify] [--rebuild-manifest]");
    process.exit(64);
  }
  const baseUrl = process.env.FOUNDRY_SIDECAR_URL ?? "http://localhost:30001";
  const apiKey = process.env.API_KEY;
  // A plain dry run only reads local vault files and needs no sidecar at
  // all; only the modes that actually talk to Foundry require a key.
  if (!apiKey && (args.apply || args.verify || args.rebuildManifest)) {
    console.error("Set API_KEY to the sidecar's private API key.");
    process.exit(64);
  }

  const manifestPath = args.manifestPath ?? join(dirname(args.vaultPath), "obsidian-import-manifest.json");
  const notes = await loadNotes(args.vaultPath, args.only, args.limit);
  const linkIndex = buildLinkIndex(notes);

  let manifest = args.rebuildManifest ? emptyManifest() : await readManifest(manifestPath);

  if (args.rebuildManifest) {
    // The obsidian.path/hash flag this importer writes isn't exposed
    // through the GM read routes today, so a full rebuild can only recover
    // entry ids by matching a Foundry entry's name to a vault note's title
    // — enough to avoid a duplicate create on the next run, not to restore
    // exact content hashes (those get picked up as ordinary "update"s the
    // first time a rebuilt manifest is used, which is the correct, safe
    // fallback: worst case is one redundant update-page call per note).
    const byTitle = new Map(notes.map((n) => [n.title.trim().toLowerCase(), n]));
    const first = await sidecarFetch(baseUrl, apiKey, "/api/mcp/journal?limit=100");
    let all = [...first.results];
    while (all.length < first.total) {
      const next = await sidecarFetch(baseUrl, apiKey, `/api/mcp/journal?limit=100&offset=${all.length}`);
      if (next.results.length === 0) break;
      all = all.concat(next.results);
    }
    let matched = 0;
    for (const entry of all) {
      const note = byTitle.get(entry.entryName.trim().toLowerCase());
      if (!note) continue;
      matched++;
      manifest.notes[note.vaultPath] = { entryId: entry.entryId, pageIds: { public: null, secret: null }, contentHash: null, visibilityKey: null };
    }
    console.log(`--rebuild-manifest matched ${matched}/${all.length} Foundry entries to vault notes by name. Content hashes were not restored — the next run will report each as an update, which is expected.`);
  }

  if (args.verify) {
    // A coarse but real check: every manifest entry still exists, and its
    // broad visibility class (gm-only vs. visible-to-someone) matches what
    // the manifest recorded. This does not reproduce exact membership —
    // Foundry has no way to ask "which named profile produced this
    // ownership map", only "who can currently see it" — so a party
    // membership drift (a player leaving, a new one joining) will not be
    // flagged here; only a wholesale loss of visibility (or of the entry
    // itself) will be.
    let ok = 0, problems = [];
    for (const [vaultPath, entry] of Object.entries(manifest.notes)) {
      if (!entry.entryId) continue;
      let detail;
      try {
        detail = await sidecarFetch(baseUrl, apiKey, `/api/mcp/journal/${entry.entryId}`);
      } catch {
        problems.push({ vaultPath, problem: "entry no longer exists in Foundry" });
        continue;
      }
      const expectGmOnly = entry.visibilityKey === "gm" || entry.visibilityKey == null;
      if (Boolean(detail.visibility?.gmOnly) !== expectGmOnly) {
        problems.push({ vaultPath, problem: `expected gmOnly=${expectGmOnly}, Foundry reports gmOnly=${detail.visibility?.gmOnly}` });
        continue;
      }
      ok++;
    }
    console.log(`--verify: ${ok} entr${ok === 1 ? "y" : "ies"} consistent, ${problems.length} problem(s).`);
    for (const p of problems) console.log(`  - ${p.vaultPath}: ${p.problem}`);
    if (problems.length > 0) process.exit(1);
    return;
  }

  const secretMarkers = args.secretMarkers ?? DEFAULT_SECRET_MARKERS;

  const plans = notes.map((note) => {
    const visibility = resolveNoteVisibility(note.frontmatter, args.allowVisibility);
    const { publicBody, secretBody } = splitSecretSection(note.body, secretMarkers);
    const contentHash = noteContentHash(publicBody, secretBody);
    const visibilityKey = visibilityKeyOf(visibility);
    const manifestEntry = manifest.notes[note.vaultPath];
    const action = planNoteAction(manifestEntry, contentHash, visibilityKey, args.allowVisibilityChange);
    return { note, visibility, publicBody, secretBody, contentHash, visibilityKey, manifestEntry, action };
  });

  if (!args.apply) {
    const summary = {
      vaultPath: args.vaultPath,
      totalNotes: plans.length,
      toCreate: plans.filter((p) => p.action === "create").length,
      toUpdate: plans.filter((p) => p.action === "update").length,
      unchanged: plans.filter((p) => p.action === "unchanged").length,
      visibilityChangesRefused: plans.filter((p) => p.action === "visibility-change-refused").length,
      downgraded: plans.filter((p) => p.visibility.downgraded).map((p) => ({ vaultPath: p.note.vaultPath, reason: p.visibility.reason })),
      byVisibility: {
        gm: plans.filter((p) => p.visibility.profile === "gm").length,
        party: plans.filter((p) => p.visibility.profile === "party").length,
        players: plans.filter((p) => p.visibility.profile === "players").length,
      },
      notes: plans.map((p) => ({ vaultPath: p.note.vaultPath, action: p.action, visibility: p.visibility.profile, downgraded: p.visibility.downgraded })),
    };
    if (args.json) console.log(JSON.stringify(summary, null, 2));
    else {
      console.log(`Dry run over ${summary.totalNotes} note(s) in ${args.vaultPath}:`);
      console.log(`  create: ${summary.toCreate}, update: ${summary.toUpdate}, unchanged: ${summary.unchanged}, visibility changes refused: ${summary.visibilityChangesRefused}`);
      console.log(`  visibility: gm=${summary.byVisibility.gm} party=${summary.byVisibility.party} players=${summary.byVisibility.players}`);
      if (summary.downgraded.length > 0) {
        console.log(`  downgraded to gm-only (${summary.downgraded.length}):`);
        for (const d of summary.downgraded) console.log(`    - ${d.vaultPath}: ${d.reason}`);
      }
      console.log("Run again with --apply to write. Nothing was written.");
    }
    return;
  }

  const playerVisibleCount = plans.filter((p) => p.action !== "unchanged" && p.visibility.profile !== "gm").length;
  if (playerVisibleCount > 0) {
    const names = new Set();
    for (const p of plans) {
      if (p.visibility.profile === "players") for (const ref of p.visibility.players) names.add(ref);
      if (p.visibility.profile === "party") names.add("the party");
    }
    console.log(`This will make ${playerVisibleCount} note(s) readable by ${[...names].join(", ") || "players"}.`);
    const confirmed = await promptConfirmation(playerVisibleCount);
    if (!confirmed) { console.log("Confirmation did not match. Nothing was written."); process.exit(1); }
  }

  const manifestByPath = new Map(Object.entries(manifest.notes).map(([k, v]) => [k, v]));
  const report = [];

  // Pass 1: create/update every note at its resolved visibility, with
  // wikilinks left literal — nothing has an id to link to yet.
  for (const plan of plans) {
    if (plan.action === "unchanged" || plan.action === "visibility-change-refused") {
      if (plan.action === "visibility-change-refused") report.push({ type: "visibility-change-refused", vaultPath: plan.note.vaultPath });
      continue;
    }
    const html = convertMarkdownToHtml(plan.publicBody, report);
    const apiVisibility = toApiVisibility(plan.visibility);

    if (!plan.manifestEntry) {
      const { applied } = await previewAndApply(baseUrl, apiKey, {
        operation: "create-entry",
        name: plan.note.title,
        pages: [{ name: "Overview", content: html }],
        knowledge: plan.note.frontmatter.type ? { type: plan.note.frontmatter.type, tags: plan.note.frontmatter.tags ?? [] } : undefined,
        visibility: apiVisibility,
      }, true);
      manifestByPath.set(plan.note.vaultPath, {
        entryId: applied.entryId, pageIds: { public: applied.pages?.[0]?.pageId ?? null, secret: null },
        contentHash: plan.contentHash, visibilityKey: plan.visibilityKey,
        obsidian: { path: plan.note.vaultPath, markdown: plan.publicBody },
        importedAt: applied.importedAt ?? undefined,
      });
    } else {
      const entryId = plan.manifestEntry.entryId;
      const pageId = plan.manifestEntry.pageIds?.public;
      const { applied } = await previewAndApply(baseUrl, apiKey, {
        operation: "update-page",
        entryId, pageId,
        pages: [{ name: "Overview", content: html }],
        visibility: apiVisibility,
      }, true);
      manifestByPath.set(plan.note.vaultPath, {
        ...plan.manifestEntry, contentHash: plan.contentHash, visibilityKey: plan.visibilityKey,
        obsidian: { path: plan.note.vaultPath, markdown: plan.publicBody },
      });
    }

    if (plan.secretBody) {
      const secretHtml = convertMarkdownToHtml(plan.secretBody, report);
      const entryId = manifestByPath.get(plan.note.vaultPath).entryId;
      const existingSecretPageId = plan.manifestEntry?.pageIds?.secret;
      const { applied } = existingSecretPageId
        ? await previewAndApply(baseUrl, apiKey, { operation: "update-page", entryId, pageId: existingSecretPageId, pages: [{ name: "DM Notes", content: secretHtml }], visibility: { profile: "gm" } }, true)
        : await previewAndApply(baseUrl, apiKey, { operation: "add-page", entryId, pages: [{ name: "DM Notes", content: secretHtml }], visibility: { profile: "gm" } }, true);
      const current = manifestByPath.get(plan.note.vaultPath);
      manifestByPath.set(plan.note.vaultPath, { ...current, pageIds: { ...current.pageIds, secret: applied.pageId ?? existingSecretPageId } });
    }
  }

  // Pass 2: rewrite wikilinks now that every note in this run has an id.
  for (const plan of plans) {
    if (plan.action === "unchanged" || plan.action === "visibility-change-refused") continue;
    const html = convertMarkdownToHtml(plan.publicBody, []);
    if (!noteHasWikilinks(html)) continue;
    const resolved = resolveWikilinksInHtml(html, linkIndex, manifestByPath, report);
    const entry = manifestByPath.get(plan.note.vaultPath);
    await previewAndApply(baseUrl, apiKey, {
      operation: "update-page", entryId: entry.entryId, pageId: entry.pageIds.public,
      pages: [{ name: "Overview", content: resolved }],
      visibility: toApiVisibility(plan.visibility),
    }, true);
  }

  const newManifest = { version: 1, notes: Object.fromEntries(manifestByPath) };
  await writeManifest(manifestPath, newManifest);

  console.log(`Imported ${plans.filter((p) => p.action !== "unchanged" && p.action !== "visibility-change-refused").length} note(s). Manifest written to ${manifestPath}.`);
  if (report.length > 0) {
    console.log(`${report.length} item(s) need attention:`);
    for (const item of report) console.log(`  - ${item.type}${item.target ? `: ${item.target}` : ""}${item.vaultPath ? `: ${item.vaultPath}` : ""}${item.reason ? ` (${item.reason})` : ""}`);
  }
}

const isMainModule = process.argv[1] && import.meta.url === `file://${process.argv[1]}`;
if (isMainModule) {
  main().catch((err) => { console.error(err.message); process.exit(1); });
}
