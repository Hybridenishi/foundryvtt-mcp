const express = require("express");
const { io: socketIO } = require("socket.io-client");
const axios = require("axios");
const {
  collectionValues,
  listActorActivities,
  listActorItems,
  summarizeActor,
  validateActor,
  withoutItems,
} = require("./actor-utils");

const FOUNDRY_URL = process.env.FOUNDRY_URL || "http://foundry:30000";
const USERNAME = process.env.FOUNDRY_USERNAME || "mcp-api";
const PASSWORD = process.env.FOUNDRY_PASSWORD || "password-for-hermes";
const API_KEY = process.env.API_KEY || "mcp-bridge-key-2026";
const PORT = parseInt(process.env.PORT || "30001", 10);
const TIMEOUT = 30_000;

let socket = null;
let connected = false;
let worldData = null;
let mcpUserId = null;

function isConnected() {
  return connected && Boolean(socket?.connected);
}

function foundryVersionFromHtml(html) {
  const match = typeof html === "string" && html.match(/Version\s+(\d+(?:\.\d+)?(?:\s+Build\s+\d+)?)/i);
  return match?.[1] ?? null;
}

function contentRulesFromWorld(world) {
  const rules = new Set();
  for (const actor of world?.actors ?? []) {
    for (const item of collectionValues(actor.items)) {
      const sourceRules = item?.system?.source?.rules;
      if (typeof sourceRules === "string" && sourceRules.length > 0) rules.add(sourceRules);
    }
  }
  return [...rules].sort();
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
  const session = await getSessionCookie();
  const userId = await resolveUserId(session);
  await authenticate(session, userId);
  console.log(`Authenticated as ${USERNAME} (${userId})`);
  mcpUserId = userId;

  socket = socketIO(FOUNDRY_URL, {
    transports: ["websocket"],
    extraHeaders: { Cookie: `session=${session}` },
    timeout: TIMEOUT,
  });

  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error("World load timeout")), TIMEOUT);
    socket.once("connect_error", (e) => { clearTimeout(t); reject(e); });
    socket.once("session", () => {
      socket.emit("world", (data) => {
        clearTimeout(t);
        worldData = data;
        connected = true;
        console.log(`Connected — ${data.actors?.length||0} actors, ${data.scenes?.length||0} scenes`);
        resolve();
      });
    });
    socket.on("disconnect", (reason) => {
      connected = false;
      console.error(`Foundry socket disconnected: ${reason}`);
    });
  });
}

function getWorld() {
  if (!isConnected()) throw new Error("Not connected");
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error("world timeout")), TIMEOUT);
    socket.emit("world", (data) => { clearTimeout(t); worldData = data; resolve(data); });
  });
}

// ── Express ────────────────────────────────────────────────────────
const app = express();
app.use(express.json());

app.use((req, res, next) => {
  if (req.headers["x-api-key"] !== API_KEY) return res.status(401).json({ error: "Unauthorized" });
  if (!isConnected()) return res.status(503).json({ error: "Not connected" });
  next();
});

function refreshResponse(_req, res) {
  res.json({ ok: true, connected: isConnected(), timestamp: Date.now() });
}

app.get("/api/mcp/refresh", refreshResponse);
app.post("/api/mcp/refresh", refreshResponse);
app.get("/api/mcp/world-summary", async (_req, res) => {
  try { const w = await getWorld(); res.json({ actors: w.actors?.length||0, scenes: w.scenes?.length||0, items: w.items?.length||0, users: w.users?.length||0 }); }
  catch(e) { res.status(500).json({ error: e.message }); }
});
app.get("/api/mcp/system-info", async (_req, res) => {
  try {
    const [w, systemManifest, joinPage] = await Promise.all([
      getWorld(),
      axios.get(`${FOUNDRY_URL}/systems/dnd5e/system.json`, { timeout: TIMEOUT }).catch(() => ({ data: null })),
      axios.get(`${FOUNDRY_URL}/join`, { timeout: TIMEOUT }).catch(() => ({ data: null })),
    ]);
    res.json({
      foundryVersion: foundryVersionFromHtml(joinPage.data),
      system: {
        id: systemManifest.data?.id ?? "dnd5e",
        title: systemManifest.data?.title ?? null,
        version: systemManifest.data?.version ?? null,
      },
      contentRules: contentRulesFromWorld(w),
      modules: w.modules?.map(m => ({
        id: m._id || m.id,
        name: m.name ?? m.title ?? null,
        version: m.version ?? null,
        active: m.active,
      })) || [],
    });
  }
  catch(e) { res.status(500).json({ error: e.message }); }
});

