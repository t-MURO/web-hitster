# Prototype Instructions

Run the local server yourself and open the preview in the browser available to this environment. Do not give the user server-start instructions when you can run it.

Before making substantial visual changes, use the Product Design plugin's `get-context` skill when the visual source is unclear or no longer matches the current goal. When the user gives durable prototype-specific design feedback, preferences, or decisions, record them in `AGENTS.md`.

When implementing from a selected generated mock, treat that image as the source of truth for layout, component anatomy, density, spacing, color, typography, visible content, and hierarchy.

Build app UI in `src/`. Keep `.openai/hosting.json`, `worker/index.js`, `scripts/prepare-sites-build.mjs`, and `tests/sites-worker.test.mjs` intact so the same local prototype can be handed to Sites. Before a Sites handoff, run `npm run build` and `npm run test:sites`; the build must leave `dist/client/index.html`, `dist/server/index.js`, and `dist/.openai/hosting.json`.

## Music Timeline design direction

- The selected visual source is `design/reference/music-timeline-selected.png`.
- Recreate the selected dark hi-fi listening-room direction faithfully: near-black surfaces, warm amber primary actions, electric-blue connection states, condensed display typography, tactile record-sleeve imagery, fine dividers, and restrained radii and shadows.
- The hero state is the live desktop round: five connected players, Maya active, a public chronological timeline, a hidden song, selectable insertion gaps, and one dominant `LOCK IN` action.
- Never show the current mystery song title, artist, or cover before reveal.
- Keep the interface original. Do not use HITSTER branding, assets, or trade dress.
- The production implementation is desktop-only. Its primary private-prototype
  happy path uses host-only Spotify Authorization Code login to import trusted
  metadata from an owned or collaborative playlist, then uses `yt-dlp` and
  `ffmpeg` on the server to prepare temporary MP3 files for authenticated,
  synchronized room playback. CSV/JSON decks and host-managed external cues
  remain available as a fallback.
- Never expose the current mystery title, artist, cover, Spotify URL, YouTube
  result, or temporary filesystem path before reveal. Clients fetch audio only
  through an opaque authenticated room-and-round endpoint.
- Begin a hosted game once there is one starting card per connected player plus
  the first mystery track, with an absolute minimum of three prepared tracks.
  Track client readiness before host playback, preserve temporary audio for
  rematches, and delete it when the room closes, expires, or the server restarts.
- Do not blindly trust the first YouTube search result. Rank several candidates
  against Spotify title, artist, and duration metadata, reject risky variants,
  and keep every failed attempt outside the playable deck. Hosts can cancel a
  preparation or retry one/all excluded tracks.
- Keep a credential-free hosted demo in development mode. It generates
  temporary tones with `ffmpeg` so the preparation, streaming, readiness,
  playback, and cleanup flow can be verified without Spotify or YouTube access.
- This is an intentionally private, non-commercial prototype. The user accepts
  the documented Spotify and YouTube policy risks for this happy-path build;
  keep those risks explicit in project documentation.
- Keep room and deck data ephemeral: no game history, player statistics, or
  persistent database for version one.
- Follow the Original timeline rules: every player starts with one visible card,
  the oldest starting card takes the first turn, equal-year cards stay grouped
  with placement allowed only before or after the group, and only completing
  the host-selected 5–20-card win target produces a winner.
- Implement the full music-token economy: start with two, spend one to redraw,
  spend one to challenge, trade three for a guaranteed card before listening
  and skip the purchaser's next turn, and earn one for a correct title-and-artist
  guess up to a maximum of five. Make a successfully earned token visually
  prominent at reveal.
- After lock-in, open a server-authoritative 15-second challenge window.
  Opponents may challenge or pass early; when time expires, unanswered players
  automatically pass and the active player or host can reveal.
