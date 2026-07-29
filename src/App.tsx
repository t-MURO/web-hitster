import {
  useEffect,
  useMemo,
  useState,
  type ChangeEvent,
  type CSSProperties,
  type FormEvent,
  type ReactNode,
} from "react";
import {
  ArrowLeft,
  ArrowRight,
  ArrowsClockwise,
  CaretDown,
  Check,
  Copy,
  Crown,
  DownloadSimple,
  FileCsv,
  Gear,
  Headphones,
  LinkSimple,
  Pause,
  Play,
  Plus,
  Question,
  SignOut,
  SpeakerHigh,
  SpeakerSlash,
  UploadSimple,
  UsersThree,
  Waveform,
  X,
} from "@phosphor-icons/react";
import "@fontsource/bebas-neue/400.css";
import "@fontsource/inter/400.css";
import "@fontsource/inter/500.css";
import "@fontsource/inter/600.css";
import { api } from "./api.js";
import {
  inviteCodeFromPath,
  normalizeRoomCode,
  roomInviteUrl,
} from "./room-url.js";
import { useRoom } from "./useRoom.js";
import {
  primeRoomAudio,
  useSynchronizedAudio,
} from "./useSynchronizedAudio.js";
import type {
  ClientConfig,
  CurrentRoundSnapshot,
  GameSnapshot,
  PlaybackSnapshot,
  PlayerProfile,
  PublicTrack,
  RoomCommand,
  RoomPlayerSnapshot,
  RoomSnapshot,
  SessionResponse,
  SpotifyPlaylistSummary,
  SpotifyPlaylistsResponse,
  Track,
} from "../shared/types.js";

const AVATARS = ["maya", "leo", "sofia", "ben", "nora"] as const;
const FALLBACK_COVERS = [1977, 1984, 1999, 2013];
const PLAYER_PROFILE_STORAGE_KEY = "webstar.player-profile.v1";
const MAX_PROFILE_PHOTO_BYTES = 128 * 1024;
const MAX_PROFILE_PHOTO_DATA_URL_LENGTH =
  Math.ceil((MAX_PROFILE_PHOTO_BYTES * 4) / 3) + 64;
const MAX_PROFILE_PHOTO_SOURCE_BYTES = 8 * 1024 * 1024;
const PROFILE_PHOTO_TYPES = new Set(["image/jpeg", "image/png", "image/webp"]);

type AsyncCallback = () => Promise<unknown>;
type RunAction = (label: string, callback: AsyncCallback) => Promise<void>;
type ActiveGame = GameSnapshot & {
  activePlayerId: string;
  current: CurrentRoundSnapshot;
};
type ActiveRoom = RoomSnapshot & { game: ActiveGame };
type FinishedRoom = RoomSnapshot & { game: GameSnapshot };
type SynchronizedAudioControls = ReturnType<typeof useSynchronizedAudio>;

function hasGame(room: RoomSnapshot): room is FinishedRoom {
  return room.game !== null;
}

function hasActiveGame(room: RoomSnapshot): room is ActiveRoom {
  return Boolean(room.game?.activePlayerId && room.game.current);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : "Something went wrong.";
}

function isAvatarKey(value: unknown): value is (typeof AVATARS)[number] {
  return AVATARS.includes(value as (typeof AVATARS)[number]);
}

function isProfilePhoto(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length <= MAX_PROFILE_PHOTO_DATA_URL_LENGTH &&
    /^data:image\/(?:jpeg|png|webp);base64,[A-Za-z0-9+/]+={0,2}$/.test(value)
  );
}

function readRememberedProfile(): PlayerProfile | null {
  try {
    const stored = window.localStorage.getItem(PLAYER_PROFILE_STORAGE_KEY);
    if (!stored) return null;
    const value = JSON.parse(stored) as Partial<PlayerProfile>;
    const displayName =
      typeof value.displayName === "string" ? value.displayName.trim() : "";
    if (
      displayName.length < 2 ||
      displayName.length > 24 ||
      !isAvatarKey(value.avatarKey)
    ) {
      return null;
    }
    return {
      displayName,
      avatarKey: value.avatarKey,
      avatarUrl: isProfilePhoto(value.avatarUrl) ? value.avatarUrl : null,
    };
  } catch {
    return null;
  }
}

function rememberProfile(profile: PlayerProfile): void {
  try {
    window.localStorage.setItem(
      PLAYER_PROFILE_STORAGE_KEY,
      JSON.stringify({
        displayName: profile.displayName,
        avatarKey: profile.avatarKey,
        avatarUrl: isProfilePhoto(profile.avatarUrl)
          ? profile.avatarUrl
          : null,
      } satisfies PlayerProfile),
    );
  } catch {
    // Private browsing and storage limits should not prevent someone from playing.
  }
}

function forgetProfile(): void {
  try {
    window.localStorage.removeItem(PLAYER_PROFILE_STORAGE_KEY);
  } catch {
    // The server profile can still be changed when browser storage is unavailable.
  }
}

function playerAvatar(profile: PlayerProfile): string {
  return isProfilePhoto(profile.avatarUrl)
    ? profile.avatarUrl
    : `/assets/avatars/${profile.avatarKey}.png`;
}

function loadPhoto(url: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const image = new Image();
    image.onload = () => resolve(image);
    image.onerror = () => reject(new Error("That image could not be opened."));
    image.src = url;
  });
}

function canvasBlob(
  canvas: HTMLCanvasElement,
  type: "image/webp" | "image/jpeg",
  quality: number,
): Promise<Blob> {
  return new Promise((resolve, reject) => {
    canvas.toBlob(
      (blob) =>
        blob
          ? resolve(blob)
          : reject(new Error("That image could not be prepared.")),
      type,
      quality,
    );
  });
}

function blobDataUrl(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () =>
      reject(new Error("That image could not be prepared."));
    reader.readAsDataURL(blob);
  });
}

async function prepareProfilePhoto(file: File): Promise<string> {
  if (!PROFILE_PHOTO_TYPES.has(file.type)) {
    throw new Error("Choose a JPEG, PNG, or WebP image.");
  }
  if (file.size > MAX_PROFILE_PHOTO_SOURCE_BYTES) {
    throw new Error("Choose an image smaller than 8 MB.");
  }

  const objectUrl = URL.createObjectURL(file);
  try {
    const image = await loadPhoto(objectUrl);
    const canvas = document.createElement("canvas");
    canvas.width = 192;
    canvas.height = 192;
    const context = canvas.getContext("2d");
    if (!context) throw new Error("That image could not be prepared.");

    const sourceSize = Math.min(image.naturalWidth, image.naturalHeight);
    const sourceX = (image.naturalWidth - sourceSize) / 2;
    const sourceY = (image.naturalHeight - sourceSize) / 2;
    context.drawImage(
      image,
      sourceX,
      sourceY,
      sourceSize,
      sourceSize,
      0,
      0,
      canvas.width,
      canvas.height,
    );

    let blob = await canvasBlob(canvas, "image/webp", 0.78);
    if (blob.size > MAX_PROFILE_PHOTO_BYTES) {
      blob = await canvasBlob(canvas, "image/jpeg", 0.7);
    }
    if (blob.size > MAX_PROFILE_PHOTO_BYTES) {
      throw new Error("That image is still too large after resizing.");
    }
    return blobDataUrl(blob);
  } finally {
    URL.revokeObjectURL(objectUrl);
  }
}

function isWebUrl(value: string): boolean {
  try {
    return ["http:", "https:"].includes(new URL(value).protocol);
  } catch {
    return false;
  }
}

function fallbackCover(
  track: Pick<PublicTrack, "coverUrl"> | null | undefined,
  index = 0,
): string {
  if (track?.coverUrl) return track.coverUrl;
  const key = FALLBACK_COVERS[index % FALLBACK_COVERS.length];
  return `/assets/covers/cover-${key}.png`;
}

