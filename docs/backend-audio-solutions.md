# Backend audio solutions for Music Timeline

Verified against primary sources on 2026-07-29.

## Bottom line

Yes, the home server can stream the mystery audio to every player and start it
nearly simultaneously. The best technical design for this game is not a
Spotify-style service or an internet-radio server: it is an authenticated audio
endpoint, client prebuffering, and a scheduled Web Audio start.

That design is suitable only for recordings the host is actually permitted to
reproduce and transmit. A purchased CD/file or a paid streaming subscription
does not, by itself, grant those rights. For a mainstream hit catalogue, none
of the investigated consumer services provides both a raw backend stream and
documented permission for this blind remote game.

**Recommended v1:**

1. Keep the current external-audio mode as the default for ordinary commercial
   music.
2. Add an optional built-in audio mode for self-created, public-domain
   recordings, directly licensed files, and carefully reviewed Creative Commons
   tracks.
3. If an immediately usable independent-music catalogue is acceptable, trial
   Jamendo as a separate provider mode. Stream its provider URLs rather than
   rehosting them, retain each track's licence information, and show attribution
   on reveal.

This is a technical and product recommendation, not legal advice.

## What “streaming from the backend” should look like

### Recommended: authenticated HTTP audio plus synchronized Web Audio

The host uploads an audio file and its game metadata. The server stores it
ephemerally and exposes it only through a room-authorized, short-lived URL.
Before each round, every browser downloads or buffers the selected audio and
sends `audio-ready`. The server then broadcasts an idempotent command such as
`{ roundId, startsAt }`, with `startsAt` two or three seconds in the future.
Each client maps that server deadline onto its own audio clock and schedules
playback.

