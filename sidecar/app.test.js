const assert = require("node:assert/strict");
const test = require("node:test");
const http = require("node:http");
const { createApp } = require("./app");

const API_KEY = "test-api-key";

function fixtureWorld() {
  return {
    actors: [
      {
        _id: "actor-1",
        name: "Hero",
        type: "character",
        items: [{ _id: "item-1", name: "Sword", type: "weapon", system: { activities: {} } }],
      },
    ],
    items: [{ _id: "witem-1", name: "Potion", type: "consumable" }],
    scenes: [{ _id: "scene-1", name: "Tavern", active: true, tokens: [] }],
    combats: [],
    messages: [],
    journal: [
      {
        _id: "journal-1",
        name: "City of Ravencroft",
        folder: "folder-locations",
        flags: { "foundry-mcp-bridge": { knowledge: { type: "location", tags: ["city", "coastal"] } } },
        pages: [
          { _id: "page-1", name: "Overview", type: "text", text: { content: "The harbor district of Ravencroft has been quiet lately." } },
        ],
      },
      {
        _id: "journal-2",
        name: "Leon Blackstone",
        pages: [
          { _id: "page-2", name: "Notes", type: "text", text: { content: "A shopkeeper of no particular renown." } },
        ],
      },
    ],
    folders: [
      { _id: "folder-locations", name: "Locations", type: "JournalEntry", folder: null },
      { _id: "folder-scenes", name: "Scene Folder", type: "Scene", folder: null },
    ],
    users: [{ _id: "user-1", name: "GM", role: 4, active: true }],
    modules: [{ _id: "mod-1", name: "Test Module", version: "1.0.0", active: true }],
  };
}

// A second fixture, built on the first, adding non-GM users and ownership
// data — kept separate from fixtureWorld() so the Stage 1 assertions above
// (which count actors/journal entries directly) never have to change as
// Stage 2 fixtures grow.
function fixtureWorldWithOwnership() {
  const world = fixtureWorld();
  world.users = [
    ...world.users,
    { _id: "user-alice", name: "Alice", role: 1, active: true },
    { _id: "user-bob", name: "Bob", role: 1, active: true },
  ];
  world.actors = world.actors.map((a) =>
    a._id === "actor-1" ? { ...a, ownership: { default: 0, "user-alice": 3 } } : a,
  );
  // journal-1 (City of Ravencroft): party-visible entry, and its one page
  // carries no ownership of its own — it inherits from the entry.
  world.journal = world.journal.map((j) =>
    j._id === "journal-1" ? { ...j, ownership: { default: 0, "user-alice": 2, "user-bob": 2 } } : j,
  );
  // journal-2 (Leon Blackstone) is left with no `ownership` field at all —
  // deny-by-default means it stays invisible to every player, exercising
  // the "no ownership field, not just an empty one" denial path.
  world.journal.push(
    // GM-only entry — the indistinguishability test's hidden subject.
    {
      _id: "journal-secret",
      name: "Mortala's True Name",
      ownership: { default: 0 },
      pages: [{ _id: "page-secret", name: "Notes", type: "text", text: { content: "Her true name is Ashkatai." } }],
    },
    // Entry-level visible to Alice, but its only page is explicitly
    // GM-only — must read as fully hidden, not as an empty-but-real entry.
    {
      _id: "journal-mixed",
      name: "Ravencroft Undercity",
      ownership: { default: 0, "user-alice": 2 },
      pages: [{ _id: "page-mixed-secret", name: "GM Only", type: "text", text: { content: "The undercity hides a cult." }, ownership: { default: 0 } }],
    },
    // Entry-level visible to Alice, genuinely zero pages — nothing is being
    // hidden from her, so this one must survive, unlike journal-mixed.
    {
      _id: "journal-empty",
      name: "Blank Slate",
      ownership: { default: 0, "user-alice": 2 },
      pages: [],
    },
  );
  return world;
}

// Every test gets its own app + fresh in-memory bridge state, wired to a
// fixture world and no live Foundry — this is the whole point of the app.js
// extraction: exercising the route table without a real deployment.
function startApp(overrides = {}) {
  const world = overrides.world ?? fixtureWorld();
  const app = createApp({
    apiKey: API_KEY,
    writeEnabled: false,
    foundryUrl: "http://127.0.0.1:1", // deliberately unreachable; system-info's axios calls should fail soft
    isConnected: () => true,
    getWorld: async () => world,
    emitModifyDocument: async () => ({ ok: true }),
    validateBridgeGmSession: async (req) => {
      if (!req.headers.cookie) throw new Error("A Foundry session cookie is required to pair the GM bridge.");
      return { userId: "gm-user-1" };
    },
    getMcpUserId: () => "mcp-user-1",
    preparedActorTimeoutMs: 50,
    ...overrides.deps,
  });
  const server = app.listen(0);
  const port = () => server.address().port;
  return { server, port };
}

