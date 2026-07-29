export const AVATAR_KEYS = ["maya", "leo", "sofia", "ben", "nora"] as const;

export type AvatarKey = (typeof AVATAR_KEYS)[number];
export type GamePhase = "listening" | "revealed";
export type GameStatus = "playing" | "finished";
export type PlaybackStatus = "ready" | "playing" | "paused";
export type RoomStatus = "lobby" | "playing" | "finished";

export interface PlayerProfile {
  displayName: string;
  avatarKey: AvatarKey;
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
}

export type ClientConfig = Pick<
  AppConfig,
  "demoMode" | "deckSize" | "winningTimelineSize" | "disconnectGraceMs"
>;

export interface Track {
  id: string;
  title: string;
  artist: string;
  year: number;
  originalYear: number;
  coverUrl: string | null;
  audioCue: string;
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
  correct: boolean;
  previousYear: number | null;
  nextYear: number | null;
}

export interface CurrentRoundSnapshot {
  phase: GamePhase;
  selectedGap: number;
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
  source: "upload" | "demo";
  trackCount: number;
  ready: boolean;
}

export interface PlaybackSnapshot {
  status: PlaybackStatus;
  cueVersion: number;
  changedAt: number;
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
  deck: DeckSummary | null;
  deckReview: Track[] | null;
  playback: PlaybackSnapshot;
  hostCue: Track | null;
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
