import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { FoundryClient } from "./client.js";
import { logger } from "./logger.js";
import { registerDiceTool } from "./tools/dice.js";
import { registerReadTools } from "./tools/read.js";
import { registerWriteTools } from "./tools/write.js";

function requiredEnvironment(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`Missing required environment variable: ${name}`);
  return value;
}

async function main(): Promise<void> {
  const client = new FoundryClient({
    baseUrl: requiredEnvironment("FOUNDRY_URL"),
    apiKey: process.env.FOUNDRY_API_KEY ?? "mcp-bridge-key-2026",
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
  registerReadTools(server, client);
  registerDiceTool(server);
  registerWriteTools(server, client, writeEnabled);

  const transport = new StdioServerTransport();
  await server.connect(transport);
  logger.info("Foundry VTT MCP server ready (HTTP bridge mode)", { writeEnabled });
}

main().catch((error: unknown) => {
  logger.error("Failed to start Foundry VTT MCP server", {
    error: error instanceof Error ? error.message : String(error),
  });
  process.exitCode = 1;
});
