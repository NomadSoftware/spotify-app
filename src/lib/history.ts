import { fetchRecentlyPlayed } from './tracks';
import { mergePlays, MAX_ENTRIES } from './historyCore';
import type { PlayEntry } from './types';

const HISTORY_KEY = 'sp.history';

// Re-export pure helpers so UI modules can import everything from here.
export { mergePlays, recentTrackIds, playKey, MAX_ENTRIES } from './historyCore';

// ---- storage + syncing ----

export function loadHistory(): PlayEntry[] {
  try {
    const raw = localStorage.getItem(HISTORY_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw) as PlayEntry[];
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

export function saveHistory(entries: PlayEntry[]): void {
  localStorage.setItem(HISTORY_KEY, JSON.stringify(entries));
}

export function clearHistory(): void {
  localStorage.removeItem(HISTORY_KEY);
}

/**
 * Pull Spotify's recently-played window (≤50 tracks, roughly the last day) and
 * merge it into the local store. Walking back with the `before` cursor grabs
 * whatever additional history Spotify still serves (usually nothing beyond
 * ~24h, but a few extra pages are cheap).
 */
export async function syncHistory(): Promise<number> {
  let entries = loadHistory();
  const before = entries.length;
  let oldestSeen: string | undefined;
  for (let page = 0; page < 4; page++) {
    const res = await fetchRecentlyPlayed({ limit: 50, before: oldestSeen });
    if (res.items.length === 0) break;
    const plays: PlayEntry[] = res.items
      .filter((it) => it.track.id)
      .map((it) => ({ trackId: it.track.id as string, playedAt: it.played_at }));
    entries = mergePlays(entries, plays);
    const oldestInPage = res.items[res.items.length - 1].played_at;
    if (!oldestSeen || oldestInPage < oldestSeen) oldestSeen = oldestInPage;
    if (res.items.length < 50) break;
  }
  saveHistory(entries.slice(0, MAX_ENTRIES));
  return entries.length - before;
}

let pollTimer: ReturnType<typeof setInterval> | undefined;

/**
 * Keep the local history fresh while the app is open: sync now, then every
 * `intervalMs`, plus whenever the tab becomes visible again.
 */
export function startHistoryPolling(onSync: (added: number) => void, intervalMs = 5 * 60_000): () => void {
  const run = async () => {
    try {
      onSync(await syncHistory());
    } catch {
      /* offline/token expiry — the next tick or manual sync will retry */
    }
  };
  void run();
  pollTimer = setInterval(run, intervalMs);
  const onVisible = () => {
    if (document.visibilityState === 'visible') void run();
  };
  document.addEventListener('visibilitychange', onVisible);
  return () => {
    if (pollTimer) clearInterval(pollTimer);
    document.removeEventListener('visibilitychange', onVisible);
  };
}
