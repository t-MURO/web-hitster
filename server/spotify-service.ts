import type { SpotifyPlaylistSummary, Track } from "../shared/types.js";
import type { SpotifySession } from "./session-store.js";

const SPOTIFY_ACCOUNTS_URL = "https://accounts.spotify.com";
const SPOTIFY_API_URL = "https://api.spotify.com/v1";
const MAX_PLAYLIST_ITEMS_INSPECTED = 500;
const MAX_ELIGIBLE_TRACKS = 200;
const PLAYLIST_SCOPES = [
  "playlist-read-private",
  "playlist-read-collaborative",
];

interface SpotifyTokenResponse {
  access_token?: string;
  refresh_token?: string;
  expires_in?: number;
}

interface SpotifyProfileResponse {
  account_id?: string;
  id?: string;
  display_name?: string;
}

interface SpotifyImage {
  url?: string;
  width?: number | null;
}

interface SpotifyPlaylistResponse {
  id?: string;
  name?: string;
  description?: string | null;
  collaborative?: boolean;
  external_urls?: { spotify?: string };
  images?: SpotifyImage[];
  owner?: {
    id?: string;
    display_name?: string | null;
  };
  items?: {
    total?: number;
  };
  tracks?: {
    total?: number;
  };
}

interface SpotifyPlaylistsPage {
  items?: SpotifyPlaylistResponse[];
  next?: string | null;
}

interface SpotifyArtist {
  name?: string;
}

interface SpotifyAlbum {
  release_date?: string;
  images?: SpotifyImage[];
}

interface SpotifyTrackItem {
  id?: string;
  name?: string;
  type?: string;
  is_local?: boolean;
  duration_ms?: number;
  artists?: SpotifyArtist[];
  album?: SpotifyAlbum;
  external_ids?: { isrc?: string };
  external_urls?: { spotify?: string };
}

interface SpotifyPlaylistItem {
  item?: SpotifyTrackItem | null;
  track?: SpotifyTrackItem | null;
}

interface SpotifyPlaylistItemsResponse {
  items?: SpotifyPlaylistItem[];
  next?: string | null;
}

export interface SpotifyPlaylistImport {
  id: string;
  name: string;
  tracks: Track[];
  rejections: SpotifyPlaylistRejection[];
}

export interface SpotifyPlaylistRejection {
  id: string;
  title: string;
  artist: string;
  reason: string;
}

export class SpotifyError extends Error {
  readonly code: string;

  constructor(message: string, code = "SPOTIFY_ERROR") {
    super(message);
    this.name = "SpotifyError";
    this.code = code;
  }
}

export function parseSpotifyPlaylistId(value: unknown): string {
  const input = String(value ?? "").trim();
  const uriMatch = /^spotify:playlist:([A-Za-z0-9]+)$/.exec(input);
  if (uriMatch?.[1]) return uriMatch[1];

  try {
    const url = new URL(input);
    if (
      url.protocol !== "https:" ||
      !["open.spotify.com", "www.open.spotify.com"].includes(url.hostname)
    ) {
      throw new Error("unsupported host");
    }
    const pathMatch = /^\/playlist\/([A-Za-z0-9]+)\/?$/.exec(url.pathname);
    if (pathMatch?.[1]) return pathMatch[1];
  } catch {
    // The public error below intentionally does not distinguish malformed URLs.
  }

  throw new SpotifyError(
    "Paste a Spotify playlist link, such as https://open.spotify.com/playlist/…",
    "INVALID_PLAYLIST_URL",
  );
}

function releaseYear(value: unknown): number | null {
  const match = /^(\d{4})/.exec(String(value ?? ""));
  if (!match?.[1]) return null;
  const year = Number.parseInt(match[1], 10);
  return year >= 1900 && year <= 2100 ? year : null;
}

function bestCover(images: SpotifyImage[] | undefined): string | null {
  if (!images?.length) return null;
  return (
    [...images]
      .sort((left, right) => (right.width ?? 0) - (left.width ?? 0))
      .find((image) => image.url)?.url ?? null
  );
}

