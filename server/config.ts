import type { AppConfig } from "../shared/types.js";
import os from "node:os";
import path from "node:path";

const DEFAULT_PORT = 4317;

function asBoolean(value: string | undefined, fallback = false): boolean {
  if (value == null || value === "") return fallback;
  return ["1", "true", "yes", "on"].includes(value.toLowerCase());
}

function trimTrailingSlash(value: string): string {
  return value.replace(/\/+$/, "");
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  const port = Number.parseInt(env.PORT ?? String(DEFAULT_PORT), 10);
  const publicBaseUrl = trimTrailingSlash(
    env.PUBLIC_BASE_URL ?? `http://127.0.0.1:${port}`,
  );
  const isProduction = env.NODE_ENV === "production";

  return {
    port,
    publicBaseUrl,
    isProduction,
    demoMode: asBoolean(env.DEMO_MODE, !isProduction),
    sessionSecret: env.SESSION_SECRET ?? "development-only-change-me",
    cookieSecure: asBoolean(
      env.COOKIE_SECURE,
      publicBaseUrl.startsWith("https://"),
    ),
    disconnectGraceMs: Number.parseInt(env.DISCONNECT_GRACE_MS ?? "120000", 10),
    deckSize: Number.parseInt(env.DECK_SIZE ?? "50", 10),
    winningTimelineSize: Number.parseInt(
      env.WINNING_TIMELINE_SIZE ?? "10",
      10,
    ),
    spotifyClientId: env.SPOTIFY_CLIENT_ID?.trim() ?? "",
    spotifyClientSecret: env.SPOTIFY_CLIENT_SECRET?.trim() ?? "",
    spotifyRedirectUri:
      env.SPOTIFY_REDIRECT_URI?.trim() ??
      `${publicBaseUrl}/api/spotify/callback`,
    youtubeDownloaderPath: env.YOUTUBE_DOWNLOADER_PATH?.trim() || "yt-dlp",
    ffmpegPath: env.FFMPEG_PATH?.trim() || "ffmpeg",
    audioTempRoot:
      env.AUDIO_TEMP_ROOT?.trim() ||
      path.join(os.tmpdir(), "music-timeline-audio"),
    audioBitrateKbps: Number.parseInt(env.AUDIO_BITRATE_KBPS ?? "192", 10),
    audioPreparationConcurrency: Number.parseInt(
      env.AUDIO_PREPARATION_CONCURRENCY ?? "2",
      10,
    ),
  };
}

export function validateConfig(config: AppConfig): string[] {
  const errors: string[] = [];

  if (!Number.isInteger(config.port) || config.port < 1 || config.port > 65535) {
    errors.push("PORT must be a valid TCP port.");
  }

  if (
    config.isProduction &&
    (!config.sessionSecret ||
      config.sessionSecret === "development-only-change-me")
  ) {
    errors.push(
      "SESSION_SECRET must be set to a strong random value in production.",
    );
  }

  if (config.deckSize < 12) {
    errors.push("DECK_SIZE must be at least 12.");
  }

  if (Boolean(config.spotifyClientId) !== Boolean(config.spotifyClientSecret)) {
    errors.push(
      "SPOTIFY_CLIENT_ID and SPOTIFY_CLIENT_SECRET must either both be set or both be empty.",
    );
  }

  if (
    config.audioBitrateKbps != null &&
    (!Number.isInteger(config.audioBitrateKbps) ||
      config.audioBitrateKbps < 64 ||
      config.audioBitrateKbps > 320)
  ) {
    errors.push("AUDIO_BITRATE_KBPS must be between 64 and 320.");
  }

  if (
    config.audioPreparationConcurrency != null &&
    (!Number.isInteger(config.audioPreparationConcurrency) ||
      config.audioPreparationConcurrency < 1 ||
      config.audioPreparationConcurrency > 5)
  ) {
    errors.push("AUDIO_PREPARATION_CONCURRENCY must be between 1 and 5.");
  }

  return errors;
}
