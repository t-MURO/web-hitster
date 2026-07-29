import type {
  GamePhase,
  GamePlayer,
  GameSnapshot,
  GameStatus,
  PublicTrack,
  RoundOutcome,
  Track,
} from "../shared/types.js";

interface CurrentRound {
  track: Track;
  phase: GamePhase;
  selectedGap: number;
  outcome: RoundOutcome | null;
}

export class GameRuleError extends Error {
  readonly code: string;

  constructor(message: string, code = "GAME_RULE_VIOLATION") {
    super(message);
    this.name = "GameRuleError";
    this.code = code;
  }
}

function shuffled<T>(items: readonly T[], random: () => number): T[] {
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

function publicTrack(track: Track): PublicTrack {
  return {
    id: track.id,
    title: track.title,
    artist: track.artist,
    year: track.year,
    coverUrl: track.coverUrl,
  };
}

function defaultGap(timeline: readonly Track[]): number {
  return Math.ceil(timeline.length / 2);
}

export class TimelineGame {
  #players: GamePlayer[] = [];
  #turnOrder: string[] = [];
  #timelines = new Map<string, Track[]>();
  #deck: Track[] = [];
  #turnIndex = 0;
  #roundNumber = 0;
  #current: CurrentRound | null = null;
  #status: GameStatus = "playing";
  #winners: string[] = [];
  #winningTimelineSize = 10;

  static create({
    players,
    tracks,
    random = Math.random,
    winningTimelineSize = 10,
  }: {
    players: GamePlayer[];
    tracks: Track[];
    random?: () => number;
    winningTimelineSize?: number;
  }): TimelineGame {
    if (players.length < 2 || players.length > 5) {
      throw new GameRuleError("A game needs between 2 and 5 players.");
    }
    if (tracks.length <= players.length) {
      throw new GameRuleError("The deck does not have enough tracks to start.");
    }

    const game = new TimelineGame();
    game.#players = structuredClone(players);
    game.#turnOrder = shuffled(
      players.map((player) => player.id),
      random,
    );
    game.#winningTimelineSize = winningTimelineSize;

    const shuffledTracks = shuffled(tracks, random);
    for (const playerId of game.#turnOrder) {
      const startingCard = shuffledTracks.shift();
      if (!startingCard) {
        throw new GameRuleError("The deck does not have enough starting cards.");
      }
      game.#timelines.set(playerId, [startingCard]);
    }
    game.#deck = shuffledTracks;
    game.#startRound();
    return game;
  }

  get activePlayerId(): string | null {
    return this.#turnOrder[this.#turnIndex] ?? null;
  }

  get status(): GameStatus {
    return this.#status;
  }

  get phase(): GamePhase | null {
    return this.#current?.phase ?? null;
  }

  get currentTrack(): Track | null {
    return this.#current?.track ?? null;
  }

  #timeline(playerId: string | null): Track[] {
    if (!playerId) {
      throw new GameRuleError("There is no active player.");
    }
    const timeline = this.#timelines.get(playerId);
    if (!timeline) {
      throw new GameRuleError("That player has no active timeline.");
    }
    return timeline;
  }

  #startRound(): void {
    const track = this.#deck.shift();
    if (!track) {
      this.#finishByScore();
      return;
    }

    this.#roundNumber += 1;
    const timeline = this.#timeline(this.activePlayerId);
    this.#current = {
      track,
      phase: "listening",
      selectedGap: defaultGap(timeline),
      outcome: null,
    };
  }

  #finishByScore(): void {
    this.#status = "finished";
    const scores = this.#turnOrder.map((playerId) => ({
      playerId,
      score: this.#timelines.get(playerId)?.length ?? 0,
    }));
    const highScore = Math.max(0, ...scores.map((entry) => entry.score));
    this.#winners = scores
      .filter((entry) => entry.score === highScore)
      .map((entry) => entry.playerId);
  }

  selectGap(playerId: string, gapIndex: number): void {
    if (this.#status !== "playing" || this.#current?.phase !== "listening") {
      throw new GameRuleError("The timeline position cannot be changed now.");
    }
    if (playerId !== this.activePlayerId) {
      throw new GameRuleError("Only the active player can choose a position.");
    }

    const timeline = this.#timeline(playerId);
    if (
      !Number.isInteger(gapIndex) ||
      gapIndex < 0 ||
      gapIndex > timeline.length
    ) {
      throw new GameRuleError("That timeline position does not exist.");
    }
    this.#current.selectedGap = gapIndex;
  }

  reveal(playerId: string): RoundOutcome {
    if (this.#status !== "playing" || this.#current?.phase !== "listening") {
      throw new GameRuleError("This round cannot be revealed now.");
    }
    if (playerId !== this.activePlayerId) {
      throw new GameRuleError("Only the active player can lock in.");
    }

    const timeline = this.#timeline(playerId);
    const gapIndex = this.#current.selectedGap;
    const previousYear = timeline[gapIndex - 1]?.year ?? -Infinity;
    const nextYear = timeline[gapIndex]?.year ?? Infinity;
    const year = this.#current.track.year;
    const correct = year >= previousYear && year <= nextYear;

    if (correct) {
      timeline.splice(gapIndex, 0, this.#current.track);
    }

    this.#current.phase = "revealed";
    this.#current.outcome = {
      correct,
      previousYear: Number.isFinite(previousYear) ? previousYear : null,
      nextYear: Number.isFinite(nextYear) ? nextYear : null,
    };

    if (correct && timeline.length >= this.#winningTimelineSize) {
      this.#status = "finished";
      this.#winners = [playerId];
    }

    return structuredClone(this.#current.outcome);
  }

  nextRound(playerId: string, hostId: string): void {
    if (this.#status !== "playing" || this.#current?.phase !== "revealed") {
      throw new GameRuleError("Finish the current round first.");
    }
    if (playerId !== this.activePlayerId && playerId !== hostId) {
      throw new GameRuleError("Only the active player or host can continue.");
    }

    this.#turnIndex = (this.#turnIndex + 1) % this.#turnOrder.length;
    this.#startRound();
  }

  removePlayer(playerId: string): void {
    const removedIndex = this.#turnOrder.indexOf(playerId);
    if (removedIndex < 0) return;

    const removedActivePlayer = removedIndex === this.#turnIndex;
    this.#turnOrder.splice(removedIndex, 1);
    this.#timelines.delete(playerId);
    this.#players = this.#players.filter((player) => player.id !== playerId);

    if (this.#turnOrder.length === 0) {
      this.#status = "finished";
      this.#winners = [];
      return;
    }

    if (removedIndex < this.#turnIndex) this.#turnIndex -= 1;
    if (this.#turnIndex >= this.#turnOrder.length) this.#turnIndex = 0;

    if (removedActivePlayer && this.#current?.phase === "listening") {
      this.#current.selectedGap = defaultGap(
        this.#timeline(this.activePlayerId),
      );
    }

    if (this.#turnOrder.length === 1) {
      this.#status = "finished";
      this.#winners = [...this.#turnOrder];
    }
  }

  finish(): void {
    if (this.#status === "finished") return;
    this.#finishByScore();
  }

  snapshot(): GameSnapshot {
    const current =
      this.#current == null
        ? null
        : {
            phase: this.#current.phase,
            selectedGap: this.#current.selectedGap,
            outcome: structuredClone(this.#current.outcome),
            track:
              this.#current.phase === "revealed"
                ? publicTrack(this.#current.track)
                : null,
          };

    return {
      status: this.#status,
      roundNumber: this.#roundNumber,
      activePlayerId: this.activePlayerId,
      turnOrder: [...this.#turnOrder],
      timelines: Object.fromEntries(
        this.#turnOrder.map((playerId) => [
          playerId,
          (this.#timelines.get(playerId) ?? []).map(publicTrack),
        ]),
      ),
      current,
      remainingTrackCount: this.#deck.length,
      winners: [...this.#winners],
      scores: Object.fromEntries(
        this.#turnOrder.map((playerId) => [
          playerId,
          this.#timelines.get(playerId)?.length ?? 0,
        ]),
      ),
    };
  }
}
