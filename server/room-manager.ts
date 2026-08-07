import { randomBytes } from "node:crypto";
import type {
  AvatarKey,
  DeckPreparationSnapshot,
  GamePlayer,
  PlayerProfile,
  PlaybackSnapshot,
  RoomActionResult,
  RoomSnapshot,
  Track,
} from "../shared/types.js";
import {
  MAX_PLAYERS,
  MAX_WINNING_TIMELINE_SIZE,
  MIN_WINNING_TIMELINE_SIZE,
} from "../shared/types.js";
import { createDemoDeck, DeckError, parseDeck } from "./deck-parser.js";
import { GameRuleError, TimelineGame } from "./game-engine.js";

const ROOM_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
const PLAYABLE_TRACK_BUFFER = 3;

type ActionType = "create" | "join" | "resume" | "command";
type Payload = Record<string, unknown>;

export interface RoomSession {
  id: string;
  profile: PlayerProfile | null;
  roomCode: string | null;
  spotify?: {
    displayName: string | null;
  } | null;
}

export interface SessionLookup {
  get(id: string): RoomSession | null | undefined;
}

interface RoomPlayer {
  id: string;
  displayName: string;
  avatarKey: AvatarKey;
  avatarUrl: string | null;
  connected: boolean;
  disconnectedAt: number | null;
  joinedAt: number;
  sockets: Set<string>;
}

