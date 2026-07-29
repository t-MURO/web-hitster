# Spotify platform research for Music Timeline

Verified against official Spotify sources on 2026-07-29.

## Bottom line: the intended Spotify integration is not permitted

Spotify's Developer Policy, effective 2025-05-15, explicitly says: **"Do not create a game, including trivia quizzes."** It separately prohibits a product that plays content from one source to several simultaneous listeners, and gives that exact pattern as an example of non-interactive webcasting. A remotely synchronized music-timeline game falls directly under the game prohibition and likely under the simultaneous-listener prohibition as well. Private, invite-only, and non-commercial use does not create an exception. Non-commercial status only avoids a separate restriction on commercial streaming apps. [Spotify Developer Policy, sections III–IV](https://developer.spotify.com/policy) and [Spotify's compliance examples](https://developer.spotify.com/compliance-tips).

There is a second conflict with the blind-play mechanic. Spotify expressly defines "Streaming" to include using its Platform to control a background Spotify application, so keeping playback in the official desktop client does not make this a non-streaming integration. For a Streaming SDA, Spotify requires relevant cover art and metadata to be displayed in the app while Spotify content is playing; the game intentionally hides these until reveal. [Spotify Developer Terms, section II.14](https://developer.spotify.com/terms) and [Spotify Developer Policy, section II.5](https://developer.spotify.com/policy).

**Recommendation:** do not ship or privately operate the planned Web API/Spotify Connect integration without written permission from Spotify. The safe paths are to obtain written approval, choose a music provider/license that permits games, or keep Spotify completely outside the app and have players manually operate their official clients. The technical notes below are useful only if Spotify approves the use case or its policy changes.

## Development Mode in 2026

- New apps start in Development Mode. The app owner must keep an active Spotify Premium subscription or the app stops functioning. A Development Mode app permits **up to five authorized users**. Every user must be entered in Dashboard → app → Settings → Users Management using their name and Spotify email. A non-allowlisted user may complete OAuth, but API calls made with that token return `403`. [Quota modes](https://developer.spotify.com/documentation/web-api/concepts/quota-modes).
- Treat the five-user limit as five total Spotify accounts and do not assume the developer account is an extra slot; Spotify's public documentation does not promise an extra owner slot.
- Since 2026-02-11, newly created Development Mode apps use a reduced endpoint/field set. The endpoints this design needs remain listed, but playlist contents are available only for playlists the current user owns or collaborates on. `GET /playlists/{id}/tracks` became `GET /playlists/{id}/items`, and the nested response names moved from `tracks`/`track` to `items`/`item`. [February 2026 migration guide](https://developer.spotify.com/documentation/web-api/tutorials/february-2026-migration-guide) and [February 2026 changelog](https://developer.spotify.com/documentation/web-api/references/changes/february-2026).
- The same 2026 change removed `product` from the Development Mode `GET /me` response. Do not depend on the profile response to prove that each player has Premium. The playback endpoints themselves remain Premium-only, so onboarding must explain the requirement and gracefully handle playback-control failure. [February 2026 migration guide](https://developer.spotify.com/documentation/web-api/tutorials/february-2026-migration-guide).
- A 2026-07-23 update increased the number of Development Mode Client IDs from one to 25 per developer, but all of those apps now share one developer-account quota. This supersedes the older "one Client ID" statement in the February migration guide; it does **not** change the five-user cap per app. [July 2026 quota update](https://developer.spotify.com/blog/2026-07-23-web-api-quota-updates).
- Extended quota is not a realistic escape hatch for this private project. Since 2025-05-15, Spotify accepts applications only from organizations, and its published criteria include an established entity, a launched service, at least 250,000 monthly active users, key-market availability, commercial viability, and policy compliance. [Quota modes](https://developer.spotify.com/documentation/web-api/concepts/quota-modes) and [2025 extended-access announcement](https://developer.spotify.com/blog/2025-04-15-updating-the-criteria-for-web-api-extended-access).

The current 2–10-player room uses Spotify only through the host's authorized
account, so the Development Mode user cap applies to authorized hosts rather
than every room participant. This does not cure the policy prohibition.

## OAuth and redirect URIs

For the home-server deployment, use the server-side **Authorization Code flow**, keeping the client secret only on the server. Authorization Code with PKCE is Spotify's recommended flow when a secret cannot be kept safely, such as a browser-only SPA. Both flows issue refresh tokens. [Authorization flow selection](https://developer.spotify.com/documentation/web-api/concepts/authorization), [Authorization Code flow](https://developer.spotify.com/documentation/web-api/tutorials/code-flow), and [Authorization Code with PKCE](https://developer.spotify.com/documentation/web-api/tutorials/code-pkce-flow).

Implementation requirements:

1. Register the production callback exactly, for example `https://music.example.net/auth/spotify/callback`.
2. The OAuth request, token exchange, and Dashboard entry must match exactly, including scheme, host, path, case, and trailing slash.
3. Production callbacks must use HTTPS. HTTP is allowed only for an explicit loopback literal such as `http://127.0.0.1:4317/auth/spotify/callback`; `localhost` is not allowed. A loopback callback may omit the registered port and supply a dynamic port in the request. [Redirect URI rules](https://developer.spotify.com/documentation/web-api/concepts/redirect_uri).
4. Generate, store, and validate the OAuth `state` value to prevent CSRF. Spotify marks `state` strongly recommended and its Authorization Code guide says to reject a callback when it does not match. [Authorization Code flow](https://developer.spotify.com/documentation/web-api/tutorials/code-flow).
5. Exchange the code only on the server, associate tokens with a server-side session, and never send the client secret to the browser. This is an architectural consequence of the server-side flow.
6. Access tokens currently last one hour. Dashboard-app refresh tokens currently last six months; refreshing access does not extend that six-month lifetime, so the app must support reauthorization. Preserve the old refresh token if a refresh response does not include a replacement. [Refreshing tokens](https://developer.spotify.com/documentation/web-api/tutorials/refreshing-tokens).

## Minimum scopes

For every player whose Spotify client the game would inspect and control:

- `user-read-private` — retrieve the current profile with `GET /me`. Use the current `account_id` for durable account linking; Spotify says it is immutable and preferred over the legacy user `id`. Do not rely on deprecated profile fields. [Current user profile](https://developer.spotify.com/documentation/web-api/reference/get-current-users-profile) and [May 2026 account ID change](https://developer.spotify.com/documentation/web-api/references/changes/may-2026).
- `user-read-playback-state` — list Spotify Connect devices and inspect the active playback/device.
- `user-modify-playback-state` — transfer, start/resume, and pause playback.

For the host selecting the deck:

- `playlist-read-private` — include the host's private playlists and read allowed playlist items.
- `playlist-read-collaborative` — include collaborative playlists owned by somebody else in the picker. Spotify's playlist guide says collaborative playlists require this scope to appear. [Working with playlists](https://developer.spotify.com/documentation/web-api/concepts/playlists).

`user-read-email` is not needed for the game. Spotify removed email from Development Mode profile responses in 2026, and the allowlist email is administered separately in the Developer Dashboard. `streaming` is not needed when playback remains in the official Spotify desktop app rather than the Web Playback SDK.

## Endpoints and current constraints

| Purpose | Request | Scope | Important behavior |
|---|---|---|---|
| Identify logged-in account | `GET /v1/me` | `user-read-private` | Persist `account_id`, not legacy `id`. |
| List host playlists | `GET /v1/me/playlists` | `playlist-read-private`; add `playlist-read-collaborative` | Page size max 50. Returns owned/followed playlists according to scopes. [Reference](https://developer.spotify.com/documentation/web-api/reference/get-a-list-of-current-users-playlists). |
| Load deck candidates | `GET /v1/playlists/{playlist_id}/items` | `playlist-read-private` | Development Mode: only playlists the caller owns or collaborates on; otherwise `403`. Page size max 50, so paginate until 50 eligible tracks are collected or the playlist is exhausted. Use `items[].item`, not the removed `tracks[].track`. [Reference](https://developer.spotify.com/documentation/web-api/reference/get-playlists-items). |
| List Connect devices | `GET /v1/me/player/devices` | `user-read-playback-state` | Some models are not returned. IDs can be `null` and are not guaranteed stable; refetch periodically. A restricted device cannot accept Web API commands. [Reference](https://developer.spotify.com/documentation/web-api/reference/get-a-users-available-devices). |
| Inspect playback | `GET /v1/me/player` | `user-read-playback-state` | Returns active device, current item, position, and play state; `204` means no current playback information. [Reference](https://developer.spotify.com/documentation/web-api/reference/get-information-about-the-users-current-playback). |
| Transfer to selected client | `PUT /v1/me/player` with `{"device_ids":["…"],"play":false}` | `user-modify-playback-state` | Premium-only. Although the body is an array, only one device is supported. Ordering is not guaranteed when combined with other Player endpoints. [Reference](https://developer.spotify.com/documentation/web-api/reference/transfer-a-users-playback). |
| Start one mystery track | `PUT /v1/me/player/play?device_id=…` with `{"uris":["spotify:track:…"],"position_ms":0}` | `user-modify-playback-state` | Premium-only. Omitting `device_id` targets the active device. Supplying the selected device explicitly avoids accidental playback elsewhere. [Reference](https://developer.spotify.com/documentation/web-api/reference/start-a-users-playback). |
| Pause | `PUT /v1/me/player/pause?device_id=…` | `user-modify-playback-state` | Premium-only. Omitting the ID targets the active device. [Reference](https://developer.spotify.com/documentation/web-api/reference/pause-a-users-playback). |

All user-specific calls must use that user's access token. Spotify exposes no group-playback endpoint: loose synchronization would require the server to issue separate calls to each player's account. That fan-out is also why the design resembles the policy's prohibited single-source/several-listener example.

For deck construction, accept only `item.type === "track"`, reject local files (`is_local`), null/unavailable items, and entries without a usable Spotify URI. The playlist response includes `album.release_date` plus `release_date_precision` (`year`, `month`, or `day`); taking the first four digits implements the accepted "Spotify album year" rule, but it is an album-release year rather than a guaranteed original song-release year. [Playlist items response model](https://developer.spotify.com/documentation/web-api/reference/get-playlists-items).

Device setup should be explicit: ask each player to open Spotify Desktop, call the devices endpoint, let the player select the intended non-restricted device, and keep the ID only ephemerally. Refetch before a round or after a control failure. Because Spotify says Player endpoint ordering is not guaranteed, do not assume an immediate transfer followed by play will execute in order; verify the active device or target `play` directly by explicit `device_id`.

## Rate limits, quotas, and retries

- The standard Web API rate limit is calculated over a rolling 30-second window; Spotify does not publish a fixed request count, and Development Mode has a lower limit than Extended Quota Mode. Some endpoints also have custom limits. [Rate limits](https://developer.spotify.com/documentation/web-api/concepts/rate-limits).
- On `429`, honor the response's `Retry-After` seconds before retrying. Do not busy-loop or retry all five player calls simultaneously.
- Development Mode also has quota buckets shared across every Development Mode app belonging to the developer account. Bucket groupings and limits may change. A quota exhaustion response uses `429` with `error.reason: "QUOTA_EXCEEDED"`; distinguish that from a temporary rate limit and surface a non-retryable-for-now room error. [Quota modes](https://developer.spotify.com/documentation/web-api/concepts/quota-modes) and [July 2026 quota update](https://developer.spotify.com/blog/2026-07-23-web-api-quota-updates).
- Cache the selected playlist's `snapshot_id` and parsed 50-track deck for the room, avoid polling playback continuously, coalesce duplicate device checks, and refresh only on user action or recovery. Spotify specifically recommends using playlist `snapshot_id` to avoid refetching unchanged playlists. [Rate-limit guidance](https://developer.spotify.com/documentation/web-api/concepts/rate-limits).

## Other policy and product requirements

Even with written permission for the game:

- Every player controlling music must be Premium because transfer/play/pause are Premium-only. The Development Mode app owner must independently remain Premium. [Player endpoint references](https://developer.spotify.com/documentation/web-api/reference/start-a-users-playback) and [Quota modes](https://developer.spotify.com/documentation/web-api/concepts/quota-modes).
- Provide a privacy policy explaining what Spotify/user data is accessed, stored, used, and disclosed; request only data needed by the app. [Developer Policy, section I](https://developer.spotify.com/policy).
- Store or cache Spotify content only as strictly necessary to operate the app, keep displayed data current, and do not retain it indefinitely. [Developer Terms, sections IV.8 and V](https://developer.spotify.com/terms).
- Spotify metadata and cover art must be attributed to Spotify and link back to the applicable Spotify item. Spotify visual content must remain in its original form: do not crop it, overlay text/logos, or otherwise alter it. [Playlist items policy notes](https://developer.spotify.com/documentation/web-api/reference/get-playlists-items) and [Design & Branding Guidelines](https://developer.spotify.com/documentation/design).
- Do not download or cache audio, alter it, mix/overlap it with other audio, manipulate play counts, target the app to children, imply Spotify endorsement, or use a Spotify-confusing name. [Developer Policy](https://developer.spotify.com/policy).
- Non-commercial operation is necessary for a streaming integration but is not sufficient: it does not waive the game, webcasting, blind-metadata, attribution, or user-data rules. [Developer Policy](https://developer.spotify.com/policy).

## Implementation decision

**Status: blocked on Spotify policy, not on technical feasibility.** The required Development Mode endpoints and five-user allowance exist, and the home-server/Cloudflare callback can satisfy OAuth requirements. However, the product's defining behavior is explicitly prohibited by Spotify's current policy. No production Spotify integration should be implemented until written approval is obtained or the product is redesigned around a provider/license that permits games.
