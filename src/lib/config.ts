export const CLIENT_ID: string | undefined = import.meta.env.VITE_SPOTIFY_CLIENT_ID;

export const AUTHORIZE_URL = 'https://accounts.spotify.com/authorize';
export const TOKEN_URL = 'https://accounts.spotify.com/api/token';
export const API_BASE = 'https://api.spotify.com/v1';

// Scopes: read liked songs, unlike/unlike via /me/library, manage private
// playlists, read play history. No playback, so no streaming scopes.
export const SCOPES = [
  'user-library-read',
  'user-library-modify',
  'playlist-modify-private',
  'user-read-recently-played',
].join(' ');

// The redirect URI is derived from wherever the app is served so it keeps
// matching the dashboard registration. In dev that is
// http://127.0.0.1:5173/callback — register exactly that in the dashboard.
export function redirectUri(): string {
  return new URL('callback', `${location.origin}${location.pathname}`).href;
}

export function isLocalhost(): boolean {
  return location.hostname === 'localhost';
}
