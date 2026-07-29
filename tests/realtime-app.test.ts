import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import test from "node:test";
import { io as createSocket, type Socket } from "socket.io-client";
import type {
  AvatarKey,
  RoomActionResponse,
  RoomActionResult,
} from "../shared/types.js";
import { createApplication } from "../server/create-app.js";

function required<T>(value: T | null | undefined, label: string): T {
  assert.ok(value != null, label);
  return value;
}

async function profileSession(
  baseUrl: string,
  displayName: string,
  avatarKey: AvatarKey,
): Promise<string> {
  const sessionResponse = await fetch(`${baseUrl}/api/session`);
  const setCookie = required(
    sessionResponse.headers.get("set-cookie"),
    "session cookie",
  );
  const cookie = required(setCookie.split(";")[0], "cookie value");
  const profileResponse = await fetch(`${baseUrl}/api/profile`, {
    method: "POST",
    headers: {
      Cookie: cookie,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ displayName, avatarKey }),
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
        if (timeoutError) {
          reject(timeoutError);
        } else if (!response?.ok) {
          reject(
            Object.assign(
              new Error(response?.error.message ?? "Action failed."),
              response?.error,
            ),
          );
        } else {
          resolve(response.result);
        }
      },
    );
  });
}

test("two browser sessions can create, join, start, and reveal without leaking mystery metadata", async (t) => {
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

  const hostCookie = await profileSession(baseUrl, "Maya", "maya");
  const guestCookie = await profileSession(baseUrl, "Leo", "leo");
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
  });

  const created = await action(hostSocket, "create");
  const code = required(created.code, "room code");
  await action(guestSocket, "join", { code });
  await action(hostSocket, "command", {
    code,
    type: "useDemoDeck",
  });
  const started = await action(hostSocket, "command", {
    code,
    type: "startGame",
  });

  const hostStart = required(started.snapshot, "host start snapshot");
  assert.equal(
    required(required(hostStart.game, "host game").current, "host round").track,
    null,
  );
  assert.ok(required(hostStart.hostCue, "host cue").audioCue);

  const guestSessionId = required(
    application.sessions.fromCookieHeader(guestCookie),
    "guest session",
  ).id;
  const hostSessionId = required(
    application.sessions.fromCookieHeader(hostCookie),
    "host session",
  ).id;
  const guestSnapshot = application.rooms.snapshot(code, guestSessionId);
  assert.equal(guestSnapshot.hostCue, null);
  assert.equal(
    required(required(guestSnapshot.game, "guest game").current, "guest round")
      .track,
    null,
  );

  await action(hostSocket, "command", {
    code,
    type: "playCue",
  });
  const activeId = required(
    required(application.rooms.snapshot(code, hostSessionId).game, "active game")
      .activePlayerId,
    "active player",
  );
  const activeSocket = activeId === hostSessionId ? hostSocket : guestSocket;
  const opponentSocket =
    activeId === hostSessionId ? guestSocket : hostSocket;
  await action(activeSocket, "command", {
    code,
    type: "lockIn",
  });
  await action(opponentSocket, "command", {
    code,
    type: "passChallenge",
  });
  const revealed = await action(activeSocket, "command", {
    code,
    type: "reveal",
  });

  const revealedGame = required(
    required(revealed.snapshot, "revealed snapshot").game,
    "revealed game",
  );
  const revealedRound = required(revealedGame.current, "revealed round");
  assert.ok(required(revealedRound.track, "revealed track").year);
  assert.equal(revealedRound.phase, "revealed");
});
