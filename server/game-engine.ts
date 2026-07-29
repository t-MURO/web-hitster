import type {
  GamePhase,
  GamePlayer,
  GameSnapshot,
  GameStatus,
  PublicTrack,
  RoundChallengeSnapshot,
  RoundOutcome,
  Track,
} from "../shared/types.js";

interface CurrentRound {
  track: Track;
  phase: GamePhase;
  selectedGap: number;
  challenges: RoundChallengeSnapshot[];
  challengePasses: Set<string>;
  guess: { title: string; artist: string } | null;
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

function gapBounds(
  timeline: readonly Track[],
  gapIndex: number,
): { previousYear: number; nextYear: number } {
  return {
    previousYear: timeline[gapIndex - 1]?.year ?? -Infinity,
    nextYear: timeline[gapIndex]?.year ?? Infinity,
  };
}

function isCorrectGap(
  timeline: readonly Track[],
  gapIndex: number,
  year: number,
): boolean {
  const { previousYear, nextYear } = gapBounds(timeline, gapIndex);
  return year >= previousYear && year <= nextYear;
}

function insertionGap(timeline: readonly Track[], year: number): number {
  const firstLaterTrack = timeline.findIndex((track) => track.year > year);
  return firstLaterTrack < 0 ? timeline.length : firstLaterTrack;
}

function normalizedAnswer(value: string): string {
  return value
    .normalize("NFKD")
    .replace(/\p{Diacritic}/gu, "")
    .toLowerCase()
    .replace(/&/g, " and ")
    .replace(/\b(feat|ft)\.?\b/g, " featuring ")
    .replace(/[^a-z0-9]+/g, " ")
    .trim()
    .replace(/\s+/g, " ");
}

function baseTitle(value: string): string {
  return normalizedAnswer(value.replace(/\s*[\[(].*?[\])]\s*$/g, ""));
}

function titleMatches(guess: string, answer: string): boolean {
  const normalizedGuess = normalizedAnswer(guess);
  return (
    normalizedGuess === normalizedAnswer(answer) ||
    normalizedGuess === baseTitle(answer)
  );
}

function artistMatches(guess: string, answer: string): boolean {
  const normalizedGuess = normalizedAnswer(guess);
  if (normalizedGuess === normalizedAnswer(answer)) return true;
  return answer
    .split(/\s*(?:,|&|\bfeat\.?\b|\bft\.?\b|\bfeaturing\b)\s*/i)
    .some((artist) => normalizedAnswer(artist) === normalizedGuess);
}

export class TimelineGame {
  #players: GamePlayer[] = [];
  #turnOrder: string[] = [];
  #timelines = new Map<string, Track[]>();
  #deck: Track[] = [];
  #knownTrackIds = new Set<string>();
  #tokens = new Map<string, number>();
  #skipNextTurn = new Set<string>();
  #turnIndex = 0;
  #roundNumber = 0;
  #current: CurrentRound | null = null;
  #status: GameStatus = "playing";
  #winners: string[] = [];
  #winningTimelineSize = 10;
  #maximumTrackCount = Number.POSITIVE_INFINITY;
  #acceptingTracks = false;
  #random: () => number = Math.random;

  static create({
    players,
    tracks,
    random = Math.random,
    winningTimelineSize = 10,
    maximumTrackCount = Number.POSITIVE_INFINITY,
    acceptingTracks = false,
  }: {
    players: GamePlayer[];
    tracks: Track[];
    random?: () => number;
    winningTimelineSize?: number;
    maximumTrackCount?: number;
    acceptingTracks?: boolean;
  }): TimelineGame {
    if (players.length < 2 || players.length > 5) {
      throw new GameRuleError("A game needs between 2 and 5 players.");
    }
    if (tracks.length <= players.length) {
      throw new GameRuleError("The deck does not have enough tracks to start.");
    }

    const game = new TimelineGame();
    game.#players = structuredClone(players);
    game.#turnOrder = players.map((player) => player.id);
    game.#winningTimelineSize = winningTimelineSize;
    game.#maximumTrackCount = maximumTrackCount;
    game.#acceptingTracks = acceptingTracks;
    game.#random = random;
    game.#tokens = new Map(players.map((player) => [player.id, 2]));

    const shuffledTracks = shuffled(tracks, random);
    game.#knownTrackIds = new Set(shuffledTracks.map((track) => track.id));
    for (const playerId of game.#turnOrder) {
      const startingCard = shuffledTracks.shift();
      if (!startingCard) {
        throw new GameRuleError("The deck does not have enough starting cards.");
      }
      game.#timelines.set(playerId, [startingCard]);
    }
    const oldestStartingYear = Math.min(
      ...game.#turnOrder.map(
        (playerId) => game.#timelines.get(playerId)?.[0]?.year ?? Infinity,
      ),
    );
    const startingPlayerIndex = game.#turnOrder.findIndex(
      (playerId) =>
        game.#timelines.get(playerId)?.[0]?.year === oldestStartingYear,
    );
    if (startingPlayerIndex > 0) {
      game.#turnOrder = [
        ...game.#turnOrder.slice(startingPlayerIndex),
        ...game.#turnOrder.slice(0, startingPlayerIndex),
      ];
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
      this.#current = null;
      if (!this.#acceptingTracks) this.#finishWithoutWinner();
      return;
    }

