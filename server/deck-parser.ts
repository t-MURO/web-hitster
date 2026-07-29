import { createHash } from "node:crypto";
import type { Track } from "../shared/types.js";

type DeckRow = Record<string, unknown>;

export class DeckError extends Error {
  readonly code: string;

  constructor(message: string, code = "INVALID_DECK") {
    super(message);
    this.name = "DeckError";
    this.code = code;
  }
}

function parseCsvRows(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let quoted = false;

  for (let index = 0; index < text.length; index += 1) {
    const character = text[index];

    if (quoted) {
      if (character === '"' && text[index + 1] === '"') {
        field += '"';
        index += 1;
      } else if (character === '"') {
        quoted = false;
      } else {
        field += character;
      }
      continue;
    }

    if (character === '"') {
      quoted = true;
    } else if (character === ",") {
      row.push(field);
      field = "";
    } else if (character === "\n") {
      row.push(field);
      rows.push(row);
      row = [];
      field = "";
    } else if (character !== "\r" && character != null) {
      field += character;
    }
  }

  if (quoted) throw new DeckError("The CSV contains an unclosed quoted field.");
  if (field || row.length) {
    row.push(field);
    rows.push(row);
  }

  return rows.filter((cells) => cells.some((cell) => cell.trim()));
}

function csvObjects(text: string): DeckRow[] {
  const rows = parseCsvRows(text);
  if (rows.length < 2) {
    throw new DeckError("The CSV needs a header and at least one track.");
  }

  const headers = rows[0]?.map((header) => header.trim()) ?? [];
  return rows.slice(1).map((row) =>
    Object.fromEntries(
      headers.map((header, index) => [header, row[index] ?? ""]),
    ),
  );
}

function isDeckRow(value: unknown): value is DeckRow {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parsedRows(text: string): DeckRow[] {
  const trimmed = text.trim();
  if (!trimmed) throw new DeckError("Choose a non-empty CSV or JSON deck.");

  if (trimmed.startsWith("[") || trimmed.startsWith("{")) {
    let payload: unknown;
    try {
      payload = JSON.parse(trimmed) as unknown;
    } catch {
      throw new DeckError("The JSON deck could not be parsed.");
    }
    const tracks = Array.isArray(payload)
      ? payload
      : isDeckRow(payload)
        ? payload.tracks
        : null;
    if (!Array.isArray(tracks) || !tracks.every(isDeckRow)) {
      throw new DeckError(
        "JSON decks must be an array or an object with a tracks array.",
      );
    }
    return tracks;
  }

  return csvObjects(trimmed);
}

function optionalUrl(
  value: unknown,
  field: string,
  rowNumber: number,
): string | null {
  const trimmed = String(value ?? "").trim();
  if (!trimmed) return null;
  try {
    const url = new URL(trimmed);
    if (!["http:", "https:"].includes(url.protocol)) throw new Error();
    return url.toString();
  } catch {
    throw new DeckError(
      `${field} on row ${rowNumber} must be an http(s) URL.`,
    );
  }
}

function rowValue(row: DeckRow, ...keys: string[]): unknown {
  for (const key of keys) {
    if (row[key] != null && row[key] !== "") return row[key];
  }
  return "";
}

function normalizeRow(
  row: DeckRow,
  index: number,
): Track & { fingerprint: string } {
  const rowNumber = index + 2;
  const title = String(rowValue(row, "title", "track", "name")).trim();
  const artist = String(rowValue(row, "artist", "artists")).trim();
  const year = Number.parseInt(
    String(rowValue(row, "year", "releaseYear")),
    10,
  );
  const audioCue = String(
    rowValue(row, "audioCue", "audio_cue", "cue", "source"),
  ).trim();

  if (!title) throw new DeckError(`Track title is missing on row ${rowNumber}.`);
  if (!artist) throw new DeckError(`Artist is missing on row ${rowNumber}.`);
  if (!Number.isInteger(year) || year < 1900 || year > 2100) {
    throw new DeckError(
      `Year on row ${rowNumber} must be between 1900 and 2100.`,
    );
  }
  if (!audioCue) {
    throw new DeckError(
      `Audio cue is missing on row ${rowNumber}. Use a URL or a private host note.`,
    );
  }

  const fingerprint = `${title.toLowerCase()}\0${artist.toLowerCase()}\0${year}`;
  return {
    id: createHash("sha256")
      .update(`${fingerprint}\0${index}`)
      .digest("hex")
      .slice(0, 16),
    fingerprint,
    title,
    artist,
    year,
    originalYear: year,
    coverUrl: optionalUrl(
      rowValue(row, "coverUrl", "cover_url", "cover", "image"),
      "Cover URL",
      rowNumber,
    ),
    audioCue,
  };
}

export function parseDeck(
  text: string,
  {
    minimumTracks = 12,
    maximumTracks = 500,
  }: { minimumTracks?: number; maximumTracks?: number } = {},
): Track[] {
  const rows = parsedRows(text);
  if (rows.length > maximumTracks) {
    throw new DeckError(`Decks may contain at most ${maximumTracks} tracks.`);
  }

  const normalized = rows.map(normalizeRow);
  const fingerprints = new Set<string>();
  const tracks = normalized.map(({ fingerprint, ...track }) => {
    if (fingerprints.has(fingerprint)) {
      throw new DeckError(
        `Duplicate track found: “${track.title}” by ${track.artist}.`,
        "DUPLICATE_TRACK",
      );
    }
    fingerprints.add(fingerprint);
    return track;
  });

  if (tracks.length < minimumTracks) {
    throw new DeckError(
      `The deck needs at least ${minimumTracks} unique tracks; it has ${tracks.length}.`,
      "DECK_TOO_SMALL",
    );
  }

  return tracks;
}

export function createDemoDeck(): Track[] {
  const covers = [1977, 1984, 1999, 2013] as const;
  return Array.from({ length: 64 }, (_, index) => {
    const year = 1962 + index;
    return {
      id: `demo-track-${String(index + 1).padStart(2, "0")}`,
      title: `Demo Track ${index + 1}`,
      artist: `Studio Artist ${(index % 9) + 1}`,
      year,
      originalYear: year,
      coverUrl: `/assets/covers/cover-${covers[index % covers.length]}.png`,
      audioCue: `Play track ${index + 1} from your private external playlist`,
    };
  });
}
