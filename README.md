# Music Timeline

A private, fully remote music-timeline game for 2–5 friends. The host imports an
owned or collaborative Spotify playlist, the server pairs its authoritative
metadata with a YouTube search result, prepares temporary MP3 files, and
synchronizes blind playback across the room.

## What works

- Temporary five-character room codes and shareable `/room/CODE` invite URLs
- Fixed 2–5-player roster with no late joining after play starts
- Host-only Spotify Authorization Code login; secrets and tokens stay server-side
- Spotify title, artists, album release year, cover, duration, and ISRC metadata
- Asynchronous YouTube search plus `yt-dlp`/`ffmpeg` MP3 preparation
- Multi-candidate title/artist/duration matching that rejects common live,
  cover, karaoke, remix, sped-up, and slowed variants
- Live preparation progress and skipped-track count without a metadata review
- Per-track and retry-all recovery, attempt counts, cancellation, and processor
  diagnostics
- Explicit non-retryable exclusions for unavailable Spotify items, local files,
  and tracks without usable release-year metadata
- Start once every player has a starting card plus one mystery track (minimum
  three); no repeats within a game
- Authenticated per-round MP3 delivery with HTTP range support
- Client preload acknowledgements and server-scheduled synchronized starts
- Oldest-card first turn, blind placement, equal-year handling, reveal, scoring,
  reconnects, host transfer, and rematches
- Full music-token rules: redraw, challenge and steal, three-token guaranteed
  card with a skipped turn, and title-and-artist token earning capped at five
- Explicit challenge-or-pass responses from every connected opponent before
  reveal
- CSV/JSON decks with host-managed external cues as a fallback
- A generated hosted-audio demo that exercises the full streaming path without
  Spotify credentials or YouTube access
- No accounts, history, statistics, database, or persistent media

## Hosted audio flow

1. The host creates a room and connects Spotify.
2. The host pastes a playlist they own or collaborate on.
3. Spotify supplies the game metadata. The server searches YouTube for each
   title and artist, extracts MP3 audio, and stores it under a room-specific
   temporary directory.
4. A two-player game can start once three tracks have succeeded; larger rooms
   wait for one starting card per player plus the first mystery track. Browsers
   preload and decode each opaque round automatically.
5. The host starts playback only after every connected player is ready. The
   server broadcasts a shared future start time so clients begin together.
6. Preparation stops after 100 successful tracks. Files remain available for
   rematches and are deleted when the room empties, expires, or the
   process/container restarts.

The current mystery title, artist, cover, Spotify link, YouTube result, and
filesystem path are never included in pre-reveal room state.

To bound temporary storage and preparation time, one import uses at most the
first 200 eligible unique playlist tracks and inspects at most 500 playlist
items.

## Spotify setup

Create a Spotify Developer application and register the exact redirect URI:

```text
https://your-music-subdomain.example/callback
```

Set the same value in `SPOTIFY_REDIRECT_URI`. The host grants only
`playlist-read-private` and `playlist-read-collaborative`. Under Spotify's
current Development Mode rules, playlist items are readable only for playlists
the logged-in host owns or collaborates on.

## Run locally

Install Node.js 22+, `yt-dlp`, and `ffmpeg`. Copy `.env.example` to `.env`,
replace the public URL and Spotify credentials, then run:

```sh
npm install
npm run dev
```

Without Spotify credentials the app still starts and the demo/upload fallback
remains available. In development, choose **Use hosted audio demo** to generate
temporary test tones with `ffmpeg` and exercise preparation, authenticated
streaming, client readiness, synchronized playback, and cleanup without any
provider API keys. The lobby also reports whether `yt-dlp` and `ffmpeg` are
available on the server.

## Run on a home server

1. Copy `.env.example` to `.env`, generate a strong `SESSION_SECRET`, and set
   `PUBLIC_BASE_URL`, `SPOTIFY_CLIENT_ID`, `SPOTIFY_CLIENT_SECRET`, and the exact
   `SPOTIFY_REDIRECT_URI`.
2. Build and start the container:

   ```sh
   docker compose up -d --build
   docker compose ps
   ```

3. Point the existing Cloudflare Tunnel hostname to
   `http://localhost:4317`. The Compose port binds only to `127.0.0.1`.
4. Optionally put Cloudflare Access in front of the hostname.

The image includes `yt-dlp` and `ffmpeg`. Its filesystem is read-only except for
a 2 GB `/tmp` tmpfs used by ephemeral room audio.

## Fallback deck format

Download `public/deck-template.csv` or upload JSON with a `tracks` array.

| Field | Required | Description |
| --- | --- | --- |
| `title` | yes | Revealed track title |
| `artist` | yes | Revealed artist |
| `year` | yes | Four-digit answer year |
| `audioCue` | yes | Host-only URL or private playback note |
| `coverUrl` | no | `http(s)` cover image URL |

## Policy and rights warning

This repository implements an intentionally private, non-commercial prototype.
Spotify currently prohibits games/trivia using its developer platform, and
YouTube prohibits downloading, caching, separating, or redistributing its
audio without permission. Private use does not create a policy or copyright
exception. Operate this only with content and permissions you are entitled to
use, and do not expose it publicly without replacing this prototype pipeline
with a licensed source. The verified platform research is in
`docs/spotify-platform-research.md` and `docs/youtube-platform-research.md`.

## Verification

```sh
npm run typecheck
npm test
npm run build
```