function ErrorBanner({
  message,
  onClose,
}: {
  message: string;
  onClose?: () => void;
}) {
  if (!message) return null;
  return (
    <div className="error-banner" role="alert">
      <span>{message}</span>
      {onClose && (
        <button aria-label="Dismiss error" onClick={onClose} type="button">
          <X aria-hidden="true" />
        </button>
      )}
    </div>
  );
}

function BrandHeader({
  room,
  connected,
  onLeave,
  children,
}: {
  room?: RoomSnapshot;
  connected: boolean;
  onLeave?: () => void;
  children?: ReactNode;
}) {
  return (
    <header className="topbar">
      <div className="brand-lockup">
        <span>Music Timeline</span>
      </div>
      {room ? (
        <div className="room-id">
          <span>Room</span>
          <strong>{room.code}</strong>
        </div>
      ) : (
        <div className="room-id">
          <span>Private listening room</span>
        </div>
      )}
      <div className="device-status">
        <span className={`status-dot ${connected ? "status-dot--online" : ""}`} />
        <span>{connected ? "Room connected" : "Reconnecting…"}</span>
      </div>
      <div className="topbar__actions">
        {children}
        {onLeave && (
          <button className="topbar-button" onClick={onLeave} type="button">
            <SignOut aria-hidden="true" />
            Leave
          </button>
        )}
      </div>
    </header>
  );
}

function ProfileScreen({
  onReady,
}: {
  onReady: (profile: PlayerProfile) => void;
}) {
  const [displayName, setDisplayName] = useState("");
  const [avatarKey, setAvatarKey] = useState("maya");
  const [avatarUrl, setAvatarUrl] = useState<string | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [photoBusy, setPhotoBusy] = useState(false);

  async function choosePhoto(event: ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0];
    event.target.value = "";
    if (!file) return;
    setPhotoBusy(true);
    setError("");
    try {
      setAvatarUrl(await prepareProfilePhoto(file));
    } catch (photoError) {
      setError(errorMessage(photoError));
    } finally {
      setPhotoBusy(false);
    }
  }

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setBusy(true);
    setError("");
    try {
      const payload = await api<{ profile: PlayerProfile }>("/api/profile", {
        method: "POST",
        body: JSON.stringify({ displayName, avatarKey, avatarUrl }),
      });
      onReady(payload.profile);
    } catch (requestError) {
      setError(errorMessage(requestError));
    } finally {
      setBusy(false);
    }
  }

  return (
    <main className="entry-shell">
      <BrandHeader connected={false} />
      <section className="entry-stage">
        <div className="entry-card">
          <span className="eyebrow">Private · Fully remote</span>
          <h1>Enter the listening room</h1>
          <p>
            Pick the name and portrait your friends will see. Your profile is
            saved only in this browser.
          </p>
          <form onSubmit={submit}>
            <label className="field-label" htmlFor="display-name">
              Player name
            </label>
            <input
              autoComplete="nickname"
              autoFocus
              id="display-name"
              maxLength={24}
              onChange={(event) => setDisplayName(event.target.value)}
              placeholder="Your name"
              value={displayName}
            />
            <fieldset className="avatar-picker">
              <legend>Choose a portrait</legend>
              <div>
                {AVATARS.map((avatar) => (
                  <button
                    aria-label={`Use ${avatar} portrait`}
                    aria-pressed={!avatarUrl && avatarKey === avatar}
                    className={
                      !avatarUrl && avatarKey === avatar
                        ? "avatar-choice is-selected"
                        : "avatar-choice"
                    }
                    key={avatar}
                    onClick={() => {
                      setAvatarKey(avatar);
                      setAvatarUrl(null);
                    }}
                    type="button"
                  >
                    <img src={`/assets/avatars/${avatar}.png`} alt="" />
                  </button>
                ))}
                <label
                  aria-label={
                    avatarUrl
                      ? "Change uploaded profile photo"
                      : "Upload a profile photo"
                  }
                  className={
                    avatarUrl
                      ? "avatar-choice avatar-upload is-selected"
                      : "avatar-choice avatar-upload"
                  }
                  title="Upload a profile photo"
                >
                  <input
                    accept="image/jpeg,image/png,image/webp"
                    disabled={photoBusy}
                    onChange={(event) => void choosePhoto(event)}
                    type="file"
                  />
                  {avatarUrl ? (
                    <img src={avatarUrl} alt="" />
                  ) : (
                    <UploadSimple aria-hidden="true" weight="bold" />
                  )}
                </label>
              </div>
            </fieldset>
            <ErrorBanner message={error} onClose={() => setError("")} />
            <button
              className="primary-button"
              disabled={busy || photoBusy}
              type="submit"
            >
              <span>
                {photoBusy
                  ? "Preparing photo…"
                  : busy
                    ? "Entering…"
                    : "Continue"}
              </span>
              <ArrowRight weight="bold" aria-hidden="true" />
            </button>
          </form>
        </div>
      </section>
    </main>
  );
}

function HomeScreen({
  profile,
  connected,
  config,
  createRoom,
  joinRoom,
  onLogout,
}: {
  profile: PlayerProfile;
  connected: boolean;
  config: ClientConfig;
  createRoom: AsyncCallback;
  joinRoom: (code: string) => Promise<unknown>;
  onLogout: () => Promise<void>;
}) {
  const [code, setCode] = useState(
    () => inviteCodeFromPath(window.location.pathname) ?? "",
  );
  const [error, setError] = useState("");
  const [busy, setBusy] = useState("");

  async function run(label: string, callback: AsyncCallback) {
    setBusy(label);
    setError("");
    try {
      await callback();
    } catch (requestError) {
      setError(errorMessage(requestError));
    } finally {
      setBusy("");
    }
  }

  return (
    <main className="entry-shell">
      <BrandHeader connected={connected}>
        <div className="signed-in-player">
          <img src={playerAvatar(profile)} alt="" />
          <span>{profile.displayName}</span>
        </div>
        <button className="topbar-button" onClick={onLogout} type="button">
          <SignOut aria-hidden="true" />
          Change player
        </button>
      </BrandHeader>
      <section className="entry-stage">
        <div className="home-grid">
          <article className="choice-card choice-card--host">
            <span className="eyebrow">Game master</span>
            <h1>Start a room</h1>
            <p>
              Choose a Spotify playlist, then invite 1–4 friends for a private
              game.
            </p>
            <button
              className="primary-button"
              disabled={!connected || Boolean(busy)}
              onClick={() => {
                primeRoomAudio();
                void run("create", createRoom);
              }}
              type="button"
            >
              <span>{busy === "create" ? "Creating…" : "Create room"}</span>
              <ArrowRight weight="bold" aria-hidden="true" />
            </button>
          </article>
          <article className="choice-card">
            <span className="eyebrow">Player</span>
            <h1>Join friends</h1>
            <p>Enter the five-character room code shared by the host.</p>
            <label className="field-label" htmlFor="room-code">
              Room code
            </label>
            <input
              autoCapitalize="characters"
              autoComplete="off"
              className="code-input"
              id="room-code"
              maxLength={5}
              onChange={(event) =>
                setCode(normalizeRoomCode(event.target.value))
              }
              placeholder="J7K4Q"
              value={code}
            />
            <button
              className="secondary-button"
              disabled={!connected || Boolean(busy) || code.length !== 5}
              onClick={() => {
                primeRoomAudio();
                void run("join", () => joinRoom(code));
              }}
              type="button"
            >
              {busy === "join" ? "Joining…" : "Join room"}
            </button>
          </article>
        </div>
        <ErrorBanner message={error} onClose={() => setError("")} />
        <p className="privacy-note">
          Private rooms for 2–5 friends. First to{" "}
          {config.winningTimelineSize} timeline cards wins.
        </p>
      </section>
    </main>
  );
}