// Actors
app.get("/api/mcp/actors", async (req, res) => {
  try { const w = await getWorld(); let a = w.actors||[]; const q = req.query.query?.toLowerCase(); if(q) a=a.filter(x=>(x.name||"").toLowerCase().includes(q)); if(req.query.type) a=a.filter(x=>x.type===req.query.type); res.json(a.slice(0,Math.min(+req.query.limit||20,100)).map(x=>({_id:x._id,name:x.name,type:x.type,img:x.img}))); }
  catch(e) { res.status(500).json({ error: e.message }); }
});
app.get("/api/mcp/actors/:id", async (req, res) => {
  try {
    const w = await getWorld();
    const a = w.actors?.find(x => x._id === req.params.id);
    if (!a) return res.status(404).json({ error: "Not found" });
    res.json(req.query.includeItems === "true" ? a : withoutItems(a));
  }
  catch(e) { res.status(500).json({ error: e.message }); }
});

app.get("/api/mcp/actors/:id/5e-summary", async (req, res) => {
  try {
    const w = await getWorld();
    const actor = w.actors?.find(x => x._id === req.params.id);
    if (!actor) return res.status(404).json({ error: "Not found" });
    res.json(summarizeActor(actor));
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.get("/api/mcp/actors/:id/items", async (req, res) => {
  try {
    const w = await getWorld();
    const actor = w.actors?.find(x => x._id === req.params.id);
    if (!actor) return res.status(404).json({ error: "Not found" });
    res.json(listActorItems(actor, req.query));
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.get("/api/mcp/actors/:id/activities", async (req, res) => {
  try {
    const w = await getWorld();
    const actor = w.actors?.find(x => x._id === req.params.id);
    if (!actor) return res.status(404).json({ error: "Not found" });
    res.json(listActorActivities(actor, req.query));
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.get("/api/mcp/actors/:id/5e-validation", async (req, res) => {
  try {
    const w = await getWorld();
    const actor = w.actors?.find(x => x._id === req.params.id);
    if (!actor) return res.status(404).json({ error: "Not found" });
    res.json(validateActor(actor));
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// Items
app.get("/api/mcp/items", async (req, res) => {
  try { const w = await getWorld(); let items = w.items||[]; const q = req.query.query?.toLowerCase(); if(q) items=items.filter(x=>(x.name||"").toLowerCase().includes(q)); if(req.query.type) items=items.filter(x=>x.type===req.query.type); res.json(items.slice(0,Math.min(+req.query.limit||20,100)).map(x=>({_id:x._id,name:x.name,type:x.type}))); }
  catch(e) { res.status(500).json({ error: e.message }); }
});
app.get("/api/mcp/items/:id", async (req, res) => {
  try {
    const w = await getWorld();
    const item = w.items?.find(x => x._id === req.params.id);
    if (!item) return res.status(404).json({ error: "Not found" });
    res.json(item);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// Scenes
app.get("/api/mcp/scenes", async (_req, res) => {
  try { const w = await getWorld(); res.json((w.scenes||[]).map(s=>({_id:s._id,name:s.name,active:s.active,tokenCount:(s.tokens||[]).length}))); }
  catch(e) { res.status(500).json({ error: e.message }); }
});
app.get("/api/mcp/scenes/:id/tokens", async (req, res) => {
  try {
    const w = await getWorld();
    const scene = w.scenes?.find(s => s._id === req.params.id);
    if (!scene) return res.status(404).json({ error: "Not found" });
    res.json(collectionValues(scene.tokens).map(t => ({
      _id: t._id,
      name: t.name,
      actorId: t.actorId ?? t.actor?.id ?? null,
      x: t.x,
      y: t.y,
      hidden: t.hidden,
      disposition: t.disposition,
      elevation: t.elevation,
      vision: t.vision,
    })));
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// Combat
app.get("/api/mcp/combats/active", async (_req, res) => {
  try { const w = await getWorld(); const c = w.combats?.find(x=>x.active); if(!c) return res.json({active:false}); res.json({_id:c._id,round:c.round,turn:c.turn,active:true,combatants:(c.combatants||[]).map(x=>({_id:x._id,name:x.name,initiative:x.initiative,defeated:x.defeated}))}); }
  catch(e) { res.status(500).json({ error: e.message }); }
});

// Chat
app.get("/api/mcp/chat-log", async (req, res) => {
  try { const w = await getWorld(); let msgs = w.messages||[]; if(req.query.speaker){const s=req.query.speaker.toLowerCase();msgs=msgs.filter(m=>(m.speaker?.alias||m.user?.name||"").toLowerCase().includes(s));} res.json(msgs.slice(-Math.min(+req.query.limit||20,100)).reverse().map(m=>({_id:m._id,content:m.content,speaker:m.speaker?.alias||m.user?.name||"?",timestamp:m.timestamp}))); }
  catch(e) { res.status(500).json({ error: e.message }); }
});
app.post("/api/mcp/chat", async (req, res) => {
  if(!req.body?.content) return res.status(400).json({error:"Requires content"});
  try {
    const msgType = parseInt(req.body.type) || 1;
    socket.emit("modifyDocument",{
      type:"ChatMessage",action:"create",
      operation:{data:[{content:req.body.content,type:msgType,author:mcpUserId}]}
    },(r)=>{res.json({ok:true,result:r})});
  }
  catch(e) { res.status(500).json({ error: e.message }); }
});

// Journal
app.get("/api/mcp/journal", async (req, res) => {
  try { const w = await getWorld(); let e=w.journal||[]; if(req.query.query){const q=req.query.query.toLowerCase();e=e.filter(j=>(j.name||"").toLowerCase().includes(q)||(j.pages||[]).some(p=>(p.text?.content||"").toLowerCase().includes(q)));} res.json(e.slice(0,Math.min(+req.query.limit||20,100)).map(j=>({_id:j._id,name:j.name}))); }
  catch(e) { res.status(500).json({ error: e.message }); }
});
app.get("/api/mcp/journal/:id", async (req, res) => {
  try {
    const w = await getWorld();
    const entry = w.journal?.find(j => j._id === req.params.id);
    if (!entry) return res.status(404).json({ error: "Not found" });
    res.json({
      _id: entry._id,
      name: entry.name,
      pages: collectionValues(entry.pages).map(page => ({
        _id: page._id,
        name: page.name,
        type: page.type,
        content: page.text?.content ?? "",
      })),
    });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// Users
app.get("/api/mcp/users", async (_req, res) => {
  try { const w = await getWorld(); res.json((w.users||[]).map(u=>({_id:u._id,name:u.name,role:u.role,active:u.active}))); }
  catch(e) { res.status(500).json({ error: e.message }); }
});

// Write — actor update
app.post("/api/mcp/actors/:id/update", async (req, res) => {
  if(!req.body?.system) return res.status(400).json({error:"Requires {system:{...}}"});
  try {
    const updates = { _id: req.params.id };
    for (const [k,v] of Object.entries(req.body.system)) updates[`system.${k}`] = v;
    socket.emit("modifyDocument",{type:"Actor",action:"update",operation:{updates:[updates],diff:true,recursive:true}},(r)=>{res.json({ok:true,result:r})});
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// Write — actor create
app.post("/api/mcp/actors/create", async (req, res) => {
  const { name, type, system } = req.body;
  if (!name) return res.status(400).json({ error: "Requires name" });
  try {
    const data = { name, type: type || "npc" };
    if (system) data.system = system;
    socket.emit("modifyDocument", {
      type: "Actor",
      action: "create",
      operation: { data: [data] }
    }, (r) => { res.json({ ok: true, actorId: r?.[0]?._id || r?._id, result: r }); });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// Write — actor delete
app.post("/api/mcp/actors/:id/delete", async (req, res) => {
  try {
    socket.emit("modifyDocument", {
      type: "Actor",
      action: "delete",
      operation: { ids: [req.params.id] }
    }, (r) => { res.json({ ok: true, deletedId: req.params.id, result: r }); });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// Write — combat
app.post("/api/mcp/combats/next-turn", async (req, res) => {
  try {
    const w = await getWorld();
    const c = req.body?.combatId ? w.combats?.find(x=>x._id===req.body.combatId) : w.combats?.find(x=>x.active);
    if(!c) return res.status(404).json({error:"No combat found"});
    const combatants = c.combatants||[];
    if(!combatants.length) return res.status(400).json({error:"No combatants"});
    const turn = ((c.turn??-1)+1) % combatants.length;
    const updates = {_id:c._id,turn};
    if(turn===0) updates.round = (c.round||0)+1;
    socket.emit("modifyDocument",{type:"Combat",action:"update",operation:{updates:[updates]}},(r)=>{res.json({ok:true,round:updates.round||c.round,turn,result:r})});
  } catch(e) { res.status(500).json({ error: e.message }); }
});

connect()
  .then(() => app.listen(PORT, () => console.log(`Sidecar ready on :${PORT}`)))
  .catch((err) => { console.error("Startup failed:", err.message); process.exit(1); });