async function responsePayload(response: Response): Promise<unknown> {
  const text = await response.text();
  if (!text) return null;
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return text;
  }
}

function spotifyMessage(payload: unknown, fallback: string): string {
  if (typeof payload === "object" && payload !== null) {
    const error = (payload as { error?: unknown }).error;
    if (typeof error === "string") return error;
    if (typeof error === "object" && error !== null) {
      const message = (error as { message?: unknown }).message;
      if (typeof message === "string" && message.trim()) return message;
    }
  }
  return fallback;
}

export class SpotifyService {
  readonly #clientId: string;
  readonly #clientSecret: string;
  readonly #redirectUri: string;
  readonly #fetch: typeof fetch;

  constructor({
    clientId,
    clientSecret,
    redirectUri,
    fetchImpl = fetch,
  }: {
    clientId: string;
    clientSecret: string;
    redirectUri: string;
    fetchImpl?: typeof fetch;
  }) {
    this.#clientId = clientId;
    this.#clientSecret = clientSecret;
    this.#redirectUri = redirectUri;
    this.#fetch = fetchImpl;
  }

  get configured(): boolean {
    return Boolean(this.#clientId && this.#clientSecret);
  }

  authorizationUrl(state: string): string {
    if (!this.configured) {
      throw new SpotifyError(
        "Spotify is not configured on this server.",
        "SPOTIFY_NOT_CONFIGURED",
      );
    }
    const url = new URL("/authorize", SPOTIFY_ACCOUNTS_URL);
    url.search = new URLSearchParams({
      client_id: this.#clientId,
      response_type: "code",
      redirect_uri: this.#redirectUri,
      scope: PLAYLIST_SCOPES.join(" "),
      state,
      show_dialog: "true",
    }).toString();
    return url.toString();
  }

  async exchangeCode(code: string): Promise<SpotifySession> {
    const token = await this.#tokenRequest(
      new URLSearchParams({
        grant_type: "authorization_code",
        code,
        redirect_uri: this.#redirectUri,
      }),
    );
    if (!token.access_token || !token.refresh_token) {
      throw new SpotifyError(
        "Spotify did not return a reusable login. Please try connecting again.",
        "SPOTIFY_LOGIN_FAILED",
      );
    }

    const profile = await this.#profile(token.access_token);
    return {
      accessToken: token.access_token,
      refreshToken: token.refresh_token,
      expiresAt: Date.now() + (token.expires_in ?? 3600) * 1000,
      displayName: profile.display_name?.trim() || null,
      accountId: profile.account_id ?? profile.id ?? null,
    };
  }

  async importPlaylist(
    spotify: SpotifySession,
    playlistValue: unknown,
  ): Promise<SpotifyPlaylistImport> {
    const playlistId = parseSpotifyPlaylistId(playlistValue);
    const playlist = await this.#authorizedJson<SpotifyPlaylistResponse>(
      spotify,
      `${SPOTIFY_API_URL}/playlists/${playlistId}`,
    );
    const tracks: Track[] = [];
    const rejections: SpotifyPlaylistRejection[] = [];
    const seen = new Set<string>();
    let itemIndex = 0;
    let next: string | null =
      `${SPOTIFY_API_URL}/playlists/${playlistId}/items?limit=50`;