function PlayerAvatar({
  player,
  small = false,
}: {
  player: RoomPlayerSnapshot;
  small?: boolean;
}) {
  return (
    <img
      className={small ? "avatar avatar--small" : "avatar"}
      src={player.avatarUrl}
      alt=""
    />
  );
}

function PlayerStrip({
  players,
  tokens,
}: {
  players: RoomPlayerSnapshot[];
  tokens?: Record<string, number>;
}) {
  return (
    <section
      className="player-strip"
      aria-label="Connected players"
      style={{ "--player-count": players.length } as CSSProperties}
    >
      {players.map((player) => (
        <div
          className={`player-chip ${player.active ? "player-chip--active" : ""}`}
          key={player.id}
        >
          <PlayerAvatar player={player} />
          <div className="player-chip__copy">
            <div className="player-chip__name-row">
              <strong>{player.displayName}</strong>
              {player.host && <Crown weight="fill" aria-label="Host" />}
              {player.active && <span className="active-tag">Active</span>}
            </div>
            <span className={player.connected ? "connected-label" : "connected-label is-offline"}>
              <Headphones weight="fill" aria-hidden="true" />
              {player.connected ? "Connected" : "Reconnecting"}
            </span>
            {tokens && (
              <span className="token-label">
                <i aria-hidden="true" />
                {tokens[player.id] ?? 0} music tokens
              </span>
            )}
          </div>
        </div>
      ))}
    </section>
  );
}