function request(port, method, path, { headers = {}, body } = {}) {
  return new Promise((resolve, reject) => {
    const payload = body !== undefined ? JSON.stringify(body) : undefined;
    const req = http.request(
      { port, method, path, headers: { ...(payload ? { "Content-Type": "application/json" } : {}), ...headers } },
      (res) => {
        let raw = "";
        res.on("data", (chunk) => { raw += chunk; });
        res.on("end", () => {
          let parsed;
          try { parsed = raw ? JSON.parse(raw) : undefined; } catch { parsed = raw; }
          resolve({ status: res.statusCode, body: parsed });
        });
      },
    );
    req.on("error", reject);
    if (payload) req.write(payload);
    req.end();
  });
}

function auth(extra = {}) {
  return { "x-api-key": API_KEY, ...extra };
}

// ── Auth ─────────────────────────────────────────────────────────────

test("rejects a request with no API key", async () => {
  const { server, port } = startApp();
  const res = await request(port(), "GET", "/api/mcp/actors");
  server.close();
  assert.equal(res.status, 401);
});

test("rejects a request with the wrong API key", async () => {
  const { server, port } = startApp();
  const res = await request(port(), "GET", "/api/mcp/actors", { headers: auth({ "x-api-key": "wrong" }) });
  server.close();
  assert.equal(res.status, 401);
});

test("mcp-bridge/ready rejects a missing Foundry session cookie", async () => {
  const { server, port } = startApp();
  const res = await request(port(), "POST", "/mcp-bridge/ready", { body: { clientId: "client-1234" } });
  server.close();
  assert.equal(res.status, 401);
});

test("mcp-bridge/poll rejects an incorrect bridge token", async () => {
  const { server, port } = startApp();
  const ready = await request(port(), "POST", "/mcp-bridge/ready", {
    headers: { cookie: "session=abc" },
    body: { clientId: "client-1234" },
  });
  assert.equal(ready.status, 200);

  const res = await request(port(), "GET", `/mcp-bridge/poll?clientId=client-1234`, {
    headers: { "x-mcp-bridge-token": "not-the-real-token" },
  });
  server.close();
  assert.equal(res.status, 401);
});

// ── Write gating ─────────────────────────────────────────────────────

test("every mutating route is disabled when writes are off", async () => {
  const { server, port } = startApp();
  const routes = [
    ["POST", "/api/mcp/actors/actor-1/hp-change"],
    ["POST", "/api/mcp/actors/actor-1/temporary-hp"],
    ["POST", "/api/mcp/actors/actor-1/conditions"],
    ["POST", "/api/mcp/actors/actor-1/spell-slots"],
    ["POST", "/api/mcp/actors/actor-1/items/item-1/activities/activity-1/use"],
    ["POST", "/api/mcp/actors/actor-1/update"],
    ["POST", "/api/mcp/actors/create"],
    ["POST", "/api/mcp/actors/actor-1/delete"],
    ["POST", "/api/mcp/combats/next-turn"],
    ["POST", "/api/mcp/chat"],
  ];
  for (const [method, path] of routes) {
    const res = await request(port(), method, path, { headers: auth(), body: {} });
    assert.equal(res.status, 403, `${method} ${path} should be write-gated`);
  }
  server.close();
});

// ── Route mapping ────────────────────────────────────────────────────

test("lists actors from the fixture world", async () => {
  const { server, port } = startApp();
  const res = await request(port(), "GET", "/api/mcp/actors", { headers: auth() });
  server.close();
  assert.equal(res.status, 200);
  assert.equal(res.body.length, 1);
  assert.equal(res.body[0].name, "Hero");
});

test("returns 404 for an unknown actor", async () => {
  const { server, port } = startApp();
  const res = await request(port(), "GET", "/api/mcp/actors/does-not-exist", { headers: auth() });
  server.close();
  assert.equal(res.status, 404);
});

// ── Journal ──────────────────────────────────────────────────────────

test("searches the journal by content and returns a snippet", async () => {
  const { server, port } = startApp();
  const res = await request(port(), "GET", "/api/mcp/journal?query=Ravencroft", { headers: auth() });
  server.close();
  assert.equal(res.status, 200);
  assert.equal(res.body.scope, "gm");
  assert.equal(res.body.total, 1);
  assert.equal(res.body.results[0].entryId, "journal-1");
  assert.equal(res.body.results[0].pageHits[0].matchCount, 1);
  assert.match(res.body.results[0].pageHits[0].snippet, /\*\*Ravencroft\*\*/);
});