    while (
      next &&
      tracks.length < MAX_ELIGIBLE_TRACKS &&
      itemIndex < MAX_PLAYLIST_ITEMS_INSPECTED
    ) {
      const page: SpotifyPlaylistItemsResponse =
        await this.#authorizedJson<SpotifyPlaylistItemsResponse>(spotify, next);
      for (const wrapper of page.items ?? []) {
        const item = wrapper.item ?? wrapper.track;
        itemIndex += 1;
        if (itemIndex > MAX_PLAYLIST_ITEMS_INSPECTED) break;
        const fallbackId = `spotify-rejected-${itemIndex}`;
        const itemId = item?.id ? `spotify-${item.id}` : fallbackId;
        const title = item?.name?.trim() || "Unavailable playlist item";
        const artist = (item?.artists ?? [])
          .map((entry) => entry.name?.trim())
          .filter((name): name is string => Boolean(name))
          .join(", ");
        if (!item) {
          rejections.push({
            id: itemId,
            title,
            artist: artist || "Unknown artist",
            reason: "Spotify reports that this playlist item is unavailable.",
          });
          continue;
        }
        if (item.type != null && item.type !== "track") continue;
        if (item.is_local) {
          rejections.push({
            id: itemId,
            title,
            artist: artist || "Unknown artist",
            reason: "Local Spotify files cannot be matched automatically.",
          });
          continue;
        }
        if (!item.id) {
          rejections.push({
            id: itemId,
            title,
            artist: artist || "Unknown artist",
            reason: "Spotify did not provide a usable track identifier.",
          });
          continue;
        }
        if (seen.has(item.id)) continue;
        seen.add(item.id);
        const year = releaseYear(item.album?.release_date);
        if (!year || !title || !artist) {
          rejections.push({
            id: itemId,
            title,
            artist: artist || "Unknown artist",
            reason: !year
              ? "Spotify did not provide a usable album release year."
              : "Spotify did not provide complete title and artist metadata.",
          });
          continue;
        }

        tracks.push({
          id: `spotify-${item.id}`,
          title,
          artist,
          year,
          originalYear: year,
          coverUrl: bestCover(item.album?.images),
          audioCue: `spotify:${item.id}`,
          durationMs:
            typeof item.duration_ms === "number" ? item.duration_ms : null,
          isrc: item.external_ids?.isrc ?? null,
          spotifyUrl:
            item.external_urls?.spotify ??
            `https://open.spotify.com/track/${item.id}`,
        });
        if (tracks.length >= MAX_ELIGIBLE_TRACKS) break;
      }

      next = this.#safeNext(page.next);
    }

    if (!tracks.length && !rejections.length) {
      throw new SpotifyError(
        "Spotify returned no eligible tracks. Use a playlist you own or collaborate on.",
        "PLAYLIST_EMPTY",
      );
    }

