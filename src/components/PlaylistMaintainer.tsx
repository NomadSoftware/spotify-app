import { useEffect, useState } from 'react';
import { getOrCreatePlaylist, replacePlaylistItems } from '../lib/playlist';
import { lastPlayedMap, loadHistory, recentTrackIds } from '../lib/history';
import { randomSample, selectNeglectFirst } from '../lib/util';
import { getLikedTracks } from '../lib/likedCache';
import type { LikedTrack, PlayEntry } from '../lib/types';

const SETTINGS_KEY = 'sp.playlist.settings';

interface Settings {
  name: string;
  size: number;
  windowDays: number;
  neglectFirst: boolean;
  autoRefresh: boolean;
  lastRefreshTs: number;
}

const DEFAULTS: Settings = {
  name: 'Not Recently Played',
  size: 50,
  windowDays: 7,
  neglectFirst: true,
  autoRefresh: true,
  lastRefreshTs: 0,
};

function clampNumber(v: unknown, min: number, max: number, fallback: number): number {
  const n = Number(v);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, Math.round(n)));
}

function loadSettings(): Settings {
  try {
    const raw = localStorage.getItem(SETTINGS_KEY);
    const parsed = raw ? (JSON.parse(raw) as Partial<Settings>) : {};
    // Clamp/validate: a stale or hand-edited blob must not feed bad values
    // into the sliders or the selection logic.
    return {
      name: typeof parsed.name === 'string' && parsed.name.trim() ? parsed.name : DEFAULTS.name,
      size: clampNumber(parsed.size, 10, 200, DEFAULTS.size),
      windowDays: clampNumber(parsed.windowDays, 1, 30, DEFAULTS.windowDays),
      neglectFirst: typeof parsed.neglectFirst === 'boolean' ? parsed.neglectFirst : DEFAULTS.neglectFirst,
      autoRefresh: typeof parsed.autoRefresh === 'boolean' ? parsed.autoRefresh : DEFAULTS.autoRefresh,
      lastRefreshTs: clampNumber(parsed.lastRefreshTs, 0, Number.MAX_SAFE_INTEGER, 0),
    };
  } catch (err) {
    console.error('[settings] failed to parse stored settings — using defaults', err);
    return DEFAULTS;
  }
}

