import { createServer } from "node:http";
import { createReadStream } from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomBytes } from "node:crypto";
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
import { createDemoDeck } from "./deck-parser.js";
import { MediaLibrary } from "./media-library.js";
import { RoomManager } from "./room-manager.js";
import { SessionStore } from "./session-store.js";
import { SpotifyService } from "./spotify-service.js";

const PROJECT_ROOT = process.cwd();
const AVATARS = new Set<string>(AVATAR_KEYS);
const MAX_AVATAR_BYTES = 128 * 1024;

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

function safeAvatarUrl(value: unknown): string | null {
  if (value === null || value === undefined || value === "") return null;
  if (typeof value !== "string") {
    throw codedError("Choose a valid profile photo.", "INVALID_PROFILE");
  }

  const match = value.match(
    /^data:image\/(?:jpeg|png|webp);base64,([A-Za-z0-9+/]+={0,2})$/,
  );
  if (!match?.[1]) {
    throw codedError(
      "Profile photos must be JPEG, PNG, or WebP images.",
      "INVALID_PROFILE",
    );
  }

  const bytes = Buffer.from(match[1], "base64");
  if (bytes.length === 0 || bytes.length > MAX_AVATAR_BYTES) {
    throw codedError(
      "That profile photo is too large. Choose a smaller image.",
      "INVALID_PROFILE",
    );
  }
  return value;
}

function isRoomAction(value: unknown): value is RoomAction {
  if (typeof value !== "object" || value === null) return false;
  const type = (value as { type?: unknown }).type;
  return ["create", "join", "resume", "command"].includes(String(type));
}

