import { fetchAllLikedTracks } from './tracks';
import type { LikedTrack } from './types';

const CACHE_KEY = 'sp.likedCache';
const CACHE_VERSION = 2; // v1 stored 64px artwork URLs
const MAX_AGE_MS = 24 * 60 * 60_000;

export interface LikedCache {
  v: number;
  ts: number;
  tracks: LikedTrack[];
  skippedLocal: number;
}

type LikedCacheData = Omit<LikedCache, 'v'>;

let memory: LikedCache | null = null;
let inflight: Promise<LikedCache> | null = null;

function readStored(): LikedCache | null {
  if (memory) return memory;
  try {
    const raw = localStorage.getItem(CACHE_KEY);
    if (raw) {
      const parsed = JSON.parse(raw) as LikedCache;
      if (parsed.v === CACHE_VERSION && Array.isArray(parsed.tracks)) memory = parsed;
    }
  } catch (err) {
    console.error('[liked-cache] failed to parse stored cache — refetching', err);
  }
  return memory;
}

function store(cache: LikedCacheData): LikedCache {
  memory = { ...cache, v: CACHE_VERSION };
  try {
    localStorage.setItem(CACHE_KEY, JSON.stringify(memory));
  } catch (err) {
    // Quota exceeded (very large libraries): drop the persisted copy, the
    // in-memory one still covers this session.
    console.error('[liked-cache] persist failed (quota?) — memory-only for this session', err);
    localStorage.removeItem(CACHE_KEY);
  }
  return memory;
}

export async function getLikedTracks(force = false): Promise<LikedCache> {
  const cached = readStored();
  if (!force && cached && Date.now() - cached.ts < MAX_AGE_MS) return cached;
  if (!inflight) {
    inflight = fetchAllLikedTracks()
      .then(({ tracks, skippedLocal }) => store({ ts: Date.now(), tracks, skippedLocal }))
      .finally(() => {
        inflight = null;
      });
  }
  return inflight;
}

/** Apply a deletion to the cached library (track no longer liked). */
export function removeFromCache(track: LikedTrack): void {
  const cached = readStored();
  if (!cached) return;
  store({
    ...cached,
    tracks: cached.tracks.filter((t) => t.id !== track.id),
  });
}

/** Re-add a track to the cached library (undo). */
export function addToCache(track: LikedTrack): void {
  const cached = readStored();
  if (!cached) return;
  store({ ...cached, ts: cached.ts, tracks: [...cached.tracks, track] });
}