    this.#roundNumber += 1;
    const timeline = this.#timeline(this.activePlayerId);
    this.#current = {
      track,
      phase: "listening",
      selectedGap: defaultGap(timeline),
      challenges: [],
      challengePasses: new Set(),
      guess: null,
      outcome: null,
    };
  }

  addTracks(tracks: readonly Track[]): number {
    if (this.#status !== "playing" || !this.#acceptingTracks) return 0;

    const capacity = Math.max(
      0,
      this.#maximumTrackCount - this.#knownTrackIds.size,
    );
    const additions = shuffled(
      tracks.filter((track) => !this.#knownTrackIds.has(track.id)),
      this.#random,
    ).slice(0, capacity);

    for (const track of additions) {
      this.#knownTrackIds.add(track.id);
      this.#deck.push(structuredClone(track));
    }
    if (!this.#current && additions.length > 0) this.#startRound();
    return additions.length;
  }

  closeTrackFeed(): void {
    this.#acceptingTracks = false;
    if (this.#status === "playing" && !this.#current && this.#deck.length === 0) {
      this.#finishWithoutWinner();
    }
  }

  #finishWithoutWinner(): void {
    this.#status = "finished";
    this.#winners = [];
  }

  #listeningRound(): CurrentRound {
    if (this.#status !== "playing" || this.#current?.phase !== "listening") {
      throw new GameRuleError("That action is only available while listening.");
    }
    return this.#current;
  }

  #activeListeningRound(playerId: string): CurrentRound {
    const round = this.#listeningRound();
    if (playerId !== this.activePlayerId) {
      throw new GameRuleError("Only the active player can do that.");
    }
    return round;
  }

  #spendTokens(playerId: string, amount: number): void {
    const tokens = this.#tokens.get(playerId) ?? 0;
    if (tokens < amount) {
      throw new GameRuleError(
        amount === 1
          ? "You have no music tokens left."
          : `You need ${amount} music tokens for that.`,
      );
    }
    this.#tokens.set(playerId, tokens - amount);
  }

  #finishIfWinner(playerId: string): void {
    if (this.#timeline(playerId).length < this.#winningTimelineSize) return;
    this.#status = "finished";
    this.#winners = [playerId];
  }

  submitGuess(playerId: string, title: string, artist: string): void {
    const round = this.#activeListeningRound(playerId);
    const cleanTitle = title.trim().slice(0, 120);
    const cleanArtist = artist.trim().slice(0, 120);
    if (!normalizedAnswer(cleanTitle) || !normalizedAnswer(cleanArtist)) {
      throw new GameRuleError("Enter both the song title and artist.");
    }
    round.guess = { title: cleanTitle, artist: cleanArtist };
  }

  skipTrack(playerId: string): void {
    this.#activeListeningRound(playerId);
    if (this.#deck.length === 0) {
      throw new GameRuleError("The next song is not ready yet.");
    }
    this.#spendTokens(playerId, 1);
    this.#startRound();
  }

  tradeTokensForCard(playerId: string): RoundOutcome {
    const round = this.#listeningRound();
    if (!this.#turnOrder.includes(playerId)) {
      throw new GameRuleError("That player is not in this game.");
    }
    this.#spendTokens(playerId, 3);

    const timeline = this.#timeline(playerId);
    const gapIndex = insertionGap(timeline, round.track.year);
    const { previousYear, nextYear } = gapBounds(timeline, gapIndex);
    timeline.splice(gapIndex, 0, round.track);
    this.#skipNextTurn.add(playerId);
    round.selectedGap = gapIndex;
    round.phase = "revealed";
    round.outcome = {
      resolution: "token-trade",
      correct: true,
      previousYear: Number.isFinite(previousYear) ? previousYear : null,
      nextYear: Number.isFinite(nextYear) ? nextYear : null,
      awardedPlayerId: playerId,
      winningChallengePlayerId: null,
      guessCorrect: null,
      tokenAwarded: false,
    };
    this.#finishIfWinner(playerId);
    return structuredClone(round.outcome);
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

  lockPlacement(playerId: string): void {
    if (this.#status !== "playing" || this.#current?.phase !== "listening") {
      throw new GameRuleError("This placement cannot be locked now.");
    }
    if (playerId !== this.activePlayerId) {
      throw new GameRuleError("Only the active player can lock in.");
    }
    this.#current.phase = "challenging";
  }

  challengeGap(playerId: string, gapIndex: number): void {
    if (this.#status !== "playing" || this.#current?.phase !== "challenging") {
      throw new GameRuleError("Challenges are not open right now.");
    }
    if (playerId === this.activePlayerId) {
      throw new GameRuleError("You cannot challenge your own placement.");
    }
    if (!this.#turnOrder.includes(playerId)) {
      throw new GameRuleError("That player is not in this game.");
    }

    const timeline = this.#timeline(this.activePlayerId);
    if (
      !Number.isInteger(gapIndex) ||
      gapIndex < 0 ||
      gapIndex > timeline.length
    ) {
      throw new GameRuleError("That timeline position does not exist.");
    }
    if (gapIndex === this.#current.selectedGap) {
      throw new GameRuleError("Choose a different position to challenge.");
    }
    const existing = this.#current.challenges.find(
      (challenge) => challenge.playerId === playerId,
    );
    if (existing?.gapIndex === gapIndex) {
      this.#current.challenges = this.#current.challenges.filter(
        (challenge) => challenge.playerId !== playerId,
      );
      this.#tokens.set(
        playerId,
        Math.min(5, (this.#tokens.get(playerId) ?? 0) + 1),
      );
      return;
    }
    const occupied = this.#current.challenges.find(
      (challenge) =>
        challenge.gapIndex === gapIndex && challenge.playerId !== playerId,
    );
    if (occupied) {
      throw new GameRuleError("Another player already challenged that position.");
    }

    if (existing) {
      existing.gapIndex = gapIndex;
      return;
    }

    if (this.#current.challengePasses.has(playerId)) {
      throw new GameRuleError("You already passed on this challenge.");
    }
    this.#spendTokens(playerId, 1);
    this.#current.challenges.push({ playerId, gapIndex });
  }

  passChallenge(playerId: string): void {
    if (this.#status !== "playing" || this.#current?.phase !== "challenging") {
      throw new GameRuleError("Challenges are not open right now.");
    }
    if (playerId === this.activePlayerId) {
      throw new GameRuleError("The active player cannot pass for opponents.");
    }
    if (!this.#turnOrder.includes(playerId)) {
      throw new GameRuleError("That player is not in this game.");
    }
    if (
      this.#current.challenges.some(
        (challenge) => challenge.playerId === playerId,
      )
    ) {
      throw new GameRuleError("Your challenge is already placed.");
    }
    this.#current.challengePasses.add(playerId);
  }

  reveal(
    playerId: string,
    hostId = playerId,
    challengePlayerIds: readonly string[] = [],
  ): RoundOutcome {
    if (this.#status !== "playing" || !this.#current) {
      throw new GameRuleError("This round cannot be revealed now.");
    }
    if (this.#current.phase === "listening") {
      this.lockPlacement(playerId);
    }
    if (this.#current.phase !== "challenging") {
      throw new GameRuleError("This round cannot be revealed now.");
    }
    if (playerId !== this.activePlayerId && playerId !== hostId) {
      throw new GameRuleError("Only the active player or host can reveal.");
    }
    const pendingChallengePlayer = challengePlayerIds.find(
      (candidateId) =>
        candidateId !== this.activePlayerId &&
        !this.#current?.challengePasses.has(candidateId) &&
        !this.#current?.challenges.some(
          (challenge) => challenge.playerId === candidateId,
        ),
    );
    if (pendingChallengePlayer) {
      throw new GameRuleError(
        "Wait for every connected opponent to challenge or pass.",
      );
    }

    const activePlayerId = this.activePlayerId;
    if (!activePlayerId) {
      throw new GameRuleError("There is no active player.");
    }
    const timeline = this.#timeline(activePlayerId);
    const gapIndex = this.#current.selectedGap;
    const { previousYear, nextYear } = gapBounds(timeline, gapIndex);
    const year = this.#current.track.year;
    const correct = isCorrectGap(timeline, gapIndex, year);
    const guessCorrect = this.#current.guess
      ? titleMatches(this.#current.guess.title, this.#current.track.title) &&
        artistMatches(this.#current.guess.artist, this.#current.track.artist)
      : null;
    let tokenAwarded = false;
    if (guessCorrect) {
      const tokens = this.#tokens.get(activePlayerId) ?? 0;
      if (tokens < 5) {
        this.#tokens.set(activePlayerId, tokens + 1);
        tokenAwarded = true;
      }
    }
    let awardedPlayerId: string | null = null;
    let winningChallengePlayerId: string | null = null;

    if (correct) {
      timeline.splice(gapIndex, 0, this.#current.track);
      awardedPlayerId = activePlayerId;
    } else {
      const winningChallenge = this.#current.challenges.find((challenge) =>
        isCorrectGap(timeline, challenge.gapIndex, year),
      );
      if (winningChallenge) {
        const winnerTimeline = this.#timeline(winningChallenge.playerId);
        winnerTimeline.splice(
          insertionGap(winnerTimeline, year),
          0,
          this.#current.track,
        );
        awardedPlayerId = winningChallenge.playerId;
        winningChallengePlayerId = winningChallenge.playerId;
      }
    }

    this.#current.phase = "revealed";
    this.#current.outcome = {
      resolution: "placement",
      correct,
      previousYear: Number.isFinite(previousYear) ? previousYear : null,
      nextYear: Number.isFinite(nextYear) ? nextYear : null,
      awardedPlayerId,
      winningChallengePlayerId,
      guessCorrect,
      tokenAwarded,
    };

    if (awardedPlayerId) this.#finishIfWinner(awardedPlayerId);

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
    let skippedPlayers = 0;
    while (
      this.activePlayerId &&
      this.#skipNextTurn.has(this.activePlayerId) &&
      skippedPlayers < this.#turnOrder.length
    ) {
      this.#skipNextTurn.delete(this.activePlayerId);
      this.#turnIndex = (this.#turnIndex + 1) % this.#turnOrder.length;
      skippedPlayers += 1;
    }
    this.#startRound();
  }

  removePlayer(playerId: string): void {
    const removedIndex = this.#turnOrder.indexOf(playerId);
    if (removedIndex < 0) return;

    const removedActivePlayer = removedIndex === this.#turnIndex;
    this.#turnOrder.splice(removedIndex, 1);
    this.#timelines.delete(playerId);
    this.#tokens.delete(playerId);
    this.#skipNextTurn.delete(playerId);
    this.#players = this.#players.filter((player) => player.id !== playerId);
    if (this.#current) {
      this.#current.challenges = this.#current.challenges.filter(
        (challenge) => challenge.playerId !== playerId,
      );
      this.#current.challengePasses.delete(playerId);
    }

    if (this.#turnOrder.length === 0) {
      this.#status = "finished";
      this.#winners = [];
      return;
    }

    if (removedIndex < this.#turnIndex) this.#turnIndex -= 1;
    if (this.#turnIndex >= this.#turnOrder.length) this.#turnIndex = 0;

    if (removedActivePlayer && this.#current) {
      this.#current.phase = "listening";
      this.#current.challenges = [];
      this.#current.challengePasses.clear();
      this.#current.guess = null;
      this.#current.outcome = null;
      this.#current.selectedGap = defaultGap(
        this.#timeline(this.activePlayerId),
      );
    }

    if (this.#turnOrder.length === 1) {
      this.#status = "finished";
      this.#winners = [];
    }
  }

  finish(): void {
    if (this.#status === "finished") return;
    this.#finishWithoutWinner();
  }

  snapshot(): GameSnapshot {
    const current =
      this.#current == null
        ? null
        : {
            phase: this.#current.phase,
            selectedGap: this.#current.selectedGap,
            challenges: structuredClone(this.#current.challenges),
            challengePasses: [...this.#current.challengePasses],
            guessSubmitted: this.#current.guess !== null,
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
      tokens: Object.fromEntries(
        this.#turnOrder.map((playerId) => [
          playerId,
          this.#tokens.get(playerId) ?? 0,
        ]),
      ),
      skippingNextTurnPlayerIds: [...this.#skipNextTurn],
    };
  }
}
