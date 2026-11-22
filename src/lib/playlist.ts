import { api } from './api';
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
 * still own it), else by name among our own playlists, else create it.
 */
export async function getOrCreatePlaylist(name: string, description: string): Promise<PlaylistRef> {
  const storedId = localStorage.getItem(PLAYLIST_ID_KEY);
  if (storedId) {
    try {
      const meta = await fetchPlaylistMeta(storedId);
      return { id: meta.id, name: meta.name, url: meta.external_urls.spotify };
    } catch {
      localStorage.removeItem(PLAYLIST_ID_KEY); // deleted on Spotify's side — recreate
    }
  }

  const me = await fetchProfile();
  const mine = await api<{ items: PlaylistSummary[] }>('/me/playlists', {
    params: { limit: 50 },
  });
  const existing = mine.items.find((p) => p.owner.id === me.id && p.name === name);
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

/** Replace the playlist's contents with `uris` (creating only if needed upstream). */
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
