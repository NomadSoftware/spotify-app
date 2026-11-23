import { fetchRecentlyPlayed } from './tracks';
import { mergePlays, MAX_ENTRIES } from './historyCore';
import type { PlayEntry } from './types';

const HISTORY_KEY = 'sp.history';
const NAMES_KEY = 'sp.trackNames';

// trackId → "Name — Artist". Captured from recently-played at sync time and
// backfilled via single-track lookups; also served by the liked-library cache.
export type TrackNames = Record<string, string>;

export function loadNames(): TrackNames {
  try {
    const raw = localStorage.getItem(NAMES_KEY);
    const parsed: unknown = raw ? JSON.parse(raw) : null;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {};
    const out: TrackNames = {};
    for (const [k, v] of Object.entries(parsed)) {
      if (typeof v === 'string') out[k] = v;
    }
    return out;
  } catch (err) {
    console.error('[history] failed to parse stored track names — ignoring', err);
    return {};
  }
}

export function rememberNames(names: TrackNames): TrackNames {
  const merged = { ...loadNames(), ...names };
  try {
    localStorage.setItem(NAMES_KEY, JSON.stringify(merged));
  } catch {
    /* quota — the returned merged object is the only fallback; callers that
       keep it (e.g. React state) cover the session, sync-captured names are
       re-captured on the next sync */
  }
  return merged;
}

// Re-export pure helpers so UI modules can import everything from here.
export { mergePlays, recentTrackIds, playKey, lastPlayedMap, MAX_ENTRIES } from './historyCore';

// ---- storage + syncing ----

export function loadHistory(): PlayEntry[] {
  try {
    const raw = localStorage.getItem(HISTORY_KEY);
    if (!raw) return [];
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    // Drop corrupt elements rather than letting them crash syncs later.
    return parsed.filter(
      (e): e is PlayEntry =>
        !!e &&
        typeof e === 'object' &&
        typeof (e as PlayEntry).trackId === 'string' &&
        typeof (e as PlayEntry).playedAt === 'string',
    );
  } catch (err) {
    console.error('[history] failed to parse stored history — starting empty', err);
    return [];
  }
}

export function saveHistory(entries: PlayEntry[]): void {
  try {
    localStorage.setItem(HISTORY_KEY, JSON.stringify(entries));
  } catch (err) {
    // Quota exceeded or storage blocked: surface it — silently discarding
    // freshly synced plays is how the history feature stops working forever.
    throw new Error(`Could not save play history (storage full or blocked): ${String(err)}`);
  }
}

export function clearHistory(): void {
  localStorage.removeItem(HISTORY_KEY);
}

// ---- change notification (polling lives in App; views subscribe) ----

const listeners = new Set<() => void>();

/** Subscribe to history/names changes from any sync. Returns an unsubscribe fn. */
export function onHistoryChanged(cb: () => void): () => void {
  listeners.add(cb);
  return () => {
    listeners.delete(cb);
  };
}

function notifyHistoryChanged(): void {
  listeners.forEach((l) => l());
}

/**
 * Pull Spotify's recently-played window (≤50 tracks, roughly the last day) and
 * merge it into the local store. Walk back with the `before` cursor (up to 4
 * pages, epoch-ms as documented) to grab anything older Spotify still serves;
 * only the most recent window is documented, so treat anything beyond it as
 * best-effort. Pages are saved incrementally so a late-page failure keeps the
 * earlier work.
 */
export async function syncHistory(): Promise<number> {
  let entries = loadHistory();
  const before = entries.length;
  let oldestSeenMs: number | undefined;
  for (let page = 0; page < 4; page++) {
    const res = await fetchRecentlyPlayed({ limit: 50, before: oldestSeenMs });
    if (res.items.length === 0) break;
    const plays: PlayEntry[] = [];
    const names: TrackNames = {};
    for (const it of res.items) {
      if (!it.track.id) continue;
      plays.push({ trackId: it.track.id, playedAt: it.played_at });
      if (it.track.name) {
        names[it.track.id] = `${it.track.name} — ${it.track.artists?.[0]?.name ?? ''}`.trim();
      }
    }
    entries = mergePlays(entries, plays);
    if (Object.keys(names).length > 0) rememberNames(names);
    saveHistory(entries.slice(0, MAX_ENTRIES));
    const oldestInPage = res.items[res.items.length - 1].played_at;
    const oldestInPageMs = Date.parse(oldestInPage);
    if (oldestSeenMs === undefined || oldestInPageMs < oldestSeenMs) oldestSeenMs = oldestInPageMs;
    if (res.items.length < 50) break;
  }
  notifyHistoryChanged();
  return entries.length - before;
}

let pollTimer: ReturnType<typeof setInterval> | undefined;

/**
 * Keep the local history fresh while the app is open: sync now, then every
 * `intervalMs`, plus whenever the tab becomes visible again. Failures go to
 * `onError` — swallowing them here would silently stop history accumulation
 * (e.g. a dead refresh token would record nothing, forever).
 */
export function startHistoryPolling(
  onSync: (added: number) => void,
  onError: (err: Error) => void,
  intervalMs = 5 * 60_000,
): () => void {
  const run = async () => {
    try {
      onSync(await syncHistory());
    } catch (err) {
      onError(err instanceof Error ? err : new Error(String(err)));
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
