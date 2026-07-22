import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { FoundryClient } from "./client.js";
import { logger } from "./logger.js";

function requiredEnvironment(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`Missing required environment variable: ${name}`);
  return value;
}

async function main(): Promise<void> {
  const client = new FoundryClient({
    baseUrl: requiredEnvironment("FOUNDRY_URL"),
    username: requiredEnvironment("FOUNDRY_USERNAME"),
    password: requiredEnvironment("FOUNDRY_PASSWORD"),
  });
  const writeEnabled = process.env.FOUNDRY_WRITE_ENABLED === "true";
  await client.connect();

  const server = new McpServer({
    name: "foundryvtt-mcp",
    version: "1.0.0",
  });
  server.registerTool(
    "ping",
    { description: "Confirm that the Foundry VTT MCP server is available." },
    async () => ({ content: [{ type: "text", text: "pong" }] }),
  );

  const transport = new StdioServerTransport();
  await server.connect(transport);
  logger.info("Foundry VTT MCP server ready", { writeEnabled });
}

main().catch((error: unknown) => {
  logger.error("Failed to start Foundry VTT MCP server", {
    error: error instanceof Error ? error.message : String(error),
  });
  process.exitCode = 1;
});