The Web Audio API can schedule an `AudioBufferSourceNode` at a precise
`AudioContext.currentTime`, including a source offset and duration. It does not
synchronize different computers' clocks, so the app must first estimate the
server offset using several ping/ack samples and prefer the lowest-round-trip
sample. Different sound cards and operating-system output buffers can still
leave small audible differences. [W3C Web Audio specification](https://www.w3.org/TR/webaudio-1.0/)

Socket.IO preserves message order but defaults to at-most-once delivery. Round
start messages therefore need unique IDs, acknowledgements, and recovery from
the authoritative room state after reconnect. [Socket.IO delivery
guarantees](https://socket.io/docs/v4/delivery-guarantees/) and [broadcast
acknowledgements](https://socket.io/docs/v4/broadcasting-events/)

Every player also needs to click an **Enable audio** control once after joining.
Browsers commonly block scripted audible playback before the user interacts
with the page. [Browser autoplay guidance](https://developer.mozilla.org/en-US/docs/Web/Media/Guides/Autoplay)

This gives the product the desired behavior:

- one host command starts audio for all players;
- the title, artist, artwork, and year can remain hidden until reveal;
- late clients can seek to the authoritative elapsed position or wait for the
  next round;
- no player needs an account with a commercial music provider.

It is not DRM. A browser that can play audio can ultimately capture it.
Authentication, room membership, expiring URLs, and prompt deletion reduce
exposure but cannot make extraction impossible.

### Simpler: progressive `<audio>` playback

The backend can serve MP3, AAC, or Opus with HTTP Range support and let each
browser use a normal `<audio>` element. Range requests and `206 Partial
Content` are standardized in [RFC 9110](https://www.rfc-editor.org/rfc/rfc9110.html#name-range-requests).
This is straightforward and bandwidth-efficient, but independent `play()`
calls can differ by hundreds of milliseconds because each browser buffers and
starts at a different time.

For five friends, the more reliable approach is to preload the round and use
Web Audio scheduling. At 128 kbit/s, five simultaneous listeners require about
0.64 Mbit/s of home-server upload bandwidth, before protocol overhead.

### Possible but inferior: Icecast

Icecast accepts one source stream and sends the same continuous broadcast to
all listeners. Its own FAQ distinguishes this from on-demand playback: every
listener at a mountpoint receives the same stream and cannot independently
choose tracks or pause without leaving the live point. [Icecast architecture
and setup](https://www.icecast.org/docs/icecast-trunk/basic_setup/) and
[Icecast FAQ](https://icecast.org/faq/)

This is attractive for a continuous remote radio show, but not for discrete
rounds. Per-browser buffer depth still varies, starting/stopping rounds is
awkward, and seeking a late player to an exact game position is not natural.

### Possible but excessive: HLS or WebRTC

- HLS/MSE adds segmented and adaptive delivery, but conventional live HLS
  intentionally plays behind the live edge. It is useful for larger audiences
  or unstable bandwidth, not five prebuffered listeners. [HLS
  specification](https://www.rfc-editor.org/rfc/rfc8216.html) and [Media Source
  Extensions](https://www.w3.org/TR/media-source-2/)
- A backend WebRTC broadcaster can push one live Opus feed with low latency.
  It adds signaling, TURN, and usually an SFU/media server, while jitter buffers
  and output hardware still prevent sample-identical playback. It is a better
  fit for live voice/video than a turn-based music game. [W3C WebRTC
  specification](https://www.w3.org/TR/webrtc/)

### Home-server and Cloudflare fit

Cloudflare Tunnel supports WebSockets, so the existing Socket.IO room model and
the scheduled-start protocol can run behind the user's subdomain. [Cloudflare
Tunnel FAQ](https://developers.cloudflare.com/cloudflare-one/faq/cloudflare-tunnels-faq/)

Audio should be served as ordinary authenticated HTTP responses from the same
origin. Avoid treating the free Cloudflare proxy as an unlimited media CDN;
Cloudflare warns that disproportionate delivery of large media files on
Free/Pro/Business plans may trigger action. A ten-player private game is small,
but the home uplink and origin should remain the source of truth. [Cloudflare
media-delivery policy](https://developers.cloudflare.com/fundamentals/reference/policies-compliances/delivering-videos-with-cloudflare/)

Navidrome is a useful optional library manager—it supports browser playback,
Subsonic-compatible streaming, multi-user access, and on-the-fly transcoding—but
it does not replace the game's clock synchronization and room authorization.
[Navidrome overview](https://www.navidrome.org/docs/overview/)

## Catalogue and provider comparison

| Source | Backend audio available? | Blind game fit | Documented policy position |
|---|---|---|---|
| Host-uploaded/rightsholder-approved files | Yes, from this app | Excellent | Technically unrestricted by a platform; the host must hold the necessary recording and composition rights or rely on a valid exception/licence. |
| Jamendo | Full stream URLs through its API | Good, but not a mainstream-hit catalogue | The official developer site invites creative integrations and offers its whole library to non-commercial apps, currently up to 35,000 API requests/month. The track response includes the audio URL, release date, and Creative Commons licence URL. Review and obey each track's licence. [API plans](https://developer.jamendo.com/v3.0) and [tracks API](https://developer.jamendo.com/v3.0/tracks) |
| Audius | Official API/SDK can query and stream tracks | Technically good; independent catalogue | Audius explicitly documents apps that stream music and offers a free API plan, but its user terms grant personal access rather than a general right to redistribute creators' content. Use official stream facilities directly and do not assume that public availability clears every underlying right. [Developer overview](https://docs.audius.co/developers/introduction/overview/), [SDK](https://docs.audius.co/sdk/), and [Audius terms](https://audius.co/documents/TermsOfUse.pdf) |
| Apple Music / MusicKit | Full songs in each authorized user's browser; no raw backend stream | Technically plausible, not policy-cleared for this game | MusicKit supports browser playback for Apple Music members. Apple's agreement requires users to initiate playback, standard play/pause/skip controls, full-song playback availability, and rendering only through MusicKit; content may not be downloaded, uploaded, modified, or synchronized with other content. There is no published blanket game ban, but blind centrally controlled gameplay is not clearly approved. Obtain written clearance before relying on it. [MusicKit](https://developer.apple.com/musickit/) and [Developer Program License §3.3.6(D)](https://developer.apple.com/support/terms/apple-developer-program-license-agreement/) |
| Spotify | No raw audio; only official clients/SDK | No | Spotify explicitly prohibits games, including trivia, and separately prohibits one source playing to several simultaneous listeners. Its playback metadata requirements also conflict with the blind round. [Spotify Developer Policy](https://developer.spotify.com/policy) |
| YouTube / YouTube Music | No supported raw-audio or YouTube Music playback API | No | A visible IFrame Player can play ordinary YouTube videos, but hidden/audio-only playback, audio extraction, download, caching, and obscuring the player/attribution are prohibited. A compliant visible player reveals the answer. [IFrame API](https://developers.google.com/youtube/iframe_api_reference), [Required Minimum Functionality](https://developers.google.com/youtube/terms/required-minimum-functionality), and [Developer Policies](https://developers.google.com/youtube/terms/developer-policies) |
| SoundCloud | Official per-track stream URLs, normally direct from SoundCloud | No without track-by-track licences | The API technically supports custom players, but requires visible uploader/SoundCloud attribution. Its terms prohibit using content in a game without all relevant licences and prohibit modifying or excerpting content without uploader permission. Backend caching is session-only. [API guide](https://developers.soundcloud.com/docs/api/) and [API Terms](https://developers.soundcloud.com/docs/api/terms-of-use) |
| Deezer | Provider playback/plugins, not a raw backend catalogue | Poor | Deezer's official developer terms require an application to be submitted for approval before going online and limit recording streams to strictly private use within a family scope. A remote friend group is not clearly covered, and the published developer material does not establish a dependable new-app path for this use. [Official Deezer terms, developer section](https://cdns-content.dzcdn.net/pdf/CGV-ww.pdf) |
| TIDAL | Official player module; preview playback is documented | No | Playback must use TIDAL's unmodified SDK/player. TIDAL's guidelines prohibit synchronizing Embed content with visual output including a game and prohibit unauthorized contests/promotions. [Quick start](https://developer.tidal.com/documentation/api-sdk/api-sdk-quick-start), [Developer Guidelines](https://developer.tidal.com/documentation/guidelines/guidelines-developer-guidelines), and [Developer Terms](https://developer.tidal.com/documentation/guidelines/guidelines-developer-terms) |
| Amazon Music | Playback API exists only in closed beta/certified products | Not available for this home project | Amazon marks the APIs as closed beta and requires product review/certification; playback is DRM-controlled and available only to authorized devices/products. [Web API overview](https://www.developer.amazon.com/docs/music/API_web_overview.html), [playback requirements](https://www.developer.amazon.com/docs/music/playback_overview.html), and [program requirements](https://developer.amazon.com/docs/music/requ_AM-Program-Requirements.html) |
| Internet-radio streams | Yes, as one linear stream | Poor | The game cannot choose or reliably identify a specific mystery track/year. Proxying or rebroadcasting a station is a separate use and must not be assumed licensed merely because the original stream is public. |
| Metadata/catalogue APIs | Usually metadata and short promotional previews only | Deck-building aid, not playback | MusicBrainz and similar databases can help populate artist, title, and release data, but metadata availability does not grant recording playback rights. |

Jamendo is the most concrete turnkey experiment because its official
non-commercial plan and track API are expressly designed to bring full audio
into third-party creative apps. Its weakness is catalogue recognition: it
contains independent music rather than the familiar chart hits the game depends
on.

For Jamendo or any Creative Commons import, keep the exact licence URL with the
deck row. CC BY-NC permits sharing and adaptation for non-commercial purposes
with attribution; ND variants permit sharing only in unadapted form. CC licences
also require reasonable attribution and forbid adding legal or effective
technical restrictions that curtail licensed freedoms. Prefer CC BY or CC BY-NC
for any server-generated excerpts, show creator/title/source/licence on reveal,
and do not assume that “free to listen” means “free to rehost.” [Creative
Commons licence guide](https://creativecommons.org/share-your-work/cclicenses/)

## Copyright and licensing boundary in Germany

The application's private, non-commercial character helps, but it is not an
automatic streaming licence:

- German copyright law reserves reproduction to the rightsholder. Section 53
  permits limited private, non-commercial copies from a lawful source, but
  subsection 6 says those copies may not be distributed or used for public
  communication. [§53 UrhG](https://www.gesetze-im-internet.de/urhg/__53.html)
- Whether a fixed group of real friends is legally “the public” is
  fact-specific. Section 15(3) says people connected to the operator or one
  another by personal relationships are not members of the public for this
  purpose. A fixed allowlist and genuine personal relationships are helpful;
  an open, forwardable, or expanding service points the other way. [§15(3)
  UrhG](https://www.gesetze-im-internet.de/urhg/__15.html)
- If the use is public, making music available online is a reserved right.
  [§19a UrhG](https://www.gesetze-im-internet.de/urhg/__19a.html)
- GEMA lists licences for small-scale music-on-demand and linear streaming,
  including offerings with little or no revenue. [GEMA online music
  licensing](https://www.gema.de/de/musiknutzer/tarifuebersicht/musik-musikvideo)
- A GEMA licence concerns authors/publishers. The recording also carries
  performer and producer rights. GVL says public web radio normally requires
  both GEMA and GVL, while interactive streaming is an exclusive right outside
  the rights GVL generally administers—so direct label/rightsholder permission
  may still be needed. [GVL web-radio licensing](https://gvl.de/rechtenutzerinnen/lizenzierung-durch-die-gvl/webradio-und-ladenfunk)
  and [GVL recording-rights FAQ](https://gvl.de/rechteinhaberinnen/tontraegerherstellerinnen/haeufig-gestellte-fragen)

“Owned music” should therefore mean **rights-controlled**, not merely bought or
subscribed to. A public-domain composition is also insufficient when the
particular modern recording remains protected.

## Concrete v1 design

Use one optional `built-in audio` deck type alongside the current external cue:

1. The host uploads an audio file only after confirming it is self-created,
   public-domain as a recording, CC-licensed for the intended use, or directly
   licensed.
2. Store the original only for the room/session. Store title, artist, release
   year, source URL, rights basis, creator attribution, and licence URL with the
   deck row.
3. Expose audio through a room-authenticated endpoint with a short-lived token
   and Range support. Do not expose filesystem paths or permanent public URLs.
4. On join, require one **Enable audio** click and run a short output test.
5. For each round, preload in all clients, collect readiness, estimate clock
   offsets, then schedule a start two or three seconds ahead. Use `roundId`
   acknowledgements and authoritative recovery after reconnect.
6. Reveal all required attribution with the answer. Delete uploaded media when
   the room expires.
7. Do not proxy, record, extract, or cache audio from Spotify, YouTube, Apple
   Music, Deezer, TIDAL, Amazon Music, or SoundCloud.

This is modest to operate on a home server, works through Cloudflare Tunnel,
preserves the blind game mechanic, and keeps the provider integration seam open.
The unresolved issue is the catalogue licence, not the streaming technology.
