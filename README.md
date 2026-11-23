# Spotify Personal Tools

A personal, fully client-side web app for two jobs:

1. **Duplicate finder** — Spotify's "you might like" suggestions often include the
   same recording from a remastered/reissued album, so liked songs accumulate
   near-duplicates. The app pairs them up (same song, similar duration, different
   release) and lets you decide: delete A, delete B, delete both, or keep both —
   with session undo.
2. **"Not recently played" playlist** — keeps a playlist filled with liked songs
   you haven't heard in ~7 days. Spotify's API only serves your most recent ~50
   plays, so the app accumulates its own play history locally (in localStorage)
   while it's open.

No backend, no playback — just Spotify's Web API from the browser via OAuth 2.0
Authorization Code + PKCE.

## Setup

1. **Create a Spotify app** at [developer.spotify.com/dashboard](https://developer.spotify.com/dashboard).
   - Per Spotify's February 2026 rules, Development Mode requires a **Premium**
     account and allows up to **25 users** — fine for personal use.
2. **Register the redirect URI** in the app settings (exact match required):

   ```
   http://127.0.0.1:5173/callback
   ```

3. **Add your Client ID**:

   ```bash
   cp .env.local.example .env.local
   # edit .env.local → VITE_SPOTIFY_CLIENT_ID=...
   ```

4. **Run** (Node 26 LTS):

   ```bash
   npm install
   npm run dev        # http://127.0.0.1:5173 (use 127.0.0.1, not localhost)
   npm test           # unit tests for the pure logic
   npm run build      # typecheck + static build in dist/
   npm run deploy     # build + deploy dist/ to Cloudflare Workers (wrangler)
   ```

Open **http://127.0.0.1:5173** (Spotify deprecated `localhost` redirect URIs) and log in.

## Deploying

Deployment target is Cloudflare Workers static assets (`wrangler.jsonc`, with
`not_found_handling: "single-page-application"` so Spotify's `/callback`
redirect serves the app). First deploy: `npx wrangler login`, then
`npm run deploy` → live at `https://spotify-personal-tools.<account>.workers.dev`.
Bind a custom subdomain in the Cloudflare dashboard if you prefer.

For any non-local origin you must also register its redirect URI
(`https://<host>/callback`) in the
[Spotify dashboard](https://developer.spotify.com/dashboard) — the app derives
the redirect from wherever it's served, and Spotify requires an exact match.
`VITE_SPOTIFY_CLIENT_ID` is inlined at build time, so set it in the deploy
environment when building outside this machine.

## How it works

- **Auth**: PKCE flow — no client secret, tokens in `localStorage`, auto-refresh
  with 401 force-refresh and 429 `Retry-After` backoff. Requests scopes:
  `user-library-read`, `user-library-modify` (unlike/re-like),
  `playlist-modify-private`, `user-read-recently-played` — nothing for playback.
- **Duplicates**: track names are normalized (edition markers like
  "2011 Remaster", "(Deluxe)", "Mono" are stripped; accent-insensitive), grouped
  by normalized name + artist, and pairs within a configurable duration tolerance
  (default 5s) are flagged. A lower-confidence tier catches the same song under a
  different primary artist ("Various Artists" compilations).
- **Deletions**: `DELETE /me/library` (Feb 2026 consolidated endpoint, ≤40 URIs
  per call). Undo re-likes via `PUT /me/library` — note Spotify doesn't restore
  the original "added" date.
- **Play history**: on open + every 5 minutes while the tab is open, the app pulls
  `GET /me/player/recently-played` and merges `{trackId, playedAt}` tuples into
  localStorage (deduped, newest first, capped at 15 000 entries). Gaps accumulate
  while the tab is closed — plays older than ~24h can't be backfilled, so the
  History tab shows your coverage window honestly.
- **Playlist**: candidates = liked songs − tracks played within the window; a
  random sample fills the playlist via `POST /me/playlists` (created once) and
  `PUT /playlists/{id}/items` (replaces ≤100 URIs per call). With
  **neglect-first** enabled (default), half the playlist comes from the 100
  least-heard candidates — never-recorded-in-history first (oldest likes
  first), then oldest last-played — and the rest from the balance.
  Auto-refresh on open when older than 12h, or "Refresh playlist now" any time.

## Feb 2026 API notes

This app targets the post-February-2026 Web API: playlist writes go through the
new `/items` endpoints, library changes through `/me/library`, and playlist
creation through `POST /me/playlists`. If you're reading this after Spotify
changes the API again, check the
[changelog](https://developer.spotify.com/documentation/web-api/references/changes/february-2026)
and the migration guide first.
