import axios from "axios";
import { io, type Socket } from "socket.io-client";
import { logger } from "./logger.js";

const AUTH_TIMEOUT_MS = 30_000;

export interface FoundryAuthentication {
  session: string;
  userId: string;
}

interface JoinData {
  users?: Array<{ _id?: string; name?: string }>;
}

function joinUrl(baseUrl: string): string {
  return new URL("join", `${baseUrl.replace(/\/$/, "")}/`).toString();
}

function sessionFromSetCookie(setCookie: string[] | string | undefined): string {
  const cookies = Array.isArray(setCookie) ? setCookie : setCookie ? [setCookie] : [];
  const sessionCookie = cookies.find((cookie) => cookie.startsWith("session="));
  const match = sessionCookie?.match(/^session=([^;]+)/);

  if (!match) throw new Error("Foundry did not return a session cookie from GET /join");
  return match[1];
}

async function getSessionCookie(baseUrl: string): Promise<string> {
  const response = await axios.get(joinUrl(baseUrl), {
    maxRedirects: 0,
    timeout: AUTH_TIMEOUT_MS,
    validateStatus: (status) => status >= 200 && status < 400,
  });
  return sessionFromSetCookie(response.headers["set-cookie"]);
}

function createSocket(baseUrl: string, session: string): Socket {
  return io(baseUrl, {
    transports: ["websocket"],
    extraHeaders: { Cookie: `session=${session}` },
    reconnection: false,
    timeout: AUTH_TIMEOUT_MS,
  });
}

async function resolveUserId(baseUrl: string, session: string, username: string): Promise<string> {
  const socket = createSocket(baseUrl, session);

  try {
    return await new Promise<string>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("Timed out resolving Foundry user")), AUTH_TIMEOUT_MS);
      const fail = (error: Error) => {
        clearTimeout(timer);
        reject(error);
      };

      socket.once("connect_error", fail);
      socket.once("session", () => {
        socket.emit("getJoinData", (data: JoinData) => {
          clearTimeout(timer);
          const userId = data.users?.find((user) => user.name === username)?._id;
          if (!userId) {
            reject(new Error(`Foundry user '${username}' was not found in join data`));
            return;
          }
          resolve(userId);
        });
      });
    });
  } finally {
    socket.disconnect();
  }
}

async function joinWorld(baseUrl: string, session: string, userId: string, password: string): Promise<void> {
  const response = await axios.post(
    joinUrl(baseUrl),
    { action: "join", userid: userId, password },
    {
      headers: { Cookie: `session=${session}` },
      timeout: AUTH_TIMEOUT_MS,
    },
  );

  if (response.data?.status !== "success") {
    throw new Error(`Foundry join failed: ${response.data?.error ?? response.data?.message ?? "unknown error"}`);
  }
}

export async function authenticateFoundry(
  baseUrl: string,
  username: string,
  password: string,
): Promise<FoundryAuthentication> {
  logger.debug("Requesting Foundry session cookie");
  const session = await getSessionCookie(baseUrl);
  const userId = await resolveUserId(baseUrl, session, username);
  await joinWorld(baseUrl, session, userId, password);
  logger.info("Authenticated with Foundry", { userId });
  return { session, userId };
}
