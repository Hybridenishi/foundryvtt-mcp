import axios, { type AxiosInstance } from "axios";
import { logger } from "./logger.js";
import { type WorldData } from "./types.js";

const CONNECT_TIMEOUT_MS = 30_000;

export interface FoundryClientOptions {
  baseUrl: string;
  apiKey: string;
}

export class FoundryClient {
  private http: AxiosInstance;
  private worldData?: WorldData;

  constructor(private readonly options: FoundryClientOptions) {
    this.http = axios.create({
      baseURL: options.baseUrl,
      timeout: CONNECT_TIMEOUT_MS,
      headers: {
        "X-API-Key": options.apiKey,
        "Content-Type": "application/json",
      },
    });
  }

  async connect(): Promise<void> {
    // Verify the module is running
    const response = await this.http.get("/api/mcp/refresh");
    if (response.data?.ok !== true) {
      throw new Error("MCP Bridge module not responding. Is it activated in Foundry?");
    }

    // Load world data via individual endpoints
    const [systemInfo, actors, scenes, items, combatsActive] = await Promise.all([
      this.http.get("/api/mcp/system-info"),
      this.http.get("/api/mcp/actors"),
      this.http.get("/api/mcp/scenes"),
      this.http.get("/api/mcp/items"),
      this.http.get("/api/mcp/combats/active").catch(() => ({ data: { active: false, combatants: [] } })),
    ]);

    this.worldData = {
      actors: actors.data,
      scenes: scenes.data,
      items: items.data,
      combats: combatsActive.data?.active ? [combatsActive.data] : [],
      journal: [],       // loaded on demand
      messages: [],       // loaded on demand
      users: [],          // loaded on demand
      folders: [],
      activeUsers: systemInfo.data?.activeUserCount ? [] : [],
      systemInfo: systemInfo.data,
    };

    logger.info("Connected to Foundry MCP Bridge", {
      version: systemInfo.data?.version,
      actors: this.worldData.actors.length,
      scenes: this.worldData.scenes.length,
    });
  }

  async disconnect(): Promise<void> {
    this.worldData = undefined;
  }

  getWorldData(): WorldData {
    if (!this.worldData) throw new Error("Not connected to Foundry");
    return this.worldData;
  }

  async refreshWorldData(): Promise<WorldData> {
    await this.connect();
    return this.getWorldData();
  }

  // ── Direct HTTP access for tools ────────────────────────────────

  get httpClient(): AxiosInstance {
    return this.http;
  }

  get apiKey(): string {
    return this.options.apiKey;
  }
}
