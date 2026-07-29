import { execFile } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdir, rm, stat } from "node:fs/promises";
import path from "node:path";
import type { Track } from "../shared/types.js";

export interface PreparedAudio {
  roomCode: string;
  trackId: string;
  filePath: string;
  size: number;
  mimeType: "audio/mpeg";
  youtubeVideoId: string | null;
}

export interface MediaPreparationResult {
  track: Track;
  audio: PreparedAudio | null;
  error: string | null;
}

export type MediaCommandRunner = (
  executable: string,
  arguments_: string[],
  options: { signal: AbortSignal },
) => Promise<{ stdout: string; stderr: string }>;

interface PreparationJob {
  id: string;
  controller: AbortController;
}

function defaultCommandRunner(
  executable: string,
  arguments_: string[],
  options: { signal: AbortSignal },
): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    execFile(
      executable,
      arguments_,
      {
        encoding: "utf8",
        maxBuffer: 4 * 1024 * 1024,
        signal: options.signal,
      },
      (error, stdout, stderr) => {
        if (error) {
          reject(
            Object.assign(error, {
              stdout: String(stdout ?? ""),
              stderr: String(stderr ?? ""),
            }),
          );
          return;
        }
        resolve({
          stdout: String(stdout ?? ""),
          stderr: String(stderr ?? ""),
        });
      },
    );
  });
}

function safeSegment(value: string): string {
  return value.replace(/[^A-Za-z0-9_-]/g, "_").slice(0, 96);
}

function conciseCommandError(error: unknown, executable: string): string {
  if (error instanceof Error) {
    const withCode = error as Error & { code?: string };
    if (withCode.code === "ENOENT") {
      return `${executable} is not installed on this server.`;
    }
    if (withCode.name === "AbortError") return "Preparation was cancelled.";
    return error.message.replace(/\s+/g, " ").trim().slice(0, 240);
  }
  return "The audio processor failed for this track.";
}

export class MediaLibrary {
  readonly #root: string;
  readonly #downloaderPath: string;
  readonly #ffmpegPath: string;
  readonly #bitrateKbps: number;
  readonly #concurrency: number;
  readonly #run: MediaCommandRunner;
  readonly #entries = new Map<string, Map<string, PreparedAudio>>();
  readonly #jobs = new Map<string, PreparationJob>();

  constructor({
    root,
    downloaderPath = "yt-dlp",
    ffmpegPath = "ffmpeg",
    bitrateKbps = 192,
    concurrency = 2,
    run = defaultCommandRunner,
  }: {
    root: string;
    downloaderPath?: string;
    ffmpegPath?: string;
    bitrateKbps?: number;
    concurrency?: number;
    run?: MediaCommandRunner;
  }) {
    const resolvedRoot = path.resolve(root);
    if (
      resolvedRoot === path.parse(resolvedRoot).root ||
      resolvedRoot.length < 8
    ) {
      throw new Error("AUDIO_TEMP_ROOT must point to a dedicated subdirectory.");
    }
    this.#root = resolvedRoot;
    this.#downloaderPath = downloaderPath;
    this.#ffmpegPath = ffmpegPath;
    this.#bitrateKbps = bitrateKbps;
    this.#concurrency = concurrency;
    this.#run = run;
  }

