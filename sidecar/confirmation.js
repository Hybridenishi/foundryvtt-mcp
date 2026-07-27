function pruneExpired(confirmations, now = Date.now()) {
  for (const [token, confirmation] of confirmations) {
    if (confirmation.expiresAt <= now) confirmations.delete(token);
  }
}

// A confirmation stores two distinct things: the binding, which identifies
// exactly which operation was previewed and must match byte-for-byte at apply
// time, and an optional payload, which is data the preview computed that the
// apply step needs but that is not itself part of the operation's identity
// (e.g. spell slots' expected prior state, used only for a stale-state check).
// Keeping them separate lets matching be symmetric: a key the apply-time
// caller omits is a mismatch, not a comparison that's silently skipped.
function issueConfirmation(confirmations, token, binding, ttlMs, options = {}) {
  const now = options.now ?? Date.now();
  pruneExpired(confirmations, now);
  confirmations.set(token, { binding: { ...binding }, payload: options.payload, expiresAt: now + ttlMs });
  return { confirmationToken: token, expiresAt: new Date(now + ttlMs).toISOString() };
}

function bindingMatches(stored, provided) {
  const storedKeys = Object.keys(stored);
  const providedKeys = Object.keys(provided);
  if (storedKeys.length !== providedKeys.length) return false;
  return storedKeys.every((key) => stored[key] === provided[key]);
}

function consumeConfirmation(confirmations, token, binding, errorLabel, options = {}) {
  const now = options.now ?? Date.now();
  const confirmation = typeof token === "string" ? confirmations.get(token) : null;
  if (!confirmation || confirmation.expiresAt <= now) {
    if (typeof token === "string") confirmations.delete(token);
    throw new Error(`A valid, unexpired ${errorLabel} confirmation token is required. Preview the operation again.`);
  }

  if (!bindingMatches(confirmation.binding, binding)) {
    throw new Error(`The confirmation token does not match this ${errorLabel} operation.`);
  }

  confirmations.delete(token);
  return confirmation.payload;
}

module.exports = { consumeConfirmation, issueConfirmation, pruneExpired };
