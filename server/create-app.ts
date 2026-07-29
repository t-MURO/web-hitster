import { createServer } from "node:http";
import path from "node:path";
import express, {
  type ErrorRequestHandler,
  type Request,
  type Response,
} from "express";
import { Server as SocketServer } from "socket.io";
import {
  AVATAR_KEYS,
  type AppConfig,
  type AvatarKey,
  type PublicError,
  type RoomAction,
  type RoomActionResponse,
} from "../shared/types.js";
import { loadConfig, validateConfig } from "./config.js";
import { RoomManager } from "./room-manager.js";
import { SessionStore } from "./session-store.js";

const PROJECT_ROOT = process.cwd();
const AVATARS = new Set<string>(AVATAR_KEYS);

interface CodedError extends Error {
  code?: string;
}

function publicError(error: unknown): PublicError {
  if (error instanceof Error) {
    return {
      code: (error as CodedError).code ?? "UNEXPECTED_ERROR",
      message: error.message || "Something went wrong.",
    };
  }
  return {
    code: "UNEXPECTED_ERROR",
    message: "Something went wrong.",
  };
}

function codedError(message: string, code: string): CodedError {
  return Object.assign(new Error(message), { code });
}

function safeName(value: unknown): string {
  const name = String(value ?? "").trim().replace(/\s+/g, " ");
  if (name.length < 2 || name.length > 24) {
    throw codedError(
      "Use a player name between 2 and 24 characters.",
      "INVALID_PROFILE",
    );
  }
  return name;
}

function isRoomAction(value: unknown): value is RoomAction {
  if (typeof value !== "object" || value === null) return false;
  const type = (value as { type?: unknown }).type;
  return ["create", "join", "resume", "command"].includes(String(type));
}

export async function createApplication({
  config = loadConfig(),
  random = Math.random,
}: {
  config?: AppConfig;
  random?: () => number;
} = {}) {
  const configErrors = validateConfig(config);
  if (configErrors.length) throw new Error(configErrors.join(" "));

  const app = express();
  const httpServer = createServer(app);
  const io = new SocketServer(httpServer, {
    maxHttpBufferSize: 1_000_000,
  });
  const sessions = new SessionStore({
    secret: config.sessionSecret,
    secure: config.cookieSecure,
  });
  const rooms = new RoomManager({
    sessions,
    disconnectGraceMs: config.disconnectGraceMs,
    deckSize: config.deckSize,
    winningTimelineSize: config.winningTimelineSize,
    demoMode: config.demoMode,
    random,
  });

  app.set("trust proxy", 1);
  app.use((request: Request, response: Response, next) => {
    response.setHeader("X-Content-Type-Options", "nosniff");
    response.setHeader("Referrer-Policy", "no-referrer");
    response.setHeader(
      "Permissions-Policy",
      "camera=(), microphone=(), geolocation=()",
    );
    if (config.isProduction) {
      response.setHeader(
        "Content-Security-Policy",
        [
          "default-src 'self'",
          "base-uri 'self'",
          "connect-src 'self' https: wss:",
          "font-src 'self'",
          "frame-ancestors 'none'",
          "img-src 'self' data: http: https:",
          "object-src 'none'",
          "script-src 'self'",
          "style-src 'self' 'unsafe-inline'",
        ].join("; "),
      );
    }
    if (request.path.startsWith("/api/")) {
      response.setHeader("Cache-Control", "no-store");
    }
    next();
  });
  app.use(express.json({ limit: "1mb" }));
  app.use(sessions.middleware());

  app.get("/api/health", (_request, response) => {
    response.json({ ok: true });
  });

  app.get("/api/session", (request, response) => {
    response.json({
      profile: request.session.profile,
      roomCode: request.session.roomCode,
      config: {
        demoMode: config.demoMode,
        deckSize: config.deckSize,
        winningTimelineSize: config.winningTimelineSize,
        disconnectGraceMs: config.disconnectGraceMs,
      },
    });
  });

  app.post("/api/profile", (request, response, next) => {
    try {
      if (request.session.roomCode) {
        throw codedError(
          "Leave the current room before changing player.",
          "IN_ROOM",
        );
      }
      const avatarKey = String(request.body?.avatarKey ?? "maya");
      if (!AVATARS.has(avatarKey)) {
        throw codedError("Choose a valid player portrait.", "INVALID_PROFILE");
      }
      request.session.profile = {
        displayName: safeName(request.body?.displayName),
        avatarKey: avatarKey as AvatarKey,
      };
      response.json({ profile: request.session.profile });
    } catch (error) {
      next(error);
    }
  });

  app.post("/api/logout", (request, response, next) => {
    try {
      if (request.session.roomCode) {
        throw codedError(
          "Leave the current room before signing out.",
          "IN_ROOM",
        );
      }
      sessions.destroy(request.session.id, response);
      response.status(204).end();
    } catch (error) {
      next(error);
    }
  });

  const apiErrorHandler: ErrorRequestHandler = (
    error,
    _request,
    response,
    _next,
  ) => {
    const payload = publicError(error);
    response.status(payload.code === "UNEXPECTED_ERROR" ? 500 : 400).json({
      error: payload,
    });
  };
  app.use("/api", apiErrorHandler);

  async function broadcast(code: string): Promise<void> {
    if (!code) return;
    const connectedSockets = await io.in(code).fetchSockets();
    for (const connectedSocket of connectedSockets) {
      try {
        const snapshot = rooms.snapshot(
          code,
          connectedSocket.data.sessionId as string,
        );
        connectedSocket.emit("room:state", snapshot);
      } catch {
        await connectedSocket.leave(code);
        connectedSocket.emit("room:left");
      }
    }
  }

  rooms.setOnChange(broadcast);

  io.use((socket, next) => {
    const session = sessions.fromCookieHeader(socket.handshake.headers.cookie);
    if (!session?.profile) {
      return next(new Error("Choose your player profile first."));
    }
    socket.data.sessionId = session.id;
    next();
  });

  io.on("connection", (socket) => {
    const sessionId = socket.data.sessionId as string;

    socket.on(
      "room:action",
      async (
        action: unknown,
        acknowledge: (response: RoomActionResponse) => void = () => {},
      ) => {
        try {
          if (!isRoomAction(action)) {
            throw codedError("Unknown room action.", "ROOM_ERROR");
          }
          const result = rooms.execute({
            sessionId,
            socketId: socket.id,
            type: action.type,
            payload: action.payload,
          });

          if (result.left && result.code) {
            await socket.leave(result.code);
            socket.emit("room:left");
          } else if (result.code) {
            await socket.join(result.code);
            await broadcast(result.code);
          }
          acknowledge({ ok: true, result });
        } catch (error) {
          acknowledge({ ok: false, error: publicError(error) });
        }
      },
    );

    socket.on("disconnect", () => {
      rooms.disconnect(sessionId, socket.id);
    });
  });

  if (config.isProduction) {
    const clientDir = path.join(PROJECT_ROOT, "dist", "client");
    app.use(express.static(clientDir, { index: false }));
    app.get("*", (_request, response) => {
      response.sendFile(path.join(clientDir, "index.html"));
    });
  } else {
    const { createServer: createViteServer } = await import("vite");
    const vite = await createViteServer({
      root: PROJECT_ROOT,
      server: { middlewareMode: true },
      appType: "spa",
    });
    app.use(vite.middlewares);
  }

  return {
    app,
    httpServer,
    io,
    rooms,
    sessions,
    config,
  };
}