export default function PlaylistMaintainer() {
  const [settings, setSettings] = useState<Settings>(loadSettings);
  const [liked, setLiked] = useState<LikedTrack[] | null>(null);
  const [history] = useState<PlayEntry[]>(() => loadHistory());
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [playlistUrl, setPlaylistUrl] = useState<string | null>(null);

  // Persist settings in an effect, not inside the state updater: updaters
  // must stay pure (StrictMode double-invokes them, and a quota throw there
  // would crash the React tree).
  useEffect(() => {
    try {
      localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings));
    } catch (err) {
      console.error('[settings] persist failed', err);
    }
  }, [settings]);

  const update = (patch: Partial<Settings>) => {
    setSettings((prev) => ({ ...prev, ...patch }));
  };

  useEffect(() => {
    void getLikedTracks(false)
      .then((c) => setLiked(c.tracks))
      .catch((err) => setError(err instanceof Error ? err.message : String(err)));
  }, []);

  const windowMs = settings.windowDays * 24 * 60 * 60_000;
  const recent = recentTrackIds(history, windowMs);
  const candidates = (liked ?? []).filter((t) => !recent.has(t.id));

  const refreshPlaylist = async () => {
    setBusy(true);
    setError(null);
    setStatus(null);
    try {
      const playlist = await getOrCreatePlaylist(
        settings.name,
        'Kept fresh by Spotify Personal Tools — songs I have not heard recently.',
      );
      // Fresh history at refresh time, not the mount-time snapshot.
      const historyNow = loadHistory();
      const lastPlayed = lastPlayedMap(historyNow);
      const recent = recentTrackIds(historyNow, windowMs);
      const pool = (liked ?? []).filter((t) => !recent.has(t.id));

      let picked: LikedTrack[];
      let fromNeglect = 0;
      if (settings.neglectFirst) {
        const result = selectNeglectFirst(pool, lastPlayed, settings.size);
        picked = result.picked;
        fromNeglect = result.fromNeglect;
      } else {
        picked = randomSample(pool, settings.size);
      }
      await replacePlaylistItems(playlist.id, picked.map((t) => t.uri));
      update({ lastRefreshTs: Date.now() });
      setPlaylistUrl(playlist.url);
      if (picked.length === 0) {
        setStatus('No candidates available — every liked song was played within the window.');
      } else if (settings.neglectFirst) {
        setStatus(
          `Playlist "${playlist.name}" updated with ${picked.length} song(s) — ${fromNeglect} from your least-heard pool, ${picked.length - fromNeglect} from the rest.`,
        );
      } else {
        setStatus(`Playlist "${playlist.name}" updated with ${picked.length} random song(s) not played in the last ${settings.windowDays} day(s).`);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  // Auto-refresh on open when the playlist went stale (checked once per mount).
  useEffect(() => {
    const staleMs = 12 * 60 * 60_000;
    if (settings.autoRefresh && Date.now() - settings.lastRefreshTs > staleMs && liked && !busy) {
      void refreshPlaylist();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [liked]);

  const oldestCovered = history.length > 0 ? history[history.length - 1].playedAt : null;

  return (
    <section className="card">
      <h2>Not recently played</h2>
      <p className="muted">
        Keeps a playlist filled with liked songs you haven't heard in a while. Which songs count as
        "heard" comes from the local play history — see the <strong>Play history</strong> tab for
        coverage.
      </p>

      <div className="settings-grid">
        <label>
          Playlist name
          <input
            type="text"
            value={settings.name}
            onChange={(e) => update({ name: e.target.value })}
            disabled={busy}
          />
        </label>
        <label>
          Playlist size: {settings.size}
          <input
            type="range"
            min={10}
            max={200}
            step={10}
            value={settings.size}
            onChange={(e) => update({ size: Number(e.target.value) })}
          />
        </label>
        <label>
          "Played recently" window: {settings.windowDays} day(s)
          <input
            type="range"
            min={1}
            max={30}
            value={settings.windowDays}
            onChange={(e) => update({ windowDays: Number(e.target.value) })}
          />
        </label>
        <label className="checkbox">
          <input
            type="checkbox"
            checked={settings.neglectFirst}
            onChange={(e) => update({ neglectFirst: e.target.checked })}
          />
          Neglect-first: half the playlist from your 100 least-heard songs
        </label>
        <label className="checkbox">
          <input
            type="checkbox"
            checked={settings.autoRefresh}
            onChange={(e) => update({ autoRefresh: e.target.checked })}
          />
          Auto-refresh when opening the app (if older than 12h)
        </label>
      </div>
      {settings.neglectFirst && (
        <p className="muted hint">
          "Least heard" = never recorded in your local history first (oldest likes first), then
          tracks whose last recorded play is oldest. With little history so far this favors your
          oldest likes; it sharpens as coverage grows.
        </p>
      )}

      <div className="stats">
        <Stat label="Liked songs" value={liked?.length ?? '…'} />
        <Stat label="Plays in history" value={history.length} />
        <Stat label={`Played in last ${settings.windowDays}d`} value={recent.size} />
        <Stat label="Candidates" value={liked ? candidates.length : '…'} />
      </div>
      {oldestCovered && (
        <p className="muted">
          History covers plays since {new Date(oldestCovered).toLocaleString()}; anything older is
          treated as "not played".
        </p>
      )}
      {history.length === 0 && (
        <p className="warning">
          No play history stored yet. Keep this tab open a while (or press Sync in the Play history
          tab) — until then the playlist may include songs you just heard.
        </p>
      )}

      {error && <p className="error">{error}</p>}
      {status && <p className="status">{status}</p>}
      {playlistUrl && (
        <p>
          <a href={playlistUrl} target="_blank" rel="noreferrer">
            Open playlist in Spotify ↗
          </a>
        </p>
      )}

      <button className="btn btn-primary" onClick={() => void refreshPlaylist()} disabled={busy || !liked}>
        {busy ? 'Updating…' : 'Refresh playlist now'}
      </button>
    </section>
  );
}

function Stat({ label, value }: { label: string; value: number | string }) {
  return (
    <div className="stat">
      <span className="stat-value">{value}</span>
      <span className="stat-label">{label}</span>
    </div>
  );
}
