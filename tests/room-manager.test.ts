import assert from "node:assert/strict";
import test from "node:test";
import type { AvatarKey } from "../shared/types.js";
import {
  RoomManager,
  type RoomSession,
  type SessionLookup,
} from "../server/room-manager.js";

type ManagerAction = "create" | "join" | "resume" | "command";

function session(
  id: string,
  displayName: string,
  avatarKey: AvatarKey,
): RoomSession {
  return {
    id,
    profile: { displayName, avatarKey },
    roomCode: null,
  };
}

function managerFixture({ disconnectGraceMs = 10 } = {}) {
  const values = new Map<string, RoomSession>([
    ["host", session("host", "Maya", "maya")],
    ["guest", session("guest", "Leo", "leo")],
    ["late", session("late", "Sofia", "sofia")],
  ]);
  const sessions: SessionLookup = {
    get: (id: string) => values.get(id),
  };
  const manager = new RoomManager({
    sessions,
    disconnectGraceMs,
    deckSize: 12,
    winningTimelineSize: 10,
    demoMode: true,
    random: () => 0,
  });
  return { manager, values };
}

function execute(
  manager: RoomManager,
  sessionId: string,
  socketId: string,
  type: ManagerAction,
  payload: Record<string, unknown> = {},
) {
  return manager.execute({ sessionId, socketId, type, payload });
}

test("starting locks the room against new players", () => {
  const { manager } = managerFixture();
  const created = execute(manager, "host", "socket-host", "create");
  execute(manager, "guest", "socket-guest", "join", { code: created.code });
  execute(manager, "host", "socket-host", "command", {
    code: created.code,
    type: "useDemoDeck",
  });
  execute(manager, "host", "socket-host", "command", {
    code: created.code,
    type: "startGame",
  });

  assert.throws(
    () => execute(manager, "late", "socket-late", "join", { code: created.code }),
    (error: unknown) =>
      error instanceof Error &&
      "code" in error &&
      error.code === "ROOM_LOCKED",
  );
});

test("a disconnected host is removed and host ownership transfers", async () => {
  const { manager } = managerFixture({ disconnectGraceMs: 5 });
  const created = execute(manager, "host", "socket-host", "create");
  execute(manager, "guest", "socket-guest", "join", { code: created.code });

  manager.disconnect("host", "socket-host");
  await new Promise((resolve) => setTimeout(resolve, 20));

  const snapshot = manager.snapshot(String(created.code), "guest");
  assert.equal(snapshot.hostId, "guest");
  assert.equal(snapshot.players.length, 1);
});
