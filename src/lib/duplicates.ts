import type { DupPair, LikedTrack } from './types';

/**
 * Duplicate detection for liked songs.
 *
 * Real-world duplicates are the same recording across album releases: the
 * original, a remaster ("Song - 2011 Remaster"), a compilation appearance, a
 * "deluxe edition" copy, or a version whose featured artist differs. We
 * normalize names to collapse edition markers, group by normalized
 * name + artist, and flag pairs whose durations are within a few seconds.
 */

const RE_BRACKETS = /[([{][^)\]}]*[)\]}]/g;
// Words that mark an edition/version suffix rather than part of the title.
const RE_EDITION_WORD =
  /\b(remaster|remastered|anniversary|deluxe|expanded|bonus|mono|stereo|remix|remixed|edit|single|version|live|acoustic|instrumental|radio|extended|high|resolution)\b/;

export function normalizeName(raw: string): string {
  let s = raw.toLowerCase();
  s = s.replace(RE_BRACKETS, ' ');
  // Cut trailing " - something" when the something looks like an edition
  // marker (e.g. "- 2011 Remaster", "- Mono Version"), repeatedly.
  for (;;) {
    const m = s.match(/^(.*?)\s+[-–]\s+(\S.*)$/);
    if (!m) break;
    if (RE_EDITION_WORD.test(m[2]) || /\b(19|20)\d{2}\b/.test(m[2])) s = m[1];
    else break;
  }
  s = s.normalize('NFKD').replace(/[\u0300-\u036f]/g, '');
  s = s.replace(/[^\p{L}\p{N}]+/gu, ' ');
  return s.trim();
}

export function normalizeArtist(raw: string): string {
  let s = raw.toLowerCase();
  s = s.replace(RE_BRACKETS, ' ');
  s = s.replace(/\s*(?:feat\.?|ft\.?|featuring|with)\s+.*$/, ' ');
  s = s.normalize('NFKD').replace(/[\u0300-\u036f]/g, '');
  s = s.replace(/[^\p{L}\p{N}]+/gu, ' ');
  return s.trim();
}

export interface FindOptions {
  /** Max duration difference for two versions to be considered the same recording. */
  durationToleranceMs?: number;
}

interface Group {
  key: string;
  tracks: LikedTrack[];
}

function groupBy(tracks: LikedTrack[], keyOf: (t: LikedTrack) => string): Group[] {
  const map = new Map<string, LikedTrack[]>();
  for (const t of tracks) {
    const key = keyOf(t);
    if (!key) continue;
    const list = map.get(key);
    if (list) list.push(t);
    else map.set(key, [t]);
  }
  return Array.from(map, ([key, groupTracks]) => ({ key, tracks: groupTracks }));
}

function pairKey(t: LikedTrack): string {
  return `${t.id}`;
}

function pairsWithin(
  tracks: LikedTrack[],
  kind: DupPair['kind'],
  toleranceMs: number,
): DupPair[] {
  const pairs: DupPair[] = [];
  for (let i = 0; i < tracks.length; i++) {
    for (let j = i + 1; j < tracks.length; j++) {
      const a = tracks[i];
      const b = tracks[j];
      if (pairKey(a) === pairKey(b)) continue;
      const diff = Math.abs(a.durationMs - b.durationMs);
      if (a.durationMs > 0 && b.durationMs > 0 && diff > toleranceMs) continue;
      // Order the pair by release year so "A" is the original and "B" the re-release.
      const [first, second] = orderPair(a, b);
      pairs.push({ kind, a: first, b: second, durationDiffMs: diff });
    }
  }
  return pairs;
}

function orderPair(a: LikedTrack, b: LikedTrack): [LikedTrack, LikedTrack] {
  const cmp =
    a.releaseYear.localeCompare(b.releaseYear) ||
    a.album.localeCompare(b.album) ||
    a.addedAt.localeCompare(b.addedAt);
  return cmp <= 0 ? [a, b] : [b, a];
}

export function findDuplicatePairs(
  tracks: LikedTrack[],
  opts: FindOptions = {},
): { near: DupPair[]; weak: DupPair[] } {
  const tolerance = opts.durationToleranceMs ?? 5000;

  // A name that normalizes to empty carries no song identity — exclude such
  // tracks up front so they can't form false groups in either tier.
  const usable = tracks.filter((t) => normalizeName(t.name) !== '');

  // Tier 1: same song + same primary artist.
  const near: DupPair[] = [];
  for (const group of groupBy(usable, (t) => `${normalizeName(t.name)}||${normalizeArtist(t.artist)}`)) {
    if (group.tracks.length < 2) continue;
    near.push(...pairsWithin(group.tracks, 'near', tolerance));
  }

  // Tier 2 (low confidence): same song name + similar duration but different
  // primary artist — catches "Various Artists" compilations. Scans all tracks
  // so a track already paired in tier 1 can still pair up across artists here.
  const weak: DupPair[] = [];
  for (const group of groupBy(usable, (t) => normalizeName(t.name))) {
    if (group.tracks.length < 2) continue;
    for (const pair of pairsWithin(group.tracks, 'weak', tolerance)) {
      if (normalizeArtist(pair.a.artist) !== normalizeArtist(pair.b.artist)) weak.push(pair);
    }
  }

  near.sort(byPair);
  weak.sort(byPair);
  return { near, weak };
}

function byPair(p1: DupPair, p2: DupPair): number {
  return (
    p1.a.name.localeCompare(p2.a.name) ||
    p1.a.artist.localeCompare(p2.a.artist) ||
    p1.b.name.localeCompare(p2.b.name)
  );
}