    return {
      id: playlistId,
      name: playlist.name?.trim() || "Spotify playlist",
      tracks,
      rejections,
    };
  }

  async listPlaylists(
    spotify: SpotifySession,
  ): Promise<SpotifyPlaylistSummary[]> {
    const playlists: SpotifyPlaylistSummary[] = [];
    const seen = new Set<string>();
    let next: string | null =
      `${SPOTIFY_API_URL}/me/playlists?limit=50&offset=0`;

    for (let pageNumber = 0; next && pageNumber < 4; pageNumber += 1) {
      const page: SpotifyPlaylistsPage =
        await this.#authorizedJson<SpotifyPlaylistsPage>(spotify, next);

      for (const playlist of page.items ?? []) {
        const id = playlist.id?.trim();
        const name = playlist.name?.trim();
        if (!id || !name || seen.has(id)) continue;
        seen.add(id);

        const ownerId = playlist.owner?.id?.trim() ?? "";
        const ownedByViewer = Boolean(
          spotify.accountId && ownerId === spotify.accountId,
        );
        const collaborative = playlist.collaborative === true;
        const hasAccessibleItems = playlist.items != null;
        const rawTrackCount =
          playlist.items?.total ?? playlist.tracks?.total ?? 0;
        const trackCount =
          Number.isInteger(rawTrackCount) && rawTrackCount >= 0
            ? rawTrackCount
            : 0;

        playlists.push({
          id,
          name,
          description: playlist.description?.trim() || null,
          imageUrl: bestCover(playlist.images),
          ownerName: ownedByViewer
            ? "You"
            : playlist.owner?.display_name?.trim() || "Spotify user",
          trackCount,
          collaborative,
          eligible: hasAccessibleItems || ownedByViewer || collaborative,
          spotifyUrl:
            playlist.external_urls?.spotify ??
            `https://open.spotify.com/playlist/${id}`,
        });
      }

      next = page.next ?? null;
    }

    return playlists;
  }

  async #profile(accessToken: string): Promise<SpotifyProfileResponse> {
    const response = await this.#request(`${SPOTIFY_API_URL}/me`, {
      headers: { Authorization: `Bearer ${accessToken}` },
    });
    const payload = await responsePayload(response);
    if (!response.ok) {
      throw new SpotifyError(
        spotifyMessage(payload, "Spotify could not load this account."),
        "SPOTIFY_LOGIN_FAILED",
      );
    }
    return (payload ?? {}) as SpotifyProfileResponse;
  }

  async #authorizedJson<T>(
    spotify: SpotifySession,
    url: string,
    refreshed = false,
  ): Promise<T> {
    if (spotify.expiresAt <= Date.now() + 30_000) {
      await this.#refresh(spotify);
    }

    const response = await this.#request(url, {
      headers: { Authorization: `Bearer ${spotify.accessToken}` },
    });
    const payload = await responsePayload(response);

    if (response.status === 401 && !refreshed) {
      await this.#refresh(spotify);
      return this.#authorizedJson<T>(spotify, url, true);
    }
    if (response.status === 403) {
      throw new SpotifyError(
        "Spotify only allows this app to read playlists you own or collaborate on.",
        "PLAYLIST_FORBIDDEN",
      );
    }
    if (response.status === 429) {
      throw new SpotifyError(
        "Spotify is rate-limiting playlist imports. Wait a moment and try again.",
        "SPOTIFY_RATE_LIMITED",
      );
    }
    if (response.status >= 500) {
      throw new SpotifyError(
        "Spotify is temporarily unavailable. Try the import again shortly.",
        "SPOTIFY_UNAVAILABLE",
      );
    }
    if (!response.ok) {
      throw new SpotifyError(
        spotifyMessage(payload, "Spotify could not load that playlist."),
        "SPOTIFY_REQUEST_FAILED",
      );
    }
    return payload as T;
  }

  async #refresh(spotify: SpotifySession): Promise<void> {
    const token = await this.#tokenRequest(
      new URLSearchParams({
        grant_type: "refresh_token",
        refresh_token: spotify.refreshToken,
      }),
    );
    if (!token.access_token) {
      throw new SpotifyError(
        "Your Spotify login has expired. Connect Spotify again.",
        "SPOTIFY_REAUTH_REQUIRED",
      );
    }
    spotify.accessToken = token.access_token;
    spotify.refreshToken = token.refresh_token ?? spotify.refreshToken;
    spotify.expiresAt = Date.now() + (token.expires_in ?? 3600) * 1000;
  }

  async #tokenRequest(body: URLSearchParams): Promise<SpotifyTokenResponse> {
    const authorization = Buffer.from(
      `${this.#clientId}:${this.#clientSecret}`,
    ).toString("base64");
    const response = await this.#request(`${SPOTIFY_ACCOUNTS_URL}/api/token`, {
      method: "POST",
      headers: {
        Authorization: `Basic ${authorization}`,
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body,
    });
    const payload = await responsePayload(response);
    if (!response.ok) {
      throw new SpotifyError(
        spotifyMessage(payload, "Spotify login could not be completed."),
        "SPOTIFY_LOGIN_FAILED",
      );
    }
    return (payload ?? {}) as SpotifyTokenResponse;
  }

  async #request(input: string, init: RequestInit): Promise<Response> {
    try {
      return await this.#fetch(input, {
        ...init,
        signal: AbortSignal.timeout(15_000),
      });
    } catch {
      throw new SpotifyError(
        "Spotify could not be reached. Check the server connection and try again.",
        "SPOTIFY_UNAVAILABLE",
      );
    }
  }

  #safeNext(value: string | null | undefined): string | null {
    if (!value) return null;
    try {
      const url = new URL(value);
      if (url.protocol === "https:" && url.hostname === "api.spotify.com") {
        return url.toString();
      }
    } catch {
      // Fall through to the same API error used for malformed Spotify data.
    }
    throw new SpotifyError(
      "Spotify returned an invalid playlist page.",
      "SPOTIFY_REQUEST_FAILED",
    );
  }
}
