import { api, paged, SpotifyApiError } from './api';
import { mapSavedTrack, type SavedTrackPageItem } from './mapping';
import { chunk } from './util';
import type { LikedTrack, SpotifyProfile } from './types';

// Feb 2026 API: library save/remove take Spotify URIs, max 40 per request.
const LIBRARY_CHUNK = 40;

export { mapSavedTrack } from './mapping';
export type { SavedTrackPageItem } from './mapping';

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

/** Unlike tracks (Feb 2026 endpoint: DELETE /me/library?uris=..., comma-separated, max 40). */
export async function unlikeTracks(uris: string[]): Promise<void> {
  for (const urisChunk of chunk(uris, LIBRARY_CHUNK)) {
    await api('/me/library', { method: 'DELETE', params: { uris: urisChunk.join(',') } });
  }
}

/** Re-like tracks (used by undo) — same query-parameter format as unlike. */
export async function likeTracks(uris: string[]): Promise<void> {
  for (const urisChunk of chunk(uris, LIBRARY_CHUNK)) {
    await api('/me/library', { method: 'PUT', params: { uris: urisChunk.join(',') } });
  }
}

export interface RecentlyPlayedItem {
  track: { id: string | null; uri: string; name: string; artists: { name: string }[] };
  played_at: string;
}

export interface TrackInfo {
  id: string;
  name: string;
  artist: string;
}

/** Single-track lookup — the Feb 2026 API removed the batch GET /tracks?ids= endpoint. */
export async function fetchTrack(id: string): Promise<TrackInfo | null> {
  try {
    const t = await api<{ id: string; name: string; artists: { name: string }[] }>(`/tracks/${id}`);
    return { id: t.id, name: t.name, artist: t.artists[0]?.name ?? '' };
  } catch (err) {
    if (err instanceof SpotifyApiError && err.status === 404) return null; // episodes etc.
    throw err;
  }
}

export async function fetchRecentlyPlayed(params: { limit?: number; before?: number; after?: number } = {}): Promise<{
  items: RecentlyPlayedItem[];
}> {
  return api('/me/player/recently-played', {
    params: { limit: params.limit ?? 50, before: params.before, after: params.after },
  });
}

export async function fetchProfile(): Promise<SpotifyProfile> {
  return api('/me');
}

export async function fetchPlaylistMeta(
  id: string,
): Promise<{ id: string; name: string; owner: { id: string }; external_urls: { spotify: string } }> {
  return api(`/playlists/${id}`);
}
