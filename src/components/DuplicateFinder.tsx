import { useEffect, useMemo, useRef, useState } from 'react';
import { unlikeTracks, likeTracks } from '../lib/tracks';
import { findDuplicatePairs } from '../lib/duplicates';
import { getLikedTracks, removeFromCache, addToCache } from '../lib/likedCache';
import type { DupPair, LikedTrack } from '../lib/types';

function pairSignature(p: DupPair): string {
  return [p.a.id, p.b.id].sort().join('|');
}

export default function DuplicateFinder() {
  const [tracks, setTracks] = useState<LikedTrack[] | null>(null);
  const [skippedLocal, setSkippedLocal] = useState(0);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [toleranceSec, setToleranceSec] = useState(5);
  const [includeWeak, setIncludeWeak] = useState(false);
  const [deletedCount, setDeletedCount] = useState(0);
  const decidedRef = useRef(new Set<string>());
  const undoRef = useRef<{ track: LikedTrack; signature: string }[]>([]);
  const [undoCount, setUndoCount] = useState(0);

  const load = async (force: boolean) => {
    setLoading(true);
    setError(null);
    setStatus(null);
    try {
      const cache = await getLikedTracks(force);
      decidedRef.current = new Set();
      undoRef.current = [];
      setUndoCount(0);
      setTracks(cache.tracks);
      setSkippedLocal(cache.skippedLocal);
      setDeletedCount(0);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    void load(false);
  }, []);

  const { near, weak } = useMemo(
    () => findDuplicatePairs(tracks ?? [], { durationToleranceMs: toleranceSec * 1000 }),
    [tracks, toleranceSec],
  );
  const queue = useMemo(() => {
    const base = includeWeak ? [...near, ...weak] : near;
    return base.filter((p) => !decidedRef.current.has(pairSignature(p)));
  }, [near, weak, includeWeak]);
  const pair: DupPair | undefined = queue[0];

  const applyDecision = async (toDelete: LikedTrack[], message: string) => {
    if (!pair) return;
    const signature = pairSignature(pair);
    setBusy(true);
    setError(null);
    try {
      if (toDelete.length > 0) {
        await unlikeTracks(toDelete.map((t) => t.uri));
        for (const t of toDelete) removeFromCache(t);
        if (tracks) setTracks(tracks.filter((t) => !toDelete.some((d) => d.id === t.id)));
        setDeletedCount((n) => n + toDelete.length);
        undoRef.current.push(
          ...toDelete.map((t) => ({ track: t, signature })),
        );
        setUndoCount(undoRef.current.length);
      }
      decidedRef.current.add(signature);
      setStatus(message);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  const undoLast = async () => {
    const last = undoRef.current.pop();
    if (!last) return;
    setBusy(true);
    setError(null);
    try {
      await likeTracks([last.track.uri]);
      addToCache(last.track);
      setTracks((prev) => (prev ? [...prev, last.track] : prev));
      decidedRef.current.delete(last.signature);
      setDeletedCount((n) => Math.max(0, n - 1));
      setStatus(`Restored "${last.track.name}" (${last.track.album}).`);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
      setUndoCount(undoRef.current.length);
    }
  };

  if (loading) {
    return (
      <section className="card">
        <p className="muted">Loading your liked songs…</p>
      </section>
    );
  }

  return (
    <section className="card">
      <div className="row wrap gap">
        <span className="muted">
          {tracks?.length ?? 0} liked tracks
          {skippedLocal > 0 && <> · {skippedLocal} local files skipped</>}
        </span>
        <label className="muted">
          Duration tolerance: {toleranceSec}s
          <input
            type="range"
            min={1}
            max={15}
            value={toleranceSec}
            onChange={(e) => setToleranceSec(Number(e.target.value))}
          />
        </label>
        <label className="muted">
          <input
            type="checkbox"
            checked={includeWeak}
            onChange={(e) => setIncludeWeak(e.target.checked)}
          />{' '}
          include different-artist matches
        </label>
        <button className="btn btn-ghost" onClick={() => void load(true)} disabled={busy}>
          Reload library
        </button>
        {undoCount > 0 && (
          <button className="btn btn-ghost" onClick={() => void undoLast()} disabled={busy}>
            Undo last ({undoCount})
          </button>
        )}
      </div>

      <p className="muted">
        <strong>{queue.length}</strong> pair(s) to review
        {deletedCount > 0 && <> · {deletedCount} track(s) removed this session</>}
      </p>

      {error && <p className="error">{error}</p>}
      {status && <p className="status">{status}</p>}

      {!pair ? (
        <div className="empty">
          <h2>{near.length + weak.length === 0 ? 'No duplicates found 🎉' : 'All pairs reviewed ✓'}</h2>
          <p className="muted">
            Liked songs can't contain the exact same track twice, but the same recording often
            exists on several albums (original, remaster, compilation, deluxe). Each pair is the
            same song on different releases — you decide which to keep.
          </p>
          <button className="btn btn-ghost" onClick={() => void load(true)} disabled={busy}>
            Reload library
          </button>
        </div>
      ) : (
        <>
          {pair.kind === 'weak' && <span className="badge badge-weak">different artist</span>}
          <span className="badge">{Math.round(pair.durationDiffMs / 100) / 10}s apart</span>
          <div className="pair-grid">
            <TrackCard track={pair.a} />
            <TrackCard track={pair.b} />
          </div>
          <div className="row gap center">
            <button
              className="btn btn-danger"
              disabled={busy}
              onClick={() => void applyDecision([pair.a], `Removed "${pair.a.name}" (${pair.a.album}).`)}
            >
              Delete A
            </button>
            <button
              className="btn btn-danger"
              disabled={busy}
              onClick={() => void applyDecision([pair.b], `Removed "${pair.b.name}" (${pair.b.album}).`)}
            >
              Delete B
            </button>
            <button
              className="btn btn-danger"
              disabled={busy}
              onClick={() => void applyDecision([pair.a, pair.b], 'Removed both versions.')}
            >
              Delete both
            </button>
            <button className="btn btn-ghost" disabled={busy} onClick={() => void applyDecision([], 'Kept both.')}>
              Keep both →
            </button>
          </div>
          <p className="muted hint">
            Deletions can be undone in this session (Undo re-likes the track, but Spotify won't
            restore the original "added" date). A is the older release, B the newer.
          </p>
        </>
      )}
    </section>
  );
}

function TrackCard({ track }: { track: LikedTrack }) {
  return (
    <div className="track-card">
      {track.imageUrl && <img src={track.imageUrl} alt={`${track.album} cover`} loading="lazy" />}
      <div className="track-meta">
        <strong className="track-name">{track.name}</strong>
        <span>{track.artist}</span>
        <span className="muted">
          {track.album} · {track.releaseYear || 'unknown year'}
        </span>
        <span className="muted">
          {formatDuration(track.durationMs)} · liked {new Date(track.addedAt).toLocaleDateString()}
        </span>
      </div>
    </div>
  );
}

function formatDuration(ms: number): string {
  const total = Math.round(ms / 1000);
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, '0')}`;
}
