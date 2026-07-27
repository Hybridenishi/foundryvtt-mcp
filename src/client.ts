import axios, { type AxiosInstance } from "axios";
import { logger } from "./logger.js";

const CONNECT_TIMEOUT_MS = 30_000;

export interface FoundryClientOptions {
  baseUrl: string;
  apiKey: string;
}

export class FoundryClient {
  private http: AxiosInstance;

  constructor(options: FoundryClientOptions) {
    this.http = axios.create({
      baseURL: options.baseUrl,
      timeout: CONNECT_TIMEOUT_MS,
      headers: {
        "X-API-Key": options.apiKey,
        "Content-Type": "application/json",
      },
    });
  }

  // Verifies the sidecar is reachable and connected to Foundry. Every tool
  // talks to the sidecar directly per-call via httpClient below, so this is
  // a startup health check, not a world-data cache.
  async connect(): Promise<void> {
    const response = await this.http.get("/api/mcp/refresh");
    if (response.data?.ok !== true) {
      throw new Error("Foundry sidecar is not responding. Is it connected to Foundry?");
    }
    logger.info("Connected to Foundry MCP Bridge");
  }

  // ── Direct HTTP access for tools ────────────────────────────────

  get httpClient(): AxiosInstance {
    return this.http;
  }
}
