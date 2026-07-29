import { randomBytes } from "node:crypto";
import type {
  AvatarKey,
  GamePlayer,
  PlayerProfile,
  PlaybackSnapshot,
  RoomActionResult,
  RoomSnapshot,
  Track,
} from "../shared/types.js";
import { createDemoDeck, DeckError, parseDeck } from "./deck-parser.js";
import { GameRuleError, TimelineGame } from "./game-engine.js";

const ROOM_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";

type ActionType = "create" | "join" | "resume" | "command";
type Payload = Record<string, unknown>;

export interface RoomSession {
  id: string;
  profile: PlayerProfile | null;
  roomCode: string | null;
}

export interface SessionLookup {
  get(id: string): RoomSession | null | undefined;
}

interface RoomPlayer {
  id: string;
  displayName: string;
  avatarKey: AvatarKey;
  avatarUrl: string;
  connected: boolean;
  disconnectedAt: number | null;
  joinedAt: number;
  sockets: Set<string>;
}

interface RoomDeck {
  name: string;
  source: "upload" | "demo";
  tracks: Track[];
  loadedAt: number;
}

interface Room {
  code: string;
  hostId: string;
  status: "lobby" | "playing" | "finished";
  locked: boolean;
  createdAt: number;
  players: Map<string, RoomPlayer>;
  deck: RoomDeck | null;
  game: TimelineGame | null;
  playback: PlaybackSnapshot;
  rematchNumber: number;
}

export class RoomError extends Error {
  readonly code: string;

  constructor(message: string, code = "ROOM_ERROR") {
    super(message);
    this.name = "RoomError";
    this.code = code;
  }
}

function shuffle<T>(items: readonly T[], random: () => number): T[] {
  const result = [...items];
  for (let index = result.length - 1; index > 0; index -= 1) {
    const swapIndex = Math.floor(random() * (index + 1));
    const current = result[index];
    const replacement = result[swapIndex];
    if (current === undefined || replacement === undefined) continue;
    [result[index], result[swapIndex]] = [replacement, current];
  }
  return result;
}

function cleanCode(code: unknown): string {
  return String(code ?? "").trim().toUpperCase();
}

function cloneTrackForReview(track: Track): Track {
  return {
    id: track.id,
    title: track.title,
    artist: track.artist,
    year: track.year,
    originalYear: track.originalYear,
    coverUrl: track.coverUrl,
    audioCue: track.audioCue,
  };
}

function playerFromSession(session: RoomSession): RoomPlayer {
  if (!session.profile) {
    throw new RoomError("Choose your player name first.", "PROFILE_REQUIRED");
  }
  return {
    id: session.id,
    displayName: session.profile.displayName,
    avatarKey: session.profile.avatarKey,
    avatarUrl: `/assets/avatars/${session.profile.avatarKey}.png`,
    connected: true,
    disconnectedAt: null,
    joinedAt: Date.now(),
    sockets: new Set<string>(),
  };
}

function asPayload(value: unknown): Payload {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Payload)
    : {};
}

export class RoomManager {
  readonly #rooms = new Map<string, Room>();
  readonly #sessions: SessionLookup;
  readonly #disconnectGraceMs: number;
  readonly #deckSize: number;
  readonly #winningTimelineSize: number;
  readonly #demoMode: boolean;
  readonly #random: () => number;
  readonly #timers = new Map<string, ReturnType<typeof setTimeout>>();
  #onChange: (code: string) => void | Promise<void> = () => {};

  constructor({
    sessions,
    disconnectGraceMs,
    deckSize,
    winningTimelineSize,
    demoMode,
    random = Math.random,
  }: {
    sessions: SessionLookup;
    disconnectGraceMs: number;
    deckSize: number;
    winningTimelineSize: number;
    demoMode: boolean;
    random?: () => number;
  }) {
    this.#sessions = sessions;
    this.#disconnectGraceMs = disconnectGraceMs;
    this.#deckSize = deckSize;
    this.#winningTimelineSize = winningTimelineSize;
    this.#demoMode = demoMode;
    this.#random = random;
  }

  setOnChange(listener: (code: string) => void | Promise<void>): void {
    this.#onChange = listener;
  }

  #notify(code: string): void {
    Promise.resolve(this.#onChange(code)).catch(() => {});
  }

