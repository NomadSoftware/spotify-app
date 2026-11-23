export function chunk<T>(arr: T[], size: number): T[][] {
  if (size <= 0) throw new Error('chunk size must be positive');
  const out: T[][] = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

export interface NeglectItem {
  id: string;
  addedAt: string;
}

/** Partial Fisher–Yates: `size` random items (no duplicates), order shuffled. */
export function randomSample<T>(items: readonly T[], size: number, rand: () => number = Math.random): T[] {
  const arr = items.slice();
  const n = Math.min(Math.max(0, size), arr.length);
  for (let i = 0; i < n; i++) {
    const j = i + Math.floor(rand() * (arr.length - i));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr.slice(0, n);
}

/**
 * Least-recently-heard ordering: tracks with no recorded play come first
 * (unknown = assume long unheard), ordered by when they were liked; tracks
 * with recorded plays follow, oldest last-play first.
 */
export function orderByNeglect<T extends NeglectItem>(
  tracks: readonly T[],
  lastPlayedByTrack: ReadonlyMap<string, string>,
): T[] {
  const never = tracks.filter((t) => !lastPlayedByTrack.has(t.id));
  const played = tracks.filter((t) => lastPlayedByTrack.has(t.id));
  never.sort((a, b) => a.addedAt.localeCompare(b.addedAt) || a.id.localeCompare(b.id));
  played.sort(
    (a, b) =>
      (lastPlayedByTrack.get(a.id) ?? '').localeCompare(lastPlayedByTrack.get(b.id) ?? '') ||
      a.addedAt.localeCompare(b.addedAt) ||
      a.id.localeCompare(b.id),
  );
  return [...never, ...played];
}

/**
 * Neglect-first selection: the first half of `size` comes from the
 * `neglectPoolSize` least-recently-heard candidates, the rest from the
 * balance. If the balance runs short, the shortfall is filled from the
 * neglected pool's leftovers so the playlist still reaches `size` (or all
 * candidates, whichever is smaller).
 */
export function selectNeglectFirst<T extends NeglectItem>(
  candidates: readonly T[],
  lastPlayedByTrack: ReadonlyMap<string, string>,
  size: number,
  rand: () => number = Math.random,
  neglectPoolSize = 100,
): { picked: T[]; fromNeglect: number } {
  if (size <= 0 || candidates.length === 0) return { picked: [], fromNeglect: 0 };
  const ordered = orderByNeglect(candidates, lastPlayedByTrack);
  const neglectPool = ordered.slice(0, Math.min(neglectPoolSize, ordered.length));
  const half = Math.round(size / 2);
  const neglectPicked = randomSample(neglectPool, half, rand);
  const taken = new Set(neglectPicked.map((t) => t.id));

  let restPicked = randomSample(
    ordered.slice(neglectPool.length).filter((t) => !taken.has(t.id)),
    size - neglectPicked.length,
    rand,
  );
  if (neglectPicked.length + restPicked.length < size) {
    // Balance ran short — fill from the neglected pool's leftovers.
    const used = new Set([...neglectPicked, ...restPicked].map((t) => t.id));
    restPicked = restPicked.concat(
      randomSample(
        ordered.filter((t) => !used.has(t.id)),
        size - neglectPicked.length - restPicked.length,
        rand,
      ),
    );
  }
  return { picked: [...neglectPicked, ...restPicked], fromNeglect: neglectPicked.length };
}