test("filters journal search by folder and by classified type", async () => {
  const { server, port } = startApp();
  const byFolder = await request(port(), "GET", "/api/mcp/journal?query=Ravencroft&folder=Locations", { headers: auth() });
  const byType = await request(port(), "GET", "/api/mcp/journal?query=Ravencroft&type=person", { headers: auth() });
  server.close();
  assert.equal(byFolder.body.total, 1);
  assert.equal(byType.body.total, 0);
});

test("gets one journal entry with full page content and a contentHash", async () => {
  const { server, port } = startApp();
  const res = await request(port(), "GET", "/api/mcp/journal/journal-2", { headers: auth() });
  server.close();
  assert.equal(res.status, 200);
  assert.equal(res.body.uuid, "JournalEntry.journal-2");
  assert.equal(res.body.pages[0].uuid, "JournalEntry.journal-2.JournalEntryPage.page-2");
  assert.ok(res.body.pages[0].contentHash);
});

test("returns 404 for an unknown journal entry", async () => {
  const { server, port } = startApp();
  const res = await request(port(), "GET", "/api/mcp/journal/does-not-exist", { headers: auth() });
  server.close();
  assert.equal(res.status, 404);
});

test("lists journal folders, excluding folders of other document types", async () => {
  const { server, port } = startApp();
  const res = await request(port(), "GET", "/api/mcp/journal/folders", { headers: auth() });
  server.close();
  assert.equal(res.status, 200);
  assert.deepEqual(res.body.folders.map((f) => f.id), ["folder-locations"]);
});

test("system-info reports fixture data even when the live Foundry calls fail", async () => {
  const { server, port } = startApp();
  const res = await request(port(), "GET", "/api/mcp/system-info", { headers: auth() });
  server.close();
  assert.equal(res.status, 200);
  assert.equal(res.body.modules.length, 1);
  assert.equal(res.body.modules[0].name, "Test Module");
  // The two axios calls to foundryUrl are unreachable in this test and fail
  // soft (per the existing .catch(() => ({ data: null })) fallback).
  assert.equal(res.body.foundryVersion, null);
  assert.equal(res.body.system.version, null);
});

// ── The damageType confirmation-binding bug, at the HTTP boundary ───────

test("apply_hp_change rejects a token when damageType is dropped between preview and apply", async () => {
  const { server, port } = startApp({ deps: { writeEnabled: true } });
  const clientId = "client-hp-test-1234";

  const ready = await request(port(), "POST", "/mcp-bridge/ready", { headers: { cookie: "session=abc" }, body: { clientId } });
  assert.equal(ready.status, 200);
  const bridgeToken = ready.body.bridgeToken;

  // Park a poll, then answer whatever bridge request arrives with a canned
  // preview result, before the preview request below even lands.
  const pollPromise = request(port(), "GET", `/mcp-bridge/poll?clientId=${clientId}`, {
    headers: { "x-mcp-bridge-token": bridgeToken },
  });

  const previewPromise = request(port(), "POST", "/api/mcp/actors/actor-1/hp-change/preview", {
    headers: auth(),
    body: { mode: "damage", amount: 10, damageType: "fire" },
  });

  const polled = await pollPromise;
  assert.equal(polled.status, 200);
  await request(port(), "POST", "/mcp-bridge/respond", {
    headers: { "x-mcp-bridge-token": bridgeToken },
    body: { clientId, requestId: polled.body.requestId, result: { before: { value: 20 }, after: { value: 10 } } },
  });

  const preview = await previewPromise;
  assert.equal(preview.status, 200);
  const token = preview.body.confirmation.confirmationToken;

  // Apply with the same token but no damageType — this is the regression:
  // the confirmation was bound to damageType "fire" and must reject an apply
  // that silently omits it, rather than applying untyped damage.
  const apply = await request(port(), "POST", "/api/mcp/actors/actor-1/hp-change", {
    headers: auth(),
    body: { mode: "damage", amount: 10, confirmationToken: token },
  });
  server.close();
  assert.equal(apply.status, 409);
  assert.match(apply.body.error, /does not match/);
});

// ── Timeout ──────────────────────────────────────────────────────────

