import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { DeckError, parseDeck } from "../server/deck-parser.js";

test("the downloadable CSV template produces a valid 50-track deck", async () => {
  const text = await readFile(
    new URL("../public/deck-template.csv", import.meta.url),
    "utf8",
  );
  const tracks = parseDeck(text, { minimumTracks: 50 });

  assert.equal(tracks.length, 50);
  assert.equal(tracks[0]?.title, "Track 01");
  assert.equal(tracks[49]?.year, 2019);
  assert.equal(tracks[0]?.coverUrl, null);
});

test("JSON decks support an object with a tracks array", () => {
  const text = JSON.stringify({
    tracks: Array.from({ length: 12 }, (_, index) => ({
      title: `Song ${index}`,
      artist: `Artist ${index}`,
      year: 1980 + index,
      audioCue: `Cue ${index}`,
    })),
  });

  assert.equal(parseDeck(text).length, 12);
});

test("duplicate title, artist, and year combinations are rejected", () => {
  const rows = Array.from({ length: 12 }, (_, index) => ({
    title: index < 2 ? "Same song" : `Song ${index}`,
    artist: index < 2 ? "Same artist" : `Artist ${index}`,
    year: index < 2 ? 2001 : 1980 + index,
    audioCue: `Cue ${index}`,
  }));

  assert.throws(
    () => parseDeck(JSON.stringify(rows)),
    (error) => error instanceof DeckError && error.code === "DUPLICATE_TRACK",
  );
});
