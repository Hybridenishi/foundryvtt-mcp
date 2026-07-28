// The Express app, independent of the real Foundry Socket.IO connection.
// index.js wires real dependencies (the live socket, auth) and calls
// listen(); tests call createApp() directly with fakes, so every route below
// is exercised without a live Foundry host.
const express = require("express");
const axios = require("axios");
const { randomUUID } = require("node:crypto");
const { bridgeTokenMatches } = require("./bridge-auth");
const {
  collectionValues,
  getActorActivity,
  listActorActivities,
  listActorItems,
  summarizeActor,
  validateActor,
  withoutItems,
} = require("./actor-utils");
const {
  searchJournal,
  buildFoldersById,
  entryDetail,
  journalFolderTree,
} = require("./journal-search");
const {
  parseHpChange,
  issueHpChangeConfirmation,
  consumeHpChangeConfirmation,
  parseTemporaryHp,
  issueTemporaryHpConfirmation,
  consumeTemporaryHpConfirmation,
  parseConditionChange,
  issueConditionChangeConfirmation,
  consumeConditionChangeConfirmation,
  issueActivityUseConfirmation,
  consumeActivityUseConfirmation,
  parseSpellSlotAdjustment,
  issueSpellSlotAdjustmentConfirmation,
  consumeSpellSlotAdjustmentConfirmation,
} = require("./confirmations");

const PREPARED_ACTOR_TIMEOUT = 8_000;
const BRIDGE_POLL_TIMEOUT = 25_000;
const BRIDGE_CLIENT_TTL = 45_000;

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