function LobbyScreen({
  room,
  connected,
  config,
  command,
}: {
  room: RoomSnapshot;
  connected: boolean;
  config: ClientConfig;
  command: RoomCommand;
}) {
  const [error, setError] = useState("");
  const [busy, setBusy] = useState("");
  const [copied, setCopied] = useState(false);
  const [playlistUrl, setPlaylistUrl] = useState("");
  const [playlistSearch, setPlaylistSearch] = useState("");
  const [spotifyPlaylists, setSpotifyPlaylists] = useState<
    SpotifyPlaylistSummary[]
  >([]);
  const [spotifyPlaylistsStatus, setSpotifyPlaylistsStatus] = useState<
    "idle" | "loading" | "ready" | "error"
  >("idle");

  useEffect(() => {
    if (!room.isHost || !room.spotify.connected) {
      setSpotifyPlaylists([]);
      setSpotifyPlaylistsStatus("idle");
      return;
    }
    let cancelled = false;
    setSpotifyPlaylistsStatus("loading");
    void api<SpotifyPlaylistsResponse>(
      `/api/spotify/playlists?code=${encodeURIComponent(room.code)}`,
    )
      .then(({ playlists }) => {
        if (cancelled) return;
        setSpotifyPlaylists(playlists);
        setSpotifyPlaylistsStatus("ready");
      })
      .catch((requestError: unknown) => {
        if (cancelled) return;
        setSpotifyPlaylistsStatus("error");
        setError(errorMessage(requestError));
      });
    return () => {
      cancelled = true;
    };
  }, [room.code, room.isHost, room.spotify.connected]);

  useEffect(() => {
    const parameters = new URLSearchParams(window.location.search);
    const spotifyError = parameters.get("spotify_error");
    if (spotifyError) setError(spotifyError);
    if (spotifyError || parameters.has("spotify")) {
      window.history.replaceState({}, "", window.location.pathname);
    }
  }, []);

  async function run(label: string, callback: AsyncCallback) {
    setBusy(label);
    setError("");
    try {
      await callback();
    } catch (requestError) {
      setError(errorMessage(requestError));
    } finally {
      setBusy("");
    }
  }

  async function uploadDeck(event: ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0];
    if (!file) return;
    const text = await file.text();
    await run("deck", () => command("setDeck", { name: file.name, text }));
    event.target.value = "";
  }

  async function copyInvite() {
    await navigator.clipboard.writeText(
      roomInviteUrl(room.code, window.location.origin),
    );
    setCopied(true);
    window.setTimeout(() => setCopied(false), 1500);
  }

  const canStart = Boolean(
    room.isHost &&
    room.players.length >= 2 &&
    room.players.every((player) => player.connected) &&
    room.deck?.ready,
  );
  const normalizedPlaylistSearch = playlistSearch.trim().toLocaleLowerCase();
  const visibleSpotifyPlaylists = normalizedPlaylistSearch
    ? spotifyPlaylists.filter((playlist) =>
        [playlist.name, playlist.ownerName, playlist.description ?? ""].some(
          (value) =>
            value.toLocaleLowerCase().includes(normalizedPlaylistSearch),
        ),
      )
    : spotifyPlaylists;

  return (
    <main className="lobby-shell">
      <BrandHeader
        room={room}
        connected={connected}
        onLeave={() => run("leave", () => command("leaveRoom"))}
      >
        <button className="topbar-button" onClick={copyInvite} type="button">
          <Copy aria-hidden="true" />
          {copied ? "Copied" : "Copy invite"}
        </button>
      </BrandHeader>
      <PlayerStrip players={room.players} />
      <section className="lobby-content">
        <div className="lobby-heading">
          <span className="eyebrow">{room.locked ? "Rematch room · Locked" : "Room open"}</span>
          <h1>{room.isHost ? "Set the deck, then invite the room" : "Waiting for the host"}</h1>
          <p>
            {room.isHost
              ? "Connect Spotify, choose a playlist, and invite your friends."
              : room.deck?.audioMode === "hosted"
                ? "Pick your spot in the call while the host gets the room ready."
                : "Keep your external voice or video call open for host-managed cues."}
          </p>
        </div>

        <div className="lobby-panels">
          <article className="lobby-panel roster-panel">
            <div className="panel-title">
              <div>
                <span className="eyebrow">Players</span>
                <h2>{room.players.length} of 5 connected</h2>
              </div>
              <UsersThree aria-hidden="true" />
            </div>
            <div className="roster-list">
              {room.players.map((player, index) => (
                <div className="roster-item" key={player.id}>
                  <span className="turn-number">{String(index + 1).padStart(2, "0")}</span>
                  <PlayerAvatar player={player} small />
                  <div>
                    <strong>{player.displayName}</strong>
                    <span>{player.host ? "Host" : player.connected ? "Ready" : "Reconnecting"}</span>
                  </div>
                  <Check
                    className={player.connected ? "ready-check" : "ready-check is-offline"}
                    weight="bold"
                    aria-hidden="true"
                  />
                </div>
              ))}
            </div>
            <p className="panel-footnote">
              Starting locks the roster. Disconnected players have two minutes
              to return.
            </p>
          </article>

          <article className="lobby-panel deck-panel">
            <div className="panel-title">
              <div>
                <span className="eyebrow">Music deck</span>
                <h2>{room.deck ? room.deck.name : "No deck loaded"}</h2>
              </div>
              <FileCsv aria-hidden="true" />
            </div>

            {room.isHost ? (
              <>
                <div className="spotify-import">
                  <div className="spotify-import__status">
                    <div>
                      <span className="provider-mark">
                        <span className="provider-mark__dot" />
                        Spotify metadata
                      </span>
                      <small>
                        {room.spotify.connected
                          ? `Connected${room.spotify.displayName ? ` as ${room.spotify.displayName}` : ""}`
                          : room.spotify.configured
                            ? "Host login required"
                            : "Spotify setup unavailable"}
                      </small>
                    </div>
                    {room.spotify.configured && !room.spotify.connected && (
                      <a
                        className="secondary-button spotify-connect"
                        href={`/api/spotify/login?room=${encodeURIComponent(room.code)}`}
                      >
                        Log in with Spotify
                      </a>
                    )}
                  </div>
                  {room.spotify.connected && (
                    <div className="spotify-library">
                      <div className="spotify-library__heading">
                        <div>
                          <strong>Your Spotify playlists</strong>
                          <small>
                            Choose one you own or collaborate on.
                          </small>
                        </div>
                        {spotifyPlaylists.length > 5 && (
                          <input
                            aria-label="Search Spotify playlists"
                            onChange={(event) =>
                              setPlaylistSearch(event.target.value)
                            }
                            placeholder="Search playlists"
                            type="search"
                            value={playlistSearch}
                          />
                        )}
                      </div>
                      {spotifyPlaylistsStatus === "loading" && (
                        <div
                          className="spotify-library__message"
                          role="status"
                        >
                          <span className="loading-pulse" />
                          Loading your playlists…
                        </div>
                      )}
                      {spotifyPlaylistsStatus === "error" && (
                        <div className="spotify-library__message">
                          Spotify could not load the library. Reconnect or try
                          again.
                        </div>
                      )}
                      {spotifyPlaylistsStatus === "ready" &&
                        spotifyPlaylists.length === 0 && (
                          <div className="spotify-library__message">
                            No playlists were returned for this Spotify
                            account.
                          </div>
                        )}
                      {spotifyPlaylistsStatus === "ready" &&
                        spotifyPlaylists.length > 0 &&
                        visibleSpotifyPlaylists.length === 0 && (
                          <div className="spotify-library__message">
                            No playlists match “{playlistSearch.trim()}”.
                          </div>
                        )}
                      {visibleSpotifyPlaylists.length > 0 && (
                        <div className="spotify-playlist-list">
                          {visibleSpotifyPlaylists.map((playlist) => {
                            const action = `spotify-import-${playlist.id}`;
                            return (
                              <article
                                className={`spotify-playlist${playlist.eligible ? "" : " is-ineligible"}`}
                                key={playlist.id}
                              >
                                <a
                                  aria-label={`Open ${playlist.name} in Spotify`}
                                  className="spotify-playlist__cover"
                                  href={playlist.spotifyUrl}
                                  rel="noreferrer"
                                  target="_blank"
                                >
                                  {playlist.imageUrl ? (
                                    <img
                                      alt=""
                                      loading="lazy"
                                      src={playlist.imageUrl}
                                    />
                                  ) : (
                                    <Waveform aria-hidden="true" />
                                  )}
                                </a>
                                <div className="spotify-playlist__details">
                                  <strong title={playlist.name}>
                                    {playlist.name}
                                  </strong>
                                  <span>
                                    {playlist.trackCount}{" "}
                                    {playlist.trackCount === 1
                                      ? "track"
                                      : "tracks"}{" "}
                                    · {playlist.ownerName}
                                  </span>
                                  {!playlist.eligible && (
                                    <small>
                                      Followed playlist · Spotify does not
                                      permit track import
                                    </small>
                                  )}
                                </div>
                                <button
                                  className="secondary-button"
                                  disabled={Boolean(busy) || !playlist.eligible}
                                  onClick={() =>
                                    void run(action, () =>
                                      api("/api/spotify/import", {
                                        method: "POST",
                                        body: JSON.stringify({
                                          code: room.code,
                                          playlistUrl: `spotify:playlist:${playlist.id}`,
                                        }),
                                      }),
                                    )
                                  }
                                  type="button"
                                >
                                  {busy === action
                                    ? "Importing…"
                                    : playlist.eligible
                                      ? "Use playlist"
                                      : "Read-only"}
                                </button>
                              </article>
                            );
                          })}
                        </div>
                      )}
                      <details className="spotify-link-fallback">
                        <summary>Paste a playlist link instead</summary>
                        <form
                          className="playlist-import-form"
                          onSubmit={(event) => {
                            event.preventDefault();
                            void run("spotify-import", () =>
                              api("/api/spotify/import", {
                                method: "POST",
                                body: JSON.stringify({
                                  code: room.code,
                                  playlistUrl,
                                }),
                              }),
                            );
                          }}
                        >
                          <label
                            className="field-label"
                            htmlFor="spotify-playlist"
                          >
                            Owned or collaborative playlist link
                          </label>
                          <div>
                            <input
                              id="spotify-playlist"
                              onChange={(event) =>
                                setPlaylistUrl(event.target.value)
                              }
                              placeholder="https://open.spotify.com/playlist/…"
                              type="url"
                              value={playlistUrl}
                            />
                            <button
                              className="secondary-button"
                              disabled={
                                Boolean(busy) ||
                                playlistUrl.trim().length === 0
                              }
                              type="submit"
                            >
                              {busy === "spotify-import"
                                ? "Reading playlist…"
                                : "Use playlist"}
                            </button>
                          </div>
                        </form>
                      </details>
                    </div>
                  )}
                </div>

                <div className="deck-actions">
                  <label className="secondary-button file-button">
                    <UploadSimple aria-hidden="true" />
                    {busy === "deck" ? "Reading…" : "Upload CSV or JSON"}
                    <input
                      accept=".csv,.json,text/csv,application/json"
                      onChange={uploadDeck}
                      type="file"
                    />
                  </label>
                  {config.demoMode && (
                    <button
                      className="secondary-button"
                      disabled={Boolean(busy)}
                      onClick={() =>
                        run("hosted-demo", () =>
                          api("/api/demo/hosted", {
                            method: "POST",
                            body: JSON.stringify({ code: room.code }),
                          }),
                        )
                      }
                      type="button"
                    >
                      {busy === "hosted-demo"
                        ? "Generating audio…"
                        : "Use hosted audio demo"}
                    </button>
                  )}
                  {config.demoMode && (
                    <button
                      className="secondary-button"
                      disabled={Boolean(busy)}
                      onClick={() => run("demo", () => command("useDemoDeck"))}
                      type="button"
                    >
                      Use external demo
                    </button>
                  )}
                  <a className="text-link" download href="/deck-template.csv">
                    <DownloadSimple aria-hidden="true" />
                    Deck template
                  </a>
                </div>
                {room.deck && (
                  <div className="deck-summary">
                    <strong>
                      {room.deck.ready ? "Ready to play" : "Getting the music ready"}
                    </strong>
                    <span>
                      {room.deck.ready
                        ? "Start whenever everyone has joined."
                        : "The start button will unlock automatically."}
                    </span>
                  </div>
                )}
              </>
            ) : (
              <div className="waiting-card">
                {room.deck ? (
                  <>
                    {room.deck.ready ? (
                      <Check weight="bold" aria-hidden="true" />
                    ) : (
                      <Waveform aria-hidden="true" />
                    )}
                    <strong>
                      {room.deck.ready ? "Ready to play" : "Almost ready"}
                    </strong>
                    <span>
                      {room.deck.ready
                        ? "The host can start when everyone is here."
                        : "Make sure everyone has joined the room."}
                    </span>
                  </>
                ) : (
                  <>
                    <Waveform aria-hidden="true" />
                    <strong>Host is choosing the deck</strong>
                  </>
                )}
              </div>
            )}
          </article>
        </div>

        <ErrorBanner message={error} onClose={() => setError("")} />
        {room.isHost ? (
          <button
            className="primary-button lobby-start"
            disabled={!canStart || Boolean(busy)}
            onClick={() => {
              primeRoomAudio();
              void run("start", () => command("startGame"));
            }}
            type="button"
          >
            <span>{busy === "start" ? "Shuffling…" : "Lock room & start"}</span>
            <ArrowRight weight="bold" aria-hidden="true" />
          </button>
        ) : (
          <div className="waiting-status">
            <span className="listening-pulse" />
            Waiting for the host to start
          </div>
        )}
      </section>
    </main>
  );
}

function WaveRail() {
  return (
    <span className="wave-rail" aria-hidden="true">
      {Array.from({ length: 7 }, (_, index) => (
        <Waveform key={index} />
      ))}
    </span>
  );
}

