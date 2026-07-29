export const AVATAR_KEYS = ["maya", "leo", "sofia", "ben", "nora"] as const;

export type AvatarKey = (typeof AVATAR_KEYS)[number];
export type GamePhase = "listening" | "challenging" | "revealed";
export type GameStatus = "playing" | "finished";
export type PlaybackStatus = "ready" | "playing" | "paused";
export type RoomStatus = "lobby" | "playing" | "finished";

export interface PlayerProfile {
  displayName: string;
  avatarKey: AvatarKey;
  avatarUrl?: string | null;
}

export interface AppConfig {
  port: number;
  publicBaseUrl: string;
  isProduction: boolean;
  demoMode: boolean;
  sessionSecret: string;
  cookieSecure: boolean;
  disconnectGraceMs: number;
  deckSize: number;
  winningTimelineSize: number;
  spotifyClientId?: string;
  spotifyClientSecret?: string;
  spotifyRedirectUri?: string;
  youtubeDownloaderPath?: string;
  ffmpegPath?: string;
  audioTempRoot?: string;
  audioBitrateKbps?: number;
  audioPreparationConcurrency?: number;
}

export interface ClientConfig {
  demoMode: boolean;
  deckSize: number;
  winningTimelineSize: number;
  disconnectGraceMs: number;
  spotifyConfigured: boolean;
}

export interface Track {
  id: string;
  title: string;
  artist: string;
  year: number;
  originalYear: number;
  coverUrl: string | null;
  audioCue: string;
  durationMs?: number | null;
  isrc?: string | null;
  spotifyUrl?: string | null;
}

export type PublicTrack = Pick<
  Track,
  "id" | "title" | "artist" | "year" | "coverUrl"
>;

export interface GamePlayer {
  id: string;
  displayName: string;
  avatarUrl: string;
}

export interface RoundOutcome {
  resolution: "placement" | "token-trade";
  correct: boolean;
  previousYear: number | null;
  nextYear: number | null;
  awardedPlayerId: string | null;
  winningChallengePlayerId: string | null;
  guessCorrect: boolean | null;
  tokenAwarded: boolean;
}

export interface RoundChallengeSnapshot {
  playerId: string;
  gapIndex: number;
}

export interface CurrentRoundSnapshot {
  phase: GamePhase;
  selectedGap: number;
  challenges: RoundChallengeSnapshot[];
  challengePasses: string[];
  guessSubmitted: boolean;
  outcome: RoundOutcome | null;
  track: PublicTrack | null;
}

export interface GameSnapshot {
  status: GameStatus;
  roundNumber: number;
  activePlayerId: string | null;
  turnOrder: string[];
  timelines: Record<string, PublicTrack[]>;
  current: CurrentRoundSnapshot | null;
  remainingTrackCount: number;
  winners: string[];
  scores: Record<string, number>;
  tokens: Record<string, number>;
  skippingNextTurnPlayerIds: string[];
}

export interface RoomPlayerSnapshot {
  id: string;
  displayName: string;
  avatarKey: AvatarKey;
  avatarUrl: string;
  connected: boolean;
  disconnectedAt: number | null;
  host: boolean;
  active: boolean;
  score: number;
}

export interface DeckSummary {
  name: string;
  source: "upload" | "demo" | "spotify" | "hosted-demo";
  audioMode: "external" | "hosted";
  trackCount: number;
  ready: boolean;
  preparation: DeckPreparationSnapshot | null;
}

export type DeckPreparationStatus =
  | "queued"
  | "processing"
  | "ready"
  | "failed";

export interface DeckFailureSnapshot {
  id: string;
  title: string;
  artist: string;
  reason: string;
  attempts: number;
  retryable: boolean;
}

export interface DeckPreparationSnapshot {
  status: DeckPreparationStatus;
  total: number;
  processed: number;
  readyCount: number;
  failedCount: number;
  failures: DeckFailureSnapshot[];
  retrying: boolean;
  currentTitle: string | null;
  message: string | null;
}

export interface MediaToolStatus {
  available: boolean;
  version: string | null;
  message: string | null;
}

export interface MediaDiagnostics {
  youtubeDownloader: MediaToolStatus;
  ffmpeg: MediaToolStatus;
}

export interface PlaybackSnapshot {
  status: PlaybackStatus;
  cueVersion: number;
  changedAt: number;
  roundNumber: number;
  startAt: number | null;
  positionMs: number;
  readyPlayerIds: string[];
}

export interface SpotifyConnectionSnapshot {
  configured: boolean;
  connected: boolean;
  displayName: string | null;
}

export interface SpotifyPlaylistSummary {
  id: string;
  name: string;
  description: string | null;
  imageUrl: string | null;
  ownerName: string;
  trackCount: number;
  collaborative: boolean;
  eligible: boolean;
  spotifyUrl: string;
}

export interface SpotifyPlaylistsResponse {
  playlists: SpotifyPlaylistSummary[];
}

export interface RoomRules {
  deckSize: number;
  winningTimelineSize: number;
  disconnectGraceMs: number;
}

export interface RoomSnapshot {
  code: string;
  status: RoomStatus;
  locked: boolean;
  hostId: string;
  viewerId: string;
  isHost: boolean;
  rematchNumber: number;
  rules: RoomRules;
  players: RoomPlayerSnapshot[];
  spotify: SpotifyConnectionSnapshot;
  deck: DeckSummary | null;
  playback: PlaybackSnapshot;
  hostCue: Pick<Track, "audioCue"> | null;
  game: GameSnapshot | null;
}

export interface SessionResponse {
  profile: PlayerProfile | null;
  roomCode: string | null;
  config: ClientConfig;
}

export interface PublicError {
  code: string;
  message: string;
}

export interface RoomActionResult {
  code: string | null;
  snapshot: RoomSnapshot | null;
  left?: boolean;
}

export type RoomActionResponse =
  | { ok: true; result: RoomActionResult }
  | { ok: false; error: PublicError };

export interface RoomAction {
  type: "create" | "join" | "resume" | "command";
  payload?: Record<string, unknown>;
}

export type RoomCommand = (
  type: string,
  payload?: Record<string, unknown>,
) => Promise<RoomActionResult>;
