import { useEffect, useState } from 'react';
import {
  adoptManagedPlaylist,
  createManagedPlaylist,
  replacePlaylistItems,
  resolveManagedPlaylist,
} from '../lib/playlist';
import type { PlaylistCandidate, Resolution, UnresolvedReason } from '../lib/playlistCore';
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

/** Set when looking for the playlist didn't settle on exactly one. */
interface Unresolved {
  reason: UnresolvedReason;
  candidates: PlaylistCandidate[];
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
  // A playlist only becomes "resolved" by being found or explicitly chosen.
  // Looking for it never creates one — that used to produce a new playlist
  // every time the stored id was missing.
  const [resolved, setResolved] = useState(false);
  const [unresolved, setUnresolved] = useState<Unresolved | null>(null);

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

  const applyResolution = (r: Resolution): void => {
    if (r.kind === 'resolved') {
      setUnresolved(null);
      setPlaylistUrl(r.playlist.url);
      setResolved(true);
      return;
    }
    setResolved(false);
    setUnresolved({ reason: r.kind, candidates: 'candidates' in r ? r.candidates : [] });
  };

  // Find the playlist by name before anything else.
  useEffect(() => {
    let cancelled = false;
    setBusy(true);
    resolveManagedPlaylist(settings.name)
      .then((r) => {
        if (!cancelled) applyResolution(r);
      })
      .catch((err) => {
        if (!cancelled) setError(err instanceof Error ? err.message : String(err));
      })
      .finally(() => {
        if (!cancelled) setBusy(false);
      });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

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
      const r = await resolveManagedPlaylist(settings.name);
      if (r.kind !== 'resolved') {
        applyResolution(r); // asks the user which playlist to use
        return;
      }
      const playlist = r.playlist;
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
      setResolved(true);
      setUnresolved(null);
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

  // Auto-refresh once the playlist is resolved and went stale (12h). Also
  // fires when a playlist is chosen or created, unless this browser refreshed
  // recently — so a new playlist gets filled straight away.
  useEffect(() => {
    const staleMs = 12 * 60 * 60_000;
    if (resolved && settings.autoRefresh && Date.now() - settings.lastRefreshTs > staleMs && liked && !busy) {
      void refreshPlaylist();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [resolved, liked]);

  const searchAgain = async () => {
    setBusy(true);
    setError(null);
    try {
      applyResolution(await resolveManagedPlaylist(settings.name));
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  const useExisting = async (ref: string) => {
    setBusy(true);
    try {
      const playlist = await adoptManagedPlaylist(ref);
      setUnresolved(null);
      setResolved(true);
      setPlaylistUrl(playlist.url);
      setStatus(`Now keeping "${playlist.name}" updated.`);
    } finally {
      setBusy(false);
    }
  };

  const create = async () => {
    setBusy(true);
    try {
      const playlist = await createManagedPlaylist(settings.name);
      // Force the auto-refresh below to fill the new (empty) playlist now.
      update({ lastRefreshTs: 0 });
      setUnresolved(null);
      setResolved(true);
      setPlaylistUrl(playlist.url);
      setStatus(`Created "${playlist.name}".`);
    } finally {
      setBusy(false);
    }
  };

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
      {playlistUrl && !unresolved && (
        <p>
          <a href={playlistUrl} target="_blank" rel="noreferrer">
            Open playlist in Spotify ↗
          </a>
        </p>
      )}

      {unresolved ? (
        <PlaylistSetup
          name={settings.name}
          unresolved={unresolved}
          busy={busy}
          onUse={useExisting}
          onCreate={create}
          onSearchAgain={() => void searchAgain()}
        />
      ) : (
        <button className="btn btn-primary" onClick={() => void refreshPlaylist()} disabled={busy || !liked}>
          {busy ? 'Working…' : 'Refresh playlist now'}
        </button>
      )}
    </section>
  );
}

function PlaylistSetup({
  name,
  unresolved,
  busy,
  onUse,
  onCreate,
  onSearchAgain,
}: {
  name: string;
  unresolved: Unresolved;
  busy: boolean;
  onUse: (ref: string) => Promise<void>;
  onCreate: () => Promise<void>;
  onSearchAgain: () => void;
}) {
  const [paste, setPaste] = useState('');
  const [actionError, setActionError] = useState<string | null>(null);

  // Choosing and creating both fail with a message the user can act on (bad
  // link, not the owner…), so they report here rather than as a general error.
  const attempt = async (action: () => Promise<void>) => {
    setActionError(null);
    try {
      await action();
    } catch (err) {
      setActionError(err instanceof Error ? err.message : String(err));
    }
  };

  const n = unresolved.candidates.length;
  const heading =
    unresolved.reason === 'ambiguous'
      ? `Which "${name}" playlist should the app keep updated?`
      : unresolved.reason === 'unmanaged'
        ? 'Use an existing playlist, or create a new one?'
        : `Couldn't find a "${name}" playlist.`;
  const body =
    unresolved.reason === 'ambiguous'
      ? `This app created ${n} playlists with that name, probably leftovers from earlier duplicates. Pick the one to keep updated — the others can be deleted in Spotify.`
      : unresolved.reason === 'unmanaged'
        ? `You have ${n} playlist${n === 1 ? '' : 's'} with that name that this app didn't create. Using one replaces its contents on every refresh.`
        : `Create one below. If you already have one, paste its Spotify link so the app updates that one instead of adding another. (The app finds its playlist by name through Spotify search, which only sees public playlists, so a private or renamed one has to be pasted.)`;

  return (
    <div className="setup-panel">
      <h3>{heading}</h3>
      <p>{body}</p>

      {n > 0 && (
        <ul className="candidate-list">
          {unresolved.candidates.map((c) => (
            <li key={c.id}>
              <span>
                {c.name} <span className="muted">· {c.trackTotal ?? '?'} tracks</span>
              </span>
              <div className="spacer" />
              <a href={c.url} target="_blank" rel="noreferrer">
                Open in Spotify ↗
              </a>
              <button className="btn" disabled={busy} onClick={() => void attempt(() => onUse(c.id))}>
                Use this one
              </button>
            </li>
          ))}
        </ul>
      )}

      {/* With several app-made playlists to choose from, creating another is
          refused (that is how the duplicates arose), so it isn't offered. */}
      {unresolved.reason !== 'ambiguous' && (
        <>
          <button className="btn btn-primary" disabled={busy} onClick={() => void attempt(onCreate)}>
            {unresolved.reason === 'none' ? `Create "${name}"` : `Create a new "${name}"`}
          </button>

          <form
            className="paste-form"
            onSubmit={(e) => {
              e.preventDefault();
              void attempt(() => onUse(paste));
            }}
          >
            <input
              type="text"
              placeholder="…or paste a Spotify playlist link"
              value={paste}
              onChange={(e) => setPaste(e.target.value)}
              disabled={busy}
              aria-label="Spotify playlist link"
            />
            <button className="btn" type="submit" disabled={busy || !paste.trim()}>
              Use that playlist
            </button>
          </form>
        </>
      )}

      {actionError && <p className="error">{actionError}</p>}

      <p className="muted hint">
        Changed the name above? <button className="btn btn-ghost" disabled={busy} onClick={onSearchAgain}>Search again</button>
      </p>
    </div>
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
