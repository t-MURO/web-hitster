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
import { useRoom } from "./useRoom.js";
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
  Track,
} from "../shared/types.js";

const AVATARS = ["maya", "leo", "sofia", "ben", "nora"] as const;
const FALLBACK_COVERS = [1977, 1984, 1999, 2013];

type AsyncCallback = () => Promise<unknown>;
type RunAction = (label: string, callback: AsyncCallback) => Promise<void>;
type ActiveGame = GameSnapshot & {
  activePlayerId: string;
  current: CurrentRoundSnapshot;
};
type ActiveRoom = RoomSnapshot & { game: ActiveGame };
type FinishedRoom = RoomSnapshot & { game: GameSnapshot };

function hasGame(room: RoomSnapshot): room is FinishedRoom {
  return room.game !== null;
}

function hasActiveGame(room: RoomSnapshot): room is ActiveRoom {
  return Boolean(room.game?.activePlayerId && room.game.current);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : "Something went wrong.";
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
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setBusy(true);
    setError("");
    try {
      const payload = await api<{ profile: PlayerProfile }>("/api/profile", {
        method: "POST",
        body: JSON.stringify({ displayName, avatarKey }),
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
            Pick the name and portrait your friends will see. No account or
            history is stored.
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
                    aria-pressed={avatarKey === avatar}
                    className={avatarKey === avatar ? "avatar-choice is-selected" : "avatar-choice"}
                    key={avatar}
                    onClick={() => setAvatarKey(avatar)}
                    type="button"
                  >
                    <img src={`/assets/avatars/${avatar}.png`} alt="" />
                  </button>
                ))}
              </div>
            </fieldset>
            <ErrorBanner message={error} onClose={() => setError("")} />
            <button className="primary-button" disabled={busy} type="submit">
              <span>{busy ? "Entering…" : "Continue"}</span>
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
  const [code, setCode] = useState("");
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
          <img src={`/assets/avatars/${profile.avatarKey}.png`} alt="" />
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
              Upload a private 50-track deck, invite 1–4 friends, and control
              the external audio cues.
            </p>
            <button
              className="primary-button"
              disabled={!connected || Boolean(busy)}
              onClick={() => run("create", createRoom)}
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
                setCode(event.target.value.toUpperCase().replace(/[^A-Z0-9]/g, ""))
              }
              placeholder="J7K4Q"
              value={code}
            />
            <button
              className="secondary-button"
              disabled={!connected || Boolean(busy) || code.length !== 5}
              onClick={() => run("join", () => joinRoom(code))}
              type="button"
            >
              {busy === "join" ? "Joining…" : "Join room"}
            </button>
          </article>
        </div>
        <ErrorBanner message={error} onClose={() => setError("")} />
        <p className="privacy-note">
          Rooms live in memory only. Audio stays outside this app. First to
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

