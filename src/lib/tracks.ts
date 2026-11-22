import { api, paged } from './api';
import { chunk } from './util';
import type { LikedTrack, SpotifyProfile } from './types';

// Feb 2026 API: library save/remove take Spotify URIs, max 40 per request.
const LIBRARY_CHUNK = 40;

export interface SavedTrackPageItem {
  added_at: string;
  track: {
    id: string | null;
    uri: string;
    name: string;
    album: { name: string; release_date: string; images: { url: string }[] };
    artists: { name: string }[];
    duration_ms: number;
    is_local: boolean;
  };
}

/** Local files have no server-side id/URI and can't be managed via the API. */
export function mapSavedTrack(item: SavedTrackPageItem): LikedTrack | null {
  const t = item.track;
  if (!t.id || t.is_local) return null;
  return {
    id: t.id,
    uri: t.uri,
    name: t.name,
    artist: t.artists[0]?.name ?? '',
    album: t.album.name,
    releaseYear: (t.album.release_date ?? '').slice(0, 4),
    durationMs: t.duration_ms,
    addedAt: item.added_at,
    imageUrl: t.album.images.at(-1)?.url ?? null,
  };
}

export async function fetchAllLikedTracks(): Promise<{ tracks: LikedTrack[]; skippedLocal: number }> {
  const items = await paged<SavedTrackPageItem>('/me/tracks');
  const tracks: LikedTrack[] = [];
  let skippedLocal = 0;
  for (const item of items) {
    const mapped = mapSavedTrack(item);
    if (mapped) tracks.push(mapped);
    else skippedLocal++;
  }
  return { tracks, skippedLocal };
}

/** Unlike tracks (Feb 2026 endpoint: DELETE /me/library with a `uris` list). */
export async function unlikeTracks(uris: string[]): Promise<void> {
  for (const urisChunk of chunk(uris, LIBRARY_CHUNK)) {
    await api('/me/library', { method: 'DELETE', body: { uris: urisChunk } });
  }
}

/** Re-like tracks (used by undo). */
export async function likeTracks(uris: string[]): Promise<void> {
  for (const urisChunk of chunk(uris, LIBRARY_CHUNK)) {
    await api('/me/library', { method: 'PUT', body: { uris: urisChunk } });
  }
}

export interface RecentlyPlayedItem {
  track: { id: string | null; uri: string };
  played_at: string;
}

export async function fetchRecentlyPlayed(params: { limit?: number; before?: string; after?: string } = {}): Promise<{
  items: RecentlyPlayedItem[];
}> {
  return api('/me/player/recently-played', {
    params: { limit: params.limit ?? 50, before: params.before, after: params.after },
  });
}

export async function fetchProfile(): Promise<SpotifyProfile> {
  return api('/me');
}

export async function fetchPlaylistMeta(id: string): Promise<{ id: string; name: string; external_urls: { spotify: string } }> {
  return api(`/playlists/${id}`);
}
