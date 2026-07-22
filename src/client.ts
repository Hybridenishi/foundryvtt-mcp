import { io, type Socket } from "socket.io-client";
import { authenticateFoundry } from "./auth.js";
import { logger } from "./logger.js";
import { worldDataSchema, type WorldData } from "./types.js";

const CONNECT_TIMEOUT_MS = 60_000;

export interface FoundryClientOptions {
  baseUrl: string;
  username: string;
  password: string;
}

export class FoundryClient {
  private socket?: Socket;
  private worldData?: WorldData;

  constructor(private readonly options: FoundryClientOptions) {}

  async connect(): Promise<void> {
    await this.disconnect();
    const { session } = await authenticateFoundry(
      this.options.baseUrl,
      this.options.username,
      this.options.password,
    );

    this.socket = io(this.options.baseUrl, {
      transports: ["websocket"],
      extraHeaders: { Cookie: `session=${session}` },
      reconnection: false,
      timeout: CONNECT_TIMEOUT_MS,
    });

    try {
      await this.loadWorldData(this.socket, true);
      const world = this.getWorldData();
      logger.info("Loaded Foundry world data", {
        actors: world.actors.length,
        scenes: world.scenes.length,
        items: world.items.length,
      });
    } catch (error) {
      await this.disconnect();
      throw error;
    }
  }

  async disconnect(): Promise<void> {
    this.socket?.disconnect();
    this.socket = undefined;
    this.worldData = undefined;
  }

  getWorldData(): WorldData {
    if (!this.worldData) throw new Error("Foundry world data is not loaded");
    return this.worldData;
  }

  async refreshWorldData(): Promise<WorldData> {
    if (!this.socket?.connected) throw new Error("Foundry is not connected");
    await this.loadWorldData(this.socket, false);
    return this.getWorldData();
  }

  private async loadWorldData(socket: Socket, waitForSession: boolean): Promise<void> {
    const worldData = await new Promise<unknown>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("Timed out loading Foundry world data")), CONNECT_TIMEOUT_MS);
      const fail = (error: Error) => {
        clearTimeout(timer);
        reject(error);
      };

      const requestWorld = () => {
        socket.emit("world", (data: unknown) => {
          clearTimeout(timer);
          resolve(data);
        });
      };

      socket.once("connect_error", fail);
      if (waitForSession) socket.once("session", requestWorld);
      else requestWorld();
    });

    this.worldData = worldDataSchema.parse(worldData);
  }
}