test("a bridge request with no responding client times out with 504", async () => {
  const { server, port } = startApp({ deps: { writeEnabled: false } });
  const clientId = "client-timeout-1234";

  const ready = await request(port(), "POST", "/mcp-bridge/ready", { headers: { cookie: "session=abc" }, body: { clientId } });
  assert.equal(ready.status, 200);

  // Park a poll but never respond to whatever gets dispatched to it — the
  // request should time out on its own after preparedActorTimeoutMs.
  request(port(), "GET", `/mcp-bridge/poll?clientId=${clientId}`, {
    headers: { "x-mcp-bridge-token": ready.body.bridgeToken },
  }).catch(() => {});

  const res = await request(port(), "GET", "/api/mcp/actors/actor-1/prepared", { headers: auth() });
  server.close();
  assert.equal(res.status, 504);
  assert.match(res.body.error, /timed out/);
});

// ── GM journal visibility block ─────────────────────────────────────────

test("GM journal search names exactly which non-GM users can see each entry and page", async () => {
  const { server, port } = startApp({ world: fixtureWorldWithOwnership() });
  const res = await request(port(), "GET", "/api/mcp/journal?query=Ravencroft", { headers: auth() });
  server.close();
  const ravencroft = res.body.results.find((r) => r.entryId === "journal-1");
  assert.deepEqual(ravencroft.visibility.visibleTo.map((u) => u.name).sort(), ["Alice", "Bob"]);
  assert.equal(ravencroft.visibility.gmOnly, false);
  assert.equal(ravencroft.pageHits[0].visibility.gmOnly, false);
});

test("GM journal search reports gmOnly for an entry no player can see", async () => {
  const { server, port } = startApp({ world: fixtureWorldWithOwnership() });
  const res = await request(port(), "GET", "/api/mcp/journal?query=Mortala", { headers: auth() });
  server.close();
  assert.equal(res.body.results[0].visibility.gmOnly, true);
  assert.deepEqual(res.body.results[0].visibility.visibleTo, []);
});

// ── Player-scoped routes ─────────────────────────────────────────────────

function playerAuth(extra = {}) {
  return { "x-api-key": "test-player-key", ...extra };
}

test("PLAYER_API_KEY reaches player routes but is rejected everywhere else", async () => {
  const { server, port } = startApp({ world: fixtureWorldWithOwnership(), deps: { playerApiKey: "test-player-key" } });
  const players = await request(port(), "GET", "/api/mcp/players", { headers: playerAuth() });
  const actors = await request(port(), "GET", "/api/mcp/actors", { headers: playerAuth() });
  const del = await request(port(), "POST", "/api/mcp/actors/actor-1/delete", { headers: playerAuth() });
  server.close();
  assert.equal(players.status, 200);
  assert.equal(actors.status, 401);
  assert.equal(del.status, 401);
});

test("the GM apiKey also reaches player routes, so the GM's own agent can preview a player's view", async () => {
  const { server, port } = startApp({ world: fixtureWorldWithOwnership() });
  const res = await request(port(), "GET", "/api/mcp/players", { headers: auth() });
  server.close();
  assert.equal(res.status, 200);
});

test("an unconfigured PLAYER_API_KEY never matches — player routes stay GM-key-only", async () => {
  const { server, port } = startApp({ world: fixtureWorldWithOwnership() }); // no playerApiKey in deps
  const res = await request(port(), "GET", "/api/mcp/players", { headers: playerAuth() });
  server.close();
  assert.equal(res.status, 401);
});

test("lists non-GM players with the character names they own", async () => {
  const { server, port } = startApp({ world: fixtureWorldWithOwnership() });
  const res = await request(port(), "GET", "/api/mcp/players", { headers: auth() });
  server.close();
  assert.equal(res.body.schemaVersion, 1);
  const alice = res.body.players.find((p) => p.userId === "user-alice");
  assert.deepEqual(alice.characterNames, ["Hero"]);
  const bob = res.body.players.find((p) => p.userId === "user-bob");
  assert.deepEqual(bob.characterNames, []);
  assert.equal(res.body.players.some((p) => p.userId === "user-1" || p.name === "GM"), false);
});

test("an unresolvable player reference is a loud 400, distinct from an empty result", async () => {
  const { server, port } = startApp({ world: fixtureWorldWithOwnership() });
  const res = await request(port(), "GET", "/api/mcp/players/does-not-exist/journal", { headers: auth() });
  server.close();
  assert.equal(res.status, 400);
  assert.match(res.body.error, /Unknown player/);
});

test("player search resolves a player by name, not only by id", async () => {
  const { server, port } = startApp({ world: fixtureWorldWithOwnership() });
  const res = await request(port(), "GET", "/api/mcp/players/Alice/journal", { headers: auth() });
  server.close();
  assert.equal(res.status, 200);
  assert.equal(res.body.asPlayer.userId, "user-alice");
});

