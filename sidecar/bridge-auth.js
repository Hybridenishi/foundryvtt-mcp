const { timingSafeEqual } = require("node:crypto");

function bridgeTokenMatches(provided, expected) {
  if (typeof provided !== "string" || typeof expected !== "string") return false;
  const providedBytes = Buffer.from(provided);
  const expectedBytes = Buffer.from(expected);
  return providedBytes.length === expectedBytes.length && timingSafeEqual(providedBytes, expectedBytes);
}

module.exports = { bridgeTokenMatches };
