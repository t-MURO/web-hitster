import { execFile } from "node:child_process";
import { randomBytes, randomInt } from "node:crypto";
import { mkdir, rm, stat } from "node:fs/promises";
import path from "node:path";
import type {
  MediaDiagnostics,
  MediaToolStatus,
  Track,
} from "../shared/types.js";

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

interface MediaPreparationOptions {
  roomCode: string;
  tracks: Track[];
  maximumSuccesses?: number;
  onResult: (result: MediaPreparationResult) => void | Promise<void>;
}

export interface YouTubeCandidate {
  id: string;
  title: string;
  duration: number | null;
  uploader: string;
  liveStatus: string | null;
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

type PreparationMode = "youtube" | "generated";

const SEARCH_RESULT_COUNT = 8;
const TOKEN_STOP_WORDS = new Set([
  "a",
  "an",
  "and",
  "audio",
  "by",
  "feat",
  "featuring",
  "ft",
  "music",
  "official",
  "the",
  "video",
]);
const UNWANTED_VARIANTS = [
  "cover",
  "instrumental",
  "karaoke",
  "live",
  "nightcore",
  "reaction",
  "remix",
  "slowed",
  "sped up",
];

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

function randomlyOrdered<T>(items: readonly T[]): T[] {
  const result = [...items];
  for (let index = result.length - 1; index > 0; index -= 1) {
    const swapIndex = randomInt(index + 1);
    const current = result[index];
    const replacement = result[swapIndex];
    if (current === undefined || replacement === undefined) continue;
    [result[index], result[swapIndex]] = [replacement, current];
  }
  return result;
}

function conciseCommandError(error: unknown, executable: string): string {
  if (error instanceof Error) {
    const withCode = error as Error & { code?: string; stderr?: string };
    if (withCode.code === "ENOENT") {
      return `${executable} is not installed on this server.`;
    }
    if (withCode.name === "AbortError") return "Preparation was cancelled.";
    const stderr = withCode.stderr?.replace(/\s+/g, " ").trim();
    if (stderr) return stderr.slice(0, 240);
    return error.message.replace(/\s+/g, " ").trim().slice(0, 240);
  }
  return "The audio processor failed for this track.";
}

function youtubeFfmpegLocation(ffmpegPath: string): string[] {
  return path.basename(ffmpegPath) === ffmpegPath
    ? []
    : ["--ffmpeg-location", ffmpegPath];
}

function normalized(value: string): string {
  return value
    .normalize("NFKD")
    .replace(/\p{Diacritic}/gu, "")
    .toLowerCase()
    .replace(/&/g, " and ")
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

function tokens(value: string): Set<string> {
  return new Set(
    normalized(value)
      .split(/\s+/)
      .filter((token) => token.length > 1 && !TOKEN_STOP_WORDS.has(token)),
  );
}

function matchRatio(needles: Set<string>, haystack: Set<string>): number {
  if (!needles.size) return 0;
  return (
    [...needles].filter((token) => haystack.has(token)).length / needles.size
  );
}

function candidateScore(track: Track, candidate: YouTubeCandidate): number {
  if (
    !/^[A-Za-z0-9_-]{6,20}$/.test(candidate.id) ||
    candidate.liveStatus === "is_live" ||
    candidate.liveStatus === "is_upcoming" ||
    (candidate.duration != null &&
      (candidate.duration < 20 || candidate.duration > 20 * 60))
  ) {
    return -Infinity;
  }

  const candidateText = `${candidate.title} ${candidate.uploader}`;
  const candidateTokens = tokens(candidateText);
  const titleRatio = matchRatio(tokens(track.title), candidateTokens);
  const artistRatio = matchRatio(tokens(track.artist), candidateTokens);
  let score = titleRatio * 58 + artistRatio * 34;

  if (titleRatio < 0.5 || artistRatio === 0) score -= 35;
  const sourceText = normalized(`${track.title} ${track.artist}`);
  const resultText = normalized(candidateText);
  for (const variant of UNWANTED_VARIANTS) {
    if (resultText.includes(variant) && !sourceText.includes(variant)) {
      score -= 28;
    }
  }

  if (/\b(topic|vevo)\b/.test(resultText)) score += 5;
  if (/\bofficial\b/.test(resultText)) score += 3;

  if (track.durationMs && candidate.duration != null) {
    const expectedSeconds = track.durationMs / 1000;
    const difference = Math.abs(candidate.duration - expectedSeconds);
    const closeWindow = Math.max(10, expectedSeconds * 0.08);
    const rejectionWindow = Math.max(45, expectedSeconds * 0.3);
    if (difference <= closeWindow) score += 20;
    else if (difference <= rejectionWindow) score += 5;
    else score -= 45;
  }

  return score;
}

export function selectYouTubeCandidate(
  track: Track,
  candidates: YouTubeCandidate[],
): YouTubeCandidate | null {
  const ranked = candidates
    .map((candidate) => ({
      candidate,
      score: candidateScore(track, candidate),
    }))
    .sort((left, right) => right.score - left.score);
  const best = ranked[0];
  return best && best.score >= 48 ? best.candidate : null;
}

function parseCandidates(stdout: string): YouTubeCandidate[] {
  let payload: unknown;
  try {
    payload = JSON.parse(stdout);
  } catch {
    throw new Error("YouTube search returned invalid data.");
  }
  const entries =
    typeof payload === "object" && payload !== null
      ? (payload as { entries?: unknown }).entries
      : null;
  if (!Array.isArray(entries)) return [];

  return entries.flatMap((entry): YouTubeCandidate[] => {
    if (typeof entry !== "object" || entry === null) return [];
    const item = entry as Record<string, unknown>;
    const id = typeof item.id === "string" ? item.id : "";
    const title = typeof item.title === "string" ? item.title : "";
    if (!id || !title) return [];
    return [
      {
        id,
        title,
        duration:
          typeof item.duration === "number" ? item.duration : null,
        uploader:
          typeof item.uploader === "string"
            ? item.uploader
            : typeof item.channel === "string"
              ? item.channel
              : "",
        liveStatus:
          typeof item.live_status === "string" ? item.live_status : null,
      },
    ];
  });
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

  async diagnostics(): Promise<MediaDiagnostics> {
    const [youtubeDownloader, ffmpeg] = await Promise.all([
      this.#toolStatus(this.#downloaderPath, ["--version"]),
      this.#toolStatus(this.#ffmpegPath, ["-version"]),
    ]);
    return { youtubeDownloader, ffmpeg };
  }

  preparePlaylist(options: MediaPreparationOptions): Promise<void> {
    return this.#prepareBatch({ ...options, mode: "youtube", reset: true });
  }

  prepareAdditional(options: MediaPreparationOptions): Promise<void> {
    return this.#prepareBatch({ ...options, mode: "youtube", reset: false });
  }

  prepareGeneratedPlaylist(options: MediaPreparationOptions): Promise<void> {
    return this.#prepareBatch({ ...options, mode: "generated", reset: true });
  }

  prepareAdditionalGenerated(options: MediaPreparationOptions): Promise<void> {
    return this.#prepareBatch({ ...options, mode: "generated", reset: false });
  }

  async #prepareBatch({
    roomCode,
    tracks,
    onResult,
    mode,
    reset,
    maximumSuccesses,
  }: {
    roomCode: string;
    tracks: Track[];
    onResult: (result: MediaPreparationResult) => void | Promise<void>;
    mode: PreparationMode;
    reset: boolean;
    maximumSuccesses?: number;
  }): Promise<void> {
    if (reset) {
      await this.cleanupRoom(roomCode);
    } else if (this.#jobs.has(roomCode)) {
      throw new Error("Audio preparation is already running for this room.");
    }

    const job: PreparationJob = {
      id: randomBytes(12).toString("hex"),
      controller: new AbortController(),
    };
    this.#jobs.set(roomCode, job);
    const roomDirectory = this.#roomDirectory(roomCode);
    await mkdir(roomDirectory, { recursive: true, mode: 0o700 });
    if (reset || !this.#entries.has(roomCode)) {
      this.#entries.set(roomCode, new Map());
    }

    const queue = randomlyOrdered(tracks);
    let cursor = 0;
    let successful = 0;
    const worker = async () => {
      while (cursor < queue.length && !job.controller.signal.aborted) {
        const index = cursor;
        cursor += 1;
        const track = queue[index];
        if (!track) continue;

        let result: MediaPreparationResult;
        try {
          const audio =
            mode === "generated"
              ? await this.#prepareGeneratedTrack(
                  roomCode,
                  roomDirectory,
                  track,
                  index,
                  job.controller.signal,
                )
              : await this.#prepareYouTubeTrack(
                  roomCode,
                  roomDirectory,
                  track,
                  job.controller.signal,
                  true,
                );
          if (
            job.controller.signal.aborted ||
            this.#jobs.get(roomCode)?.id !== job.id
          ) {
            await rm(audio.filePath, { force: true });
            return;
          }
          if (
            maximumSuccesses != null &&
            successful >= maximumSuccesses
          ) {
            await rm(audio.filePath, { force: true });
            job.controller.abort();
            return;
          }
          successful += 1;
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
            error: conciseCommandError(
              error,
              mode === "generated" ? this.#ffmpegPath : this.#downloaderPath,
            ),
          };
        }
        await onResult(result);
        if (
          result.audio &&
          maximumSuccesses != null &&
          successful >= maximumSuccesses
        ) {
          job.controller.abort();
        }
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

