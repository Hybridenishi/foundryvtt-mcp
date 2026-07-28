const { io: socketIO } = require("socket.io-client");
const axios = require("axios");
const { createApp } = require("./app");

const FOUNDRY_URL = process.env.FOUNDRY_URL || "http://foundry:30000";
const USERNAME = process.env.FOUNDRY_USERNAME || "mcp-api";
const PASSWORD = process.env.FOUNDRY_PASSWORD;
const API_KEY = process.env.API_KEY;
// Optional, second, narrower credential scoped to the player-facing routes
// (see sidecar/app.js's playerRouter). Unlike API_KEY, its absence is not
// fatal — the player routes simply stay reachable by API_KEY only until
// this is configured.
const PLAYER_API_KEY = process.env.PLAYER_API_KEY || null;
const PORT = parseInt(process.env.PORT || "30001", 10);
const TIMEOUT = 30_000;
const BRIDGE_SESSION_TIMEOUT = 8_000;
const GM_ROLE = 4;
const WRITE_ENABLED = process.env.FOUNDRY_WRITE_ENABLED === "true";

if (!API_KEY) throw new Error("API_KEY must be set for the sidecar API.");
if (!PASSWORD) throw new Error("FOUNDRY_PASSWORD must be set for the sidecar account.");

let socket = null;
let connected = false;
let mcpUserId = null;

// Bounded reconnect: on any post-startup disconnect, redo the full 4-step
// handshake from scratch (a fresh session cookie may be required if the old
// one expired during the outage) with capped exponential backoff, forever —
// giving up permanently would just reintroduce the manual-restart problem
// this exists to fix. "Bounded" means the delay is capped and only one
// retry loop ever runs at a time, not that it stops retrying.
const RECONNECT_BASE_MS = 1_000;
const RECONNECT_MAX_MS = 30_000;
let reconnectTimer = null;
let reconnectAttempt = 0;

function scheduleReconnect() {
  if (reconnectTimer) return;
  const delay = Math.min(RECONNECT_MAX_MS, RECONNECT_BASE_MS * 2 ** reconnectAttempt);
  reconnectTimer = setTimeout(async () => {
    reconnectTimer = null;
    reconnectAttempt += 1;
    try {
      await connect();
      reconnectAttempt = 0;
      console.log("Reconnected to Foundry.");
    } catch (err) {
      console.error(`Reconnect attempt failed: ${err.message}`);
      scheduleReconnect();
    }
  }, delay);
}

function isConnected() {
  return connected && Boolean(socket?.connected);
}

// ── 4-Step Auth (proven against Foundry v14) ──────────────────────
async function getSessionCookie() {
  const res = await axios.get(`${FOUNDRY_URL}/join`, {
    maxRedirects: 0, timeout: TIMEOUT,
    validateStatus: (s) => s >= 200 && s < 400,
  });
  const cookies = Array.isArray(res.headers["set-cookie"]) ? res.headers["set-cookie"] : [res.headers["set-cookie"]];
  const sc = cookies.find((c) => c.startsWith("session="));
  if (!sc) throw new Error("No session cookie");
  return sc.match(/^session=([^;]+)/)[1];
}

async function resolveUserId(session) {
  return new Promise((resolve, reject) => {
    const s = socketIO(FOUNDRY_URL, {
      transports: ["websocket"],
      extraHeaders: { Cookie: `session=${session}` },
      reconnection: false, timeout: TIMEOUT,
    });
    const t = setTimeout(() => { s.disconnect(); reject(new Error("resolveUserId timeout")); }, TIMEOUT);
    s.once("connect_error", (e) => { clearTimeout(t); s.disconnect(); reject(e); });
    s.once("session", () => {
      s.emit("getJoinData", (data) => {
        clearTimeout(t); s.disconnect();
        const u = data?.users?.find((u) => u.name === USERNAME);
        if (!u?._id) return reject(new Error(`User ${USERNAME} not found in world. Available: ${(data?.users||[]).map(u=>u.name).join(", ")}`));
        resolve(u._id);
      });
    });
  });
}

async function authenticate(session, userId) {
  const res = await axios.post(`${FOUNDRY_URL}/join`, {
    action: "join", userid: userId, password: PASSWORD,
  }, {
    headers: { Cookie: `session=${session}`, "Content-Type": "application/json" },
    timeout: TIMEOUT,
  });
  if (res.data?.status !== "success") {
    throw new Error(`Auth failed: ${res.data?.error || res.data?.message || JSON.stringify(res.data)}`);
  }
}

