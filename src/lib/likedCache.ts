import { fetchAllLikedTracks } from './tracks';
import type { LikedTrack } from './types';

const CACHE_KEY = 'sp.likedCache';
const MAX_AGE_MS = 24 * 60 * 60_000;

export interface LikedCache {
  ts: number;
  tracks: LikedTrack[];
  skippedLocal: number;
}

let memory: LikedCache | null = null;
let inflight: Promise<LikedCache> | null = null;

function readStored(): LikedCache | null {
  if (memory) return memory;
  try {
    const raw = localStorage.getItem(CACHE_KEY);
    if (raw) memory = JSON.parse(raw) as LikedCache;
  } catch {
    /* corrupt cache — refetch */
  }
  return memory;
}

function store(cache: LikedCache): void {
  memory = cache;
  try {
    localStorage.setItem(CACHE_KEY, JSON.stringify(cache));
  } catch {
    // Quota exceeded (very large libraries): drop the persisted copy, the
    // in-memory one still covers this session.
    localStorage.removeItem(CACHE_KEY);
  }
}

export async function getLikedTracks(force = false): Promise<LikedCache> {
  const cached = readStored();
  if (!force && cached && Date.now() - cached.ts < MAX_AGE_MS) return cached;
  if (!inflight) {
    inflight = fetchAllLikedTracks()
      .then(({ tracks, skippedLocal }) => {
        const cache: LikedCache = { ts: Date.now(), tracks, skippedLocal };
        store(cache);
        return cache;
      })
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
