import assert from "node:assert/strict";
import test from "node:test";
import type { AvatarKey } from "../shared/types.js";
import {
  RoomManager,
  type RoomSession,
  type SessionLookup,
} from "../server/room-manager.js";
import { createDemoDeck } from "../server/deck-parser.js";

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

test("hosted audio waits for every connected client without revealing the cue", () => {
  const { manager } = managerFixture();
  const created = execute(manager, "host", "socket-host", "create");
  const code = String(created.code);
  execute(manager, "guest", "socket-guest", "join", { code });

  const tracks = createDemoDeck().slice(0, 12);
  const importId = manager.beginSpotifyDeck({
    code,
    sessionId: "host",
    name: "Hosted test",
    total: tracks.length,
  });
  for (const preparedTrack of tracks) {
    manager.recordSpotifyPreparation({
      code,
      importId,
      track: preparedTrack,
      error: null,
    });
  }
  manager.completeSpotifyPreparation({ code, importId });
  execute(manager, "host", "socket-host", "command", {
    code,
    type: "startGame",
  });
  const started = manager.snapshot(code, "host");
  assert.equal(started.hostCue, null);
  assert.equal(started.deck?.audioMode, "hosted");
  const roundNumber = started.playback.roundNumber;
  assert.ok(
    manager.hostedTrackForRound({
      code,
      sessionId: "guest",
      roundNumber,
    }).trackId,
  );

  execute(manager, "host", "socket-host", "command", {
    code,
    type: "audioReady",
    payload: { roundNumber },
  });
  assert.throws(
    () =>
      execute(manager, "host", "socket-host", "command", {
        code,
        type: "playCue",
      }),
    (error: unknown) =>
      error instanceof Error &&
      "code" in error &&
      error.code === "AUDIO_NOT_READY",
  );

  execute(manager, "guest", "socket-guest", "command", {
    code,
    type: "audioReady",
    payload: { roundNumber },
  });
  const playing = execute(manager, "host", "socket-host", "command", {
    code,
    type: "playCue",
  });
  assert.equal(playing.snapshot?.playback.status, "playing");
  assert.ok((playing.snapshot?.playback.startAt ?? 0) > Date.now());
});

test("failed Spotify matches are listed but excluded from the game deck", () => {
  const { manager } = managerFixture();
  const created = execute(manager, "host", "socket-host", "create");
  const code = String(created.code);
  const tracks = createDemoDeck().slice(0, 13);
  const failedTrack = tracks[0];
  assert.ok(failedTrack);
  const importId = manager.beginSpotifyDeck({
    code,
    sessionId: "host",
    name: "Partially prepared deck",
    total: tracks.length,
  });

  for (const preparedTrack of tracks) {
    manager.recordSpotifyPreparation({
      code,
      importId,
      track: preparedTrack,
      error:
        preparedTrack.id === failedTrack.id
          ? "YouTube returned no usable result."
          : null,
    });
  }
  manager.completeSpotifyPreparation({ code, importId });

  const snapshot = manager.snapshot(code, "host");
  assert.equal(snapshot.deck?.trackCount, 12);
  assert.equal(snapshot.deck?.preparation?.failedCount, 1);
  assert.deepEqual(snapshot.deck?.preparation?.failures, [
    {
      id: failedTrack.id,
      title: failedTrack.title,
      artist: failedTrack.artist,
      reason: "YouTube returned no usable result.",
    },
  ]);
  assert.equal(
    snapshot.deckReview?.some((track) => track.id === failedTrack.id),
    false,
  );
});