function KnownCard({
  track,
  index,
  mini = false,
}: {
  track: PublicTrack;
  index: number;
  mini?: boolean;
}) {
  return (
    <article className={mini ? "mini-cover" : "year-card"}>
      {!mini && <span className="year-card__year">{track.year}</span>}
      <img src={fallbackCover(track, index)} alt="" />
    </article>
  );
}

function MysteryCard({ current }: { current: CurrentRoundSnapshot }) {
  const revealed = current.phase === "revealed";
  const correct = current.outcome?.correct;
  const stolen = Boolean(current.outcome?.winningChallengePlayerId);
  const tokenTrade = current.outcome?.resolution === "token-trade";
  return (
    <article
      className={`mystery-card ${revealed ? "mystery-card--revealed" : ""} ${
        revealed && !correct && !stolen ? "mystery-card--incorrect" : ""
      } ${stolen ? "mystery-card--stolen" : ""
      }`}
    >
      {revealed ? (
        <>
          {correct ? (
            <Check weight="bold" aria-hidden="true" />
          ) : stolen ? (
            <ArrowsClockwise weight="bold" aria-hidden="true" />
          ) : (
            <X weight="bold" aria-hidden="true" />
          )}
          <strong>{current.track?.year ?? "—"}</strong>
          <span>
            {tokenTrade
              ? "Token card"
              : correct
                ? "Correct"
                : stolen
                  ? "Stolen"
                  : "Wrong gap"}
          </span>
        </>
      ) : (
        <>
          <Question weight="light" aria-hidden="true" />
          <span className="sr-only">Unknown track</span>
        </>
      )}
    </article>
  );
}

function gapLabel(timeline: PublicTrack[], index: number): string {
  const previous = timeline[index - 1]?.year;
  const next = timeline[index]?.year;
  if (previous == null) return `Before ${next}`;
  if (next == null) return `After ${previous}`;
  return `Between ${previous} and ${next}`;
}

function MainTimeline({
  game,
  timeline,
  players,
  selectionMode,
  viewerId,
  onSelect,
}: {
  game: ActiveGame;
  timeline: PublicTrack[];
  players: RoomPlayerSnapshot[];
  selectionMode: "placement" | "challenge" | "none";
  viewerId: string;
  onSelect: (index: number) => void;
}) {
  const nodes: ReactNode[] = [];
  for (let index = 0; index <= timeline.length; index += 1) {
    const selected =
      game.current.outcome?.resolution !== "token-trade" &&
      game.current.selectedGap === index;
    const placedOnActiveTimeline =
      game.current.phase === "revealed" &&
      game.current.outcome?.awardedPlayerId === game.activePlayerId;
    const challenge = game.current.challenges.find(
      (entry) => entry.gapIndex === index,
    );
    const ownChallenge = challenge?.playerId === viewerId;
    const challenger = challenge
      ? players.find((player) => player.id === challenge.playerId)
      : null;
    const canSelect =
      !selected &&
      (selectionMode === "placement" ||
        (selectionMode === "challenge" &&
          (!challenge || challenge.playerId === viewerId)));
    if (selected && !placedOnActiveTimeline) {
      nodes.push(
        <div className="gap-slot gap-slot--selected" key={`gap-${index}`}>
          <span className="selection-caret" aria-hidden="true" />
          <MysteryCard current={game.current} />
          <span className="gap-slot__label">{gapLabel(timeline, index)}</span>
        </div>,
      );
    } else if (!selected) {
      nodes.push(
        <button
          aria-label={
            ownChallenge
              ? `Remove your challenge from ${gapLabel(timeline, index)}`
              : challenger
              ? `${challenger.displayName} challenged ${gapLabel(timeline, index)}`
              : gapLabel(timeline, index)
          }
          className={`gap-slot ${challenge ? "gap-slot--challenged" : ""} ${
            ownChallenge ? "gap-slot--own-challenge" : ""
          }`}
          disabled={!canSelect}
          key={`gap-${index}`}
          onClick={() => onSelect(index)}
          title={ownChallenge ? "Click again to remove your challenge" : undefined}
          type="button"
        >
          {challenger ? (
            <span className="challenge-marker">
              <strong>{challenger.displayName}</strong>
              <small>{ownChallenge ? "Remove" : "Challenge"}</small>
            </span>
          ) : (
            <Plus weight="light" aria-hidden="true" />
          )}
          <span>{gapLabel(timeline, index)}</span>
        </button>,
      );
    }
    const track = timeline[index];
    if (track) {
      nodes.push(
        <KnownCard index={index} key={track.id} track={track} />,
      );
    }
  }

  return <div className="main-timeline">{nodes}</div>;
}

function PublicTimelines({
  room,
  activePlayerId,
}: {
  room: ActiveRoom;
  activePlayerId: string;
}) {
  const players = room.players.filter((player) => player.id !== activePlayerId);
  if (!players.length) return null;
  return (
    <section className="other-timelines" aria-label="Other public timelines">
      {players.map((player) => {
        const timeline = room.game.timelines[player.id] ?? [];
        return (
          <div className="mini-timeline" key={player.id}>
            <div className="mini-timeline__person">
              <PlayerAvatar player={player} small />
              <div>
                <strong>{player.displayName}</strong>
                <span>{timeline.length} / {room.rules.winningTimelineSize}</span>
              </div>
            </div>
            <div className="mini-timeline__rail" aria-label={`${player.displayName}'s timeline`}>
              {timeline.map((track, index) => (
                <div className="mini-timeline__item" key={track.id}>
                  {index > 0 && (
                    <span className="mini-gap" aria-hidden="true">
                      <Plus aria-hidden="true" />
                    </span>
                  )}
                  <KnownCard index={index} mini track={track} />
                </div>
              ))}
            </div>
          </div>
        );
      })}
    </section>
  );
}

function HostCue({
  cue,
  playback,
  command,
  busy,
  run,
  activeIsHost,
}: {
  cue: Pick<Track, "audioCue"> | null;
  playback: PlaybackSnapshot;
  command: RoomCommand;
  busy: string;
  run: RunAction;
  activeIsHost: boolean;
}) {
  if (!cue) return null;
  return (
    <aside className="host-cue">
      <div>
        <span className="eyebrow">Host-only audio cue</span>
        <strong>Mystery track</strong>
        <small>The answer stays hidden until reveal.</small>
      </div>
      <div className="host-cue__source">
        {isWebUrl(cue.audioCue) ? (
          <a href={cue.audioCue} rel="noreferrer" target="_blank">
            <LinkSimple aria-hidden="true" />
            Open external cue
          </a>
        ) : (
          <span>{cue.audioCue}</span>
        )}
        {activeIsHost && (
          <em>You are active—open the external source without reading its title.</em>
        )}
      </div>
      <div className="host-cue__controls">
        <button
          className="cue-button cue-button--play"
          disabled={Boolean(busy)}
          onClick={() =>
            run("cue", () =>
              command(playback.status === "playing" ? "restartCue" : "playCue"),
            )
          }
          type="button"
        >
          {playback.status === "playing" ? <ArrowsClockwise /> : <Play weight="fill" />}
          {playback.status === "playing" ? "Restart cue" : "Start cue"}
        </button>
        <button
          className="cue-button"
          disabled={Boolean(busy) || playback.status !== "playing"}
          onClick={() => run("pause", () => command("pauseCue"))}
          type="button"
        >
          <Pause weight="fill" />
          Pause
        </button>
      </div>
    </aside>
  );
}

