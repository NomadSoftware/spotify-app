import { AUTHORIZE_URL, CLIENT_ID, SCOPES, TOKEN_URL, redirectUri } from './config';
import type { TokenSet } from './types';

const TOKEN_KEY = 'sp.token';
const VERIFIER_KEY = 'sp.pkce.verifier';
const STATE_KEY = 'sp.auth.state';

/** Thrown when no valid session exists (or none can be recovered) — App uses
 * it to decide between the login screen and a fatal error box. */
export class NotAuthenticatedError extends Error {
  constructor(message = 'Not logged in.') {
    super(message);
    this.name = 'NotAuthenticatedError';
  }
}

export function hasClientId(): boolean {
  return !!CLIENT_ID;
}

function randomString(length: number): string {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-._~';
  // Rejection sampling: 256 % chars.length ≠ 0, so plain modulo would make
  // the first (256 % 66) = 58 characters ~1.3× more likely than the rest.
  const acceptMax = Math.floor(256 / chars.length) * chars.length;
  let out = '';
  while (out.length < length) {
    const bytes = crypto.getRandomValues(new Uint8Array(length * 2));
    for (const b of bytes) {
      if (b < acceptMax) {
        out += chars[b % chars.length];
        if (out.length === length) break;
      }
    }
  }
  return out;
}

async function base64urlSha256(input: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(input));
  // btoa works on Latin-1; digest bytes fit in a page
  return btoa(String.fromCharCode(...new Uint8Array(digest)))
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
}

export async function beginLogin(): Promise<void> {
  if (!CLIENT_ID) {
    throw new Error(
      'VITE_SPOTIFY_CLIENT_ID is not set. Copy .env.local.example to .env.local and add your Client ID.',
    );
  }
  const verifier = randomString(96);
  const state = randomString(16);
  localStorage.setItem(VERIFIER_KEY, verifier);
  localStorage.setItem(STATE_KEY, state);

  const params = new URLSearchParams({
    response_type: 'code',
    client_id: CLIENT_ID,
    scope: SCOPES,
    redirect_uri: redirectUri(),
    state,
    code_challenge_method: 'S256',
    code_challenge: await base64urlSha256(verifier),
  });
  location.assign(`${AUTHORIZE_URL}?${params}`);
}

export function isAuthenticated(): boolean {
  const t = readToken();
  return !!t && t.expires_at > Date.now();
}

function readToken(): TokenSet | undefined {
  try {
    const raw = localStorage.getItem(TOKEN_KEY);
    return raw ? (JSON.parse(raw) as TokenSet) : undefined;
  } catch (err) {
    console.error('[auth] failed to parse stored token — treating as logged out', err);
    return undefined;
  }
}

function writeToken(t: TokenSet): void {
  localStorage.setItem(TOKEN_KEY, JSON.stringify(t));
}

export function logout(): void {
  // Remove every per-user artifact — a second account must not inherit this
  // account's library cache, history, names, or managed-playlist link.
  for (const key of Object.keys(localStorage)) {
    if (key.startsWith('sp.')) localStorage.removeItem(key);
  }
}

async function tokenRequest(body: Record<string, string>): Promise<TokenSet> {
  const res = await fetch(TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams(body),
  });
  // Parse defensively: error bodies may be non-JSON (e.g. a gateway 502 page).
  const text = await res.text();
  let json: Record<string, unknown> = {};
  try {
    json = text ? (JSON.parse(text) as Record<string, unknown>) : {};
  } catch {
    /* non-JSON body — res.ok check below handles it */
  }
  if (json.error === 'invalid_grant') {
    // The grant (refresh token or one-time code) is dead — nothing to recover.
    // Clear the session so every feature routes to a fresh login.
    localStorage.removeItem(TOKEN_KEY);
    throw new NotAuthenticatedError('Session expired — please log in again.');
  }
  if (!res.ok) {
    const desc = (json.error_description as string) || (json.error as string) || res.statusText;
    throw new Error(`Token request failed: ${desc}`);
  }
  if (typeof json.access_token !== 'string') {
    throw new Error('Token request failed: malformed response from Spotify.');
  }
  const token: TokenSet = {
    access_token: json.access_token,
    refresh_token:
      (typeof json.refresh_token === 'string' ? json.refresh_token : undefined) ?? readToken()?.refresh_token,
    expires_at: Date.now() + Number(json.expires_in ?? 3600) * 1000 - 60_000,
    scope: typeof json.scope === 'string' ? json.scope : undefined,
  };
  writeToken(token);
  return token;
}

/** Handle ?code=...&state=... after Spotify redirects back. Returns true if a login completed. */
export async function handleCallbackIfPresent(): Promise<boolean> {
  const url = new URL(location.href);
  const code = url.searchParams.get('code');
  const state = url.searchParams.get('state');
  const error = url.searchParams.get('error');
  if (!code && !error) return false;

  const expectedState = localStorage.getItem(STATE_KEY);
  const verifier = localStorage.getItem(VERIFIER_KEY);
  localStorage.removeItem(STATE_KEY);
  localStorage.removeItem(VERIFIER_KEY);
  // Strip query params and return to the app root so refresh doesn't re-handle.
  history.replaceState(null, '', '/');

  if (error) throw new Error(`Spotify login failed: ${error}`);
  if (!code) return false;
  if (!state || state !== expectedState) throw new Error('Login state mismatch — please try again.');
  if (!verifier) throw new Error('Lost PKCE verifier — please try logging in again.');

  if (!CLIENT_ID) throw new Error('VITE_SPOTIFY_CLIENT_ID is not set.');

  await tokenRequest({
    grant_type: 'authorization_code',
    code,
    redirect_uri: redirectUri(),
    client_id: CLIENT_ID,
    code_verifier: verifier,
  });
  return true;
}

/** Returns a valid access token, refreshing it first if needed. */
export async function getAccessToken(): Promise<string> {
  let token = readToken();
  if (!token) throw new NotAuthenticatedError();
  if (token.expires_at <= Date.now()) {
    if (!token.refresh_token || !CLIENT_ID) {
      throw new NotAuthenticatedError('Session expired — please log in again.');
    }
    token = await tokenRequest({
      grant_type: 'refresh_token',
      refresh_token: token.refresh_token,
      client_id: CLIENT_ID,
    });
  }
  return token.access_token;
}

/**
 * Unconditionally refresh the stored token — used by the API layer when a
 * request is 401'd despite a locally-valid expiry (server-side revocation,
 * clock skew). A dead grant clears the session via tokenRequest.
 */
export async function refreshAccessToken(): Promise<string> {
  const token = readToken();
  if (!token?.refresh_token || !CLIENT_ID) {
    throw new NotAuthenticatedError('Session expired — please log in again.');
  }
  const fresh = await tokenRequest({
    grant_type: 'refresh_token',
    refresh_token: token.refresh_token,
    client_id: CLIENT_ID,
  });
  return fresh.access_token;
}
