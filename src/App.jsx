import { useMemo, useState } from "react";
import {
  ArrowLeft,
  ArrowRight,
  ArrowsClockwise,
  CaretDown,
  Check,
  Desktop,
  Gear,
  Headphones,
  Pause,
  Plus,
  Question,
  SignOut,
  UsersThree,
  Waveform,
  X,
} from "@phosphor-icons/react";
import "@fontsource/bebas-neue/400.css";
import "@fontsource/inter/400.css";
import "@fontsource/inter/500.css";
import "@fontsource/inter/600.css";

const players = [
  { name: "Maya", avatar: "/assets/avatars/maya.png", active: true },
  { name: "Leo", avatar: "/assets/avatars/leo.png" },
  { name: "Sofia", avatar: "/assets/avatars/sofia.png" },
  { name: "Ben", avatar: "/assets/avatars/ben.png" },
  { name: "Nora", avatar: "/assets/avatars/nora.png" },
];

const timelineCards = [
  { year: 1977, cover: "/assets/covers/cover-1977.png" },
  { year: 1984, cover: "/assets/covers/cover-1984.png" },
  { year: 1999, cover: "/assets/covers/cover-1999.png" },
  { year: 2013, cover: "/assets/covers/cover-2013.png" },
];

const gapLabels = [
  "Before 1977",
  "Between 1977 and 1984",
  "Between 1984 and 1999",
  "Between 1999 and 2013",
  "After 2013",
];

const miniTimelines = {
  Leo: [1984, 1977, 2013, 1999],
  Sofia: [1999, 1977, 2013, 1984],
  Ben: [2013, 1984, 1999, 1977],
  Nora: [1977, 1999, 1984, 2013],
};

function PlayerAvatar({ player, small = false }) {
  return (
    <img
      className={small ? "avatar avatar--small" : "avatar"}
      src={player.avatar}
      alt=""
    />
  );
}

function PlayerStrip() {
  return (
    <section className="player-strip" aria-label="Connected players">
      {players.map((player) => (
        <div
          className={`player-chip ${player.active ? "player-chip--active" : ""}`}
          key={player.name}
        >
          <PlayerAvatar player={player} />
          <div className="player-chip__copy">
            <div className="player-chip__name-row">
              <strong>{player.name}</strong>
              {player.active && <span className="active-tag">Active</span>}
            </div>
            <span className="connected-label">
              <Headphones weight="fill" aria-hidden="true" />
              Connected
            </span>
          </div>
        </div>
      ))}
    </section>
  );
}

function KnownCard({ card, mini = false }) {
  return (
    <article className={mini ? "mini-cover" : "year-card"}>
      {!mini && <span className="year-card__year">{card.year}</span>}
      <img src={card.cover} alt="" />
    </article>
  );
}

