# Spell Slot Management Specification

## Summary

Add a narrowly scoped D&D 5e spell-slot mutation surface for character actors.
It adjusts the **current** count of one or more existing spell-slot pools, including
Pact Magic, through an active GM's prepared Foundry client. It does not create slot
pools, change slot maxima or overrides, cast spells, select activities, alter item
uses, or implement rest rules.

The operation follows the project's standard write contract:

1. `preview_spell_slot_adjustment` validates an exact requested final value for each
   selected pool and returns the prepared before/after state plus a short-lived,
   single-use confirmation.
2. `apply_spell_slot_adjustment` requires that confirmation and
   `FOUNDRY_WRITE_ENABLED=true`.
3. The sidecar sends the confirmed operation to the active GM bridge. The bridge
   re-reads the prepared actor, rejects any state changed since preview, updates all
   selected values atomically through the Actor document API, and reads the actor
   back for the receipt.

This is Tier A only. It relies on Foundry and the installed `dnd5e` Actor document;
it does not call module APIs or modify module internals. A normal Actor document
update permits `dnd5e`, Foundry, and installed modules to observe the change through
their normal hooks. The feature is intentionally restricted to exact current-value
adjustments because the system's spell/activity workflow remains the owner of spell
casting and consumption rules.

## API design

### MCP tools

| Tool | Read/write | Input | Result |
|---|---|---|---|
| `preview_spell_slot_adjustment` | Read-only | `actorId`, non-empty `adjustments` | Prepared before/after slot data and `confirmation` |
| `apply_spell_slot_adjustment` | Write-gated | identical `actorId`, identical `adjustments`, `confirmationToken` | `ok: true` and a read-back receipt |

`adjustments` is an array so a caller can explicitly name every pool affected by
one atomic operation:

```ts
type SlotId = "pact" | `spell${1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9}`;

type SpellSlotAdjustment = {
  slot: SlotId;
  value: number; // exact desired current count; integer from 0 through that pool's prepared max
};
```

The input order has no meaning. Reordering equivalent adjustments must not invalidate
a confirmation. A slot may occur only once. The API intentionally uses exact final
values, not deltas: the preview clearly shows the intended state and a stale-state
check prevents an old preview from overwriting a player, activity, rest, or module
change made in the meantime.

The tool schemas use `z.string().min(1)` for `actorId`, a strict `slot` enum, and
`z.number().int().min(0).max(100_000)` for `value`, followed by semantic bridge
validation against the pool's prepared maximum. The documented hard limit is only a
transport safety bound; the pool maximum is authoritative.

### Sidecar routes

| Route | Body | Notes |
|---|---|---|
| `POST /api/mcp/actors/:id/spell-slots/preview` | `{ adjustments }` | No mutation; issues confirmation after bridge preview succeeds. |
| `POST /api/mcp/actors/:id/spell-slots` | `{ adjustments, confirmationToken }` | Requires sidecar write gate; consumes confirmation; passes its preview-state fingerprint to bridge. |

Use a dedicated `spellSlotAdjustments` confirmation `Map` and a
`SPELL_SLOT_ADJUSTMENT_CONFIRMATION_TTL` of two minutes, matching the other guarded
writes. The confirmation is not transferable to any other operation or actor.

### Preview example

Request:

```json
{
  "actorId": "A9fR3Kq2wX",
  "adjustments": [
    { "slot": "pact", "value": 1 },
    { "slot": "spell1", "value": 3 }
  ]
}
```

Response:

```json
{
  "actorId": "A9fR3Kq2wX",
  "actorName": "Nim",
  "operation": "adjust-spell-slots",
  "adjustments": [
    { "slot": "pact", "before": { "value": 2, "max": 2, "override": null }, "after": { "value": 1, "max": 2, "override": null } },
    { "slot": "spell1", "before": { "value": 4, "max": 4, "override": null }, "after": { "value": 3, "max": 4, "override": null } }
  ],
  "confirmation": {
    "confirmationToken": "a7e6cf8e-37bc-4ed6-a0ec-6633bcbd4a1d",
    "expiresAt": "2026-07-27T18:02:00.000Z"
  }
}
```

The confirmation shape is always exactly:

```json
{ "confirmation": { "confirmationToken": "<uuid>", "expiresAt": "<ISO-8601 timestamp>" } }
```

### Apply example

Request:

```json
{
  "actorId": "A9fR3Kq2wX",
  "adjustments": [
    { "slot": "spell1", "value": 3 },
    { "slot": "pact", "value": 1 }
  ],
  "confirmationToken": "a7e6cf8e-37bc-4ed6-a0ec-6633bcbd4a1d"
}
```

The reversed array order is accepted because it has the same canonical binding.
Success returns `ok: true`, the same operation and adjustment identifiers, and the
actual `before` and read-back `after` values. It must not claim success using the
previewed values alone.

