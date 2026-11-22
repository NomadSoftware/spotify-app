import { AUTHORIZE_URL, CLIENT_ID, SCOPES, TOKEN_URL, redirectUri } from './config';
import type { TokenSet } from './types';

const TOKEN_KEY = 'sp.token';
const VERIFIER_KEY = 'sp.pkce.verifier';
const STATE_KEY = 'sp.auth.state';

export function hasClientId(): boolean {
  return !!CLIENT_ID;
}

function randomString(length: number): string {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-._~';
  const bytes = crypto.getRandomValues(new Uint8Array(length));
  return Array.from(bytes, (b) => chars[b % chars.length]).join('');
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
  } catch {
    return undefined;
  }
}

function writeToken(t: TokenSet): void {
  localStorage.setItem(TOKEN_KEY, JSON.stringify(t));
}

export function logout(): void {
  localStorage.removeItem(TOKEN_KEY);
}

async function tokenRequest(body: Record<string, string>): Promise<TokenSet> {
  const res = await fetch(TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams(body),
  });
  const json = (await res.json()) as Record<string, unknown>;
  if (!res.ok) {
    const desc = (json.error_description as string) || (json.error as string) || res.statusText;
    throw new Error(`Token request failed: ${desc}`);
  }
  const token: TokenSet = {
    access_token: json.access_token as string,
    refresh_token: (json.refresh_token as string | undefined) ?? readToken()?.refresh_token,
    expires_at: Date.now() + Number(json.expires_in ?? 3600) * 1000 - 60_000,
    scope: json.scope as string | undefined,
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
  if (!token) throw new Error('Not logged in.');
  if (token.expires_at <= Date.now()) {
    if (!token.refresh_token || !CLIENT_ID) throw new Error('Session expired — please log in again.');
    token = await tokenRequest({
      grant_type: 'refresh_token',
      refresh_token: token.refresh_token,
      client_id: CLIENT_ID,
    });
  }
  return token.access_token;
}