function HostedCue({
  audio,
  playback,
  command,
  busy,
  run,
  isHost,
}: {
  audio: SynchronizedAudioControls;
  playback: PlaybackSnapshot;
  command: RoomCommand;
  busy: string;
  run: RunAction;
  isHost: boolean;
}) {
  if (!audio.hosted) return null;
  const needsEnable = !audio.enabled || Boolean(audio.error);
  return (
    <aside className="host-cue hosted-cue">
      <div>
        <span className="eyebrow">Private room audio</span>
        <strong>Mystery track</strong>
        <small>No title, artist, or cover is exposed before reveal.</small>
      </div>
      <div className="host-cue__source hosted-cue__readiness">
        <span>
          {audio.loading
            ? "Cueing this round…"
            : audio.ready
              ? "Your audio is ready"
              : "Waiting for the mystery track"}
        </span>
        <em className={audio.allReady ? "is-ready" : ""}>
          {audio.readyCount} / {audio.requiredCount} players ready
        </em>
      </div>
      <div className="host-cue__controls">
        {needsEnable ? (
          <button
            className="cue-button cue-button--play"
            disabled={audio.loading || Boolean(busy)}
            onClick={() => run("enable-audio", audio.enable)}
            type="button"
          >
            <Headphones weight="fill" />
            {audio.enabled ? "Retry audio" : "Start audio"}
          </button>
        ) : isHost ? (
          <>
            <button
              className="cue-button cue-button--play"
              disabled={Boolean(busy) || !audio.allReady}
              onClick={() =>
                run("cue", () =>
                  command(
                    playback.status === "playing"
                      ? "restartCue"
                      : "playCue",
                  ),
                )
              }
              type="button"
            >
              {playback.status === "playing" ? (
                <ArrowsClockwise />
              ) : (
                <Play weight="fill" />
              )}
              {playback.status === "playing" ? "Restart cue" : "Start cue"}
            </button>
            <button
              className="cue-button"
              disabled={Boolean(busy) || playback.status !== "playing"}
              onClick={() => run("pause", () => command("pauseCue"))}
              type="button"
            >
              <Pause weight="fill" />
              Pause
            </button>
          </>
        ) : (
          <span className="audio-ready-label">
            <Check weight="bold" aria-hidden="true" />
            Ready for host
          </span>
        )}
        <div className="personal-audio-controls">
          <button
            aria-label={audio.muted ? "Unmute your audio" : "Mute your audio"}
            aria-pressed={audio.muted}
            className="personal-audio-controls__mute"
            onClick={() => audio.setMuted(!audio.muted)}
            title={audio.muted ? "Unmute" : "Mute"}
            type="button"
          >
            {audio.muted || audio.volume === 0 ? (
              <SpeakerSlash weight="fill" aria-hidden="true" />
            ) : (
              <SpeakerHigh weight="fill" aria-hidden="true" />
            )}
          </button>
          <label>
            <span className="sr-only">Your volume</span>
            <input
              aria-label="Your volume"
              max="100"
              min="0"
              onChange={(event) =>
                audio.setVolume(Number(event.target.value) / 100)
              }
              type="range"
              value={Math.round(audio.volume * 100)}
            />
          </label>
          <output aria-label="Current volume">
            {Math.round(audio.volume * 100)}%
          </output>
        </div>
      </div>
    </aside>
  );
}

function HostMenu({
  close,
  command,
  run,
}: {
  close: () => void;
  command: RoomCommand;
  run: RunAction;
}) {
  return (
    <div className="popover host-menu" role="menu">
      <button
        onClick={() => {
          close();
          run("pause", () => command("pauseCue"));
        }}
        role="menuitem"
        type="button"
      >
        <Pause weight="fill" aria-hidden="true" />
        Pause cue
      </button>
      <button
        onClick={() => {
          close();
          run("restart", () => command("restartCue"));
        }}
        role="menuitem"
        type="button"
      >
        <ArrowsClockwise aria-hidden="true" />
        Restart cue
      </button>
      <button
        className="danger-action"
        onClick={() => {
          close();
          run("end", () => command("endGame"));
        }}
        role="menuitem"
        type="button"
      >
        <SignOut aria-hidden="true" />
        End game
      </button>
    </div>
  );
}

