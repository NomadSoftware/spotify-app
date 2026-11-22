import { useEffect, useState } from 'react';
import { getOrCreatePlaylist, replacePlaylistItems } from '../lib/playlist';
import { loadHistory, recentTrackIds } from '../lib/history';
import { getLikedTracks } from '../lib/likedCache';
import type { LikedTrack, PlayEntry } from '../lib/types';

const SETTINGS_KEY = 'sp.playlist.settings';

interface Settings {
  name: string;
  size: number;
  windowDays: number;
  autoRefresh: boolean;
  lastRefreshTs: number;
}

const DEFAULTS: Settings = {
  name: 'Not Recently Played',
  size: 50,
  windowDays: 7,
  autoRefresh: true,
  lastRefreshTs: 0,
};

function loadSettings(): Settings {
  try {
    const raw = localStorage.getItem(SETTINGS_KEY);
    return raw ? { ...DEFAULTS, ...(JSON.parse(raw) as Partial<Settings>) } : DEFAULTS;
  } catch {
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

  const update = (patch: Partial<Settings>) => {
    setSettings((prev) => {
      const next = { ...prev, ...patch };
      localStorage.setItem(SETTINGS_KEY, JSON.stringify(next));
      return next;
    });
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
      const pool = candidates.slice();
      // Fisher-Yates so repeated refreshes give a different selection.
      for (let i = pool.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [pool[i], pool[j]] = [pool[j], pool[i]];
      }
      const picked = pool.slice(0, settings.size);
      await replacePlaylistItems(playlist.id, picked.map((t) => t.uri));
      update({ lastRefreshTs: Date.now() });
      setPlaylistUrl(playlist.url);
      setStatus(
        picked.length > 0
          ? `Playlist "${playlist.name}" updated with ${picked.length} song(s) not played in the last ${settings.windowDays} day(s).`
          : 'No candidates available — every liked song was played within the window.',
      );
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
            checked={settings.autoRefresh}
            onChange={(e) => update({ autoRefresh: e.target.checked })}
          />
          Auto-refresh when opening the app (if older than 12h)
        </label>
      </div>

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
