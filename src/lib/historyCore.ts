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