function MysteryCard({ correct, revealed }) {
  return (
    <article
      className={`mystery-card ${revealed ? "mystery-card--revealed" : ""} ${
        revealed && !correct ? "mystery-card--incorrect" : ""
      }`}
    >
      {revealed ? (
        <>
          {correct ? (
            <Check weight="bold" aria-hidden="true" />
          ) : (
            <X weight="bold" aria-hidden="true" />
          )}
          <strong>1991</strong>
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

function Gap({ correct, index, selected, onSelect, revealed }) {
  if (selected) {
    return (
      <div className="gap-slot gap-slot--selected">
        <span className="selection-caret" aria-hidden="true" />
        <MysteryCard correct={correct} revealed={revealed} />
        <span className="gap-slot__label">{gapLabels[index]}</span>
      </div>
    );
  }

  return (
    <button className="gap-slot" onClick={() => onSelect(index)} type="button">
      <Plus weight="light" aria-hidden="true" />
      <span>{gapLabels[index]}</span>
    </button>
  );
}

function MainTimeline({ correct, selectedGap, setSelectedGap, revealed }) {
  const nodes = [];

  timelineCards.forEach((card, index) => {
    nodes.push(
      <Gap
        index={index}
        key={`gap-${index}`}
        onSelect={setSelectedGap}
        correct={correct}
        revealed={revealed}
        selected={selectedGap === index}
      />,
    );
    nodes.push(<KnownCard card={card} key={card.year} />);
  });

  nodes.push(
    <Gap
      index={4}
      key="gap-4"
      onSelect={setSelectedGap}
      correct={correct}
      revealed={revealed}
      selected={selectedGap === 4}
    />,
  );

  return <div className="main-timeline">{nodes}</div>;
}

function OtherTimelines() {
  const supportingPlayers = players.slice(1);

  return (
    <section className="other-timelines" aria-label="Other public timelines">
      {supportingPlayers.map((player) => (
        <div className="mini-timeline" key={player.name}>
          <div className="mini-timeline__person">
            <PlayerAvatar player={player} small />
            <strong>{player.name}</strong>
          </div>
          <div className="mini-timeline__rail" aria-label={`${player.name}'s timeline`}>
            {miniTimelines[player.name].map((year, index) => {
              const card = timelineCards.find((item) => item.year === year);
              return (
                <div className="mini-timeline__item" key={`${player.name}-${year}`}>
                  {index > 0 && (
                    <span className="mini-gap" aria-hidden="true">
                      <Plus aria-hidden="true" />
                    </span>
                  )}
                  <KnownCard card={card} mini />
                </div>
              );
            })}
          </div>
        </div>
      ))}
    </section>
  );
}

function HostMenu({ onClose, onPause, onRestart }) {
  return (
    <div className="popover host-menu" role="menu">
      <button onClick={onPause} role="menuitem" type="button">
        <Pause weight="fill" aria-hidden="true" />
        Pause all
      </button>
      <button onClick={onRestart} role="menuitem" type="button">
        <ArrowsClockwise aria-hidden="true" />
        Restart track
      </button>
      <button className="danger-action" role="menuitem" type="button" onClick={onClose}>
        <SignOut aria-hidden="true" />
        End game
      </button>
    </div>
  );
}

function PlayerMenu() {
  return (
    <div className="popover players-menu">
      <span>5 players connected</span>
      <strong>Everyone can hear the track</strong>
    </div>
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

export function App() {
  const [selectedGap, setSelectedGap] = useState(2);
  const [roundState, setRoundState] = useState("listening");
  const [hostMenuOpen, setHostMenuOpen] = useState(false);
  const [playersOpen, setPlayersOpen] = useState(false);

  const gapSummary = useMemo(() => gapLabels[selectedGap], [selectedGap]);
  const revealed = roundState === "revealed";
  const paused = roundState === "paused";
  const correct = selectedGap === 2;

  function chooseGap(index) {
    setSelectedGap(index);
    setRoundState("listening");
  }

  function lockIn() {
    setRoundState("revealed");
  }

  function nextTurn() {
    setRoundState("listening");
    setSelectedGap(2);
  }

  function pauseAll() {
    setRoundState("paused");
    setHostMenuOpen(false);
  }

  function restartTrack() {
    setRoundState("listening");
    setHostMenuOpen(false);
  }

  return (
    <main className="app-shell">
      <header className="topbar">
        <div className="brand-lockup">
          <span>Music Timeline</span>
        </div>
        <div className="room-id">
          <span>Room</span>
          <strong>J7K4Q</strong>
        </div>
        <div className="device-status">
          <Desktop aria-hidden="true" />
          <span>All devices connected</span>
        </div>
        <div className="topbar__actions">
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
                onClose={() => setHostMenuOpen(false)}
                onPause={pauseAll}
                onRestart={restartTrack}
              />
            )}
          </div>
          <div className="popover-anchor">
            <button
              aria-expanded={playersOpen}
              aria-label="Show connected players"
              className="topbar-button topbar-button--compact"
              onClick={() => setPlayersOpen((value) => !value)}
              type="button"
            >
              <UsersThree aria-hidden="true" />
              <span>5</span>
              <CaretDown aria-hidden="true" />
            </button>
            {playersOpen && <PlayerMenu />}
          </div>
        </div>
      </header>

      <PlayerStrip />

      <section
        className={`round-stage ${revealed ? "round-stage--revealed" : ""} ${
          revealed && !correct ? "round-stage--incorrect" : ""
        }`}
      >
        <div className="turn-heading">
          <span aria-hidden="true" />
          <h1>
            {revealed ? (correct ? "Great placement" : "Not this time") : "Maya’s turn"}
          </h1>
          <span aria-hidden="true" />
        </div>

        <div className="listening-state" aria-live="polite">
          <WaveRail />
          {revealed ? (
            <>
              {correct ? (
                <Check weight="bold" aria-hidden="true" />
              ) : (
                <X weight="bold" aria-hidden="true" />
              )}
              <strong>{correct ? "Correct · 1991" : "1991 · Wrong gap"}</strong>
            </>
          ) : paused ? (
            <>
              <Pause weight="fill" aria-hidden="true" />
              <strong>Paused</strong>
            </>
          ) : (
            <>
              <Headphones weight="fill" aria-hidden="true" />
              <strong>Listening</strong>
            </>
          )}
          <WaveRail />
        </div>

        <MainTimeline
          correct={correct}
          revealed={revealed}
          selectedGap={selectedGap}
          setSelectedGap={chooseGap}
        />

        <div className="round-actions">
          <button
            className="lock-button"
            disabled={paused}
            onClick={revealed ? nextTurn : lockIn}
            type="button"
          >
            <span>{revealed ? "Next turn" : "Lock in"}</span>
            <ArrowRight weight="bold" aria-hidden="true" />
          </button>
          {!revealed && !paused && (
            <button
              className="change-position"
              onClick={() => chooseGap((selectedGap + 1) % gapLabels.length)}
              type="button"
            >
              <ArrowLeft aria-hidden="true" />
              <ArrowRight aria-hidden="true" />
              Change position
            </button>
          )}
          <span className="selection-status" aria-live="polite">
            {revealed
              ? correct
                ? "The card joins Maya’s timeline."
                : "The card is discarded."
              : paused
                ? "Playback is paused for everyone."
                : `Selected: ${gapSummary}`}
          </span>
        </div>
      </section>

      <OtherTimelines />
    </main>
  );
}