  #session(sessionId: string): RoomSession {
    const session = this.#sessions.get(sessionId);
    if (!session?.profile) {
      throw new RoomError("Choose your player name first.", "PROFILE_REQUIRED");
    }
    return session;
  }

  #room(code: unknown): Room {
    const room = this.#rooms.get(cleanCode(code));
    if (!room) throw new RoomError("That room does not exist.", "ROOM_NOT_FOUND");
    return room;
  }

  #membership(
    sessionId: string,
    code: unknown = null,
  ): { room: Room; player: RoomPlayer; session: RoomSession } {
    const session = this.#session(sessionId);
    const room = this.#room(code ?? session.roomCode);
    const player = room.players.get(sessionId);
    if (!player) {
      throw new RoomError("You are not part of this room.", "NOT_IN_ROOM");
    }
    return { room, player, session };
  }

  #assertHost(room: Room, sessionId: string): void {
    if (room.hostId !== sessionId) {
      throw new RoomError("Only the host can do that.", "HOST_ONLY");
    }
  }

  #generateCode(): string {
    for (let attempts = 0; attempts < 100; attempts += 1) {
      const bytes = randomBytes(5);
      const code = [...bytes]
        .map((byte) => ROOM_ALPHABET[byte % ROOM_ALPHABET.length] ?? "A")
        .join("");
      if (!this.#rooms.has(code)) return code;
    }
    throw new RoomError("Could not create a room code. Try again.");
  }

  #attachSocket(room: Room, player: RoomPlayer, socketId: string): void {
    const timerKey = `${room.code}:${player.id}`;
    const timer = this.#timers.get(timerKey);
    if (timer) {
      clearTimeout(timer);
      this.#timers.delete(timerKey);
    }
    player.sockets.add(socketId);
    player.connected = true;
    player.disconnectedAt = null;
  }

  #create(sessionId: string, socketId: string): RoomActionResult {
    const session = this.#session(sessionId);
    if (session.roomCode && this.#rooms.has(session.roomCode)) {
      throw new RoomError("Leave your current room before creating another.");
    }

    const code = this.#generateCode();
    const player = playerFromSession(session);
    const room: Room = {
      code,
      hostId: sessionId,
      status: "lobby",
      locked: false,
      createdAt: Date.now(),
      players: new Map([[sessionId, player]]),
      deck: null,
      game: null,
      playback: {
        status: "ready",
        cueVersion: 0,
        changedAt: Date.now(),
      },
      rematchNumber: 0,
    };

    this.#attachSocket(room, player, socketId);
    this.#rooms.set(code, room);
    session.roomCode = code;
    return { code, snapshot: this.snapshot(code, sessionId) };
  }

  #join(
    sessionId: string,
    socketId: string,
    payload: Payload,
  ): RoomActionResult {
    const session = this.#session(sessionId);
    const room = this.#room(payload.code);
    const existing = room.players.get(sessionId);

    if (existing) {
      this.#attachSocket(room, existing, socketId);
      session.roomCode = room.code;
      return {
        code: room.code,
        snapshot: this.snapshot(room.code, sessionId),
      };
    }

    if (room.locked || room.status !== "lobby") {
      throw new RoomError(
        "This game has started and no longer accepts new players.",
        "ROOM_LOCKED",
      );
    }
    if (room.players.size >= 5) {
      throw new RoomError("This room already has five players.", "ROOM_FULL");
    }

    const player = playerFromSession(session);
    this.#attachSocket(room, player, socketId);
    room.players.set(sessionId, player);
    session.roomCode = room.code;
    return { code: room.code, snapshot: this.snapshot(room.code, sessionId) };
  }

  #resume(sessionId: string, socketId: string): RoomActionResult {
    const session = this.#session(sessionId);
    if (!session.roomCode || !this.#rooms.has(session.roomCode)) {
      session.roomCode = null;
      return { code: null, snapshot: null };
    }
    const room = this.#room(session.roomCode);
    const player = room.players.get(sessionId);
    if (!player) {
      session.roomCode = null;
      return { code: null, snapshot: null };
    }
    this.#attachSocket(room, player, socketId);
    return { code: room.code, snapshot: this.snapshot(room.code, sessionId) };
  }

  #setDeck(room: Room, sessionId: string, payload: Payload): void {
    this.#assertHost(room, sessionId);
    if (room.status !== "lobby") {
      throw new RoomError("The deck can only be changed in the lobby.");
    }

    const name = String(payload.name ?? "Custom deck").trim().slice(0, 64);
    const tracks = parseDeck(String(payload.text ?? ""), {
      minimumTracks: this.#deckSize,
    });
    room.deck = {
      name: name || "Custom deck",
      source: "upload",
      tracks,
      loadedAt: Date.now(),
    };
  }

  #useDemoDeck(room: Room, sessionId: string): void {
    this.#assertHost(room, sessionId);
    if (!this.#demoMode) {
      throw new RoomError("The demo deck is disabled on this server.");
    }
    if (room.status !== "lobby") {
      throw new RoomError("The deck can only be changed in the lobby.");
    }
    room.deck = {
      name: "The Listening Room · Demo",
      source: "demo",
      tracks: createDemoDeck(),
      loadedAt: Date.now(),
    };
  }

  #overrideYear(room: Room, sessionId: string, payload: Payload): void {
    this.#assertHost(room, sessionId);
    if (room.status !== "lobby" || !room.deck) {
      throw new RoomError("Load a deck before correcting its years.");
    }
    const year = Number.parseInt(String(payload.year), 10);
    if (!Number.isInteger(year) || year < 1900 || year > 2100) {
      throw new RoomError("The corrected year must be between 1900 and 2100.");
    }
    const track = room.deck.tracks.find((item) => item.id === payload.trackId);
    if (!track) throw new RoomError("That track is no longer in the deck.");
    track.year = year;
  }

  #startGame(room: Room, sessionId: string): void {
    this.#assertHost(room, sessionId);
    if (room.status !== "lobby") {
      throw new RoomError("The game has already started.");
    }
    if (room.players.size < 2) {
      throw new RoomError("At least two players are required.", "NEED_PLAYERS");
    }
    if ([...room.players.values()].some((player) => !player.connected)) {
      throw new RoomError("Wait for every player to reconnect before starting.");
    }
    if (!room.deck || room.deck.tracks.length < this.#deckSize) {
      throw new RoomError(
        `Load a deck with at least ${this.#deckSize} tracks first.`,
        "DECK_REQUIRED",
      );
    }

    const tracks = shuffle(room.deck.tracks, this.#random).slice(
      0,
      this.#deckSize,
    );
    const players: GamePlayer[] = [...room.players.values()].map((player) => ({
      id: player.id,
      displayName: player.displayName,
      avatarUrl: player.avatarUrl,
    }));

    room.game = TimelineGame.create({
      players,
      tracks,
      random: this.#random,
      winningTimelineSize: this.#winningTimelineSize,
    });
    room.status = "playing";
    room.locked = true;
    room.playback = {
      status: "ready",
      cueVersion: 0,
      changedAt: Date.now(),
    };
  }

  #removePlayer(room: Room, sessionId: string): void {
    const player = room.players.get(sessionId);
    if (!player) return;

    room.players.delete(sessionId);
    room.game?.removePlayer(sessionId);
    const session = this.#sessions.get(sessionId);
    if (session) session.roomCode = null;

    if (room.players.size === 0) {
      this.#rooms.delete(room.code);
      return;
    }

    if (room.hostId === sessionId) {
      const nextHost =
        [...room.players.values()].find((candidate) => candidate.connected)?.id ??
        room.players.keys().next().value;
      if (nextHost) room.hostId = nextHost;
    }

    if (room.game?.status === "finished") room.status = "finished";
  }

  #activeGame(room: Room): TimelineGame {
    if (room.status !== "playing" || !room.game) {
      throw new RoomError("There is no active game.", "NO_ACTIVE_GAME");
    }
    return room.game;
  }

  #command(sessionId: string, payload: Payload): RoomActionResult {
    const { room } = this.#membership(sessionId, payload.code);
    const command = String(payload.type ?? "");
    const commandPayload = asPayload(payload.payload);

    switch (command) {
      case "setDeck":
        this.#setDeck(room, sessionId, commandPayload);
        break;
      case "useDemoDeck":
        this.#useDemoDeck(room, sessionId);
        break;
      case "overrideYear":
        this.#overrideYear(room, sessionId, commandPayload);
        break;
      case "startGame":
        this.#startGame(room, sessionId);
        break;
      case "selectGap": {
        const game = this.#activeGame(room);
        game.selectGap(sessionId, Number(commandPayload.gapIndex));
        break;
      }
      case "playCue":
      case "restartCue":
        this.#assertHost(room, sessionId);
        if (this.#activeGame(room).phase !== "listening") {
          throw new RoomError("There is no mystery track to start.");
        }
        room.playback.status = "playing";
        room.playback.cueVersion += 1;
        room.playback.changedAt = Date.now();
        break;
      case "pauseCue":
        this.#assertHost(room, sessionId);
        this.#activeGame(room);
        room.playback.status = "paused";
        room.playback.changedAt = Date.now();
        break;
      case "lockIn": {
        const game = this.#activeGame(room);
        if (room.playback.status !== "playing") {
          throw new RoomError(
            "The host must start the audio cue before lock-in.",
          );
        }
        game.reveal(sessionId);
        room.playback.status = "paused";
        room.playback.changedAt = Date.now();
        if (game.status === "finished") room.status = "finished";
        break;
      }
      case "nextRound": {
        const game = this.#activeGame(room);
        game.nextRound(sessionId, room.hostId);
        room.playback.status = "ready";
        room.playback.changedAt = Date.now();
        if (game.status === "finished") room.status = "finished";
        break;
      }
      case "endGame":
        this.#assertHost(room, sessionId);
        this.#activeGame(room).finish();
        room.status = "finished";
        room.playback.status = "paused";
        room.playback.changedAt = Date.now();
        break;
      case "rematch":
        this.#assertHost(room, sessionId);
        if (room.status !== "finished") {
          throw new RoomError(
            "Finish the current game before starting a rematch.",
          );
        }
        room.status = "lobby";
        room.locked = true;
        room.game = null;
        room.rematchNumber += 1;
        room.playback.status = "ready";
        room.playback.changedAt = Date.now();
        break;
      case "leaveRoom":
        this.#removePlayer(room, sessionId);
        return { code: room.code, left: true, snapshot: null };
      default:
        throw new RoomError("Unknown room command.");
    }

    return {
      code: room.code,
      snapshot: this.snapshot(room.code, sessionId),
    };
  }

  execute({
    sessionId,
    socketId,
    type,
    payload = {},
  }: {
    sessionId: string;
    socketId: string;
    type: ActionType;
    payload?: Payload;
  }): RoomActionResult {
    try {
      let result: RoomActionResult;
      if (type === "create") result = this.#create(sessionId, socketId);
      else if (type === "join") {
        result = this.#join(sessionId, socketId, payload);
      } else if (type === "resume") {
        result = this.#resume(sessionId, socketId);
      } else if (type === "command") {
        result = this.#command(sessionId, payload);
      } else {
        throw new RoomError("Unknown room action.");
      }

      if (result.code) this.#notify(result.code);
      return result;
    } catch (error) {
      if (
        error instanceof RoomError ||
        error instanceof DeckError ||
        error instanceof GameRuleError
      ) {
        throw error;
      }
      throw new RoomError("The room could not process that action.");
    }
  }

  disconnect(sessionId: string, socketId: string): string | null {
    const session = this.#sessions.get(sessionId);
    if (!session?.roomCode) return null;
    const room = this.#rooms.get(session.roomCode);
    const player = room?.players.get(sessionId);
    if (!room || !player) return null;

    player.sockets.delete(socketId);
    if (player.sockets.size > 0) return room.code;

    player.connected = false;
    player.disconnectedAt = Date.now();
    const timerKey = `${room.code}:${sessionId}`;
    const timer = setTimeout(() => {
      this.#timers.delete(timerKey);
      const currentRoom = this.#rooms.get(room.code);
      const currentPlayer = currentRoom?.players.get(sessionId);
      if (!currentRoom || !currentPlayer || currentPlayer.connected) return;
      this.#removePlayer(currentRoom, sessionId);
      this.#notify(room.code);
    }, this.#disconnectGraceMs);
    timer.unref?.();
    this.#timers.set(timerKey, timer);
    this.#notify(room.code);
    return room.code;
  }

  snapshot(code: string, viewerId: string): RoomSnapshot {
    const room = this.#room(code);
    const game = room.game?.snapshot() ?? null;
    const isHost = room.hostId === viewerId;
    const currentTrack = room.game?.currentTrack ?? null;

    return {
      code: room.code,
      status: room.status,
      locked: room.locked,
      hostId: room.hostId,
      viewerId,
      isHost,
      rematchNumber: room.rematchNumber,
      rules: {
        deckSize: this.#deckSize,
        winningTimelineSize: this.#winningTimelineSize,
        disconnectGraceMs: this.#disconnectGraceMs,
      },
      players: [...room.players.values()].map((player) => ({
        id: player.id,
        displayName: player.displayName,
        avatarKey: player.avatarKey,
        avatarUrl: player.avatarUrl,
        connected: player.connected,
        disconnectedAt: player.disconnectedAt,
        host: player.id === room.hostId,
        active: player.id === game?.activePlayerId,
        score: game?.scores[player.id] ?? 0,
      })),
      deck: room.deck
        ? {
            name: room.deck.name,
            source: room.deck.source,
            trackCount: room.deck.tracks.length,
            ready: room.deck.tracks.length >= this.#deckSize,
          }
        : null,
      deckReview:
        isHost && room.status === "lobby" && room.deck
          ? room.deck.tracks.map(cloneTrackForReview)
          : null,
      playback: structuredClone(room.playback),
      hostCue:
        isHost && room.status === "playing" && currentTrack
          ? cloneTrackForReview(currentTrack)
          : null,
      game,
    };
  }

  roomCodeForSession(sessionId: string): string | null {
    return this.#sessions.get(sessionId)?.roomCode ?? null;
  }
}
