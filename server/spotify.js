const SPOTIFY_API = "https://api.spotify.com/v1";
const SPOTIFY_ACCOUNTS = "https://accounts.spotify.com";

export const SPOTIFY_SCOPES = [
  "user-read-private",
  "playlist-read-private",
  "playlist-read-collaborative",
  "user-read-playback-state",
  "user-modify-playback-state",
];

export class SpotifyError extends Error {
  constructor(message, { code = "SPOTIFY_ERROR", status = 500, retryAfter = null } = {}) {
    super(message);
    this.name = "SpotifyError";
    this.code = code;
    this.status = status;
    this.retryAfter = retryAfter;
  }
}

function parseJson(text) {
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

function spotifyMessage(payload, fallback) {
  return payload?.error?.message ?? payload?.error_description ?? fallback;
}

function normalizeProfile(profile) {
  return {
    id: profile.id,
    displayName: profile.display_name || profile.id,
    avatarUrl: profile.images?.[0]?.url ?? null,
    externalUrl: profile.external_urls?.spotify ?? null,
  };
}

function normalizePlaylist(playlist, currentUserId) {
  const ownerId = playlist.owner?.id ?? null;
  return {
    id: playlist.id,
    name: playlist.name,
    collaborative: Boolean(playlist.collaborative),
    ownerId,
    ownerName: playlist.owner?.display_name || ownerId || "Spotify",
    ownedByCurrentUser: ownerId === currentUserId,
    imageUrl: playlist.images?.[0]?.url ?? null,
    externalUrl: playlist.external_urls?.spotify ?? null,
    snapshotId: playlist.snapshot_id ?? null,
    totalItems: playlist.items?.total ?? playlist.tracks?.total ?? null,
  };
}

function normalizeTrack(entry) {
  const track = entry?.item ?? entry?.track;
  if (
    !track ||
    track.type !== "track" ||
    track.is_local ||
    entry?.is_local ||
    !track.id ||
    !track.uri
  ) {
    return null;
  }

  const releaseDate = track.album?.release_date ?? "";
  const year = Number.parseInt(releaseDate.slice(0, 4), 10);
  if (!Number.isInteger(year) || year < 1900 || year > 2100) return null;

  return {
    id: track.id,
    uri: track.uri,
    title: track.name,
    artist: (track.artists ?? []).map((artist) => artist.name).join(", "),
    album: track.album?.name ?? "",
    year,
    originalYear: year,
    releaseDate,
    releaseDatePrecision: track.album?.release_date_precision ?? "year",
    imageUrl: track.album?.images?.[0]?.url ?? null,
    externalUrl:
      track.external_urls?.spotify ?? track.album?.external_urls?.spotify ?? null,
  };
}

export class SpotifyClient {
  #clientId;
  #clientSecret;
  #redirectUri;
  #fetch;
  #trackCache = new Map();

  constructor({ clientId, clientSecret, publicBaseUrl, fetchImpl = fetch }) {
    this.#clientId = clientId;
    this.#clientSecret = clientSecret;
    this.#redirectUri = `${publicBaseUrl}/api/auth/callback`;
    this.#fetch = fetchImpl;
  }

  get redirectUri() {
    return this.#redirectUri;
  }

  authorizationUrl(state) {
    const url = new URL(`${SPOTIFY_ACCOUNTS}/authorize`);
    url.search = new URLSearchParams({
      response_type: "code",
      client_id: this.#clientId,
      scope: SPOTIFY_SCOPES.join(" "),
      redirect_uri: this.#redirectUri,
      state,
      show_dialog: "true",
    });
    return url.toString();
  }

  async #tokenRequest(parameters) {
    const response = await this.#fetch(`${SPOTIFY_ACCOUNTS}/api/token`, {
      method: "POST",
      headers: {
        Authorization: `Basic ${Buffer.from(
          `${this.#clientId}:${this.#clientSecret}`,
        ).toString("base64")}`,
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: new URLSearchParams(parameters),
    });
    const text = await response.text();
    const payload = parseJson(text);

    if (!response.ok) {
      throw new SpotifyError(
        spotifyMessage(payload, "Spotify authorization failed."),
        { code: "SPOTIFY_AUTH_FAILED", status: response.status },
      );
    }

    return payload;
  }

  async completeLogin(session, code) {
    const tokens = await this.#tokenRequest({
      grant_type: "authorization_code",
      code,
      redirect_uri: this.#redirectUri,
    });

    session.spotify = {
      accessToken: tokens.access_token,
      refreshToken: tokens.refresh_token,
      expiresAt: Date.now() + tokens.expires_in * 1000,
      scope: tokens.scope ?? SPOTIFY_SCOPES.join(" "),
      profile: null,
    };

    const profile = await this.#request(session, "/me");
    session.spotify.profile = normalizeProfile(profile);
    return session.spotify.profile;
  }

  async #refresh(session) {
    if (!session.spotify?.refreshToken) {
      throw new SpotifyError("Spotify sign-in has expired.", {
        code: "SPOTIFY_REAUTH_REQUIRED",
        status: 401,
      });
    }

    const tokens = await this.#tokenRequest({
      grant_type: "refresh_token",
      refresh_token: session.spotify.refreshToken,
    });

    session.spotify.accessToken = tokens.access_token;
    session.spotify.expiresAt = Date.now() + tokens.expires_in * 1000;
    if (tokens.refresh_token) session.spotify.refreshToken = tokens.refresh_token;
  }

  async #request(session, pathOrUrl, options = {}, allowRefresh = true) {
    if (!session.spotify) {
      throw new SpotifyError("Sign in with Spotify first.", {
        code: "SPOTIFY_REAUTH_REQUIRED",
        status: 401,
      });
    }

    if (session.spotify.expiresAt < Date.now() + 60_000) {
      await this.#refresh(session);
    }

    const url = pathOrUrl.startsWith("http")
      ? pathOrUrl
      : `${SPOTIFY_API}${pathOrUrl}`;
    if (!url.startsWith(SPOTIFY_API)) {
      throw new SpotifyError("Refused an unexpected Spotify endpoint.");
    }

    const response = await this.#fetch(url, {
      method: options.method ?? "GET",
      headers: {
        Authorization: `Bearer ${session.spotify.accessToken}`,
        ...(options.body ? { "Content-Type": "application/json" } : {}),
      },
      body: options.body ? JSON.stringify(options.body) : undefined,
    });

    if (response.status === 401 && allowRefresh) {
      await this.#refresh(session);
      return this.#request(session, pathOrUrl, options, false);
    }

    const text = await response.text();
    const payload = parseJson(text);
    if (!response.ok) {
      const reason = payload?.error?.reason;
      const retryAfter = Number.parseInt(response.headers.get("retry-after") ?? "", 10);
      let code = "SPOTIFY_REQUEST_FAILED";
      if (response.status === 401) code = "SPOTIFY_REAUTH_REQUIRED";
      if (response.status === 403) code = "SPOTIFY_FORBIDDEN";
      if (response.status === 404) code = "SPOTIFY_DEVICE_UNAVAILABLE";
      if (response.status === 429) {
        code = reason === "QUOTA_EXCEEDED"
          ? "SPOTIFY_QUOTA_EXCEEDED"
          : "SPOTIFY_RATE_LIMITED";
      }

      throw new SpotifyError(
        spotifyMessage(payload, `Spotify request failed (${response.status}).`),
        {
          code,
          status: response.status,
          retryAfter: Number.isInteger(retryAfter) ? retryAfter : null,
        },
      );
    }

    return payload;
  }

  async getPlaylists(session) {
    const playlists = [];
    let next = `${SPOTIFY_API}/me/playlists?limit=50`;

    while (next) {
      const page = await this.#request(session, next);
      playlists.push(...(page.items ?? []));
      next = page.next;
    }

    const currentUserId = session.spotify.profile.id;
    return playlists
      .map((playlist) => normalizePlaylist(playlist, currentUserId))
      .filter(
        (playlist) => playlist.ownedByCurrentUser || playlist.collaborative,
      )
      .sort((left, right) => left.name.localeCompare(right.name));
  }

  async getPlaylistTracks(session, playlistId, snapshotId = "current") {
    const cacheKey = `${playlistId}:${snapshotId || "current"}`;
    if (this.#trackCache.has(cacheKey)) {
      return structuredClone(this.#trackCache.get(cacheKey));
    }

    const entries = [];
    let next = `${SPOTIFY_API}/playlists/${encodeURIComponent(
      playlistId,
    )}/items?limit=50`;

    while (next) {
      const page = await this.#request(session, next);
      entries.push(...(page.items ?? []));
      next = page.next;
    }

    const tracks = [];
    const seen = new Set();
    for (const entry of entries) {
      const track = normalizeTrack(entry);
      if (!track || seen.has(track.uri)) continue;
      seen.add(track.uri);
      tracks.push(track);
    }

    this.#trackCache.set(cacheKey, tracks);
    return structuredClone(tracks);
  }

  async getDevices(session) {
    const payload = await this.#request(session, "/me/player/devices");
    return (payload.devices ?? []).map((device) => ({
      id: device.id,
      name: device.name,
      type: device.type,
      active: Boolean(device.is_active),
      restricted: Boolean(device.is_restricted),
    }));
  }

  async startTrack(session, { uri, deviceId }) {
    const query = deviceId
      ? `?device_id=${encodeURIComponent(deviceId)}`
      : "";
    await this.#request(session, `/me/player/play${query}`, {
      method: "PUT",
      body: { uris: [uri], position_ms: 0 },
    });
  }

  async pause(session, { deviceId }) {
    const query = deviceId
      ? `?device_id=${encodeURIComponent(deviceId)}`
      : "";
    await this.#request(session, `/me/player/pause${query}`, {
      method: "PUT",
    });
  }
}

const DEMO_NAMES = ["Maya", "Leo", "Sofia", "Ben", "Nora"];
const DEMO_AVATARS = ["maya", "leo", "sofia", "ben", "nora"];
const DEMO_COVERS = [1977, 1984, 1999, 2013];

export function createDemoProfile(persona = "maya") {
  const index = Math.max(0, DEMO_AVATARS.indexOf(persona));
  return {
    id: `demo-${DEMO_AVATARS[index]}`,
    displayName: DEMO_NAMES[index],
    avatarUrl: `/assets/avatars/${DEMO_AVATARS[index]}.png`,
    externalUrl: "https://open.spotify.com/",
  };
}

function demoTracks() {
  return Array.from({ length: 64 }, (_, index) => {
    const year = 1962 + index;
    const cover = DEMO_COVERS[index % DEMO_COVERS.length];
    return {
      id: `demo-track-${index + 1}`,
      uri: `spotify:track:demo${String(index + 1).padStart(3, "0")}`,
      title: `Demo Track ${index + 1}`,
      artist: `Studio Artist ${(index % 9) + 1}`,
      album: `Listening Room Vol. ${(index % 7) + 1}`,
      year,
      originalYear: year,
      releaseDate: String(year),
      releaseDatePrecision: "year",
      imageUrl: `/assets/covers/cover-${cover}.png`,
      externalUrl: "https://open.spotify.com/",
    };
  });
}

export class DemoSpotifyClient {
  constructor({ publicBaseUrl }) {
    this.redirectUri = `${publicBaseUrl}/api/auth/callback`;
  }

  authorizationUrl() {
    return "/?demoSignIn=1";
  }

  async getPlaylists() {
    return [
      {
        id: "demo-playlist",
        name: "The Listening Room · 64 songs",
        collaborative: false,
        ownerId: "demo",
        ownerName: "Music Timeline",
        ownedByCurrentUser: true,
        imageUrl: "/assets/covers/cover-2013.png",
        externalUrl: "https://open.spotify.com/",
        snapshotId: "demo-v1",
        totalItems: 64,
      },
    ];
  }

  async getPlaylistTracks() {
    return demoTracks();
  }

  async getDevices() {
    return [
      {
        id: "demo-desktop",
        name: "Spotify Desktop · Demo",
        type: "computer",
        active: true,
        restricted: false,
      },
    ];
  }

  async startTrack() {}

  async pause() {}
}
