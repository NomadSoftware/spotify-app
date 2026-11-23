import { api, paged, SpotifyApiError } from './api';
import { fetchPlaylistMeta, fetchProfile } from './tracks';

const PLAYLIST_ID_KEY = 'sp.playlistId';
// Per-call URI cap for playlist writes (PUT replaces ≤100, POST appends ≤100).
const WRITE_CHUNK = 100;

export interface PlaylistRef {
  id: string;
  name: string;
  url: string;
}

interface PlaylistSummary {
  id: string;
  name: string;
  owner: { id: string };
  external_urls: { spotify: string };
}

/**
 * Find the managed playlist by stored id (verifying it still exists and we
 * still own it), else by name among our own playlists (searched across all
 * pages), else create it. Only a confirmed 404 discards the stored id —
 * transient errors are rethrown so a network blip can never de-link the
 * managed playlist or cause a silent duplicate to be created.
 */
export async function getOrCreatePlaylist(name: string, description: string): Promise<PlaylistRef> {
  const me = await fetchProfile();
  const storedId = localStorage.getItem(PLAYLIST_ID_KEY);
  if (storedId) {
    let meta: PlaylistSummary | undefined;
    try {
      meta = await fetchPlaylistMeta(storedId);
    } catch (err) {
      if (err instanceof SpotifyApiError && err.status === 404) {
        localStorage.removeItem(PLAYLIST_ID_KEY); // confirmed gone — recreate below
      } else {
        throw new Error(
          `Could not verify your managed playlist: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }
    if (meta) {
      if (meta.owner.id !== me.id) {
        // Not ours (account changed?) — forget it and re-resolve by name.
        localStorage.removeItem(PLAYLIST_ID_KEY);
      } else {
        return { id: meta.id, name: meta.name, url: meta.external_urls.spotify };
      }
    }
  }

  const mine = await paged<PlaylistSummary>('/me/playlists', { limit: 50 });
  const existing = mine.find((p) => p.owner.id === me.id && p.name === name);
  if (existing) {
    localStorage.setItem(PLAYLIST_ID_KEY, existing.id);
    return { id: existing.id, name: existing.name, url: existing.external_urls.spotify };
  }

  const created = await api<{ id: string; external_urls: { spotify: string } }>('/me/playlists', {
    method: 'POST',
    body: { name, description, public: false },
  });
  localStorage.setItem(PLAYLIST_ID_KEY, created.id);
  return { id: created.id, name, url: created.external_urls.spotify };
}

/**
 * Replace the playlist's contents with `uris`. The playlist itself is created
 * by getOrCreatePlaylist; chunks beyond the first 100 URIs are appended via
 * POST per the WRITE_CHUNK cap.
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
