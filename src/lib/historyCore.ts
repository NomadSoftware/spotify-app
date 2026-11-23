import type { PlayEntry } from './types';

// Cap stored entries (~15000 plays ≈ a year of heavy listening) so localStorage
// never overflows its ~5 MB budget.
export const MAX_ENTRIES = 15000;

export function playKey(e: PlayEntry): string {
  return `${e.trackId}|${e.playedAt}`;
}

export function mergePlays(existing: PlayEntry[], incoming: PlayEntry[]): PlayEntry[] {
  const seen = new Set(existing.map(playKey));
  const merged = [...existing];
  for (const e of incoming) {
    if (!e.trackId || !e.playedAt || seen.has(playKey(e))) continue;
    seen.add(playKey(e));
    merged.push(e);
  }
  merged.sort((a, b) => b.playedAt.localeCompare(a.playedAt)); // newest first
  return merged.slice(0, MAX_ENTRIES);
}

export function recentTrackIds(entries: PlayEntry[], windowMs: number, now = Date.now()): Set<string> {
  const cutoff = now - windowMs;
  const ids = new Set<string>();
  for (const e of entries) {
    if (Date.parse(e.playedAt) >= cutoff) ids.add(e.trackId);
  }
  return ids;
}

/** trackId → most recent recorded play (ISO). Tracks with no recorded plays are absent. */
export function lastPlayedMap(entries: PlayEntry[]): Map<string, string> {
  const map = new Map<string, string>();
  for (const e of entries) {
    const prev = map.get(e.trackId);
    if (!prev || e.playedAt > prev) map.set(e.trackId, e.playedAt);
  }
  return map;
}
