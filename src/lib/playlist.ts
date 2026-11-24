import { api, paged, SpotifyApiError } from './api';
import { fetchProfile } from './tracks';
import {
  decidePlaylist,
  MANAGED_DESCRIPTION,
  parsePlaylistRef,
  PLAYLIST_REGISTRY_KEY,
  type ManagedPlaylist,
  type PlaylistCandidate,
  type Resolution,
} from './playlistCore';

// Single-id key written by earlier versions. Read once as a seed for the
// registry so existing installs keep the playlist they were already updating.
const LEGACY_ID_KEY = 'sp.playlistId';
// Per-call URI cap for playlist writes (PUT replaces ≤100, POST appends ≤100).
const WRITE_CHUNK = 100;

/** What Spotify returns for a playlist. Fields are optional defensively:
 *  the listing and search return trimmed-down objects. */
interface PlaylistSummary {
  id: string;
  name?: string | null;
  description?: string | null;
  owner?: { id?: string | null } | null;
  external_urls?: { spotify?: string } | null;
  tracks?: { total?: number | null } | null;
}

function toCandidate(p: PlaylistSummary): PlaylistCandidate {
  return {
    id: p.id,
    name: p.name ?? '',
    description: p.description ?? '',
    ownerId: p.owner?.id ?? null,
    url: p.external_urls?.spotify ?? `https://open.spotify.com/playlist/${p.id}`,
    trackTotal: p.tracks?.total ?? null,
  };
}

// ---- stored id, one per Spotify user ----

function loadRegistry(): Record<string, string> {
  try {
    const raw = localStorage.getItem(PLAYLIST_REGISTRY_KEY);
    const parsed: unknown = raw ? JSON.parse(raw) : {};
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {};
    const out: Record<string, string> = {};
    for (const [user, id] of Object.entries(parsed)) {
      if (typeof id === 'string' && id) out[user] = id;
    }
    return out;
  } catch (err) {
    console.error('[playlist] failed to parse the stored playlist registry — starting empty', err);
    return {};
  }
}

function setStoredPlaylistId(userId: string, id: string | null): void {
  const registry = loadRegistry();
  if (id) registry[userId] = id;
  else delete registry[userId];
  try {
    localStorage.setItem(PLAYLIST_REGISTRY_KEY, JSON.stringify(registry));
  } catch (err) {
    console.error('[playlist] could not save the playlist id — the app may have to look it up by name again', err);
  }
}

function storedPlaylistId(userId: string): string | null {
  const registry = loadRegistry();
  if (registry[userId]) return registry[userId];
  const legacy = localStorage.getItem(LEGACY_ID_KEY);
  if (!legacy) return null;
  // Ownership is checked by the caller before it is trusted.
  localStorage.removeItem(LEGACY_ID_KEY);
  setStoredPlaylistId(userId, legacy);
  return legacy;
}

// ---- lookups (all read-only) ----

/** One playlist by id; null when it no longer exists. */
async function fetchPlaylist(id: string): Promise<PlaylistCandidate | null> {
  try {
    return toCandidate(await api<PlaylistSummary>(`/playlists/${id}`));
  } catch (err) {
    if (err instanceof SpotifyApiError && err.status === 404) return null;
    throw err;
  }
}

/**
 * Playlists named `name` that the current user owns.
 *
 * Neither source is complete on its own, so both are tried: the user's
 * playlist listing has been observed to omit app-created playlists entirely,
 * while search only covers public playlists and returns at most 10 results.
 */
async function findOwnedByName(name: string): Promise<PlaylistCandidate[]> {
  // The listing is a supplement, not a dependency — if it fails, search alone
  // still decides. A failure of search itself is NOT swallowed: with no
  // working lookup the caller must not be offered "create".
  const listed = await paged<PlaylistSummary>('/me/playlists', { limit: 50 })
    .then((items) => items.map(toCandidate))
    .catch((err) => {
      console.error('[playlist] playlist listing failed — relying on search', err);
      return [] as PlaylistCandidate[];
    });

  const searched = await api<{ playlists: { items: (PlaylistSummary | null)[] } | null }>('/search', {
    params: { q: `"${name}"`, type: 'playlist', limit: 10 },
  });
  const hits = (searched.playlists?.items ?? []).filter((p): p is PlaylistSummary => !!p);
  return [...listed, ...hits.map(toCandidate)];
}