## Validation and edge cases

Validation runs at both the sidecar boundary (shape and confirmation binding) and
the GM bridge (authoritative prepared actor state). Bridge validation is repeated on
apply; preview validation is never authority to write.

| Case | Required behavior |
|---|---|
| Actor ID missing, malformed, or not found by GM | Reject; never issue/consume a usable receipt. |
| No active authenticated GM bridge, timed-out bridge request, or disconnected sidecar | Return explicit bridge/transport error; do not issue a confirmation. |
| Actor is not a `character` | Reject. This release does not manage NPC, vehicle, group, or arbitrary actor slot data. |
| `adjustments` absent, not an array, or empty | Reject; no no-op confirmation. |
| Adjustment is not an object, contains unknown fields, has invalid `slot`, or non-integer/non-finite `value` | Reject. Do not coerce strings, floats, `NaN`, `Infinity`, or booleans. |
| Slot key is `spell0`, `spell10`, arbitrary path text, or a noncanonical spelling | Reject from the fixed allow-list. |
| Duplicate slot in one request | Reject, even if its values agree; there must be one unambiguous final value per pool. |
| Input order differs between preview and apply | Accept when the canonical adjustments are identical. |
| Preview/apply target differs by actor, slot, desired value, operation, or canonical adjustment set | Reject confirmation mismatch with 409; token remains consumable only for the exact operation unless it is expired. |
| Token missing, unknown, expired, or previously consumed | Reject with 409 and require a new preview. Expired tokens are pruned. |
| Write feature disabled | Reject before confirmation consumption and before bridge dispatch. |
| Requested pool is absent, not an object, or is not a usable prepared slot pool | Reject. Do not create `system.spells` keys. |
| `pact` pool | Support exactly as an ordinary selected pool; include it in prepared actor and party summaries. |
| Pool `value`, `max`, or `override` is missing, non-finite, non-integer, or internally inconsistent | Reject as unprepared/invalid state rather than guessing. |
| Requested value is below zero or above the pool's prepared `max` | Reject. Do not clamp a caller's requested value. |
| Prepared maximum is zero | Only `value: 0` is mathematically valid, but reject the request as a no-op/unusable pool; do not advertise a mutation for unavailable slots. |
| Requested value equals current value | Reject as a no-op. This keeps confirmations meaningful and avoids needless document updates/hooks. |
| A 2014/2024 mix, active effect, class change, rest, spell cast, player edit, or module hook changes any selected pool's `value`, `max`, or `override` after preview | Reject apply as stale (409) before writing; caller must preview again. |
| A nonselected slot changes after preview | Permit apply. The state fingerprint is scoped to selected pools, so unrelated game activity does not invalidate the request. |
| Actor is deleted or selected pool disappears between preview and apply | Reject stale/not-found; make no update. |
| One of several selected pools becomes stale | Reject the entire operation; no partial update. |
| Foundry update fails or post-update read-back disagrees with desired values | Return an error; do not return `ok: true`. Preserve the bridge error and, if a write may have occurred, include a diagnostic read-back where safe. |
| A module reacts to the Actor update | Allow normal hooks to run. Receipt reports the actual read-back values; it does not promise that unrelated module-managed state was unchanged. |
| Concurrent applies with different confirmations | The bridge checks state immediately before update. At most the first matching operation can proceed; the later one must fail stale validation after the first changes a selected pool. |

## Canonical binding and stale-state model

Canonicalization is a security and correctness requirement, not display formatting.
It ensures that semantically identical arrays bind to the same confirmation while
different requested values cannot be smuggled behind a reordered or differently
serialized object.

```js
function canonicalAdjustments(adjustments) {
  // Called only after strict structural validation and duplicate detection.
  return [...adjustments]
    .map(({ slot, value }) => ({ slot, value }))
    .sort((a, b) => a.slot.localeCompare(b.slot));
}

function adjustmentsKey(adjustments) {
  return JSON.stringify(canonicalAdjustments(adjustments));
}

function selectedStateKey(selectedSlots) {
  // selectedSlots is canonical and contains the bridge-read value/max/override.
  return JSON.stringify(selectedSlots.map(({ slot, value, max, override }) => ({
    slot, value, max, override,
  })));
}
```

Issue the confirmation with this complete binding:

```js
{
  actorId,
  operation: "adjust-spell-slots",
  adjustmentsKey: adjustmentsKey(adjustments),
  selectedStateKey: selectedStateKey(preview.selectedSlots)
}
```

The apply route recomputes `adjustmentsKey` from the request and passes the
`selectedStateKey` returned by `consumeConfirmation` to the bridge. Therefore the
bridge receives the expected prepared state from the stored preview, not from a
client-controlled body. Update `consumeConfirmation` to return the stored binding
after it checks and deletes the token. Existing callers may ignore the return value.