  async initialize(): Promise<void> {
    await rm(this.#root, { recursive: true, force: true });
    await mkdir(this.#root, { recursive: true, mode: 0o700 });
  }

  get(roomCode: string, trackId: string): PreparedAudio | null {
    return this.#entries.get(roomCode)?.get(trackId) ?? null;
  }

  async preparePlaylist({
    roomCode,
    tracks,
    onResult,
  }: {
    roomCode: string;
    tracks: Track[];
    onResult: (result: MediaPreparationResult) => void | Promise<void>;
  }): Promise<void> {
    await this.cleanupRoom(roomCode);
    const job: PreparationJob = {
      id: randomBytes(12).toString("hex"),
      controller: new AbortController(),
    };
    this.#jobs.set(roomCode, job);

    const roomDirectory = this.#roomDirectory(roomCode);
    await mkdir(roomDirectory, { recursive: true, mode: 0o700 });
    this.#entries.set(roomCode, new Map());

    let cursor = 0;
    const worker = async () => {
      while (cursor < tracks.length && !job.controller.signal.aborted) {
        const index = cursor;
        cursor += 1;
        const track = tracks[index];
        if (!track) continue;

        let result: MediaPreparationResult;
        try {
          const audio = await this.#prepareTrack(
            roomCode,
            roomDirectory,
            track,
            job.controller.signal,
          );
          if (this.#jobs.get(roomCode)?.id !== job.id) return;
          this.#entries.get(roomCode)?.set(track.id, audio);
          result = { track, audio, error: null };
        } catch (error) {
          if (
            job.controller.signal.aborted ||
            this.#jobs.get(roomCode)?.id !== job.id
          ) {
            return;
          }
          result = {
            track,
            audio: null,
            error: conciseCommandError(error, this.#downloaderPath),
          };
        }
        await onResult(result);
      }
    };

    try {
      await Promise.all(
        Array.from(
          { length: Math.min(this.#concurrency, tracks.length) },
          () => worker(),
        ),
      );
    } finally {
      if (this.#jobs.get(roomCode)?.id === job.id) {
        this.#jobs.delete(roomCode);
      }
    }
  }

  async cleanupRoom(roomCode: string): Promise<void> {
    const job = this.#jobs.get(roomCode);
    if (job) {
      job.controller.abort();
      this.#jobs.delete(roomCode);
    }
    this.#entries.delete(roomCode);
    await rm(this.#roomDirectory(roomCode), {
      recursive: true,
      force: true,
    });
  }

  async close(): Promise<void> {
    for (const job of this.#jobs.values()) job.controller.abort();
    this.#jobs.clear();
    this.#entries.clear();
    await rm(this.#root, { recursive: true, force: true });
  }

  async #prepareTrack(
    roomCode: string,
    roomDirectory: string,
    track: Track,
    signal: AbortSignal,
  ): Promise<PreparedAudio> {
    const stem = safeSegment(track.id);
    const outputTemplate = path.join(roomDirectory, `${stem}.%(ext)s`);
    const query = `${track.title} ${track.artist} official audio`;
    const { stdout } = await this.#run(
      this.#downloaderPath,
      [
        "--no-playlist",
        "--quiet",
        "--no-warnings",
        "--socket-timeout",
        "20",
        "--retries",
        "3",
        "--extract-audio",
        "--audio-format",
        "mp3",
        "--audio-quality",
        `${this.#bitrateKbps}K`,
        "--ffmpeg-location",
        this.#ffmpegPath,
        "--output",
        outputTemplate,
        "--print",
        "before_dl:%(id)s",
        "--print",
        "after_move:%(filepath)s",
        `ytsearch1:${query}`,
      ],
      { signal },
    );

    const lines = stdout
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean);
    const filePath = path.resolve(lines.at(-1) ?? "");
    const relative = path.relative(roomDirectory, filePath);
    if (
      !filePath ||
      relative.startsWith("..") ||
      path.isAbsolute(relative) ||
      path.extname(filePath).toLowerCase() !== ".mp3"
    ) {
      throw new Error("The audio processor did not return a safe MP3 file.");
    }
    const file = await stat(filePath);
    if (!file.isFile() || file.size === 0) {
      throw new Error("The audio processor returned an empty file.");
    }

    return {
      roomCode,
      trackId: track.id,
      filePath,
      size: file.size,
      mimeType: "audio/mpeg",
      youtubeVideoId: lines.length > 1 ? (lines[0] ?? null) : null,
    };
  }

  #roomDirectory(roomCode: string): string {
    const safeCode = safeSegment(roomCode.toUpperCase());
    if (!safeCode) throw new Error("A valid room code is required.");
    return path.join(this.#root, safeCode);
  }
}
