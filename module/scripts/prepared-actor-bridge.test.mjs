import assert from "node:assert/strict";
import test from "node:test";
import { MODULE_SOCKET, PREPARED_ACTOR_READY, summarizePreparedActor } from "./prepared-actor-bridge.mjs";

test("bridge uses a namespaced socket event and readiness signal", () => {
  assert.equal(MODULE_SOCKET, "module.foundry-mcp-bridge");
  assert.equal(PREPARED_ACTOR_READY, "prepared-actor-bridge-ready");
});

test("summarizePreparedActor preserves client-prepared combat values", () => {
  const summary = summarizePreparedActor({
    id: "actor-1",
    name: "Prepared Hero",
    type: "character",
    system: {
      details: { level: 15 },
      attributes: { hp: { value: 78, max: 108 }, ac: { value: 15, calc: "default" } },
      abilities: { wis: { value: 16, mod: 3, save: 8, proficient: 1 } },
      spells: { spell1: { value: 3, max: 4 }, spell8: { value: 1, max: 1 }, pact: { value: 0, max: 0 } },
    },
  });

  assert.equal(summary.dataProvenance.prepared, true);
  assert.equal(summary.details.level, 15);
  assert.deepEqual(summary.hp, { value: 78, max: 108, temp: null, tempmax: null });
  assert.equal(summary.ac.value, 15);
  assert.equal(summary.abilities.wis.mod, 3);
  assert.deepEqual(summary.spellSlots.spell1, { value: 3, max: 4, override: null });
  assert.deepEqual(summary.spellSlots.spell8, { value: 1, max: 1, override: null });
  assert.equal(summary.spellSlots.pact, undefined);
});