## Implementation layers

| Layer | Change | Responsibility |
|---|---|---|
| `module/scripts/prepared-actor-bridge.mjs` | Include valid `pact` in `summarizeSpellSlots`; add validate, preview, apply helpers and switch cases. | Authoritative prepared-state inspection, stale check, Actor update, read-back receipt. |
| `sidecar/index.js` | Add TTL/map, strict parser/canonicalizer, binding issuers/consumers, preview/apply routes, and status mapping. | HTTP boundary, write gate, token lifecycle, scoped binding, GM bridge dispatch. |
| `sidecar/confirmation.js` | Return a consumed stored binding from `consumeConfirmation`. | Lets sidecar send the trusted preview fingerprint to bridge. |
| `src/tools/write.ts` | Register preview/apply MCP tools with strict Zod schemas and tool descriptions. | Public MCP contract and disabled-write response. |
| `src/tools/read.ts` and descriptions | Update prepared-slot wording only if needed to state that Pact Magic is included. | Accurate public read contract. |
| Tests | Add unit and route/tool-registration coverage below. | Prevent regressions in safety boundary and contract. |
| `README.md`, `ROADMAP.md` | Document both tools and mark the spell-slot portion complete only after tests and live smoke pass. | Keep advertised surface truthful. |

No legacy raw write is reused or expanded. No `modifyDocument`, arbitrary dotted
path, unprepared Socket.IO snapshot, or client-provided before-state is accepted.

## Bridge pseudocode

```js
const SLOT_IDS = new Set(["pact", ...Array.from({ length: 9 }, (_, i) => `spell${i + 1}`)]);

function validateSlotAdjustments(actor, request) {
  if (actor.type !== "character") throw new Error("Spell slot adjustment supports character actors only.");
  const adjustments = request?.adjustments;
  if (!Array.isArray(adjustments) || adjustments.length === 0) throw new Error("adjustments must be a non-empty array.");

  const seen = new Set();
  const canonical = adjustments.map((adjustment) => {
    if (!adjustment || Object.keys(adjustment).some((key) => key !== "slot" && key !== "value")) throw new Error("Each adjustment must contain only slot and value.");
    const { slot, value } = adjustment;
    if (!SLOT_IDS.has(slot)) throw new Error("slot must be pact or spell1 through spell9.");
    if (!Number.isInteger(value) || value < 0 || value > 100_000) throw new Error("value must be an integer between 0 and 100000.");
    if (seen.has(slot)) throw new Error(`Duplicate slot '${slot}'.`);
    seen.add(slot);

    const pool = actor.system?.spells?.[slot];
    if (!pool || typeof pool !== "object") throw new Error(`Spell-slot pool '${slot}' is unavailable.`);
    const current = { slot, value: pool.value, max: pool.max, override: pool.override ?? null };
    if (![current.value, current.max].every(Number.isInteger) || current.value < 0 || current.max < 0 || current.value > current.max || (current.override !== null && !Number.isInteger(current.override))) {
      throw new Error(`Spell-slot pool '${slot}' is not valid prepared state.`);
    }
    if (current.max === 0) throw new Error(`Spell-slot pool '${slot}' has no available slots.`);
    if (value > current.max) throw new Error(`Requested ${slot} value exceeds its prepared maximum.`);
    if (value === current.value) throw new Error(`Requested ${slot} value is unchanged.`);
    return { requested: { slot, value }, current };
  });
  return canonical.sort((a, b) => a.requested.slot.localeCompare(b.requested.slot));
}

function previewSpellSlotAdjustment(actor, request) {
  const entries = validateSlotAdjustments(actor, request);
  const selectedSlots = entries.map(({ requested, current }) => current);
  return {
    actorId: actor.id, actorName: actor.name, operation: "adjust-spell-slots",
    adjustments: entries.map(({ requested, current }) => ({
      slot: requested.slot, before: current, after: { ...current, value: requested.value },
    })),
    selectedSlots, // internal bridge result; sidecar turns this into selectedStateKey
  };
}

async function applySpellSlotAdjustment(actor, request) {
  // Revalidate format and current permitted bounds at the point of write.
  const entries = validateSlotAdjustments(actor, request);
  const actualStateKey = selectedStateKey(entries.map(({ current }) => current));
  if (actualStateKey !== request.expectedSelectedStateKey) {
    throw new Error("Spell slot state changed since preview. Preview the operation again.");
  }

  const before = entries.map(({ requested, current }) => ({ slot: requested.slot, before: current }));
  const update = Object.fromEntries(entries.map(({ requested }) => [
    `system.spells.${requested.slot}.value`, requested.value,
  ]));
  if (typeof actor.update !== "function") throw new Error("The Foundry Actor.update method is unavailable.");
  await actor.update(update);

  // Re-read actual prepared actor data. Do not synthesize the receipt from request.
  const after = entries.map(({ requested }) => readPreparedSlot(actor, requested.slot));
  for (const slot of after) {
    const requested = entries.find(({ requested }) => requested.slot === slot.slot).requested;
    if (slot.value !== requested.value) throw new Error(`Read-back for '${slot.slot}' does not match the requested value.`);
  }
  return { actorId: actor.id, actorName: actor.name, operation: "adjust-spell-slots", before, after };
}

// handleBridgeRequest cases:
// "preview-spell-slot-adjustment" => previewSpellSlotAdjustment(actor, request)
// "apply-spell-slot-adjustment"   => applySpellSlotAdjustment(actor, request)
```