interface RoomDeck {
  name: string;
  source: "upload" | "demo" | "spotify" | "hosted-demo";
  tracks: Track[];
  loadedAt: number;
  importId: string | null;
  preparation: DeckPreparationSnapshot | null;
  failedTracks: Map<
    string,
    { track: Track; reason: string; attempts: number }
  >;
  staticFailures: DeckPreparationSnapshot["failures"];
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
  winningTimelineSize: number;
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

function playerFromSession(session: RoomSession): RoomPlayer {
  if (!session.profile) {
    throw new RoomError("Choose your player name first.", "PROFILE_REQUIRED");
  }
  return {
    id: session.id,
    displayName: session.profile.displayName,
    avatarKey: session.profile.avatarKey,
    avatarUrl: session.profile.avatarUrl ?? null,
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

function isHostedSource(
  source: RoomDeck["source"] | undefined,
): source is "spotify" | "hosted-demo" {
  return source === "spotify" || source === "hosted-demo";
}

export class RoomManager {
  readonly #rooms = new Map<string, Room>();
  readonly #sessions: SessionLookup;
  readonly #disconnectGraceMs: number;
  readonly #deckSize: number;
  readonly #winningTimelineSize: number;
  readonly #demoMode: boolean;
  readonly #spotifyConfigured: boolean;
  readonly #random: () => number;
  readonly #timers = new Map<string, ReturnType<typeof setTimeout>>();
  readonly #challengeTimers = new Map<
    string,
    ReturnType<typeof setTimeout>
  >();
  #onChange: (code: string) => void | Promise<void> = () => {};
  #onMediaRelease: (code: string) => void | Promise<void> = () => {};

  constructor({
    sessions,
    disconnectGraceMs,
    deckSize,
    winningTimelineSize,
    demoMode,
    spotifyConfigured = false,
    random = Math.random,
  }: {
    sessions: SessionLookup;
    disconnectGraceMs: number;
    deckSize: number;
    winningTimelineSize: number;
    demoMode: boolean;
    spotifyConfigured?: boolean;
    random?: () => number;
  }) {
    this.#sessions = sessions;
    this.#disconnectGraceMs = disconnectGraceMs;
    this.#deckSize = deckSize;
    this.#winningTimelineSize = winningTimelineSize;
    this.#demoMode = demoMode;
    this.#spotifyConfigured = spotifyConfigured;
    this.#random = random;
  }

  setOnChange(listener: (code: string) => void | Promise<void>): void {
    this.#onChange = listener;
  }

  setOnMediaRelease(
    listener: (code: string) => void | Promise<void>,
  ): void {
    this.#onMediaRelease = listener;
  }

  #notify(code: string): void {
    Promise.resolve(this.#onChange(code)).catch(() => {});
  }

  #releaseMedia(code: string): void {
    Promise.resolve(this.#onMediaRelease(code)).catch(() => {});
  }

  #clearChallengeTimer(code: string): void {
    const timer = this.#challengeTimers.get(code);
    if (timer) clearTimeout(timer);
    this.#challengeTimers.delete(code);
  }

  #scheduleChallengeTimer(room: Room): void {
    this.#clearChallengeTimer(room.code);
    const snapshot = room.game?.snapshot();
    const deadline = snapshot?.current?.challengeDeadline;
    if (
      snapshot?.current?.phase !== "challenging" ||
      deadline == null
    ) {
      return;
    }
    const roundNumber = snapshot.roundNumber;
    const expire = () => {
      const currentRoom = this.#rooms.get(room.code);
      const currentGame = currentRoom?.game;
      const currentSnapshot = currentGame?.snapshot();
      if (
        !currentRoom ||
        !currentGame ||
        currentSnapshot?.roundNumber !== roundNumber ||
        currentSnapshot.current?.phase !== "challenging"
      ) {
        this.#challengeTimers.delete(room.code);
        return;
      }
      const currentDeadline = currentSnapshot.current.challengeDeadline;
      if (currentDeadline != null && currentDeadline > Date.now()) {
        const nextTimer = setTimeout(expire, currentDeadline - Date.now());
        nextTimer.unref?.();
        this.#challengeTimers.set(room.code, nextTimer);
        return;
      }
      this.#challengeTimers.delete(room.code);
      if (currentGame.expireChallengeWindow()) {
        this.#notify(room.code);
      }
    };
    const timer = setTimeout(expire, Math.max(0, deadline - Date.now()));
    timer.unref?.();
    this.#challengeTimers.set(room.code, timer);
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

  #create(
    sessionId: string,
    socketId: string,
    payload: Payload,
  ): RoomActionResult {
    const session = this.#session(sessionId);
    if (session.roomCode && this.#rooms.has(session.roomCode)) {
      throw new RoomError("Leave your current room before creating another.");
    }

    const code = this.#generateCode();
    const player = playerFromSession(session);
    const requestedWinningTimelineSize = Number(
      payload.winningTimelineSize ?? this.#winningTimelineSize,
    );
    if (
      !Number.isInteger(requestedWinningTimelineSize) ||
      requestedWinningTimelineSize < MIN_WINNING_TIMELINE_SIZE ||
      requestedWinningTimelineSize > MAX_WINNING_TIMELINE_SIZE
    ) {
      throw new RoomError(
        `Choose a win target between ${MIN_WINNING_TIMELINE_SIZE} and ${MAX_WINNING_TIMELINE_SIZE}.`,
        "INVALID_WIN_TARGET",
      );
    }
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
        roundNumber: 0,
        startAt: null,
        positionMs: 0,
        readyPlayerIds: [],
      },
      rematchNumber: 0,
      winningTimelineSize: requestedWinningTimelineSize,
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
    if (room.players.size >= MAX_PLAYERS) {
      throw new RoomError(
        `This room already has ${MAX_PLAYERS} players.`,
        "ROOM_FULL",
      );
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
      minimumTracks: PLAYABLE_TRACK_BUFFER,
    });
    room.deck = {
      name: name || "Custom deck",
      source: "upload",
      tracks,
      loadedAt: Date.now(),
      importId: null,
      preparation: null,
      failedTracks: new Map(),
      staticFailures: [],
    };
    this.#releaseMedia(room.code);
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
      importId: null,
      preparation: null,
      failedTracks: new Map(),
      staticFailures: [],
    };
    this.#releaseMedia(room.code);
  }

  #minimumTracksToStart(room: Room): number {
    return Math.max(PLAYABLE_TRACK_BUFFER, room.players.size + 1);
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
    const minimumTracks = this.#minimumTracksToStart(room);
    if (!room.deck || room.deck.tracks.length < minimumTracks) {
      throw new RoomError(
        "The music is not ready yet.",
        "DECK_REQUIRED",
      );
    }

    const acceptingTracks =
      isHostedSource(room.deck.source) &&
      room.deck.preparation?.status === "processing" &&
      room.deck.tracks.length < this.#deckSize;
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
      winningTimelineSize: room.winningTimelineSize,
      maximumTrackCount: this.#deckSize,
      acceptingTracks,
    });
    room.status = "playing";
    room.locked = true;
    this.#resetRoundPlayback(room, 0);
  }

  #removePlayer(room: Room, sessionId: string): void {
    const player = room.players.get(sessionId);
    if (!player) return;

    room.players.delete(sessionId);
    room.game?.removePlayer(sessionId);
    if (
      room.game?.phase !== "challenging" ||
      room.game?.status === "finished"
    ) {
      this.#clearChallengeTimer(room.code);
    }
    const session = this.#sessions.get(sessionId);
    if (session) session.roomCode = null;

    if (room.players.size === 0) {
      this.#clearChallengeTimer(room.code);
      this.#rooms.delete(room.code);
      this.#releaseMedia(room.code);
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

  #resetRoundPlayback(room: Room, cueVersion: number): void {
    this.#clearChallengeTimer(room.code);
    const game = this.#activeGame(room);
    room.playback = {
      status: "ready",
      cueVersion,
      changedAt: Date.now(),
      roundNumber: game.snapshot().roundNumber,
      startAt: null,
      positionMs: 0,
      readyPlayerIds: [],
    };
  }

  #pausePlayback(room: Room): void {
    if (room.playback.status === "playing" && room.playback.startAt != null) {
      room.playback.positionMs += Math.max(
        0,
        Date.now() - room.playback.startAt,
      );
    }
    room.playback.status = "paused";
    room.playback.startAt = null;
    room.playback.cueVersion += 1;
    room.playback.changedAt = Date.now();
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
      case "startGame":
        this.#startGame(room, sessionId);
        break;
      case "selectGap": {
        const game = this.#activeGame(room);
        game.selectGap(sessionId, Number(commandPayload.gapIndex));
        break;
      }
      case "submitGuess": {
        const game = this.#activeGame(room);
        game.submitGuess(
          sessionId,
          String(commandPayload.title ?? ""),
          String(commandPayload.artist ?? ""),
        );
        break;
      }
      case "skipTrack": {
        const game = this.#activeGame(room);
        game.skipTrack(sessionId);
        this.#resetRoundPlayback(room, room.playback.cueVersion + 1);
        break;
      }
      case "tradeTokensForCard": {
        const game = this.#activeGame(room);
        if (room.playback.status !== "ready") {
          throw new RoomError(
            "Trade tokens before the host starts the mystery song.",
          );
        }
        game.tradeTokensForCard(sessionId);
        this.#pausePlayback(room);
        if (game.status === "finished") room.status = "finished";
        break;
      }
      case "audioReady": {
        const game = this.#activeGame(room);
        if (!isHostedSource(room.deck?.source)) {
          throw new RoomError(
            "This room does not use hosted audio.",
            "AUDIO_NOT_HOSTED",
          );
        }
        const roundNumber = Number(commandPayload.roundNumber);
        if (
          game.phase !== "listening" ||
          roundNumber !== room.playback.roundNumber
        ) {
          throw new RoomError(
            "That audio round is no longer active.",
            "AUDIO_ROUND_CHANGED",
          );
        }
        if (!room.playback.readyPlayerIds.includes(sessionId)) {
          room.playback.readyPlayerIds.push(sessionId);
        }
        room.playback.changedAt = Date.now();
        break;
      }
      case "playCue":
      case "restartCue":
        this.#assertHost(room, sessionId);
        if (this.#activeGame(room).phase !== "listening") {
          throw new RoomError("There is no mystery track to start.");
        }
        if (
          isHostedSource(room.deck?.source) &&
          [...room.players.values()].some(
            (player) =>
              player.connected &&
              !room.playback.readyPlayerIds.includes(player.id),
          )
        ) {
          throw new RoomError(
            "Wait for every connected player to finish loading the audio.",
            "AUDIO_NOT_READY",
          );
        }
        if (command === "restartCue") room.playback.positionMs = 0;
        room.playback.status = "playing";
        room.playback.cueVersion += 1;
        room.playback.changedAt = Date.now();
        room.playback.startAt = Date.now() + 1_500;
        break;
      case "pauseCue":
        this.#assertHost(room, sessionId);
        this.#activeGame(room);
        this.#pausePlayback(room);
        break;
      case "lockIn": {
        const game = this.#activeGame(room);
        if (room.playback.status !== "playing") {
          throw new RoomError(
            "The host must start the audio cue before lock-in.",
          );
        }
        game.lockPlacement(sessionId);
        this.#scheduleChallengeTimer(room);
        break;
      }
      case "challengeGap": {
        const game = this.#activeGame(room);
        game.challengeGap(sessionId, Number(commandPayload.gapIndex));
        break;
      }
      case "passChallenge": {
        const game = this.#activeGame(room);
        game.passChallenge(sessionId);
        break;
      }
      case "reveal": {
        const game = this.#activeGame(room);
        game.reveal(
          sessionId,
          room.hostId,
          [...room.players.values()]
            .filter((player) => player.connected)
            .map((player) => player.id),
        );
        this.#clearChallengeTimer(room.code);
        this.#pausePlayback(room);
        if (game.status === "finished") room.status = "finished";
        break;
      }
      case "nextRound": {
        const game = this.#activeGame(room);
        game.nextRound(sessionId, room.hostId);
        if (game.status === "finished") room.status = "finished";
        else this.#resetRoundPlayback(room, room.playback.cueVersion + 1);
        break;
      }
      case "endGame":
        this.#assertHost(room, sessionId);
        this.#activeGame(room).finish();
        this.#clearChallengeTimer(room.code);
        room.status = "finished";
        this.#pausePlayback(room);
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
        this.#clearChallengeTimer(room.code);
        room.rematchNumber += 1;
        room.playback = {
          status: "ready",
          cueVersion: room.playback.cueVersion + 1,
          changedAt: Date.now(),
          roundNumber: 0,
          startAt: null,
          positionMs: 0,
          readyPlayerIds: [],
        };
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
      if (type === "create") {
        result = this.#create(sessionId, socketId, payload);
      }
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
    room.playback.readyPlayerIds = room.playback.readyPlayerIds.filter(
      (playerId) => playerId !== sessionId,
    );
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
        winningTimelineSize: room.winningTimelineSize,
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
      spotify: {
        configured: this.#spotifyConfigured,
        connected: Boolean(this.#sessions.get(viewerId)?.spotify),
        displayName:
          this.#sessions.get(viewerId)?.spotify?.displayName ?? null,
      },
      deck: room.deck
        ? {
            name: room.deck.name,
            source: room.deck.source,
            audioMode:
              isHostedSource(room.deck.source) ? "hosted" : "external",
            trackCount: isHost ? room.deck.tracks.length : 0,
            ready:
              room.deck.tracks.length >= this.#minimumTracksToStart(room),
            preparation:
              isHost && room.deck.preparation
                ? structuredClone(room.deck.preparation)
                : null,
          }
        : null,
      playback: structuredClone(room.playback),
      hostCue:
        isHost &&
        room.status === "playing" &&
        !isHostedSource(room.deck?.source) &&
        currentTrack
          ? { audioCue: currentTrack.audioCue }
          : null,
      game,
    };
  }

  roomCodeForSession(sessionId: string): string | null {
    return this.#sessions.get(sessionId)?.roomCode ?? null;
  }

  assertHostLobby(code: string, sessionId: string): void {
    const { room } = this.#membership(sessionId, code);
    this.#assertHost(room, sessionId);
    if (room.status !== "lobby") {
      throw new RoomError("Audio decks can only be changed in the lobby.");
    }
  }

  beginSpotifyDeck({
    code,
    sessionId,
    name,
    total,
    failures = [],
  }: {
    code: string;
    sessionId: string;
    name: string;
    total: number;
    failures?: Array<{
      id: string;
      title: string;
      artist: string;
      reason: string;
    }>;
  }): string {
    return this.#beginHostedDeck({
      code,
      sessionId,
      name,
      total,
      source: "spotify",
      message: "Matching Spotify tracks with YouTube audio…",
      failures,
    });
  }

  beginHostedDemoDeck({
    code,
    sessionId,
    name,
    total,
  }: {
    code: string;
    sessionId: string;
    name: string;
    total: number;
  }): string {
    return this.#beginHostedDeck({
      code,
      sessionId,
      name,
      total,
      source: "hosted-demo",
      message: "Generating temporary test audio without Spotify or YouTube…",
      failures: [],
    });
  }

  #beginHostedDeck({
    code,
    sessionId,
    name,
    total,
    source,
    message,
    failures,
  }: {
    code: string;
    sessionId: string;
    name: string;
    total: number;
    source: "spotify" | "hosted-demo";
    message: string;
    failures: Array<{
      id: string;
      title: string;
      artist: string;
      reason: string;
    }>;
  }): string {
    this.assertHostLobby(code, sessionId);
    const room = this.#room(code);
    const importId = randomBytes(16).toString("hex");
    room.deck = {
      name: name.trim().slice(0, 64) || "Hosted audio deck",
      source,
      tracks: [],
      loadedAt: Date.now(),
      importId,
      failedTracks: new Map(),
      staticFailures: failures.map((failure) => ({
        ...failure,
        attempts: 0,
        retryable: false,
      })),
      preparation: {
        status: "processing",
        total,
        processed: failures.length,
        readyCount: 0,
        failedCount: failures.length,
        failures: failures.map((failure) => ({
          ...failure,
          attempts: 0,
          retryable: false,
        })),
        retrying: false,
        currentTitle: null,
        message,
      },
    };
    this.#notify(room.code);
    return importId;
  }

  recordSpotifyPreparation({
    code,
    importId,
    track,
    error,
    retry = false,
  }: {
    code: string;
    importId: string;
    track: Track;
    error: string | null;
    retry?: boolean;
  }): boolean {
    const room = this.#rooms.get(cleanCode(code));
    if (
      !room?.deck ||
      !isHostedSource(room.deck.source) ||
      room.deck.importId !== importId ||
      !room.deck.preparation
    ) {
      return false;
    }
    if (!retry) room.deck.preparation.processed += 1;
    room.deck.preparation.currentTitle = track.title;
    if (error) {
      const previous = room.deck.failedTracks.get(track.id);
      const attempts = (previous?.attempts ?? 0) + 1;
      room.deck.failedTracks.set(track.id, {
        track: structuredClone(track),
        reason: error,
        attempts,
      });
      room.deck.preparation.failures =
        room.deck.preparation.failures.filter(
          (failure) => failure.id !== track.id,
        );
      room.deck.preparation.failures.push({
        id: track.id,
        title: track.title,
        artist: track.artist,
        reason: error,
        attempts,
        retryable: true,
      });
      room.deck.preparation.message = `Skipped “${track.title}”: ${error}`;
    } else if (!room.deck.tracks.some((item) => item.id === track.id)) {
      room.deck.failedTracks.delete(track.id);
      room.deck.preparation.failures =
        room.deck.preparation.failures.filter(
          (failure) => failure.id !== track.id,
        );
      const preparedTrack = structuredClone(track);
      room.deck.tracks.push(preparedTrack);
      const previousRoundNumber = room.game?.snapshot().roundNumber ?? null;
      room.game?.addTracks([preparedTrack]);
      if (
        room.game &&
        previousRoundNumber !== null &&
        room.game.snapshot().roundNumber !== previousRoundNumber
      ) {
        this.#resetRoundPlayback(room, room.playback.cueVersion + 1);
      }
      room.deck.preparation.readyCount = room.deck.tracks.length;
      room.deck.preparation.message =
        room.deck.tracks.length >= this.#minimumTracksToStart(room)
          ? "Enough tracks are ready. You can start now."
          : "Preparing temporary MP3 files…";
    }
    const retryableFailures = room.deck.preparation.failures.filter(
      (failure) => failure.retryable,
    );
    room.deck.preparation.failures = [
      ...room.deck.staticFailures,
      ...retryableFailures,
    ];
    room.deck.preparation.failedCount =
      room.deck.preparation.failures.length;
    this.#notify(room.code);
    return true;
  }

  completeSpotifyPreparation({
    code,
    importId,
  }: {
    code: string;
    importId: string;
  }): boolean {
    const room = this.#rooms.get(cleanCode(code));
    if (
      !room?.deck ||
      !isHostedSource(room.deck.source) ||
      room.deck.importId !== importId ||
      !room.deck.preparation
    ) {
      return false;
    }
    const enoughTracks =
      room.deck.tracks.length >= this.#minimumTracksToStart(room);
    room.deck.preparation.status = enoughTracks ? "ready" : "failed";
    room.deck.preparation.retrying = false;
    room.deck.preparation.currentTitle = null;
    room.deck.preparation.readyCount = room.deck.tracks.length;
    room.deck.preparation.message = enoughTracks
      ? `${room.deck.tracks.length} tracks are ready for this room.`
      : "Not enough tracks could be prepared to start the game.";
    room.game?.closeTrackFeed();
    if (room.game?.status === "finished") {
      room.status = "finished";
      this.#pausePlayback(room);
    }
    this.#notify(room.code);
    return true;
  }

  failSpotifyPreparation({
    code,
    importId,
    message,
  }: {
    code: string;
    importId: string;
    message: string;
  }): boolean {
    const room = this.#rooms.get(cleanCode(code));
    if (
      !room?.deck ||
      !isHostedSource(room.deck.source) ||
      room.deck.importId !== importId ||
      !room.deck.preparation
    ) {
      return false;
    }
    room.deck.preparation.status = "failed";
    room.deck.preparation.retrying = false;
    room.deck.preparation.currentTitle = null;
    room.deck.preparation.message = message.slice(0, 280);
    room.game?.closeTrackFeed();
    if (room.game?.status === "finished") {
      room.status = "finished";
      this.#pausePlayback(room);
    }
    this.#notify(room.code);
    return true;
  }

  retryHostedFailures({
    code,
    sessionId,
    trackIds,
  }: {
    code: string;
    sessionId: string;
    trackIds?: string[];
  }): {
    importId: string;
    source: "spotify" | "hosted-demo";
    tracks: Track[];
    remainingCapacity: number;
  } {
    this.assertHostLobby(code, sessionId);
    const room = this.#room(code);
    const deck = room.deck;
    if (
      !deck ||
      !isHostedSource(deck.source) ||
      !deck.importId ||
      !deck.preparation
    ) {
      throw new RoomError(
        "There is no hosted audio deck to retry.",
        "NO_HOSTED_DECK",
      );
    }
    if (deck.preparation.status === "processing") {
      throw new RoomError(
        "Wait for the current preparation run to finish first.",
        "PREPARATION_BUSY",
      );
    }
    const requestedIds =
      trackIds?.length ? new Set(trackIds) : new Set(deck.failedTracks.keys());
    const tracks = [...deck.failedTracks.entries()]
      .filter(([trackId]) => requestedIds.has(trackId))
      .map(([, failure]) => structuredClone(failure.track));
    if (!tracks.length) {
      throw new RoomError(
        "There are no matching failed tracks to retry.",
        "NO_FAILED_TRACKS",
      );
    }

    deck.preparation.status = "processing";
    deck.preparation.retrying = true;
    deck.preparation.currentTitle = null;
    deck.preparation.message = `Retrying ${tracks.length} excluded ${
      tracks.length === 1 ? "track" : "tracks"
    }…`;
    this.#notify(room.code);
    return {
      importId: deck.importId,
      source: deck.source,
      tracks,
      remainingCapacity: Math.max(0, this.#deckSize - deck.tracks.length),
    };
  }

  cancelHostedDeck(code: string, sessionId: string): void {
    this.assertHostLobby(code, sessionId);
    const room = this.#room(code);
    if (!isHostedSource(room.deck?.source)) {
      throw new RoomError(
        "There is no hosted preparation to cancel.",
        "NO_HOSTED_DECK",
      );
    }
    room.deck = null;
    this.#releaseMedia(room.code);
    this.#notify(room.code);
  }

  hostedTrackForRound({
    code,
    sessionId,
    roundNumber,
  }: {
    code: string;
    sessionId: string;
    roundNumber: number;
  }): { trackId: string } {
    const { room } = this.#membership(sessionId, code);
    if (!isHostedSource(room.deck?.source) || !room.game) {
      throw new RoomError(
        "This room does not have hosted audio.",
        "AUDIO_NOT_HOSTED",
      );
    }
    if (
      room.status !== "playing" ||
      room.playback.roundNumber !== roundNumber
    ) {
      throw new RoomError(
        "That audio round is no longer active.",
        "AUDIO_ROUND_CHANGED",
      );
    }
    const track = room.game.currentTrack;
    if (!track) {
      throw new RoomError("The current audio is unavailable.", "AUDIO_MISSING");
    }
    return { trackId: track.id };
  }
}