function PlayerStrip({ players }: { players: RoomPlayerSnapshot[] }) {
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

  async function copyCode() {
    await navigator.clipboard.writeText(room.code);
    setCopied(true);
    window.setTimeout(() => setCopied(false), 1500);
  }

  const canStart = Boolean(
    room.isHost &&
    room.players.length >= 2 &&
    room.players.every((player) => player.connected) &&
    room.deck?.ready,
  );

  return (
    <main className="lobby-shell">
      <BrandHeader
        room={room}
        connected={connected}
        onLeave={() => run("leave", () => command("leaveRoom"))}
      >
        <button className="topbar-button" onClick={copyCode} type="button">
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
              ? "Audio is played outside the app. The host alone sees each cue."
              : "Keep your external voice or video call open so everyone hears the same cue."}
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
                <span className="eyebrow">Private deck</span>
                <h2>{room.deck ? room.deck.name : "No deck loaded"}</h2>
              </div>
              <FileCsv aria-hidden="true" />
            </div>

            {room.isHost ? (
              <>
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
                      onClick={() => run("demo", () => command("useDemoDeck"))}
                      type="button"
                    >
                      Use demo deck
                    </button>
                  )}
                  <a className="text-link" download href="/deck-template.csv">
                    <DownloadSimple aria-hidden="true" />
                    Deck template
                  </a>
                </div>
                {room.deck && (
                  <div className="deck-summary">
                    <strong>{room.deck.trackCount} unique tracks</strong>
                    <span>
                      {room.deck.ready
                        ? `${room.rules.deckSize} will be shuffled into the game`
                        : `${room.rules.deckSize - room.deck.trackCount} more required`}
                    </span>
                  </div>
                )}
                {room.deckReview && (
                  <details className="year-review">
                    <summary>Review album years ({room.deckReview.length})</summary>
                    <div className="year-review__list">
                      {room.deckReview.map((track) => (
                        <label key={track.id}>
                          <span>
                            <strong>{track.title}</strong>
                            <small>{track.artist}</small>
                          </span>
                          <input
                            aria-label={`Year for ${track.title}`}
                            defaultValue={track.year}
                            inputMode="numeric"
                            max="2100"
                            min="1900"
                            onBlur={(event) => {
                              const year = Number(event.target.value);
                              if (year !== track.year) {
                                run(`year-${track.id}`, () =>
                                  command("overrideYear", { trackId: track.id, year }),
                                );
                              }
                            }}
                            type="number"
                          />
                        </label>
                      ))}
                    </div>
                  </details>
                )}
              </>
            ) : (
              <div className="waiting-card">
                {room.deck ? (
                  <>
                    <Check weight="bold" aria-hidden="true" />
                    <strong>{room.deck.trackCount} tracks ready</strong>
                    <span>Only the host can review the mystery deck.</span>
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
            onClick={() => run("start", () => command("startGame"))}
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
  return (
    <article
      className={`mystery-card ${revealed ? "mystery-card--revealed" : ""} ${
        revealed && !correct ? "mystery-card--incorrect" : ""
      }`}
    >
      {revealed ? (
        <>
          {correct ? <Check weight="bold" aria-hidden="true" /> : <X weight="bold" aria-hidden="true" />}
          <strong>{current.track?.year ?? "—"}</strong>
          <span>{correct ? "Correct" : "Wrong gap"}</span>
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
  canSelect,
  onSelect,
}: {
  game: ActiveGame;
  timeline: PublicTrack[];
  canSelect: boolean;
  onSelect: (index: number) => void;
}) {
  const nodes: ReactNode[] = [];
  for (let index = 0; index <= timeline.length; index += 1) {
    const selected = game.current.selectedGap === index;
    if (selected) {
      nodes.push(
        <div className="gap-slot gap-slot--selected" key={`gap-${index}`}>
          <span className="selection-caret" aria-hidden="true" />
          <MysteryCard current={game.current} />
          <span className="gap-slot__label">{gapLabel(timeline, index)}</span>
        </div>,
      );
    } else {
      nodes.push(
        <button
          aria-label={gapLabel(timeline, index)}
          className="gap-slot"
          disabled={!canSelect}
          key={`gap-${index}`}
          onClick={() => onSelect(index)}
          type="button"
        >
          <Plus weight="light" aria-hidden="true" />
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
  cue: Track | null;
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
        <strong>{cue.title}</strong>
        <small>{cue.artist} · answer {cue.year}</small>
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
        {activeIsHost && <em>You are active—avoid reading the answer if playing blind.</em>}
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
  const game = room.game;
  const activePlayer = room.players.find((player) => player.id === game.activePlayerId);
  const timeline = game.timelines[game.activePlayerId] ?? [];
  const isActive = room.viewerId === game.activePlayerId;
  const revealed = game.current.phase === "revealed";
  const correct = game.current.outcome?.correct;

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

  const stateLabel = revealed
    ? correct
      ? `Correct · ${game.current.track?.year ?? "—"}`
      : `${game.current.track?.year ?? "—"} · Wrong gap`
    : room.playback.status === "playing"
      ? "Listening"
      : room.playback.status === "paused"
        ? "Paused"
        : "Waiting for host";

  const canSelect = isActive && !revealed;
  const canLock = isActive && !revealed && room.playback.status === "playing";
  const canContinue = revealed && (isActive || room.isHost);

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
      <PlayerStrip players={room.players} />
      <HostCue
        activeIsHost={room.hostId === game.activePlayerId}
        busy={busy}
        command={command}
        cue={room.hostCue}
        playback={room.playback}
        run={run}
      />

      <section
        className={`round-stage ${revealed ? "round-stage--revealed" : ""} ${
          revealed && !correct ? "round-stage--incorrect" : ""
        }`}
      >
        <div className="turn-heading">
          <span aria-hidden="true" />
          <h1>
            {revealed
              ? correct
                ? "Great placement"
                : "Not this time"
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

        <div className="timeline-scroller">
          <MainTimeline
            canSelect={canSelect}
            game={game}
            onSelect={(gapIndex) => run("gap", () => command("selectGap", { gapIndex }))}
            timeline={timeline}
          />
        </div>

        <div className="round-actions">
          <button
            className="lock-button"
            disabled={Boolean(busy) || (revealed ? !canContinue : !canLock)}
            onClick={() =>
              run(revealed ? "next" : "lock", () =>
                command(revealed ? "nextRound" : "lockIn"),
              )
            }
            type="button"
          >
            <span>
              {revealed
                ? canContinue
                  ? "Next turn"
                  : "Waiting"
                : isActive
                  ? "Lock in"
                  : `Waiting for ${activePlayer.displayName}`}
            </span>
            <ArrowRight weight="bold" aria-hidden="true" />
          </button>
          {!revealed && isActive && (
            <span className="selection-status">
              Selected: {gapLabel(timeline, game.current.selectedGap)}
            </span>
          )}
          {!isActive && !revealed && (
            <span className="selection-status">
              {activePlayer.displayName} is choosing a position.
            </span>
          )}
        </div>
        <ErrorBanner message={error} onClose={() => setError("")} />
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
          {winners.length === 1
            ? `${winners[0]?.displayName ?? "Winner"} wins`
            : `${winners.map((winner) => winner.displayName).join(" & ")} tie`}
        </h1>
        <p>First to ten—or the highest timeline when the deck ran out.</p>
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

export function App() {
  const [session, setSession] = useState<SessionResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [fatalError, setFatalError] = useState("");
  const roomConnection = useRoom(Boolean(session?.profile));

  useEffect(() => {
    api<SessionResponse>("/api/session")
      .then(setSession)
      .catch((error: unknown) => setFatalError(errorMessage(error)))
      .finally(() => setLoading(false));
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
          onReady={(profile) =>
            setSession((value) => (value ? { ...value, profile } : value))
          }
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