async function connect() {
  // A prior socket from an earlier attempt or a since-dropped connection
  // must not keep running (and must not fire its own "disconnect" handler,
  // which would schedule a second, redundant reconnect loop).
  if (socket) {
    socket.removeAllListeners();
    socket.disconnect();
  }

  const session = await getSessionCookie();
  const userId = await resolveUserId(session);
  await authenticate(session, userId);
  console.log(`Authenticated as ${USERNAME} (${userId})`);
  mcpUserId = userId;

  // Manual reconnection only: driving the full 4-step handshake ourselves
  // on every reconnect (rather than letting Socket.IO's own reconnection
  // resume the old transport) is what lets a session that expired during
  // the outage be replaced with a fresh one.
  socket = socketIO(FOUNDRY_URL, {
    transports: ["websocket"],
    extraHeaders: { Cookie: `session=${session}` },
    timeout: TIMEOUT,
    reconnection: false,
  });

  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error("World load timeout")), TIMEOUT);
    socket.once("connect_error", (e) => { clearTimeout(t); reject(e); });
    socket.once("session", () => {
      socket.emit("world", (data) => {
        clearTimeout(t);
        connected = true;
        console.log(`Connected — ${data.actors?.length||0} actors, ${data.scenes?.length||0} scenes`);
        resolve();
      });
    });
    socket.on("disconnect", (reason) => {
      connected = false;
      console.error(`Foundry socket disconnected: ${reason}`);
      scheduleReconnect();
    });
  });
}

function getWorld() {
  if (!isConnected()) throw new Error("Not connected");
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error("world timeout")), TIMEOUT);
    socket.emit("world", (data) => { clearTimeout(t); resolve(data); });
  });
}

function emitModifyDocument(payload) {
  return new Promise((resolve, reject) => {
    if (!socket) return reject(new Error("Not connected"));
    socket.emit("modifyDocument", payload, resolve);
  });
}

function sessionFromCookie(cookieHeader) {
  if (typeof cookieHeader !== "string") return null;
  return cookieHeader.split(";").map((value) => value.trim())
    .find((value) => value.startsWith("session="))?.slice("session=".length) ?? null;
}

// The browser's same-origin request carries its Foundry session cookie. Verify
// that cookie with Foundry itself; never trust a client-supplied user ID.
function validateBridgeGmSession(req) {
  const session = sessionFromCookie(req.headers.cookie);
  if (!session) return Promise.reject(new Error("A Foundry session cookie is required to pair the GM bridge."));

  return new Promise((resolve, reject) => {
    const bridgeSocket = socketIO(FOUNDRY_URL, {
      transports: ["websocket"],
      extraHeaders: { Cookie: `session=${session}` },
      reconnection: false,
      timeout: BRIDGE_SESSION_TIMEOUT,
    });
    const finish = (error, identity) => {
      clearTimeout(timeout);
      bridgeSocket.disconnect();
      if (error) reject(error); else resolve(identity);
    };
    const timeout = setTimeout(() => finish(new Error("Foundry session validation timed out.")), BRIDGE_SESSION_TIMEOUT);
    bridgeSocket.once("connect_error", () => finish(new Error("Foundry session validation failed.")));
    bridgeSocket.once("session", (sessionData) => {
      const userId = sessionData?.userId;
      if (typeof userId !== "string" || !userId) return finish(new Error("Foundry session is not authenticated."));
      bridgeSocket.emit("getJoinData", (joinData) => {
        const user = joinData?.users?.find((candidate) => candidate?._id === userId);
        if (!user || Number(user.role) < GM_ROLE) return finish(new Error("Only an authenticated Foundry GM can pair the bridge."));
        finish(null, { userId });
      });
    });
  });
}

const app = createApp({
  apiKey: API_KEY,
  playerApiKey: PLAYER_API_KEY,
  writeEnabled: WRITE_ENABLED,
  foundryUrl: FOUNDRY_URL,
  isConnected,
  getWorld,
  emitModifyDocument,
  validateBridgeGmSession,
  getMcpUserId: () => mcpUserId,
});

connect()
  .then(() => app.listen(PORT, () => console.log(`Sidecar ready on :${PORT}`)))
  .catch((err) => { console.error("Startup failed:", err.message); process.exit(1); });