The sidecar removes the internal `selectedSlots` field from the public preview before
responding, derives `selectedStateKey`, and stores it in the confirmation binding.
The public result exposes only the human/audit-friendly before/after objects.

## Full test plan

### Bridge unit tests

- `summarizePreparedActor` and party summaries include valid `pact` alongside
  `spell1`–`spell9`, while excluding unrelated `system.spells` keys.
- Preview accepts a valid single ordinary pool, a valid Pact Magic pool, and a valid
  multi-pool operation; verifies sorted, deterministic output.
- Preview rejects every structural and semantic validation case in the table:
  non-character actor; missing/empty/non-array adjustments; unknown fields;
  malformed values; invalid pool names; duplicate pools; missing/non-object pool;
  invalid prepared fields; max zero; no-op; and out-of-range desired values.
- Preview does not mutate the Actor or call `update`.
- Apply sends one `actor.update` containing every selected dotted value path, never
  calls `modifyDocument`, and returns read-back state.
- Apply rejects a changed selected `value`, `max`, or `override` before `update`.
- Apply permits a change to a nonselected pool.
- Apply rejects actor/pool disappearance and every stale member of a multi-pool
  request without calling `update`.
- Apply propagates `update` failure and rejects mismatched post-update read-back.

### Sidecar and confirmation tests

- Parser accepts canonical valid input and rejects malformed JSON shapes, duplicate
  slots, invalid slot names, unknown adjustment fields, floats, strings, NaN,
  infinities, and empty arrays.
- Canonicalization yields identical `adjustmentsKey` for reordered input and
  different keys for any changed slot/value pair.
- Issued binding contains `actorId`, `operation`, canonical `adjustmentsKey`, and
  trusted `selectedStateKey`.
- Apply accepts reordered equivalent input; rejects a changed actor, operation,
  slot set, desired value, missing/invalid/expired/replayed token; and consumes a
  successful token exactly once.
- Disabled write gate returns before consuming a valid token or dispatching a bridge
  request.
- Preview route issues `{ confirmation: { confirmationToken, expiresAt } }` only
  after a successful bridge preview; bridge unavailable/timeout produces no token.
- Apply route passes the stored state fingerprint—not a request-body fingerprint—to
  the bridge; stale bridge error maps to 409. Validation errors map to 400.

### MCP contract tests

- Both tool names register with their intended read-only/destructive annotations,
  schemas, descriptions, and HTTP route mappings.
- Preview serializes the exact confirmation wrapper shape shown above.
- Apply returns the sidecar error body as an MCP error and reports disabled writes
  without making HTTP calls.

### Integration and live smoke

- With a test character containing ordinary and Pact Magic slots, preview an
  ordinary-only, pact-only, and combined adjustment; verify Foundry is unchanged
  after each preview.
- Apply a combined adjustment and verify the character sheet and prepared bridge
  receipt match; inspect that active module hooks do not produce errors.
- Cast/spend a selected slot after preview, then confirm apply fails stale and does
  not overwrite it. Change a nonselected slot and confirm apply still succeeds.
- Verify expiry, replay, disabled write gate, no active GM bridge, and a fresh
  browser bridge connection. Run `npm test`, `npm run build`, deploy, then
  `npm run smoke:foundry -- --require-bridge`.

## Post-implementation checklist

- [ ] Pact Magic appears in prepared actor and prepared party summaries.
- [ ] Preview and apply tools, routes, TTL/map, canonical binding, and bridge cases
  are implemented exactly as specified.
- [ ] Confirmation response uses `{confirmation: {confirmationToken, expiresAt}}`.
- [ ] Apply requires the sidecar write gate and never consumes a token when disabled.
- [ ] Canonical `adjustmentsKey` and trusted selected-state fingerprint are stored;
  bridge stale checks run immediately before the update.
- [ ] No arbitrary document paths, `modifyDocument`, module internals, or raw
  Socket.IO actor values are introduced.
- [ ] Multi-pool update is one Actor update and produces an actual read-back receipt.
- [ ] Unit, route, MCP registration, and live smoke tests pass.
- [ ] README and roadmap describe only the shipped capability; roadmap status is
  updated after deployment verification.
