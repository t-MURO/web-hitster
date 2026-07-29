# Music Timeline

A private, fully remote music-timeline game for 2–5 friends. The app manages
rooms, turns, timelines, scoring, reconnects, and reveals. Audio remains outside
the app and is controlled manually by the host.

## What works

- Temporary five-character room codes
- Fixed 2–5-player roster with no late joining after the game starts
- CSV or JSON deck upload with year corrections
- Fifty shuffled tracks with no repeats
- Unique starting cards and randomized turn order
- Blind placement, automatic reveal, and flexible same-year placement
- First timeline to 10 cards wins
- Highest score wins if the deck is exhausted
- Host cue controls for externally managed audio
- Two-minute reconnect window, player removal, and host transfer
- Rematches with the same locked roster
- No accounts, game history, statistics, or persistent room data

## Audio model

The host sees a private `audioCue` for the current track and plays it using a
separate music player. Everyone listens through the already-established voice
or video call. The app never authenticates with, controls, or reads data from a
music provider.

Because the cue includes the answer, the fairest setup uses a non-playing game
master. A playing host can still run the room, but should delegate cue playback
if they want to remain blind.

Use only audio you are entitled to play for your group.

## Deck format

Download [`public/deck-template.csv`](public/deck-template.csv) or upload JSON
with a `tracks` array. A production deck needs at least 50 unique tracks.

| Field | Required | Description |
| --- | --- | --- |
| `title` | yes | Revealed track title |
| `artist` | yes | Revealed artist |
| `year` | yes | Four-digit answer year |
| `audioCue` | yes | Host-only URL or private playback note |
| `coverUrl` | no | `http(s)` cover image URL |

Rooms and uploaded decks exist only in server memory. Restarting the container
clears them.

## Run locally

```sh
npm install
npm run dev
```

Open `http://127.0.0.1:4317`. Development mode includes a generated demo deck.

## Run on a home server

1. Copy the environment template and generate a session secret:

   ```sh
   cp .env.example .env
   openssl rand -base64 48
   ```

2. Put the generated value in `SESSION_SECRET` and set `PUBLIC_BASE_URL` to the
   HTTPS hostname you will use.

3. Start the single container:

   ```sh
   docker compose up -d --build
   docker compose ps
   ```

4. In your existing Cloudflare Tunnel, add a public hostname pointing to:

   ```text
   http://localhost:4317
   ```

5. Optionally protect the hostname with Cloudflare Access so only invited
   friends can reach the room screen.

The Compose port is bound to `127.0.0.1`, so the service is exposed through the
tunnel rather than directly on the home network.

## Verification

```sh
npm run typecheck
npm test
npm run build
curl http://127.0.0.1:4317/api/health
```

The React client, realtime server, game engine, deck parser, and multiplayer
tests are written in strict TypeScript. Shared room and game contracts live in
[`shared/types.ts`](shared/types.ts).

## Spotify note

Spotify integration is intentionally not implemented. Spotify's current
Developer Policy prohibits games/trivia and separately conflicts with the blind
playback mechanic. The primary-source research is in
[`docs/spotify-platform-research.md`](docs/spotify-platform-research.md).