test("player journal search is indistinguishable between a real GM-only subject and gibberish", async () => {
  const { server, port } = startApp({ world: fixtureWorldWithOwnership() });
  const hidden = await request(port(), "GET", "/api/mcp/players/user-alice/journal?query=Mortala%27s%20True%20Name", { headers: auth() });
  const nothing = await request(port(), "GET", "/api/mcp/players/user-alice/journal?query=zzqqxxNoSuchThing", { headers: auth() });
  server.close();
  assert.equal(hidden.status, nothing.status);
  // asPlayer is identical between the two calls (same player, same shape);
  // strip nothing — the bodies must be byte-for-byte the same JSON.
  assert.deepEqual(hidden.body, nothing.body);
  assert.equal(hidden.body.total, 0);
});

test("player journal search cross-product matches an independently computed expectation", async () => {
  const { server, port } = startApp({ world: fixtureWorldWithOwnership() });
  const alice = await request(port(), "GET", "/api/mcp/players/user-alice/journal", { headers: auth() });
  const bob = await request(port(), "GET", "/api/mcp/players/user-bob/journal", { headers: auth() });
  server.close();
  // Hand-computed from fixtureWorldWithOwnership(): journal-1 is visible to
  // both; journal-2 has no ownership field at all (deny by default);
  // journal-secret is GM-only; journal-mixed is entry-visible to Alice only
  // but its sole page is hidden, so it must not appear for her either;
  // journal-empty is entry-visible to Alice with zero pages, so it survives.
  assert.deepEqual(alice.body.results.map((r) => r.entryId).sort(), ["journal-1", "journal-empty"]);
  assert.deepEqual(bob.body.results.map((r) => r.entryId).sort(), ["journal-1"]);
});

test("player journal results omit folder, knowledge, and visibility — GM-only fields", async () => {
  const { server, port } = startApp({ world: fixtureWorldWithOwnership() });
  const res = await request(port(), "GET", "/api/mcp/players/user-alice/journal", { headers: auth() });
  server.close();
  for (const result of res.body.results) {
    assert.equal("folder" in result, false);
    assert.equal("knowledge" in result, false);
    assert.equal("visibility" in result, false);
  }
});

test("player entry detail 404s identically for a nonexistent id, a forbidden entry, and a readable entry with every page hidden", async () => {
  const { server, port } = startApp({ world: fixtureWorldWithOwnership() });
  const missing = await request(port(), "GET", "/api/mcp/players/user-alice/journal/does-not-exist", { headers: auth() });
  const forbidden = await request(port(), "GET", "/api/mcp/players/user-alice/journal/journal-secret", { headers: auth() });
  const emptied = await request(port(), "GET", "/api/mcp/players/user-alice/journal/journal-mixed", { headers: auth() });
  server.close();
  assert.deepEqual(missing.body, { error: "Not found" });
  assert.deepEqual(forbidden.body, missing.body);
  assert.deepEqual(emptied.body, missing.body);
  assert.equal(missing.status, 404);
  assert.equal(forbidden.status, 404);
  assert.equal(emptied.status, 404);
});

test("player entry detail returns only readable pages for a mixed-visibility entry, and an empty page list for a genuinely empty one", async () => {
  const { server, port } = startApp({ world: fixtureWorldWithOwnership() });
  const ravencroft = await request(port(), "GET", "/api/mcp/players/user-alice/journal/journal-1", { headers: auth() });
  const blank = await request(port(), "GET", "/api/mcp/players/user-alice/journal/journal-empty", { headers: auth() });
  server.close();
  assert.equal(ravencroft.status, 200);
  assert.equal(ravencroft.body.pages.length, 1);
  assert.equal(blank.status, 200);
  assert.deepEqual(blank.body.pages, []);
});

test("index feed enumerates only pages visible to at least one non-GM user, with the visible user id set", async () => {
  const { server, port } = startApp({ world: fixtureWorldWithOwnership() });
  const res = await request(port(), "GET", "/api/mcp/players/index-feed", { headers: auth() });
  server.close();
  assert.equal(res.body.schemaVersion, 1);
  const pageIds = res.body.items.map((i) => i.pageUuid);
  assert.equal(pageIds.some((id) => id.includes("page-secret")), false); // GM-only, excluded
  assert.equal(pageIds.some((id) => id.includes("page-mixed-secret")), false); // GM-only page, excluded
  const overview = res.body.items.find((i) => i.pageUuid.includes("page-1"));
  assert.deepEqual(overview.visibleTo.sort(), ["user-alice", "user-bob"]);
  assert.ok(overview.contentHash);
});
