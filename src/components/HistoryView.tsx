import { useEffect, useMemo, useRef, useState } from 'react';
import {
  clearHistory,
  loadHistory,
  loadNames,
  onHistoryChanged,
  recentTrackIds,
  rememberNames,
  syncHistory,
  type TrackNames,
} from '../lib/history';
import { fetchTrack } from '../lib/tracks';
import { getLikedTracks } from '../lib/likedCache';
import type { LikedTrack, PlayEntry } from '../lib/types';

export default function HistoryView() {
  const [entries, setEntries] = useState<PlayEntry[]>(() => loadHistory());
  const [storedNames, setStoredNames] = useState<TrackNames>(() => loadNames());
  const [likedMap, setLikedMap] = useState<Map<string, LikedTrack>>(new Map());
  const [syncing, setSyncing] = useState(false);
  const [status, setStatus] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  // One lookup attempt per track, ever — avoids hammering the API on 404s
  // (podcast episodes) and keeps backfill cost bounded.
  const backfillTried = useRef(new Set<string>());

  useEffect(() => {
    getLikedTracks(false)
      .then((c) => setLikedMap(new Map(c.tracks.map((t) => [t.id, t]))))
      .catch((err) => {
        console.error('[history] liked-library load failed — falling back to stored names', err);
        setLikedMap(new Map());
      });
  }, []);

  // Liked-library names override the generic store (both are authoritative).
  const displayNames = useMemo(() => {
    const map = new Map<string, string>();
    for (const [id, label] of Object.entries(storedNames)) map.set(id, label);
    for (const [id, t] of likedMap) map.set(id, `${t.name} — ${t.artist}`);
    return map;
  }, [storedNames, likedMap]);

  // Backfill names for the visible list: one single-track GET per unresolved
  // track (the Feb 2026 API removed batch lookups), cached in localStorage.
  // Failures count as their one attempt for this session — no per-render
  // retry storm; the raw ID keeps showing until the next app start.
  useEffect(() => {
    const shown = entries.slice(0, 100);
    const missing = shown.filter(
      (e) => !displayNames.has(e.trackId) && !backfillTried.current.has(e.trackId),
    );
    if (missing.length === 0) return;
    let cancelled = false;
    (async () => {
      for (const e of missing) {
        if (cancelled) return;
        backfillTried.current.add(e.trackId);
        try {
          const info = await fetchTrack(e.trackId);
          const label = info ? `${info.name} — ${info.artist}`.trim() : 'Unavailable track';
          setStoredNames(rememberNames({ [e.trackId]: label }));
        } catch (err) {
          console.error('[history-names] lookup failed for', e.trackId, err);
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [entries, displayNames]);

  useEffect(() => {
    // Polling lives in App (all tabs); this view just follows the changes.
    return onHistoryChanged(() => {
      setEntries(loadHistory());
      setStoredNames(loadNames());
    });
  }, []);

  const sevenDay = useMemo(() => recentTrackIds(entries, 7 * 24 * 60 * 60_000), [entries]);
  const oldest = entries.length > 0 ? entries[entries.length - 1].playedAt : null;
  const uniqueTracks = useMemo(() => new Set(entries.map((e) => e.trackId)).size, [entries]);
  const recent = entries.slice(0, 100);

  const syncNow = async () => {
    setSyncing(true);
    setError(null);
    try {
      const added = await syncHistory();
      setEntries(loadHistory());
      setStoredNames(loadNames());
      setStatus(added > 0 ? `+${added} new play(s) recorded.` : 'No new plays found.');
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSyncing(false);
    }
  };

  const wipe = () => {
    if (!confirm('Delete all locally stored play history? The playlist feature will treat everything as "not played" until history rebuilds.')) return;
    clearHistory();
    setEntries([]);
    setStatus('History cleared.');
  };

  return (
    <section className="card">
      <h2>Play history</h2>
      <p className="muted">
        Spotify's API only serves your most recent ~50 plays (roughly the last day), so this app
        stores plays locally while it's open. Coverage grows over time — leave the tab open in a
        background window to record more.
      </p>

      <div className="stats">
        <div className="stat">
          <span className="stat-value">{entries.length}</span>
          <span className="stat-label">Plays stored</span>
        </div>
        <div className="stat">
          <span className="stat-value">{uniqueTracks}</span>
          <span className="stat-label">Unique tracks</span>
        </div>
        <div className="stat">
          <span className="stat-value">{sevenDay.size}</span>
          <span className="stat-label">Played in last 7 days</span>
        </div>
        <div className="stat">
          <span className="stat-value">{oldest ? new Date(oldest).toLocaleDateString() : '—'}</span>
          <span className="stat-label">Coverage starts</span>
        </div>
      </div>

      {error && <p className="error">{error}</p>}
      {status && <p className="status">{status}</p>}

      <div className="row gap">
        <button className="btn btn-primary" onClick={() => void syncNow()} disabled={syncing}>
          {syncing ? 'Syncing…' : 'Sync now'}
        </button>
        <button className="btn btn-danger" onClick={wipe} disabled={entries.length === 0}>
          Clear history
        </button>
      </div>

      {entries.length === 0 && (
        <p className="muted">
          Nothing stored yet — press <strong>Sync now</strong> to backfill from Spotify's recent
          plays, and keep this tab open so polling can accumulate history.
        </p>
      )}

      {recent.length > 0 && (
        <>
          <h3>Most recent plays</h3>
          <ul className="play-list">
            {recent.map((e) => (
              <li key={`${e.trackId}|${e.playedAt}`}>
                <span className="play-name">{displayNames.get(e.trackId) ?? e.trackId}</span>
                <span className="muted">{new Date(e.playedAt).toLocaleString()}</span>
              </li>
            ))}
          </ul>
          {entries.length > recent.length && (
            <p className="muted">
              Showing the {recent.length} most recent of {entries.length} stored plays.
            </p>
          )}
        </>
      )}
    </section>
  );
}
