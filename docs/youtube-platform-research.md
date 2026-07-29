# YouTube platform research for Music Timeline

Verified against official YouTube and Google sources on 2026-07-29.

## Bottom line: not a better foundation for blind synchronized gameplay

YouTube is technically useful for finding videos, importing ordinary YouTube
playlists, and controlling a visible embedded player. It is not a supported
YouTube Music playback integration: Google documents the YouTube Data API and
IFrame Player, but no public YouTube Music catalog/playback API or Premium
entitlement API. Using an undocumented YouTube Music endpoint is expressly
prohibited. [YouTube Data API reference](https://developers.google.com/youtube/v3/docs),
[IFrame Player API](https://developers.google.com/youtube/iframe_api_reference),
[Developer Policies §III.D.7](https://developers.google.com/youtube/terms/developer-policies#d-accessing-youtube-api-services).

More importantly, a compliant YouTube player must remain visible and
unobscured. YouTube says video metadata such as the title and thumbnail should
generally remain visible and unmodified, YouTube attribution must not be
obscured, and overlays may not cover the player. That directly conflicts with
the game's defining requirement to hide the song title, artist, and cover until
the reveal. [Policy compliance guide](https://developers.google.com/youtube/terms/developer-policies-guide#your-api-service-must-reflect-a-users-standard-experience-on-youtube),
[Required Minimum Functionality](https://developers.google.com/youtube/terms/required-minimum-functionality#youtube-embedded-player-and-video-playback),
[Developer Policies §III.F](https://developers.google.com/youtube/terms/developer-policies#f-user-experience).

**Recommendation:** keep the production app provider-neutral. YouTube links can
remain host-only external cues, and a future importer could turn an ordinary
YouTube playlist into draft deck rows that the host reviews and supplements
with release years. Do not implement hidden YouTube embeds, extracted audio, or
automatic multi-player YouTube playback. A mode with a normal visible YouTube
player is technically possible, but it would reveal the answer and therefore
would not be the intended blind game.

## Capability and policy assessment

| Requirement | Official capability or restriction | Assessment |
|---|---|---|
| YouTube Music API | Google's public developer catalog exposes YouTube videos, playlists, channels, subscriptions, analytics, and reporting; it does not document a YouTube Music streaming/catalog/player API. The OAuth catalog contains a YouTube Music **data-portability** scope for exporting a user's library, not live playback control. Undocumented APIs and reverse engineering are prohibited. [Data API overview](https://developers.google.com/youtube/v3/getting-started), [API reference](https://developers.google.com/youtube/v3/docs), [OAuth scope catalog](https://developers.google.com/identity/protocols/oauth2/scopes), [Developer Policies §III.D.7](https://developers.google.com/youtube/terms/developer-policies#d-accessing-youtube-api-services) | No supported YouTube Music replacement for Spotify Connect. |
| Search | `search.list` can search videos, channels, and playlists, filter for embeddable videos, and return up to 50 results per call. The current default allocation is 100 search calls per day. [search.list](https://developers.google.com/youtube/v3/docs/search/list) | Technically adequate for a small private deck builder, but search results are YouTube videos rather than canonical music tracks. |
| Playlist import | `playlists.list` can retrieve playlists by ID and, with OAuth, playlists owned by the authenticated YouTube user. `playlistItems.list` returns the videos in a playlist, up to 50 per page; inaccessible/private playlists require proper authorization. [playlists.list](https://developers.google.com/youtube/v3/docs/playlists/list), [playlistItems.list](https://developers.google.com/youtube/v3/docs/playlistItems/list), [OAuth guide](https://developers.google.com/youtube/v3/guides/authentication) | Viable for importing an ordinary YouTube playlist. It is not documented as access to the user's complete YouTube Music library. |
| Release year | The video resource provides the video's title, description, YouTube publication date, and optional recording date. The publication date is when the YouTube video became public, and the recording date is when that video was recorded; neither is a promised original song-release year. [video resource](https://developers.google.com/youtube/v3/docs/videos) | The host must still supply or correct the song's release year. |
| Playback and excerpts | The IFrame API can cue/load a video or playlist and play, pause, stop, seek, set volume, and receive state events. Its documented loading methods accept start and end times. [IFrame Player API](https://developers.google.com/youtube/iframe_api_reference) | Technically capable of playing a timed excerpt in one browser. |
| Blind presentation | Embedded players must be at least 200×200, branding and attribution may not be obscured, metadata such as title and thumbnail generally must remain visible and unmodified, and overlays may not cover any part of the player. The `modestbranding` parameter is deprecated and has no effect. [Required Minimum Functionality](https://developers.google.com/youtube/terms/required-minimum-functionality#youtube-embedded-player-and-video-playback), [policy compliance guide](https://developers.google.com/youtube/terms/developer-policies-guide#your-api-service-must-reflect-a-users-standard-experience-on-youtube), [player parameters](https://developers.google.com/youtube/player_parameters#modestbranding) | Fundamentally incompatible with hiding the answer before reveal. |
| Hidden or audio-only player | API clients must not separate, isolate, modify, or separately promote the audio/video components, modify or block the player, or use a background player that is not displayed in the page, tab, or screen being viewed. Downloading, caching, or storing audiovisual content also requires prior written approval. [Developer Policies §III.I](https://developers.google.com/youtube/terms/developer-policies#i-additional-prohibitions), [Developer Policies §III.E.1](https://developers.google.com/youtube/terms/developer-policies#e-handling-youtube-data-and-content) | A hidden iframe, audio extraction, proxy, local cache, or custom audio player is not a compliant workaround. |
| Autoplay | Scripted playback is supported, but the player must be visible and more than half visible before automatic playback. Browsers can block `autoplay`, `loadVideoById`, and `playVideo`; the API reports this through `onAutoplayBlocked`. [Required Minimum Functionality](https://developers.google.com/youtube/terms/required-minimum-functionality#autoplay-and-scripted-playbacks), [IFrame autoplay event](https://developers.google.com/youtube/iframe_api_reference#onAutoplayBlocked) | Every player may need a local interaction, preventing dependable one-click remote starts. |
| Synchronized playback | The IFrame API controls a player in the current browser and exposes no group-session or synchronized multi-client playback primitive. Each browser would independently load, buffer, and respond to application-broadcast play/seek commands. This is an inference from the documented player API. Autoplay can be blocked, ads may not be blocked, and videos may be unavailable or non-embeddable. [IFrame Player API](https://developers.google.com/youtube/iframe_api_reference), [policy compliance guide](https://developers.google.com/youtube/terms/developer-policies-guide#your-api-service-must-reflect-a-users-standard-experience-on-youtube), [video embeddability](https://developers.google.com/youtube/v3/docs/videos#status.embeddable) | Application-level synchronization would be best-effort and prone to different start times, buffering, ads, and drift. |
| Google login and Premium | The IFrame Player does not require user authorization. OAuth authorizes access to private YouTube account data and actions; the documented YouTube scopes and Data API resources expose no YouTube Premium or Music Premium entitlement check. This entitlement conclusion is an inference from the official scope and API catalogs. [Developer Policies §III.D.2](https://developers.google.com/youtube/terms/developer-policies#d-accessing-youtube-api-services), [OAuth guide](https://developers.google.com/youtube/v3/guides/authentication), [OAuth scope catalog](https://developers.google.com/identity/protocols/oauth2/scopes), [Data API reference](https://developers.google.com/youtube/v3/docs) | The app cannot reliably require or verify Premium. Google OAuth login would not prove ad-free playback. |
| Premium streaming limits | YouTube says an individual Premium or Music Premium membership supports one simultaneous video/audio stream; family and two-person plans allow more streams for their eligible members. [YouTube Premium streaming limits](https://support.google.com/youtube/answer/7361503) | Separate accounts avoid one-account concurrency limits, but Premium status still cannot be verified by the app and does not solve blind metadata or sync. |
| Games and trivia | The current API policies do not state a blanket prohibition on games or trivia. They do prohibit offering incentives, rewards, or compensation for engaging with YouTube by viewing content, and prohibit unlawful online gambling. A score-based recognition game is not explicitly resolved by those rules, so its treatment is ambiguous rather than clearly approved. YouTube advises requesting an API Compliance Audit when a developer is unsure whether a service is allowed. [Playback Integrity, Developer Policies §III.F.3](https://developers.google.com/youtube/terms/developer-policies#f-user-experience), [Additional Prohibitions §III.I](https://developers.google.com/youtube/terms/developer-policies#i-additional-prohibitions), [policy compliance guide](https://developers.google.com/youtube/terms/developer-policies-guide) | Less explicit than Spotify's game ban, but not a clean approval. Obtain written compliance guidance before making YouTube viewing part of scored gameplay. |
| Quota | Current defaults are 100 `search.list` calls/day, 100 `videos.insert` calls/day, and 10,000 units/day combined for other endpoints. Ordinary playlist/video reads generally cost one unit; invalid requests also consume quota. Additional quota requires a compliance audit. [quota overview](https://developers.google.com/youtube/v3/getting-started#quota-usage), [Developer Policies §III.D.3](https://developers.google.com/youtube/terms/developer-policies#d-accessing-youtube-api-services) | Sufficient for this small friend group if deck lookup is cached, but not the primary blocker. |
| Private/non-commercial use | The API Terms bind anyone who accesses or uses the YouTube API Services and require compliance with the Developer Policies. The policies separately permit some commercial uses subject to the same agreement; they do not provide a private or non-commercial waiver from player, metadata, branding, privacy, copyright, or quota rules. [API Terms §§1–3](https://developers.google.com/youtube/terms/api-services-terms-of-service), [Developer Policies §III.G](https://developers.google.com/youtube/terms/developer-policies#g-distribution-and-commercial-use) | Private and non-commercial operation does not cure the conflicts. |

## Practical product options

1. **Recommended:** keep uploaded CSV/JSON decks and host-managed external cues.
   Permit normal `youtube.com` or `music.youtube.com` share URLs as host-only
   cue text without calling undocumented YouTube Music services.
2. **Possible later:** add an ordinary YouTube playlist importer using the Data
   API. Import video IDs, titles, thumbnails, and cue URLs as a draft; require
   host review, manual release-year entry, and YouTube attribution wherever
   YouTube API data is displayed. [YouTube branding requirements](https://developers.google.com/youtube/terms/branding-guidelines),
   [video metadata policy](https://developers.google.com/youtube/terms/developer-policies-guide#your-api-service-must-reflect-a-users-standard-experience-on-youtube).
3. **Not recommended:** place an IFrame Player in every player's browser and
   broadcast play commands. A compliant visible player reveals the mystery
   track, while a concealed/audio-only player violates the published player
   rules.
4. **Do not implement:** unofficial YouTube Music APIs, stream extraction,
   audio proxies, downloaded clips, or hidden iframes. The official terms grant
   no right to redistribute audiovisual content outside the documented player,
   and third-party rights still apply. [API Terms §§12 and 16](https://developers.google.com/youtube/terms/api-services-terms-of-service),
   [Developer Policies §III.D.7 and §III.I](https://developers.google.com/youtube/terms/developer-policies).

**Implementation decision: provider-neutral remains the right architecture.**
YouTube is useful as a manually operated host cue source or, with care, a deck
import source. It does not provide a compliant path to the app's desired blind,
automatic, tightly synchronized remote playback.