// deps: { apiKey, writeEnabled, foundryUrl, isConnected(), getWorld(),
//         emitModifyDocument(payload), validateBridgeGmSession(req),
//         getMcpUserId() }
function createApp(deps) {
  const { apiKey, writeEnabled, foundryUrl, isConnected, getWorld, emitModifyDocument, validateBridgeGmSession, getMcpUserId } = deps;
  // Overridable only so tests can exercise the timeout path in milliseconds
  // instead of real seconds; production always gets the real default.
  const preparedActorTimeoutMs = deps.preparedActorTimeoutMs ?? PREPARED_ACTOR_TIMEOUT;

  // Bridge-client bookkeeping is local to this app instance, not shared
  // module state — each createApp() call (each server process, or each test)
  // gets its own independent bridge protocol state.
  const pendingPreparedActorRequests = new Map();
  const preparedActorClients = new Map();
  const queuedPreparedActorRequests = [];

  function activePreparedActorClients() {
    const cutoff = Date.now() - BRIDGE_CLIENT_TTL;
    for (const [clientId, client] of preparedActorClients) {
      if (client.lastSeen < cutoff) {
        if (client.poll) clearTimeout(client.poll.timeout);
        preparedActorClients.delete(clientId);
      }
    }
    return [...preparedActorClients.values()];
  }

  function clearBridgePoll(client) {
    if (!client?.poll) return;
    clearTimeout(client.poll.timeout);
    client.poll = null;
  }

  function dispatchPreparedActorRequests() {
    const client = activePreparedActorClients().find((candidate) => candidate.poll);
    if (!client || queuedPreparedActorRequests.length === 0) return;

    const request = queuedPreparedActorRequests.shift();
    const poll = client.poll;
    clearBridgePoll(client);
    // Preserve the requested bridge operation and its validated payload. Sending
    // only the actor ID makes the client default every request to a summary.
    poll.res.json(request);
  }

  function requestBridgeOperation(operation) {
    if (!isConnected()) return Promise.reject(new Error("Not connected"));
    if (activePreparedActorClients().length === 0) {
      return Promise.reject(new Error("No active GM prepared-data bridge. Reload Foundry as a GM and keep that browser tab open."));
    }

    return new Promise((resolve, reject) => {
      const requestId = randomUUID();
      const timeout = setTimeout(() => {
        pendingPreparedActorRequests.delete(requestId);
        reject(new Error("Prepared actor request timed out. Open Foundry as a GM so the bridge module can respond."));
      }, preparedActorTimeoutMs);

      pendingPreparedActorRequests.set(requestId, { resolve, reject, timeout });
      queuedPreparedActorRequests.push({ requestId, ...operation });
      dispatchPreparedActorRequests();
    });
  }

  function requestPreparedActor(actorId) {
    return requestBridgeOperation({ type: "prepared-actor-summary", actorId });
  }

  const app = express();
  app.use(express.json());

  function bridgeClient(req) {
    const clientId = typeof req.body?.clientId === "string" ? req.body.clientId : req.query?.clientId;
    if (typeof clientId !== "string" || clientId.length < 8 || clientId.length > 200) return null;
    return clientId;
  }

  function bridgeTokenAuthorized(req, client) {
    return Boolean(client) && bridgeTokenMatches(req.headers["x-mcp-bridge-token"], client.bridgeToken);
  }

  function requireWriteEnabled(_req, res, next) {
    if (!writeEnabled) return res.status(403).json({ error: "Write operations are disabled. Set FOUNDRY_WRITE_ENABLED=true to enable them." });
    next();
  }

  // Same-origin HTTPS bridge for an active GM's Foundry browser client. The
  // regular sidecar API middleware below intentionally does not apply here.
  app.post("/mcp-bridge/ready", async (req, res) => {
    const clientId = bridgeClient(req);
    if (!clientId) return res.status(400).json({ error: "A clientId is required" });
    try {
      const { userId } = await validateBridgeGmSession(req);
      const current = preparedActorClients.get(clientId) ?? { clientId, poll: null };
      clearBridgePoll(current);
      current.userId = userId;
      current.bridgeToken = randomUUID();
      current.lastSeen = Date.now();
      preparedActorClients.set(clientId, current);
      res.set("Cache-Control", "no-store");
      res.json({ ok: true, clientId, bridgeToken: current.bridgeToken, expiresInSeconds: BRIDGE_CLIENT_TTL / 1_000 });
    } catch (error) {
      res.status(401).json({ error: error.message });
    }
  });

  app.get("/mcp-bridge/poll", (req, res) => {
    const clientId = bridgeClient(req);
    const client = clientId && preparedActorClients.get(clientId);
    if (!bridgeTokenAuthorized(req, client)) return res.status(401).json({ error: "Unauthorized" });
    if (!client) return res.status(404).json({ error: "Unknown bridge client; announce readiness first" });

    const current = client;
    current.lastSeen = Date.now();
    clearBridgePoll(current);
    res.set("Cache-Control", "no-store");
    current.poll = {
      res,
      timeout: setTimeout(() => {
        if (current.poll?.res === res) {
          current.poll = null;
          res.status(204).end();
        }
      }, BRIDGE_POLL_TIMEOUT),
    };
    res.on("close", () => {
      if (current.poll?.res === res) clearBridgePoll(current);
    });
    dispatchPreparedActorRequests();
  });

  app.post("/mcp-bridge/respond", (req, res) => {
    const clientId = bridgeClient(req);
    const client = clientId && preparedActorClients.get(clientId);
    if (!bridgeTokenAuthorized(req, client)) return res.status(401).json({ error: "Unauthorized" });
    if (!client) return res.status(404).json({ error: "Unknown bridge client" });
    client.lastSeen = Date.now();

    const requestId = req.body?.requestId;
    const pending = typeof requestId === "string" && pendingPreparedActorRequests.get(requestId);
    if (!pending) return res.status(404).json({ error: "Unknown or expired prepared actor request" });

    clearTimeout(pending.timeout);
    pendingPreparedActorRequests.delete(requestId);
    if (req.body?.error) pending.reject(new Error(req.body.error));
    else if (req.body?.summary) pending.resolve(req.body.summary);
    else if (Object.hasOwn(req.body ?? {}, "result")) pending.resolve(req.body.result);
    else return res.status(400).json({ error: "A result or error is required" });
    res.json({ ok: true, requestId });
  });

  app.use((req, res, next) => {
    if (req.headers["x-api-key"] !== apiKey) return res.status(401).json({ error: "Unauthorized" });
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
        axios.get(`${foundryUrl}/systems/dnd5e/system.json`, { timeout: 30_000 }).catch(() => ({ data: null })),
        axios.get(`${foundryUrl}/join`, { timeout: 30_000 }).catch(() => ({ data: null })),
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
        preparedActorBridge: { responders: activePreparedActorClients().map(({ clientId, userId, lastSeen }) => ({ clientId, userId, lastSeen })) },
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

  app.get("/api/mcp/actors/:id/prepared", async (req, res) => {
    try {
      const summary = await requestPreparedActor(req.params.id);
      res.json(summary);
    } catch(e) {
      res.status(e.message.includes("timed out") ? 504 : 500).json({ error: e.message });
    }
  });

  app.get("/api/mcp/party/prepared", async (_req, res) => {
    try {
      res.json(await requestBridgeOperation({ type: "prepared-party-summary" }));
    } catch (e) {
      res.status(e.message.includes("timed out") ? 504 : 500).json({ error: e.message });
    }
  });

  // Guarded HP changes run inside the active GM client through dnd5e's
  // Actor.applyDamage. Preview is read-only; apply requires the one-time token
  // returned by the matching preview.
  app.post("/api/mcp/actors/:id/hp-change/preview", async (req, res) => {
    try {
      const change = parseHpChange(req.body);
      const preview = await requestBridgeOperation({ type: "preview-hp-change", actorId: req.params.id, ...change });
      res.json({
        ...preview,
        confirmation: issueHpChangeConfirmation(req.params.id, change),
      });
    } catch (e) {
      res.status(e.message.includes("mode") || e.message.includes("amount") || e.message.includes("damageType") ? 400 : 500).json({ error: e.message });
    }
  });

  app.post("/api/mcp/actors/:id/hp-change", requireWriteEnabled, async (req, res) => {
    try {
      const change = parseHpChange(req.body);
      consumeHpChangeConfirmation(req.body?.confirmationToken, req.params.id, change);
      const result = await requestBridgeOperation({ type: "apply-hp-change", actorId: req.params.id, ...change });
      res.json({ ok: true, ...result });
    } catch (e) {
      const status = e.message.includes("confirmation") || e.message.includes("token") ? 409
        : e.message.includes("mode") || e.message.includes("amount") || e.message.includes("damageType") ? 400 : 500;
      res.status(status).json({ error: e.message });
    }
  });

  // Temporary HP is deliberately an explicit replacement, rather than an
  // inferred grant: callers preview the exact resulting value before the GM
  // client updates the prepared dnd5e Actor document.
  app.post("/api/mcp/actors/:id/temporary-hp/preview", async (req, res) => {
    try {
      const change = parseTemporaryHp(req.body);
      const preview = await requestBridgeOperation({ type: "preview-temporary-hp", actorId: req.params.id, ...change });
      res.json({ ...preview, confirmation: issueTemporaryHpConfirmation(req.params.id, change) });
    } catch (e) {
      res.status(e.message.includes("amount") ? 400 : 500).json({ error: e.message });
    }
  });

  app.post("/api/mcp/actors/:id/temporary-hp", requireWriteEnabled, async (req, res) => {
    try {
      const change = parseTemporaryHp(req.body);
      consumeTemporaryHpConfirmation(req.body?.confirmationToken, req.params.id, change);
      const result = await requestBridgeOperation({ type: "set-temporary-hp", actorId: req.params.id, ...change });
      res.json({ ok: true, ...result });
    } catch (e) {
      const status = e.message.includes("confirmation") || e.message.includes("token") ? 409
        : e.message.includes("amount") ? 400 : 500;
      res.status(status).json({ error: e.message });
    }
  });

  app.post("/api/mcp/actors/:id/conditions/preview", async (req, res) => {
    try {
      const change = parseConditionChange(req.body);
      const preview = await requestBridgeOperation({ type: "preview-condition-change", actorId: req.params.id, ...change });
      res.json({ ...preview, confirmation: issueConditionChangeConfirmation(req.params.id, change) });
    } catch (e) {
      res.status(e.message.includes("mode") || e.message.includes("statusId") || e.message.includes("Exhaustion") ? 400 : 500).json({ error: e.message });
    }
  });

  app.post("/api/mcp/actors/:id/conditions", requireWriteEnabled, async (req, res) => {
    try {
      const change = parseConditionChange(req.body);
      consumeConditionChangeConfirmation(req.body?.confirmationToken, req.params.id, change);
      const result = await requestBridgeOperation({ type: "apply-condition-change", actorId: req.params.id, ...change });
      res.json({ ok: true, ...result });
    } catch (e) {
      const status = e.message.includes("confirmation") || e.message.includes("token") ? 409
        : e.message.includes("mode") || e.message.includes("statusId") || e.message.includes("Exhaustion") ? 400 : 500;
      res.status(status).json({ error: e.message });
    }
  });

  // Guarded activity use is intentionally limited to unambiguous dnd5e utility
  // activities. The active GM client invokes Activity#use so dnd5e, not this
  // bridge, owns validation, resource consumption, effects, and chat output.
  app.post("/api/mcp/actors/:id/items/:itemId/activities/:activityId/use/preview", async (req, res) => {
    try {
      const preview = await requestBridgeOperation({
        type: "preview-utility-activity-use",
        actorId: req.params.id,
        itemId: req.params.itemId,
        activityId: req.params.activityId,
      });
      res.json({ ...preview, confirmation: issueActivityUseConfirmation(req.params.id, req.params.itemId, req.params.activityId) });
    } catch (e) {
      res.status(e.message.includes("only supports") || e.message.includes("cannot") || e.message.includes("does not") ? 400 : 500).json({ error: e.message });
    }
  });

  app.post("/api/mcp/actors/:id/items/:itemId/activities/:activityId/use", requireWriteEnabled, async (req, res) => {
    try {
      consumeActivityUseConfirmation(req.body?.confirmationToken, req.params.id, req.params.itemId, req.params.activityId);
      const result = await requestBridgeOperation({
        type: "use-utility-activity",
        actorId: req.params.id,
        itemId: req.params.itemId,
        activityId: req.params.activityId,
      });
      res.json({ ok: true, ...result });
    } catch (e) {
      const status = e.message.includes("confirmation") || e.message.includes("token") ? 409
        : e.message.includes("only supports") || e.message.includes("cannot") || e.message.includes("does not") ? 400 : 500;
      res.status(status).json({ error: e.message });
    }
  });

  // Guarded spell-slot adjustment: exact values only, canonical binding,
  // stale-state check at apply time through the GM bridge.
  app.post("/api/mcp/actors/:id/spell-slots/preview", async (req, res) => {
    try {
      const parsed = parseSpellSlotAdjustment(req.body);
      const preview = await requestBridgeOperation({
        type: "preview-spell-slot-adjustment",
        actorId: req.params.id,
        adjustments: parsed.adjustments,
      });
      const selectedSlots = preview.selectedSlots;
      delete preview.selectedSlots; // internal bridge field — not public
      res.json({
        ...preview,
        confirmation: issueSpellSlotAdjustmentConfirmation(req.params.id, parsed.adjustments, selectedSlots),
      });
    } catch (e) {
      res.status(e.message.includes("adjustments") || e.message.includes("slot") || e.message.includes("value") ? 400 : 500).json({ error: e.message });
    }
  });

  app.post("/api/mcp/actors/:id/spell-slots", requireWriteEnabled, async (req, res) => {
    try {
      const parsed = parseSpellSlotAdjustment(req.body);
      const payload = consumeSpellSlotAdjustmentConfirmation(req.body?.confirmationToken, req.params.id, parsed.adjustments);
      const result = await requestBridgeOperation({
        type: "apply-spell-slot-adjustment",
        actorId: req.params.id,
        adjustments: parsed.adjustments,
        expectedSelectedStateKey: payload.selectedStateKey,
      });
      res.json({ ok: true, ...result });
    } catch (e) {
      const status = e.message.includes("confirmation") || e.message.includes("token") || e.message.includes("state changed") ? 409
        : e.message.includes("adjustments") || e.message.includes("slot") || e.message.includes("value") ? 400 : 500;
      res.status(status).json({ error: e.message });
    }
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

  app.get("/api/mcp/actors/:id/items/:itemId/activities/:activityId", async (req, res) => {
    try {
      const w = await getWorld();
      const actor = w.actors?.find((candidate) => candidate._id === req.params.id);
      if (!actor) return res.status(404).json({ error: "Actor not found" });
      const activity = getActorActivity(actor, req.params.itemId, req.params.activityId);
      if (!activity) return res.status(404).json({ error: "Activity not found on this actor and item" });
      res.json(activity);
    } catch (e) { res.status(500).json({ error: e.message }); }
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
  app.post("/api/mcp/chat", requireWriteEnabled, async (req, res) => {
    if(!req.body?.content) return res.status(400).json({error:"Requires content"});
    try {
      const msgType = parseInt(req.body.type) || 1;
      const result = await emitModifyDocument({
        type:"ChatMessage",action:"create",
        operation:{data:[{content:req.body.content,type:msgType,author:getMcpUserId()}]}
      });
      res.json({ok:true,result});
    }
    catch(e) { res.status(500).json({ error: e.message }); }
  });

  // Journal — GM-scoped. Returns full search results including any
  // GM-only material; there is no permission filtering at this route.
  // Player-scoped equivalents (which do filter) are a later stage.
  app.get("/api/mcp/journal", async (req, res) => {
    try {
      const w = await getWorld();
      const foldersById = buildFoldersById(w.folders);
      const { total, returned, results } = searchJournal(collectionValues(w.journal), foldersById, req.query);
      res.json({ scope: "gm", total, returned, results });
    }
    catch(e) { res.status(500).json({ error: e.message }); }
  });
  // Registered before /journal/:id — otherwise Express would match this
  // path's "folders" segment as the :id param.
  app.get("/api/mcp/journal/folders", async (_req, res) => {
    try {
      const w = await getWorld();
      res.json({ folders: journalFolderTree(w.folders) });
    } catch(e) { res.status(500).json({ error: e.message }); }
  });
  app.get("/api/mcp/journal/:id", async (req, res) => {
    try {
      const w = await getWorld();
      const entry = collectionValues(w.journal).find(j => j._id === req.params.id);
      if (!entry) return res.status(404).json({ error: "Not found" });
      const foldersById = buildFoldersById(w.folders);
      res.json(entryDetail(entry, foldersById));
    } catch(e) { res.status(500).json({ error: e.message }); }
  });

  // Users
  app.get("/api/mcp/users", async (_req, res) => {
    try { const w = await getWorld(); res.json((w.users||[]).map(u=>({_id:u._id,name:u.name,role:u.role,active:u.active}))); }
    catch(e) { res.status(500).json({ error: e.message }); }
  });

  // Write — actor update
  app.post("/api/mcp/actors/:id/update", requireWriteEnabled, async (req, res) => {
    if(!req.body?.system) return res.status(400).json({error:"Requires {system:{...}}"});
    try {
      const updates = { _id: req.params.id };
      for (const [k,v] of Object.entries(req.body.system)) updates[`system.${k}`] = v;
      const result = await emitModifyDocument({type:"Actor",action:"update",operation:{updates:[updates],diff:true,recursive:true}});
      res.json({ok:true,result});
    } catch(e) { res.status(500).json({ error: e.message }); }
  });

  // Write — actor create
  app.post("/api/mcp/actors/create", requireWriteEnabled, async (req, res) => {
    const { name, type, system } = req.body;
    if (!name) return res.status(400).json({ error: "Requires name" });
    try {
      const data = { name, type: type || "npc" };
      if (system) data.system = system;
      const result = await emitModifyDocument({
        type: "Actor",
        action: "create",
        operation: { data: [data] }
      });
      res.json({ ok: true, actorId: result?.[0]?._id || result?._id, result });
    } catch(e) { res.status(500).json({ error: e.message }); }
  });

  // Write — actor delete
  app.post("/api/mcp/actors/:id/delete", requireWriteEnabled, async (req, res) => {
    try {
      const result = await emitModifyDocument({
        type: "Actor",
        action: "delete",
        operation: { ids: [req.params.id] }
      });
      res.json({ ok: true, deletedId: req.params.id, result });
    } catch(e) { res.status(500).json({ error: e.message }); }
  });

  // Write — combat
  app.post("/api/mcp/combats/next-turn", requireWriteEnabled, async (req, res) => {
    try {
      const w = await getWorld();
      const c = req.body?.combatId ? w.combats?.find(x=>x._id===req.body.combatId) : w.combats?.find(x=>x.active);
      if(!c) return res.status(404).json({error:"No combat found"});
      const combatants = c.combatants||[];
      if(!combatants.length) return res.status(400).json({error:"No combatants"});
      const turn = ((c.turn??-1)+1) % combatants.length;
      const updates = {_id:c._id,turn};
      if(turn===0) updates.round = (c.round||0)+1;
      const result = await emitModifyDocument({type:"Combat",action:"update",operation:{updates:[updates]}});
      res.json({ok:true,round:updates.round||c.round,turn,result});
    } catch(e) { res.status(500).json({ error: e.message }); }
  });

  return app;
}

module.exports = { createApp };
