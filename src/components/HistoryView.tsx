import { useEffect, useMemo, useState } from 'react';
import { clearHistory, loadHistory, recentTrackIds, startHistoryPolling, syncHistory } from '../lib/history';
import { getLikedTracks } from '../lib/likedCache';
import type { LikedTrack, PlayEntry } from '../lib/types';

export default function HistoryView() {
  const [entries, setEntries] = useState<PlayEntry[]>(() => loadHistory());
  const [nameById, setNameById] = useState<Map<string, LikedTrack>>(new Map());
  const [syncing, setSyncing] = useState(false);
  const [status, setStatus] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    getLikedTracks(false)
      .then((c) => setNameById(new Map(c.tracks.map((t) => [t.id, t]))))
      .catch(() => setNameById(new Map()));
  }, []);

  useEffect(() => {
    // Poll while the app is open; each sync extends local coverage.
    return startHistoryPolling((added) => {
      setEntries(loadHistory());
      if (added > 0) setStatus(`+${added} new play(s) recorded.`);
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

      {recent.length > 0 && (
        <>
          <h3>Most recent plays</h3>
          <ul className="play-list">
            {recent.map((e) => {
              const t = nameById.get(e.trackId);
              return (
                <li key={`${e.trackId}|${e.playedAt}`}>
                  <span className="play-name">{t ? `${t.name} — ${t.artist}` : e.trackId}</span>
                  <span className="muted">{new Date(e.playedAt).toLocaleString()}</span>
                </li>
              );
            })}
          </ul>
          {entries.length > recent.length && (
            <p className="muted">Showing the {recent.length} most recent of {entries.length} stored plays.</p>
          )}
        </>
      )}
      {entries.length === 0 && (
        <p className="muted">
          Nothing stored yet — press <strong>Sync now</strong> to backfill from Spotify's recent
          plays, and keep this tab open so polling can accumulate history.
        </p>
      )}
    </section>
  );
}
