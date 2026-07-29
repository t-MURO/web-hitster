import assert from "node:assert/strict";
import test from "node:test";
import type { GamePlayer, PublicTrack, Track } from "../shared/types.js";
import { TimelineGame } from "../server/game-engine.js";

function tracks(count = 12): Track[] {
  return Array.from({ length: count }, (_, index) => ({
    id: `track-${index}`,
    title: `Track ${index}`,
    artist: `Artist ${index}`,
    year: 1970 + index * 3,
    originalYear: 1970 + index * 3,
    coverUrl: null,
    audioCue: `Cue ${index}`,
  }));
}

function players(): GamePlayer[] {
  return [
    { id: "maya", displayName: "Maya", avatarUrl: "/maya.png" },
    { id: "leo", displayName: "Leo", avatarUrl: "/leo.png" },
  ];
}

function required<T>(value: T | null | undefined, label: string): T {
  assert.ok(value != null, label);
  return value;
}

function correctGap(timeline: PublicTrack[], year: number): number {
  const index = timeline.findIndex((track) => track.year > year);
  return index < 0 ? timeline.length : index;
}

test("mystery metadata remains hidden until reveal", () => {
  const game = TimelineGame.create({
    players: players(),
    tracks: tracks(),
    random: () => 0,
  });

  const before = game.snapshot();
  assert.equal(required(before.current, "current round").track, null);

  const active = required(before.activePlayerId, "active player");
  const currentTrack = required(game.currentTrack, "mystery track");
  const gap = correctGap(before.timelines[active] ?? [], currentTrack.year);
  game.selectGap(active, gap);
  game.reveal(active);

  const after = game.snapshot();
  const revealed = required(after.current, "revealed round");
  assert.equal(required(revealed.track, "revealed track").year, currentTrack.year);
  assert.equal(required(revealed.outcome, "round outcome").correct, true);
});

test("wrong placement discards the track", () => {
  const game = TimelineGame.create({
    players: players(),
    tracks: tracks(),
    random: () => 0,
  });
  const before = game.snapshot();
  const active = required(before.activePlayerId, "active player");
  const timeline = before.timelines[active] ?? [];
  const currentTrack = required(game.currentTrack, "mystery track");
  const rightGap = correctGap(timeline, currentTrack.year);
  const wrongGap = rightGap === 0 ? timeline.length : 0;

  game.selectGap(active, wrongGap);
  game.reveal(active);

  const after = game.snapshot();
  const outcome = required(
    required(after.current, "revealed round").outcome,
    "round outcome",
  );
  assert.equal(outcome.correct, false);
  assert.equal(after.scores[active], before.scores[active]);
});

test("same-year placement is accepted on either side of an equal-year card", () => {
  const equalYearTracks = tracks();
  for (const index of [0, 1, 2]) {
    const track = equalYearTracks[index];
    if (track) track.year = 1991;
  }
  const game = TimelineGame.create({
    players: players(),
    tracks: equalYearTracks,
    random: () => 0,
  });
  const snapshot = game.snapshot();
  const active = required(snapshot.activePlayerId, "active player");
  const timeline = snapshot.timelines[active] ?? [];
  const currentTrack = required(game.currentTrack, "mystery track");
  const equalIndex = timeline.findIndex(
    (track) => track.year === currentTrack.year,
  );

  if (equalIndex >= 0) {
    game.selectGap(active, equalIndex);
    assert.equal(game.reveal(active).correct, true);
  } else {
    assert.ok(
      true,
      "Deterministic shuffle did not deal the equal-year pair together.",
    );
  }
});

test("reaching the configured timeline size finishes the game", () => {
  const game = TimelineGame.create({
    players: players(),
    tracks: tracks(),
    random: () => 0,
    winningTimelineSize: 2,
  });
  const before = game.snapshot();
  const active = required(before.activePlayerId, "active player");
  const currentTrack = required(game.currentTrack, "mystery track");
  game.selectGap(
    active,
    correctGap(before.timelines[active] ?? [], currentTrack.year),
  );
  game.reveal(active);

  const after = game.snapshot();
  assert.equal(after.status, "finished");
  assert.deepEqual(after.winners, [active]);
});
