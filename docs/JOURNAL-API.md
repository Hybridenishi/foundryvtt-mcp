# Journal API — reference for an external authoring client

This is the precise contract for building a client against this sidecar's journal
surface — the routes an authoring tool (for example, a GM-side note-taking app)
needs to search, read, and write Foundry journal entries with correct per-player
visibility. It is deliberately narrower than the full endpoint table in
[`README.md`](../README.md#endpoints-sidecar): that table is for orientation across
every route in the repo, this document is for writing a typed client against the
subset that matters for authoring.

If you are building an MCP tool or working inside this repo, `README.md` and
`AGENTS.md` are the right starting points instead. This document assumes you are
outside the repo, calling the sidecar over HTTP.

## Before anything else: five behaviors that will surprise you

1. **Preview needs no GM bridge. Apply does.** `POST /api/mcp/journal/write/preview`
   only reads the world snapshot the sidecar already has — it works with no
   Foundry browser tab open. `POST /api/mcp/journal/write` requires an active,
   paired GM bridge (a GM's Foundry tab, kept open) to actually execute the
   write. Check [`GET /api/mcp/write-status`](#get-apimcpwrite-status) before
   letting a user try to publish, not after they've composed three paragraphs.

2. **Confirmation tokens are single-use, expire in 2 minutes, and are bound to
   the *resolved* audience, not the request you sent.** The token from preview
   encodes a hash of the operation's identity — including the ownership map
   preview actually resolved (which users are on the roster right now, which
   character actors they own). If anything about that resolution changes before
   you call apply — a new player joins, a character's ownership changes, or you
   simply wait too long — apply returns `409`. **The correct response to a `409`
   is to preview again, never to retry the same apply call.**

3. **One visibility per call, and the schema cannot express otherwise.** There is
   no way to request "public overview, but this one section is GM-only" in a
   single `create-entry` call. Build mixed-visibility content by composition:
   `create-entry` at one visibility, then a separate, separately previewed
   `add-page` call at a different visibility. This is deliberate — it forces a
   distinct receipt naming exactly who can see the secret page, at the moment
   the secret page is created.

4. **Player references fail loud, never silently.** `visibility.players` accepts
   a Foundry user id, a user's display name, or the name of a character actor
   they own. An unresolvable or ambiguous name returns `400` naming the problem
   (`docs/examples/errors.json`'s `validation_unresolvable_player_400`) — it never
   guesses, and it never silently drops the ambiguous name from the list.

5. **The error envelope is always `{ "error": "<message>" }`.** Verified against
   every error response in `sidecar/app.js` (81 of 81 use this exact shape). One
   `Codable` error type covers every route in this document.

## Versioning

Every response documented here carries `schemaVersion: 1` at the top level.
Additive changes (a new optional field) do not bump the version. A field removal,
rename, or type change bumps it. Pin to the version, not just the shape — a
client that doesn't check `schemaVersion` has no signal when this contract
changes under it.

## Auth

`X-API-Key: <key>` header on every request. There are two independent keys:

- **`API_KEY`** — reaches every route in this document, plus every GM/actor/write
  route in the full API. This is what an authoring client should hold.
- **`PLAYER_API_KEY`** — reaches only `/api/mcp/players/*` (documented below for
  completeness, since a read-only companion or a player-facing consumer might use
  it), and is structurally unable to reach anything else — GM journal routes,
  actor routes, and every write route reject it with `401`, by construction
  (separate middleware, not a permission check that can be gotten wrong).

Missing or wrong key on any route: `401` (`docs/examples/errors.json`'s
`unauthorized_401`).

## Routes

### `GET /api/mcp/refresh`

Health check. No auth-scope distinction — reachable with either key.

**Response** — [`docs/examples/refresh.json`](examples/refresh.json)

```json
{ "ok": true, "connected": true, "timestamp": 1785284968730 }
```

### `GET /api/mcp/write-status`

**Add this to any pre-publish check.** Cheap — reads only in-process state, makes
no call to Foundry, safe to call on a timer or every time a compose window opens.
Requires `API_KEY`.

**Response** — [`docs/examples/write-status.json`](examples/write-status.json)

```json
{
  "schemaVersion": 1,
  "writeEnabled": true,
  "foundryConnected": true,
  "bridge": { "available": false, "responders": 0 }
}
```

| Field | Meaning |
|---|---|
| `writeEnabled` | The sidecar's `FOUNDRY_WRITE_ENABLED` flag. `false` means every write route returns `403` regardless of anything else. |
| `foundryConnected` | The sidecar's own Socket.IO connection to Foundry. `false` means every route returns `503`, including this one — see below. |
| `bridge.available` | Whether a GM's Foundry browser tab is currently paired. `false` means `preview` will still work, but `apply` will eventually time out with `504`. |
| `bridge.responders` | How many GM tabs are paired. Normally 0 or 1. |

If `foundryConnected` would be `false`, this route (like every other route) 503s
before returning a body — the shared auth middleware checks connectivity before
any handler runs. A `503` *is* the "not connected" signal; there is no body to
inspect.

### `GET /api/mcp/players`

Roster of non-GM Foundry users, for a visibility picker. Requires `API_KEY` or
`PLAYER_API_KEY`.

**Response** — [`docs/examples/players.json`](examples/players.json)

```json
{
  "schemaVersion": 1,
  "players": [
    { "userId": "examplePlayer00001", "name": "<player-1>", "characterNames": ["<PC-A>"] }
  ]
}
```

`characterNames` lists character actors that player currently owns — empty if
none. Use `userId` (or `name`, or a listed character name) as a `visibility.players`
entry when composing a write; all three forms resolve.

### `GET /api/mcp/journal`

Search, for attaching a new page to an existing entry or browsing before writing.
Requires `API_KEY`. Query params: `query`, `type`, `tag`, `folder`, `limit`,
`offset` — all optional; an empty query returns everything (subject to the other
filters).

**Response** — [`docs/examples/journal-search.json`](examples/journal-search.json)

Each result's `visibility.visibleTo` names exactly who (besides the GM) can
currently read it — resolved to names, not just ids, so a UI can render
"visible to Alice and Bob" directly from this field without a second lookup.

### `GET /api/mcp/journal/folders`

Folder tree, for a folder picker on `create-entry`. Requires `API_KEY`.

**Response** — [`docs/examples/journal-folders.json`](examples/journal-folders.json)

### `GET /api/mcp/journal/:id`

One entry with full page content. Requires `API_KEY`. `404` if the id doesn't
exist ([`docs/examples/player-journal-not-found.json`](examples/player-journal-not-found.json)
shows the shape — GM and player 404s are byte-identical).

**Response** — [`docs/examples/journal-detail.json`](examples/journal-detail.json)

Each page carries `contentHash` (sha256 of its content) — useful for a client
doing its own change detection without re-diffing full HTML.

### `POST /api/mcp/journal/write/preview`

Read-only. Resolves the requested visibility to a concrete audience and returns a
confirmation token. **Does not require the GM bridge.** Requires `API_KEY` — no
`FOUNDRY_WRITE_ENABLED` check either, since nothing is written yet.

**Request body:**

```json
{
  "operation": "create-entry",
  "entryId": null,
  "pageId": null,
  "name": "<Example Entry>",
  "folder": null,
  "knowledge": { "type": "person", "tags": [] },
  "pages": [{ "name": "Overview", "content": "<p>...</p>" }],
  "visibility": { "profile": "players", "players": ["<player-1>"] }
}
```

`operation` is one of `create-entry` | `add-page` | `update-page`.

- `create-entry` — `name` required, `entryId`/`pageId` omitted.
- `add-page` — `entryId` required, exactly one page, `pageId` omitted.
- `update-page` — `entryId` and `pageId` both required, exactly one page.

`visibility.profile` is one of:

| Profile | Meaning | Extra field |
|---|---|---|
| `"gm"` | GM-only. No other field. | — |
| `"party"` | Every non-GM user who currently owns a character actor. Derived at preview time, not stored — re-resolved on every call. | — |
| `"players"` | Named explicitly. | `players: [String]` — user ids, names, or owned-character names |

There is no default — omitting `visibility` is a `400`.

Content is HTML (`text.format: 1` on the Foundry side).
`@UUID[JournalEntry.<id>]{Label}` enrichers are supported in `content` and
resolve normally in Foundry once the target entry exists.

**Response** — [`docs/examples/write-preview.json`](examples/write-preview.json)

```json
{
  "schemaVersion": 1,
  "operation": "create-entry",
  "entryId": null,
  "pageId": null,
  "name": "<Example Entry>",
  "pages": [{ "name": "Overview" }],
  "visibility": {
    "profile": "players",
    "gmOnly": false,
    "visibleTo": [{ "userId": "examplePlayer00001", "name": "<player-1>" }]
  },
  "confirmation": {
    "confirmationToken": "73cce1bf-b3c9-4c7a-95a6-1b16b1c13b09",
    "expiresAt": "2026-07-29T00:32:10.750Z"
  }
}
```

**Show `visibility.visibleTo` to the user before offering to publish.** That is
the entire reason this is a two-step flow rather than a single write call.

### `POST /api/mcp/journal/write`

Executes an exactly-previewed write. Requires `API_KEY`, `FOUNDRY_WRITE_ENABLED`,
and an active GM bridge. Same body as preview, plus `confirmationToken` from the
matching preview response.

**Response** — [`docs/examples/write-apply-create-entry.json`](examples/write-apply-create-entry.json)

```json
{
  "schemaVersion": 1,
  "ok": true,
  "operation": "create-entry",
  "visibility": {
    "profile": "players",
    "visibleTo": [{ "userId": "examplePlayer00001", "name": "<player-1>" }]
  },
  "entryId": "abc123newEntry01",
  "entryUuid": "JournalEntry.abc123newEntry01",
  "entryName": "<Example Entry>",
  "ownership": { "default": 0, "examplePlayer00001": 2 },
  "pages": [
    {
      "pageId": "def456newPage001",
      "pageUuid": "JournalEntry.abc123newEntry01.JournalEntryPage.def456newPage001",
      "pageName": "Overview",
      "ownership": { "default": 0, "examplePlayer00001": 2 }
    }
  ]
}
```

`visibility.visibleTo` and `ownership` here are read back from the document
*after* writing it, not echoed from the request — this is the receipt, and it is
what should actually be shown to the user as confirmation of who can see what,
not the request they sent a moment earlier.

### Player-scoped routes (`/api/mcp/players/*`)

Documented for completeness — these are for a player-facing reader, not an
authoring client, but they share this contract and `PLAYER_API_KEY` can reach
them. All four require the path-scoped `:userRef` (a user id, name, or owned
character name) and return the same uniform envelope whether the entry is
genuinely absent or the named player simply cannot see it — see
[`docs/PRIMER.md`](PRIMER.md) and `docs/ROADMAP.md`'s Phase 6 section for the
non-leakage design this depends on.

- `GET /api/mcp/players/:userRef/journal` — [example](examples/player-journal-search.json)
- `GET /api/mcp/players/:userRef/journal/:entryId` — 404s identically whether
  the entry doesn't exist, isn't readable, or every page on it is hidden —
  [example](examples/player-journal-not-found.json)
- `GET /api/mcp/players/index-feed` — full enumeration of every page visible to
  at least one non-GM user; empty when nothing is yet player-visible —
  [example](examples/player-index-feed.json). Each item, when present, has the
  shape `{ entryUuid, pageUuid, entryName, pageName, content, contentHash, visibleTo: [userId, ...] }`.

## Errors

Every error body is `{ "error": "<message>" }`. Full set with real messages:
[`docs/examples/errors.json`](examples/errors.json).

| Status | Meaning | Retry? |
|---|---|---|
| `400` | Validation failure — missing field, bad visibility profile, unresolvable player name | No — fix the request |
| `401` | Missing or wrong API key | No |
| `404` | Entry or page id doesn't exist | No |
| `409` | Confirmation token expired, already used, or bound to a request that no longer matches (audience changed) | **Re-preview, then retry** |
| `503` | Sidecar isn't connected to Foundry right now | Yes, after a delay |
| `504` | Apply timed out waiting for the GM bridge | No — needs a human to open Foundry as GM; check `write-status` first next time |
| `500` | Unexpected server-side failure | Maybe, but treat as a bug report |

## Known limitations

- No folder creation — only selecting an existing folder id on `create-entry`.
- No journal entry or page deletion.
- No attachment or image upload; content is text/HTML only.
- No bulk operations — one entry or page per call.
- `party` visibility is derived at write time from current character ownership,
  not stored as a named group — the party composition can change between two
  writes made minutes apart.

## Credential scope — a deliberate open question

An authoring client needs only the five journal routes documented above, but
today the only credential that reaches them (`API_KEY`) also reaches every
actor route, `update_actor`, actor deletion, chat posting, and combat control —
everything. There's a reasonable case for a third, narrower credential scoped to
journal routes only, mirroring how `PLAYER_API_KEY` narrows the player surface.

This hasn't been built. The judgment call so far: an authoring client runs on the
GM's own machine, and the GM already has full Foundry access by definition, so
the incremental blast radius of holding `API_KEY` is small. Revisit this if an
authoring client is ever meant to run somewhere less trusted than the GM's own
laptop.
