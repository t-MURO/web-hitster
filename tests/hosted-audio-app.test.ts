import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import type { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { io as createSocket, type Socket } from "socket.io-client";
import type {
  RoomActionResponse,
  RoomActionResult,
} from "../shared/types.js";
import { createApplication } from "../server/create-app.js";
import { createDemoDeck } from "../server/deck-parser.js";
import {
  MediaLibrary,
  type MediaCommandRunner,
} from "../server/media-library.js";

function required<T>(value: T | null | undefined, label: string): T {
  assert.ok(value != null, label);
  return value;
}

async function profileSession(baseUrl: string, name: string): Promise<string> {
  const sessionResponse = await fetch(`${baseUrl}/api/session`);
  const cookie = required(
    required(sessionResponse.headers.get("set-cookie"), "session cookie").split(
      ";",
    )[0],
    "cookie value",
  );
  const profileResponse = await fetch(`${baseUrl}/api/profile`, {
    method: "POST",
    headers: {
      Cookie: cookie,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ displayName: name, avatarKey: "maya" }),
  });
  assert.equal(profileResponse.status, 200);
  return cookie;
}

function connect(baseUrl: string, cookie: string): Promise<Socket> {
  return new Promise((resolve, reject) => {
    const socket = createSocket(baseUrl, {
      transports: ["websocket"],
      extraHeaders: { Cookie: cookie },
      forceNew: true,
    });
    socket.once("connect", () => resolve(socket));
    socket.once("connect_error", reject);
  });
}

function action(
  socket: Socket,
  type: "create" | "join" | "command",
  payload: Record<string, unknown> = {},
): Promise<RoomActionResult> {
  return new Promise((resolve, reject) => {
    socket.timeout(5_000).emit(
      "room:action",
      { type, payload },
      (timeoutError: Error | null, response?: RoomActionResponse) => {
        if (timeoutError) reject(timeoutError);
        else if (!response?.ok) reject(new Error(response?.error.message));
        else resolve(response.result);
      },
    );
  });
}

test("only room members can range-stream the opaque current-round MP3", async (t) => {
  const parent = await mkdtemp(path.join(os.tmpdir(), "webstar-audio-app-"));
  const run: MediaCommandRunner = async (_executable, arguments_) => {
    const outputIndex = arguments_.indexOf("--output");
    const template = required(arguments_[outputIndex + 1], "output template");
    const filePath = template.replace("%(ext)s", "mp3");
    await writeFile(filePath, Buffer.from("0123456789"));
    return { stdout: `youtube-id\n${filePath}\n`, stderr: "" };
  };
  const media = new MediaLibrary({
    root: path.join(parent, "audio"),
    run,
  });
  const application = await createApplication({
    config: {
      port: 4317,
      publicBaseUrl: "http://127.0.0.1",
      isProduction: true,
      demoMode: true,
      sessionSecret: "test-session-secret-that-is-long-enough",
      cookieSecure: false,
      disconnectGraceMs: 25,
      deckSize: 12,
      winningTimelineSize: 10,
    },
    mediaLibrary: media,
    random: () => 0,
  });
  await new Promise<void>((resolve) => {
    application.httpServer.listen(
      { port: 0, host: "127.0.0.1" },
      () => resolve(),
    );
  });
  const address = application.httpServer.address() as AddressInfo;
  const baseUrl = `http://127.0.0.1:${address.port}`;
  const hostCookie = await profileSession(baseUrl, "Host");
  const guestCookie = await profileSession(baseUrl, "Guest");
  const strangerCookie = await profileSession(baseUrl, "Stranger");
  const hostSocket = await connect(baseUrl, hostCookie);
  const guestSocket = await connect(baseUrl, guestCookie);

  t.after(async () => {
    hostSocket.disconnect();
    guestSocket.disconnect();
    await new Promise<void>((resolve) => application.io.close(() => resolve()));
    if (application.httpServer.listening) {
      await new Promise<void>((resolve, reject) => {
        application.httpServer.close((error) =>
          error ? reject(error) : resolve(),
        );
      });
    }
    await rm(parent, { recursive: true, force: true });
  });

  const created = await action(hostSocket, "create");
  const code = required(created.code, "room code");
  await action(guestSocket, "join", { code });
  const hostId = required(
    application.sessions.fromCookieHeader(hostCookie),
    "host session",
  ).id;
  const tracks = createDemoDeck().slice(0, 12);
  const importId = application.rooms.beginSpotifyDeck({
    code,
    sessionId: hostId,
    name: "Hosted deck",
    total: tracks.length,
  });
  await media.preparePlaylist({
    roomCode: code,
    tracks,
    onResult: ({ track, error }) => {
      application.rooms.recordSpotifyPreparation({
        code,
        importId,
        track,
        error,
      });
    },
  });
  application.rooms.completeSpotifyPreparation({ code, importId });
  const started = await action(hostSocket, "command", {
    code,
    type: "startGame",
  });
  const roundNumber = required(started.snapshot, "started room").playback
    .roundNumber;

  const audioResponse = await fetch(
    `${baseUrl}/api/rooms/${code}/audio/${roundNumber}`,
    {
      headers: {
        Cookie: guestCookie,
        Range: "bytes=2-5",
      },
    },
  );
  assert.equal(audioResponse.status, 206);
  assert.equal(audioResponse.headers.get("content-range"), "bytes 2-5/10");
  assert.equal(await audioResponse.text(), "2345");
  assert.equal(audioResponse.headers.get("content-type"), "audio/mpeg");

  const deniedResponse = await fetch(
    `${baseUrl}/api/rooms/${code}/audio/${roundNumber}`,
    { headers: { Cookie: strangerCookie } },
  );
  assert.equal(deniedResponse.status, 400);
});