export async function createApplication({
  config = loadConfig(),
  random = Math.random,
  spotifyService,
  mediaLibrary,
}: {
  config?: AppConfig;
  random?: () => number;
  spotifyService?: SpotifyService;
  mediaLibrary?: MediaLibrary;
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
  const spotify =
    spotifyService ??
    new SpotifyService({
      clientId: config.spotifyClientId ?? "",
      clientSecret: config.spotifyClientSecret ?? "",
      redirectUri:
        config.spotifyRedirectUri ??
        `${config.publicBaseUrl}/callback`,
    });
  const media =
    mediaLibrary ??
    new MediaLibrary({
      root:
        config.audioTempRoot ??
        path.join(os.tmpdir(), `music-timeline-audio-${process.pid}`),
      downloaderPath: config.youtubeDownloaderPath ?? "yt-dlp",
      ffmpegPath: config.ffmpegPath ?? "ffmpeg",
      bitrateKbps: config.audioBitrateKbps ?? 96,
      concurrency: config.audioPreparationConcurrency ?? 2,
    });
  await media.initialize();
  const rooms = new RoomManager({
    sessions,
    disconnectGraceMs: config.disconnectGraceMs,
    deckSize: config.deckSize,
    winningTimelineSize: config.winningTimelineSize,
    demoMode: config.demoMode,
    spotifyConfigured: spotify.configured,
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
        spotifyConfigured: spotify.configured,
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
        avatarUrl: safeAvatarUrl(request.body?.avatarUrl),
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

  let mediaDiagnosticsCache:
    | Awaited<ReturnType<MediaLibrary["diagnostics"]>>
    | null = null;
  let mediaDiagnosticsAt = 0;
  app.get("/api/media/status", async (request, response, next) => {
    try {
      if (!request.session.roomCode) {
        throw codedError(
          "Create a room before checking its audio tools.",
          "ROOM_REQUIRED",
        );
      }
      rooms.assertHostLobby(request.session.roomCode, request.session.id);
      if (
        !mediaDiagnosticsCache ||
        Date.now() - mediaDiagnosticsAt > 60_000
      ) {
        mediaDiagnosticsCache = await media.diagnostics();
        mediaDiagnosticsAt = Date.now();
      }
      response.json(mediaDiagnosticsCache);
    } catch (error) {
      next(error);
    }
  });

  function startHostedPreparation({
    roomCode,
    importId,
    tracks,
    source,
    retry = false,
    maximumSuccesses = config.deckSize,
  }: {
    roomCode: string;
    importId: string;
    tracks: ReturnType<typeof createDemoDeck>;
    source: "spotify" | "hosted-demo";
    retry?: boolean;
    maximumSuccesses?: number;
  }): void {
    const onResult = ({
      track,
      error,
    }: {
      track: (typeof tracks)[number];
      error: string | null;
    }) => {
      rooms.recordSpotifyPreparation({
        code: roomCode,
        importId,
        track,
        error,
        retry,
      });
    };
    const preparation = retry
      ? source === "hosted-demo"
        ? media.prepareAdditionalGenerated({
            roomCode,
            tracks,
            onResult,
            maximumSuccesses,
          })
        : media.prepareAdditional({
            roomCode,
            tracks,
            onResult,
            maximumSuccesses,
          })
      : source === "hosted-demo"
        ? media.prepareGeneratedPlaylist({
            roomCode,
            tracks,
            onResult,
            maximumSuccesses,
          })
        : media.preparePlaylist({
            roomCode,
            tracks,
            onResult,
            maximumSuccesses,
          });

    void preparation
      .then(() => {
        rooms.completeSpotifyPreparation({ code: roomCode, importId });
      })
      .catch((error: unknown) => {
        rooms.failSpotifyPreparation({
          code: roomCode,
          importId,
          message:
            error instanceof Error
              ? error.message
              : "Audio preparation stopped unexpectedly.",
        });
      });
  }

  app.get("/api/spotify/login", (request, response, next) => {
    try {
      const roomCode = String(request.query.room ?? request.session.roomCode ?? "")
        .trim()
        .toUpperCase();
      rooms.assertHostLobby(roomCode, request.session.id);
      const state = randomBytes(24).toString("base64url");
      request.session.spotifyOAuth = {
        state,
        roomCode,
        createdAt: Date.now(),
      };
      response.redirect(spotify.authorizationUrl(state));
    } catch (error) {
      next(error);
    }
  });

  app.get(
    ["/callback", "/api/spotify/callback"],
    async (request, response, next) => {
    const attempt = request.session.spotifyOAuth;
    try {
      request.session.spotifyOAuth = null;
      if (
        !attempt ||
        attempt.state !== String(request.query.state ?? "") ||
        Date.now() - attempt.createdAt > 10 * 60 * 1000
      ) {
        throw codedError(
          "The Spotify login request expired. Start it again from the room.",
          "SPOTIFY_STATE_MISMATCH",
        );
      }
      rooms.assertHostLobby(attempt.roomCode, request.session.id);
      if (request.query.error) {
        throw codedError(
          "Spotify access was not granted.",
          "SPOTIFY_ACCESS_DENIED",
        );
      }
      const code = String(request.query.code ?? "");
      if (!code) {
        throw codedError(
          "Spotify did not return an authorization code.",
          "SPOTIFY_LOGIN_FAILED",
        );
      }
      request.session.spotify = await spotify.exchangeCode(code);
      response.redirect(`/room/${attempt.roomCode}?spotify=connected`);
    } catch (error) {
      if (attempt?.roomCode) {
        const message = publicError(error).message.slice(0, 180);
        response.redirect(
          `/room/${attempt.roomCode}?spotify_error=${encodeURIComponent(message)}`,
        );
      } else {
        next(error);
      }
    }
    },
  );

  app.post("/api/spotify/disconnect", (request, response, next) => {
    try {
      if (request.session.roomCode) {
        rooms.assertHostLobby(request.session.roomCode, request.session.id);
      }
      request.session.spotify = null;
      request.session.spotifyOAuth = null;
      response.status(204).end();
    } catch (error) {
      next(error);
    }
  });

  app.get("/api/spotify/playlists", async (request, response, next) => {
    try {
      const roomCode = String(
        request.query.code ?? request.session.roomCode ?? "",
      )
        .trim()
        .toUpperCase();
      rooms.assertHostLobby(roomCode, request.session.id);
      if (!request.session.spotify) {
        throw codedError(
          "Connect Spotify before loading your playlists.",
          "SPOTIFY_LOGIN_REQUIRED",
        );
      }
      response.json({
        playlists: await spotify.listPlaylists(request.session.spotify),
      });
    } catch (error) {
      next(error);
    }
  });

  app.post("/api/spotify/import", async (request, response, next) => {
    try {
      const roomCode = String(
        request.body?.code ?? request.session.roomCode ?? "",
      )
        .trim()
        .toUpperCase();
      rooms.assertHostLobby(roomCode, request.session.id);
      if (!request.session.spotify) {
        throw codedError(
          "Connect Spotify before importing a playlist.",
          "SPOTIFY_LOGIN_REQUIRED",
        );
      }
      const playlist = await spotify.importPlaylist(
        request.session.spotify,
        request.body?.playlistUrl,
      );
      const importId = rooms.beginSpotifyDeck({
        code: roomCode,
        sessionId: request.session.id,
        name: playlist.name,
        total: playlist.tracks.length + playlist.rejections.length,
        failures: playlist.rejections,
      });

      startHostedPreparation({
        roomCode,
        importId,
        tracks: playlist.tracks,
        source: "spotify",
      });

      response.status(202).json({
        accepted: true,
        name: playlist.name,
        total: playlist.tracks.length + playlist.rejections.length,
      });
    } catch (error) {
      next(error);
    }
  });

  app.post("/api/demo/hosted", (request, response, next) => {
    try {
      if (!config.demoMode) {
        throw codedError(
          "The hosted demo is disabled on this server.",
          "DEMO_DISABLED",
        );
      }
      const roomCode = String(
        request.body?.code ?? request.session.roomCode ?? "",
      )
        .trim()
        .toUpperCase();
      const tracks = createDemoDeck();
      const importId = rooms.beginHostedDemoDeck({
        code: roomCode,
        sessionId: request.session.id,
        name: "Hosted audio · No Spotify required",
        total: tracks.length,
      });
      startHostedPreparation({
        roomCode,
        importId,
        tracks,
        source: "hosted-demo",
      });
      response.status(202).json({ accepted: true, total: tracks.length });
    } catch (error) {
      next(error);
    }
  });

  app.post("/api/audio/retry", (request, response, next) => {
    try {
      const roomCode = String(
        request.body?.code ?? request.session.roomCode ?? "",
      )
        .trim()
        .toUpperCase();
      const rawTrackIds = request.body?.trackIds;
      const trackIds = Array.isArray(rawTrackIds)
        ? rawTrackIds
            .filter((value): value is string => typeof value === "string")
            .slice(0, 200)
        : undefined;
      const retry = rooms.retryHostedFailures({
        code: roomCode,
        sessionId: request.session.id,
        trackIds,
      });
      startHostedPreparation({
        roomCode,
        importId: retry.importId,
        tracks: retry.tracks,
        source: retry.source,
        retry: true,
        maximumSuccesses: retry.remainingCapacity,
      });
      response.status(202).json({
        accepted: true,
        total: retry.tracks.length,
      });
    } catch (error) {
      next(error);
    }
  });

  app.post("/api/audio/cancel", (request, response, next) => {
    try {
      const roomCode = String(
        request.body?.code ?? request.session.roomCode ?? "",
      )
        .trim()
        .toUpperCase();
      rooms.cancelHostedDeck(roomCode, request.session.id);
      response.status(204).end();
    } catch (error) {
      next(error);
    }
  });

  app.get(
    "/api/rooms/:code/audio/:roundNumber",
    (request, response, next) => {
      try {
        const roundNumber = Number.parseInt(request.params.roundNumber, 10);
        if (!Number.isInteger(roundNumber) || roundNumber < 1) {
          throw codedError("That audio round is invalid.", "INVALID_AUDIO_ROUND");
        }
        const { trackId } = rooms.hostedTrackForRound({
          code: request.params.code,
          sessionId: request.session.id,
          roundNumber,
        });
        const audio = media.get(request.params.code.toUpperCase(), trackId);
        if (!audio) {
          throw codedError(
            "This round's temporary audio is unavailable.",
            "AUDIO_MISSING",
          );
        }

        response.setHeader("Accept-Ranges", "bytes");
        response.setHeader("Content-Type", audio.mimeType);
        response.setHeader(
          "Content-Disposition",
          `inline; filename="round-${roundNumber}.mp3"`,
        );
        const range = request.headers.range;
        if (!range) {
          response.setHeader("Content-Length", audio.size);
          createReadStream(audio.filePath).on("error", next).pipe(response);
          return;
        }

        const match = /^bytes=(\d*)-(\d*)$/.exec(range);
        if (!match) {
          response.status(416).setHeader("Content-Range", `bytes */${audio.size}`);
          response.end();
          return;
        }
        const suffixLength =
          !match[1] && match[2] ? Number.parseInt(match[2], 10) : null;
        const start =
          suffixLength == null
            ? match[1]
              ? Number.parseInt(match[1], 10)
              : 0
            : Math.max(0, audio.size - suffixLength);
        const end =
          suffixLength == null && match[2]
            ? Number.parseInt(match[2], 10)
            : audio.size - 1;
        if (
          !Number.isInteger(start) ||
          !Number.isInteger(end) ||
          start < 0 ||
          end < start ||
          end >= audio.size
        ) {
          response.status(416).setHeader("Content-Range", `bytes */${audio.size}`);
          response.end();
          return;
        }
        response.status(206);
        response.setHeader("Content-Length", end - start + 1);
        response.setHeader("Content-Range", `bytes ${start}-${end}/${audio.size}`);
        createReadStream(audio.filePath, { start, end })
          .on("error", next)
          .pipe(response);
      } catch (error) {
        next(error);
      }
    },
  );

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
  rooms.setOnMediaRelease((code) => media.cleanupRoom(code));

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

  httpServer.once("close", () => {
    void media.close();
  });

  return {
    app,
    httpServer,
    io,
    rooms,
    sessions,
    spotify,
    media,
    config,
  };
}