function GameScreen({
  room,
  connected,
  command,
}: {
  room: ActiveRoom;
  connected: boolean;
  command: RoomCommand;
}) {
  const [hostMenuOpen, setHostMenuOpen] = useState(false);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState("");
  const [guessTitle, setGuessTitle] = useState("");
  const [guessArtist, setGuessArtist] = useState("");
  const synchronizedAudio = useSynchronizedAudio(room, command);
  const game = room.game;
  const activePlayer = room.players.find((player) => player.id === game.activePlayerId);
  const timeline = game.timelines[game.activePlayerId] ?? [];
  const isActive = room.viewerId === game.activePlayerId;
  const challenging = game.current.phase === "challenging";
  const revealed = game.current.phase === "revealed";
  const correct = game.current.outcome?.correct;
  const awardedPlayer = game.current.outcome?.awardedPlayerId
    ? room.players.find(
        (player) => player.id === game.current.outcome?.awardedPlayerId,
      )
    : null;
  const viewerChallenge = game.current.challenges.find(
    (challenge) => challenge.playerId === room.viewerId,
  );
  const viewerTokens = game.tokens[room.viewerId] ?? 0;
  const viewerPassed = game.current.challengePasses.includes(room.viewerId);
  const viewerResponded = Boolean(viewerChallenge) || viewerPassed;
  const connectedOpponentIds = room.players
    .filter(
      (player) =>
        player.connected && player.id !== game.activePlayerId,
    )
    .map((player) => player.id);
  const everyOpponentResponded = connectedOpponentIds.every(
    (playerId) =>
      game.current.challengePasses.includes(playerId) ||
      game.current.challenges.some(
        (challenge) => challenge.playerId === playerId,
      ),
  );
  const tokenTrade = game.current.outcome?.resolution === "token-trade";

  useEffect(() => {
    setGuessTitle("");
    setGuessArtist("");
  }, [game.roundNumber]);

  async function run(label: string, callback: AsyncCallback) {
    setBusy(label);
    setError("");
    try {
      await callback();
    } catch (requestError) {
      setError(errorMessage(requestError));
    } finally {
      setBusy("");
    }
  }

  async function submitGuess(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    await run("guess", () =>
      command("submitGuess", {
        title: guessTitle,
        artist: guessArtist,
      }),
    );
  }

  const stateLabel = revealed
    ? tokenTrade
      ? `Token card · ${game.current.track?.year ?? "—"}`
      : correct
      ? `Correct · ${game.current.track?.year ?? "—"}`
      : awardedPlayer
        ? `${game.current.track?.year ?? "—"} · ${awardedPlayer.displayName} stole it`
        : `${game.current.track?.year ?? "—"} · No correct challenge`
    : challenging
      ? "Challenges open"
    : synchronizedAudio.hosted && !synchronizedAudio.enabled
      ? "Start audio"
      : synchronizedAudio.hosted && synchronizedAudio.loading
        ? "Loading round"
        : synchronizedAudio.hosted && !synchronizedAudio.allReady
          ? "Players loading"
    : room.playback.status === "playing"
      ? "Listening"
      : room.playback.status === "paused"
        ? "Paused"
        : "Waiting for host";

  const canChallenge =
    challenging &&
    !isActive &&
    !viewerPassed &&
    (viewerTokens > 0 || Boolean(viewerChallenge));
  const selectionMode: "placement" | "challenge" | "none" =
    isActive && game.current.phase === "listening"
      ? "placement"
      : canChallenge
        ? "challenge"
        : "none";
  const canLock =
    isActive &&
    game.current.phase === "listening" &&
    room.playback.status === "playing";
  const canPass = challenging && !isActive && !viewerResponded;
  const canReveal =
    challenging &&
    everyOpponentResponded &&
    (isActive || room.isHost);
  const canContinue = revealed && (isActive || room.isHost);
  const canSkip =
    isActive &&
    game.current.phase === "listening" &&
    viewerTokens >= 1 &&
    game.remainingTrackCount > 0;
  const canTrade =
    game.current.phase === "listening" &&
    room.playback.status === "ready" &&
    viewerTokens >= 3;
  const showNonActiveTrade = canTrade && !isActive;

  if (!activePlayer) {
    return (
      <main className="loading-screen">
        <X aria-hidden="true" />
        <strong>The active player is no longer in this room.</strong>
      </main>
    );
  }

  return (
    <main className="game-shell">
      <BrandHeader room={room} connected={connected}>
        {room.isHost && (
          <div className="popover-anchor">
            <button
              aria-expanded={hostMenuOpen}
              className="topbar-button"
              onClick={() => setHostMenuOpen((value) => !value)}
              type="button"
            >
              <Gear aria-hidden="true" />
              Host controls
            </button>
            {hostMenuOpen && (
              <HostMenu
                close={() => setHostMenuOpen(false)}
                command={command}
                run={run}
              />
            )}
          </div>
        )}
        <div className="topbar-button topbar-button--static">
          <UsersThree aria-hidden="true" />
          <span>{room.players.length}</span>
          <CaretDown aria-hidden="true" />
        </div>
      </BrandHeader>
      <PlayerStrip
        players={room.players}
        tokens={game.tokens}
      />
      {game.current.phase === "listening" && (
        <>
          <HostCue
            activeIsHost={room.hostId === game.activePlayerId}
            busy={busy}
            command={command}
            cue={room.hostCue}
            playback={room.playback}
            run={run}
          />
          <HostedCue
            audio={synchronizedAudio}
            busy={busy}
            command={command}
            isHost={room.isHost}
            playback={room.playback}
            run={run}
          />
        </>
      )}

      <section
        className={`round-stage ${challenging ? "round-stage--challenging" : ""} ${
          revealed ? "round-stage--revealed" : ""
        } ${
          revealed && !correct ? "round-stage--incorrect" : ""
        }`}
      >
        <div className="turn-heading">
          <span aria-hidden="true" />
          <h1>
            {revealed
              ? tokenTrade
                ? `${awardedPlayer?.displayName ?? "A player"} took the card`
                : correct
                ? "Great placement"
                : awardedPlayer
                  ? `${awardedPlayer.displayName} stole the card`
                  : "Not this time"
              : challenging
                ? `Challenge ${activePlayer.displayName}’s placement`
              : `${activePlayer.displayName}’s turn`}
          </h1>
          <span aria-hidden="true" />
        </div>
        <div className="listening-state" aria-live="polite">
          <WaveRail />
          {revealed ? (
            correct ? <Check weight="bold" aria-hidden="true" /> : <X weight="bold" aria-hidden="true" />
          ) : room.playback.status === "playing" ? (
            <Headphones weight="fill" aria-hidden="true" />
          ) : room.playback.status === "paused" ? (
            <Pause weight="fill" aria-hidden="true" />
          ) : (
            <Play weight="fill" aria-hidden="true" />
          )}
          <strong>{stateLabel}</strong>
          <WaveRail />
        </div>

        <div
          className={`round-rule-tools ${
            revealed ? "round-rule-tools--answer" : ""
          } ${
            showNonActiveTrade ? "round-rule-tools--tokens-only" : ""
          }`}
        >
          {revealed && game.current.track ? (
            <article className="reveal-answer">
              <img
                src={fallbackCover(game.current.track, game.roundNumber)}
                alt=""
              />
              <div>
                <span className="eyebrow">The answer</span>
                <strong>{game.current.track.title}</strong>
                <small>
                  {game.current.track.artist} · {game.current.track.year}
                </small>
              </div>
            </article>
          ) : game.current.phase === "listening" && (isActive || canTrade) ? (
            <>
              {isActive && (
                <form
                  className="song-guess"
                  onSubmit={(event) => void submitGuess(event)}
                >
                  <div>
                    <label className="field-label" htmlFor="guess-title">
                      Know the song? Earn a token
                    </label>
                    <span>
                      Correctly name both before locking in. Maximum five tokens.
                    </span>
                  </div>
                  <input
                    autoComplete="off"
                    id="guess-title"
                    maxLength={120}
                    onChange={(event) => setGuessTitle(event.target.value)}
                    placeholder="Song title"
                    value={guessTitle}
                  />
                  <input
                    autoComplete="off"
                    id="guess-artist"
                    maxLength={120}
                    onChange={(event) => setGuessArtist(event.target.value)}
                    placeholder="Artist"
                    value={guessArtist}
                  />
                  <button
                    className="secondary-button"
                    disabled={
                      Boolean(busy) ||
                      !guessTitle.trim() ||
                      !guessArtist.trim()
                    }
                    type="submit"
                  >
                    {busy === "guess"
                      ? "Saving…"
                      : game.current.guessSubmitted
                        ? "Update guess"
                        : "Submit guess"}
                  </button>
                </form>
              )}
              <div className="token-actions">
                {isActive && (
                  <button
                    className="secondary-button"
                    disabled={Boolean(busy) || !canSkip}
                    onClick={() =>
                      void run("skip", () => command("skipTrack"))
                    }
                    type="button"
                  >
                    Skip song · 1 token
                  </button>
                )}
                <button
                  className="secondary-button"
                  disabled={Boolean(busy) || !canTrade}
                  onClick={() =>
                    void run("trade", () => command("tradeTokensForCard"))
                  }
                  title="Available before the song starts; you will skip your next turn."
                  type="button"
                >
                  Take card · 3 tokens
                </button>
              </div>
            </>
          ) : null}
        </div>

        <div className="timeline-scroller">
          <MainTimeline
            game={game}
            onSelect={(gapIndex) =>
              run(
                selectionMode === "challenge" ? "challenge" : "gap",
                () =>
                  command(
                    selectionMode === "challenge"
                      ? "challengeGap"
                      : "selectGap",
                    { gapIndex },
                  ),
              )
            }
            players={room.players}
            selectionMode={selectionMode}
            timeline={timeline}
            viewerId={room.viewerId}
          />
        </div>

        <div className="round-actions">
          <button
            className="lock-button"
            disabled={
              Boolean(busy) ||
              (revealed
                ? !canContinue
                : challenging
                  ? !canPass && !canReveal
                  : !canLock)
            }
            onClick={() => {
              const commandName = revealed
                ? "nextRound"
                : challenging
                  ? canPass
                    ? "passChallenge"
                    : "reveal"
                  : "lockIn";
              void run(commandName, () => command(commandName));
            }}
            type="button"
          >
            <span>
              {revealed
                ? canContinue
                  ? "Next turn"
                  : "Waiting"
                : challenging
                  ? canPass
                    ? "No challenge"
                    : canReveal
                    ? "Reveal answer"
                    : viewerChallenge
                      ? "Challenge placed"
                      : viewerPassed
                        ? "Waiting for others"
                        : isActive
                          ? "Waiting for responses"
                          : "Waiting for reveal"
                : isActive
                  ? "Lock in"
                  : `Waiting for ${activePlayer.displayName}`}
            </span>
            <ArrowRight weight="bold" aria-hidden="true" />
          </button>
          {game.current.phase === "listening" && isActive && (
            <span className="selection-status">
              Selected: {gapLabel(timeline, game.current.selectedGap)}
            </span>
          )}
          {game.current.phase === "listening" && !isActive && (
            <span className="selection-status">
              {activePlayer.displayName} is choosing a position.
            </span>
          )}
          {challenging && !isActive && (
            <span className="selection-status">
              {viewerChallenge
                ? `Your challenge token is on ${gapLabel(
                    timeline,
                    viewerChallenge.gapIndex,
                  )}. Select it again to remove it, or choose another gap to move it.`
                : viewerPassed
                  ? "You passed. Waiting for the other players."
                : viewerTokens > 0
                  ? "Think it is wrong? Choose a different gap, or pass."
                  : "You have no music tokens. Pass to continue."}
            </span>
          )}
          {challenging && isActive && (
            <span className="selection-status">
              Give opponents a chance to challenge before revealing.
            </span>
          )}
          {revealed && game.current.outcome?.guessCorrect !== null && (
            <span
              className={`selection-status guess-result ${
                game.current.outcome?.guessCorrect ? "is-correct" : ""
              }`}
            >
              {game.current.outcome?.guessCorrect
                ? game.current.outcome.tokenAwarded
                  ? "Title and artist correct · You earned 1 music token."
                  : "Title and artist correct · Your token stack is already full."
                : "The title or artist guess was not correct."}
            </span>
          )}
          {revealed && tokenTrade && (
            <span className="selection-status">
              The card was added automatically to{" "}
              {awardedPlayer?.displayName ?? "the buyer"}’s timeline. They will
              skip their next turn.
            </span>
          )}
        </div>
        <ErrorBanner
          message={error || synchronizedAudio.error}
          onClose={() => setError("")}
        />
      </section>
      <PublicTimelines activePlayerId={game.activePlayerId} room={room} />
    </main>
  );
}

