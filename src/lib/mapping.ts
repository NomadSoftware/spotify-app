import type { LikedTrack } from './types';

// Wire shape of a GET /me/tracks page item (kept here so the mapper is pure
// and unit-testable in plain Node — api.ts/config.ts pull in browser envs).
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
    // Images are sorted largest-first (640/300/64) — take the big one;
    // CSS scales it down and the 64px variant is far too small.
    imageUrl: t.album.images[0]?.url ?? null,
  };
}
