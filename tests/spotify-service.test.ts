import assert from "node:assert/strict";
import test from "node:test";
import {
  parseSpotifyPlaylistId,
  SpotifyService,
} from "../server/spotify-service.js";
import type { SpotifySession } from "../server/session-store.js";

function response(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function connectedSession(): SpotifySession {
  return {
    accessToken: "access",
    refreshToken: "refresh",
    expiresAt: Date.now() + 60 * 60 * 1000,
    displayName: "Maya",
    accountId: "account",
  };
}

test("Spotify playlist links and URIs are parsed without accepting other hosts", () => {
  assert.equal(
    parseSpotifyPlaylistId(
      "https://open.spotify.com/playlist/37i9dQZF1DX4JAvHpjipBk?si=test",
    ),
    "37i9dQZF1DX4JAvHpjipBk",
  );
  assert.equal(
    parseSpotifyPlaylistId("spotify:playlist:37i9dQZF1DX4JAvHpjipBk"),
    "37i9dQZF1DX4JAvHpjipBk",
  );
  assert.throws(() =>
    parseSpotifyPlaylistId(
      "https://example.com/playlist/37i9dQZF1DX4JAvHpjipBk",
    ),
  );
});

test("Spotify metadata remains authoritative when a playlist is imported", async () => {
  const requests: string[] = [];
  const fetchImpl = (async (input: string | URL | Request) => {
    const url = String(input);
    requests.push(url);
    if (url.endsWith("/playlists/playlist123")) {
      return response({ name: "Friday room" });
    }
    return response({
      items: [
        {
          item: {
            id: "track123",
            type: "track",
            name: "The Song",
            duration_ms: 201000,
            artists: [{ name: "The Artist" }],
            album: {
              release_date: "1987-05-01",
              images: [
                { url: "https://images.example/small.jpg", width: 64 },
                { url: "https://images.example/large.jpg", width: 640 },
              ],
            },
            external_ids: { isrc: "ABC123" },
            external_urls: {
              spotify: "https://open.spotify.com/track/track123",
            },
          },
        },
      ],
      next: null,
    });
  }) as typeof fetch;
  const service = new SpotifyService({
    clientId: "client",
    clientSecret: "secret",
    redirectUri: "http://127.0.0.1/callback",
    fetchImpl,
  });

  const playlist = await service.importPlaylist(
    connectedSession(),
    "https://open.spotify.com/playlist/playlist123",
  );

  assert.equal(requests.length, 2);
  assert.equal(playlist.name, "Friday room");
  assert.deepEqual(playlist.tracks[0], {
    id: "spotify-track123",
    title: "The Song",
    artist: "The Artist",
    year: 1987,
    originalYear: 1987,
    coverUrl: "https://images.example/large.jpg",
    audioCue: "spotify:track123",
    durationMs: 201000,
    isrc: "ABC123",
    spotifyUrl: "https://open.spotify.com/track/track123",
  });
});

test("Spotify explains the owned-or-collaborative playlist restriction", async () => {
  const service = new SpotifyService({
    clientId: "client",
    clientSecret: "secret",
    redirectUri: "http://127.0.0.1/callback",
    fetchImpl: (async () =>
      response({ error: { message: "Forbidden" } }, 403)) as typeof fetch,
  });

  await assert.rejects(
    () =>
      service.importPlaylist(
        connectedSession(),
        "spotify:playlist:playlist123",
      ),
    (error: unknown) =>
      error instanceof Error &&
      "code" in error &&
      error.code === "PLAYLIST_FORBIDDEN",
  );
});