function ResultsScreen({
  room,
  connected,
  command,
}: {
  room: FinishedRoom;
  connected: boolean;
  command: RoomCommand;
}) {
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const winners = room.game.winners
    .map((id) => room.players.find((player) => player.id === id))
    .filter((player): player is RoomPlayerSnapshot => Boolean(player));
  const ranked = [...room.players].sort(
    (left, right) => (room.game.scores[right.id] ?? 0) - (room.game.scores[left.id] ?? 0),
  );

  async function run(commandName: string) {
    setBusy(true);
    setError("");
    try {
      await command(commandName);
    } catch (requestError) {
      setError(errorMessage(requestError));
    } finally {
      setBusy(false);
    }
  }

  return (
    <main className="results-shell">
      <BrandHeader room={room} connected={connected} />
      <PlayerStrip players={room.players} />
      <section className="results-stage">
        <Crown weight="fill" aria-hidden="true" />
        <span className="eyebrow">Game complete</span>
        <h1>
          {winners.length === 0
            ? "Game ended"
            : winners.length === 1
            ? `${winners[0]?.displayName ?? "Winner"} wins`
            : `${winners.map((winner) => winner.displayName).join(" & ")} tie`}
        </h1>
        <p>
          {winners.length
            ? "The first player to complete a ten-card timeline wins."
            : "No player completed a ten-card timeline."}
        </p>
        <div className="scoreboard">
          {ranked.map((player, index) => (
            <div className="score-row" key={player.id}>
              <span>{String(index + 1).padStart(2, "0")}</span>
              <PlayerAvatar player={player} small />
              <strong>{player.displayName}</strong>
              <b>{room.game.scores[player.id]} cards</b>
            </div>
          ))}
        </div>
        <ErrorBanner message={error} onClose={() => setError("")} />
        {room.isHost ? (
          <button
            className="primary-button results-action"
            disabled={busy}
            onClick={() => run("rematch")}
            type="button"
          >
            <span>{busy ? "Preparing…" : "Play a rematch"}</span>
            <ArrowsClockwise weight="bold" aria-hidden="true" />
          </button>
        ) : (
          <div className="waiting-status">
            <span className="listening-pulse" />
            Waiting for the host
          </div>
        )}
      </section>
    </main>
  );
}

function BetweenRoundsScreen({
  room,
  connected,
}: {
  room: FinishedRoom;
  connected: boolean;
}) {
  const activePlayer = room.players.find(
    (player) => player.id === room.game.activePlayerId,
  );

  return (
    <main className="game-shell">
      <BrandHeader room={room} connected={connected} />
      <PlayerStrip players={room.players} />
      <section className="between-rounds-stage">
        <Waveform aria-hidden="true" />
        <strong>Next track is cueing…</strong>
        <span>
          {activePlayer
            ? `${activePlayer.displayName} is up next.`
            : "The next turn will begin in a moment."}
        </span>
      </section>
    </main>
  );
}

export function App() {
  const [session, setSession] = useState<SessionResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [fatalError, setFatalError] = useState("");
  const roomConnection = useRoom(Boolean(session?.profile));

  useEffect(() => {
    let active = true;

    async function openSession() {
      try {
        let loadedSession = await api<SessionResponse>("/api/session");
        if (loadedSession.profile) {
          rememberProfile(loadedSession.profile);
        } else {
          const rememberedProfile = readRememberedProfile();
          if (rememberedProfile) {
            try {
              const restored = await api<{ profile: PlayerProfile }>(
                "/api/profile",
                {
                  method: "POST",
                  body: JSON.stringify(rememberedProfile),
                },
              );
              loadedSession = {
                ...loadedSession,
                profile: restored.profile,
              };
              rememberProfile(restored.profile);
            } catch {
              // A stale local profile should not prevent the entry screen opening.
            }
          }
        }
        if (active) setSession(loadedSession);
      } catch (error) {
        if (active) setFatalError(errorMessage(error));
      } finally {
        if (active) setLoading(false);
      }
    }

    void openSession();
    return () => {
      active = false;
    };
  }, []);

  const content = useMemo(() => {
    if (loading) {
      return (
        <main className="loading-screen">
          <Waveform aria-hidden="true" />
          <strong>Opening the listening room…</strong>
        </main>
      );
    }
    if (fatalError) {
      return (
        <main className="loading-screen">
          <X aria-hidden="true" />
          <strong>{fatalError}</strong>
        </main>
      );
    }
    if (!session) {
      return (
        <main className="loading-screen">
          <X aria-hidden="true" />
          <strong>The listening room could not open.</strong>
        </main>
      );
    }
    if (!session.profile) {
      return (
        <ProfileScreen
          onReady={(profile) => {
            rememberProfile(profile);
            setSession((value) => (value ? { ...value, profile } : value));
          }}
        />
      );
    }
    if (!roomConnection.room) {
      return (
        <HomeScreen
          config={session.config}
          connected={roomConnection.connected}
          createRoom={roomConnection.createRoom}
          joinRoom={roomConnection.joinRoom}
          onLogout={async () => {
            await api<null>("/api/logout", { method: "POST" });
            forgetProfile();
            setSession((value) =>
              value ? { ...value, profile: null, roomCode: null } : value,
            );
          }}
          profile={session.profile}
        />
      );
    }
    if (roomConnection.room.status === "lobby") {
      return (
        <LobbyScreen
          command={roomConnection.command}
          config={session.config}
          connected={roomConnection.connected}
          room={roomConnection.room}
        />
      );
    }
    if (roomConnection.room.status === "finished" && hasGame(roomConnection.room)) {
      return (
        <ResultsScreen
          command={roomConnection.command}
          connected={roomConnection.connected}
          room={roomConnection.room}
        />
      );
    }
    if (
      roomConnection.room.status === "playing" &&
      hasGame(roomConnection.room) &&
      !roomConnection.room.game.current
    ) {
      return (
        <BetweenRoundsScreen
          connected={roomConnection.connected}
          room={roomConnection.room}
        />
      );
    }
    if (!hasActiveGame(roomConnection.room)) {
      return (
        <main className="loading-screen">
          <X aria-hidden="true" />
          <strong>The current round is unavailable.</strong>
        </main>
      );
    }
    return (
      <GameScreen
        command={roomConnection.command}
        connected={roomConnection.connected}
        room={roomConnection.room}
      />
    );
  }, [
    fatalError,
    loading,
    roomConnection.command,
    roomConnection.connected,
    roomConnection.createRoom,
    roomConnection.joinRoom,
    roomConnection.room,
    session,
  ]);

  return (
    <>
      {content}
      <ErrorBanner message={roomConnection.connectionError} />
    </>
  );
}