  async #prepareYouTubeTrack(
    roomCode: string,
    roomDirectory: string,
    track: Track,
    signal: AbortSignal,
    retryOnce = false,
  ): Promise<PreparedAudio> {
    try {
      return await this.#downloadYouTubeTrack(
        roomCode,
        roomDirectory,
        track,
        signal,
      );
    } catch (error) {
      if (!retryOnce || signal.aborted) throw error;
      return this.#downloadYouTubeTrack(
        roomCode,
        roomDirectory,
        track,
        signal,
      );
    }
  }

  async #downloadYouTubeTrack(
    roomCode: string,
    roomDirectory: string,
    track: Track,
    signal: AbortSignal,
  ): Promise<PreparedAudio> {
    const query = `${track.title} ${track.artist}`;
    const search = await this.#run(
      this.#downloaderPath,
      [
        "--quiet",
        "--no-warnings",
        "--skip-download",
        "--flat-playlist",
        "--dump-single-json",
        "--playlist-end",
        String(SEARCH_RESULT_COUNT),
        `ytsearch${SEARCH_RESULT_COUNT}:${query}`,
      ],
      { signal },
    );
    const candidate = selectYouTubeCandidate(track, parseCandidates(search.stdout));
    if (!candidate) {
      throw new Error(
        "YouTube found no close title, artist, and duration match.",
      );
    }

    const outputTemplate = path.join(
      roomDirectory,
      `${safeSegment(track.id)}.%(ext)s`,
    );
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
        "--format",
        `bestaudio[abr<=${this.#bitrateKbps}]/bestaudio`,
        "--extract-audio",
        "--audio-format",
        "mp3",
        "--audio-quality",
        `${this.#bitrateKbps}K`,
        ...youtubeFfmpegLocation(this.#ffmpegPath),
        "--output",
        outputTemplate,
        "--print",
        "after_move:%(filepath)s",
        `https://www.youtube.com/watch?v=${candidate.id}`,
      ],
      { signal },
    );
    const filePath = stdout
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean)
      .at(-1);
    return this.#preparedAudio({
      roomCode,
      track,
      roomDirectory,
      filePath,
      youtubeVideoId: candidate.id,
    });
  }

  async #prepareGeneratedTrack(
    roomCode: string,
    roomDirectory: string,
    track: Track,
    index: number,
    signal: AbortSignal,
  ): Promise<PreparedAudio> {
    const filePath = path.join(roomDirectory, `${safeSegment(track.id)}.mp3`);
    const frequency = 220 + (index % 24) * 18;
    await this.#run(
      this.#ffmpegPath,
      [
        "-hide_banner",
        "-loglevel",
        "error",
        "-f",
        "lavfi",
        "-i",
        `sine=frequency=${frequency}:duration=12`,
        "-af",
        "afade=t=in:st=0:d=0.15,afade=t=out:st=11.5:d=0.5",
        "-b:a",
        `${this.#bitrateKbps}k`,
        "-y",
        filePath,
      ],
      { signal },
    );
    return this.#preparedAudio({
      roomCode,
      track,
      roomDirectory,
      filePath,
      youtubeVideoId: null,
    });
  }

  async #preparedAudio({
    roomCode,
    track,
    roomDirectory,
    filePath,
    youtubeVideoId,
  }: {
    roomCode: string;
    track: Track;
    roomDirectory: string;
    filePath: string | undefined;
    youtubeVideoId: string | null;
  }): Promise<PreparedAudio> {
    const resolvedPath = path.resolve(filePath ?? "");
    const relative = path.relative(roomDirectory, resolvedPath);
    if (
      !resolvedPath ||
      relative.startsWith("..") ||
      path.isAbsolute(relative) ||
      path.extname(resolvedPath).toLowerCase() !== ".mp3"
    ) {
      throw new Error("The audio processor did not return a safe MP3 file.");
    }
    const file = await stat(resolvedPath);
    if (!file.isFile() || file.size === 0) {
      throw new Error("The audio processor returned an empty file.");
    }
    return {
      roomCode,
      trackId: track.id,
      filePath: resolvedPath,
      size: file.size,
      mimeType: "audio/mpeg",
      youtubeVideoId,
    };
  }

  async #toolStatus(
    executable: string,
    arguments_: string[],
  ): Promise<MediaToolStatus> {
    try {
      const result = await this.#run(executable, arguments_, {
        signal: AbortSignal.timeout(10_000),
      });
      const version =
        result.stdout
          .split(/\r?\n/)
          .map((line) => line.trim())
          .find(Boolean)
          ?.slice(0, 120) ?? null;
      return { available: true, version, message: null };
    } catch (error) {
      return {
        available: false,
        version: null,
        message: conciseCommandError(error, executable),
      };
    }
  }

  #roomDirectory(roomCode: string): string {
    const safeCode = safeSegment(roomCode.toUpperCase());
    if (!safeCode) throw new Error("A valid room code is required.");
    return path.join(this.#root, safeCode);
  }
}
