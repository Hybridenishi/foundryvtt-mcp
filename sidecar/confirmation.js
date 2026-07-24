function pruneExpired(confirmations, now = Date.now()) {
  for (const [token, confirmation] of confirmations) {
    if (confirmation.expiresAt <= now) confirmations.delete(token);
  }
}

function issueConfirmation(confirmations, token, binding, ttlMs, now = Date.now()) {
  pruneExpired(confirmations, now);
  confirmations.set(token, { ...binding, expiresAt: now + ttlMs });
  return { confirmationToken: token, expiresAt: new Date(now + ttlMs).toISOString() };
}

function consumeConfirmation(confirmations, token, binding, errorLabel, now = Date.now()) {
  const confirmation = typeof token === "string" ? confirmations.get(token) : null;
  if (!confirmation || confirmation.expiresAt <= now) {
    if (typeof token === "string") confirmations.delete(token);
    throw new Error(`A valid, unexpired ${errorLabel} confirmation token is required. Preview the operation again.`);
  }

  if (Object.entries(binding).some(([key, value]) => confirmation[key] !== value)) {
    throw new Error(`The confirmation token does not match this ${errorLabel} operation.`);
  }

  confirmations.delete(token);
}

module.exports = { consumeConfirmation, issueConfirmation, pruneExpired };
