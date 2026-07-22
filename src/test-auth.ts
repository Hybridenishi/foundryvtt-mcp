import { authenticateFoundry } from "./auth.js";
import { logger } from "./logger.js";

const baseUrl = process.env.FOUNDRY_URL;
const username = process.env.FOUNDRY_USERNAME;
const password = process.env.FOUNDRY_PASSWORD;

if (!baseUrl || !username || !password) {
  logger.error("Set FOUNDRY_URL, FOUNDRY_USERNAME, and FOUNDRY_PASSWORD before running test:auth");
  process.exitCode = 1;
} else {
  try {
    const { userId } = await authenticateFoundry(baseUrl, username, password);
    logger.info("Foundry authentication test succeeded", { userId });
  } catch (error) {
    logger.error("Foundry authentication test failed", {
      error: error instanceof Error ? error.message : String(error),
    });
    process.exitCode = 1;
  }
}
