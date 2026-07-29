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
- The production implementation is desktop-only and provider-neutral. It uses
  temporary in-memory rooms, host-uploaded CSV/JSON decks, Socket.IO state
  synchronization, and host-managed external audio cues.
- Do not add Spotify authentication, Spotify API calls, or automated provider
  playback. Current policy research is recorded in
  `docs/spotify-platform-research.md`.
- Keep room and deck data ephemeral: no game history, player statistics, or
  persistent database for version one.
