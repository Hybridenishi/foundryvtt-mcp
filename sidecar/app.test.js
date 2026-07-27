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
    journal: [],
    users: [{ _id: "user-1", name: "GM", role: 4, active: true }],
    modules: [{ _id: "mod-1", name: "Test Module", version: "1.0.0", active: true }],
  };
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