/**
 * Find the playlist this app manages for the current user. Never creates one:
 * a missing stored id must surface as a question to the user, not a duplicate.
 */
export async function resolveManagedPlaylist(name: string): Promise<Resolution> {
  const me = await fetchProfile();
  if (!me.id) throw new Error("Spotify didn't return your account id, so the app can't tell which playlist is yours.");
  const userId = me.id;

  const stored = storedPlaylistId(userId);
  if (stored) {
    const found = await fetchPlaylist(stored);
    if (found && found.ownerId === userId) {
      return { kind: 'resolved', playlist: { id: found.id, name: found.name, url: found.url } };
    }
    // Deleted on Spotify's side, or no longer this account's: forget it and
    // look for a playlist to adopt below.
    console.warn('[playlist] stored playlist is gone or not owned — looking it up again', { stored });
    setStoredPlaylistId(userId, null);
  }

  const resolution = decidePlaylist(await findOwnedByName(name), name, userId);
  if (resolution.kind === 'resolved') setStoredPlaylistId(userId, resolution.playlist.id);
  return resolution;
}

/** Create the managed playlist. Only ever called from an explicit click. */
export async function createManagedPlaylist(name: string): Promise<ManagedPlaylist> {
  // Re-check first: if a playlist to use appeared since the user was asked
  // (another tab, another browser), use it instead of adding another.
  const check = await resolveManagedPlaylist(name);
  if (check.kind === 'resolved') return check.playlist;
  if (check.kind === 'ambiguous') {
    throw new Error('Several matching playlists now exist — choose one instead of creating another.');
  }
  const me = await fetchProfile();
  const created = await api<PlaylistSummary>('/me/playlists', {
    method: 'POST',
    body: { name, description: MANAGED_DESCRIPTION, public: false },
  });
  const playlist: ManagedPlaylist = {
    id: created.id,
    name: created.name ?? name,
    url: created.external_urls?.spotify ?? `https://open.spotify.com/playlist/${created.id}`,
  };
  if (me.id) setStoredPlaylistId(me.id, playlist.id);
  return playlist;
}

/**
 * Make an existing playlist the managed one for the current user. `ref` is a
 * Spotify link, URI or id. The caller is responsible for having asked the
 * user, since every refresh replaces the playlist's contents.
 */
export async function adoptManagedPlaylist(ref: string): Promise<ManagedPlaylist> {
  const id = parsePlaylistRef(ref);
  if (!id) {
    throw new Error("That doesn't look like a Spotify playlist link (e.g. https://open.spotify.com/playlist/…).");
  }
  const me = await fetchProfile();
  const found = await fetchPlaylist(id);
  if (!found) throw new Error("That playlist doesn't exist, or Spotify won't show it to this account.");
  if (found.ownerId !== me.id) throw new Error("You don't own that playlist, so the app can't update it.");
  if (me.id) setStoredPlaylistId(me.id, found.id);
  return { id: found.id, name: found.name, url: found.url };
}

/**
 * Replace the playlist's contents with `uris`. The playlist itself is found
 * by resolveManagedPlaylist; chunks beyond the first 100 URIs are appended
 * via POST per the WRITE_CHUNK cap.
 */
export async function replacePlaylistItems(playlistId: string, uris: string[]): Promise<void> {
  const first = uris.slice(0, WRITE_CHUNK);
  await api(`/playlists/${playlistId}/items`, { method: 'PUT', body: { uris: first } });
  for (let i = WRITE_CHUNK; i < uris.length; i += WRITE_CHUNK) {
    await api(`/playlists/${playlistId}/items`, {
      method: 'POST',
      body: { uris: uris.slice(i, i + WRITE_CHUNK) },
    });
  }
}
