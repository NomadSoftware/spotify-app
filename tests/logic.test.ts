import assert from 'node:assert/strict';
import { normalizeName, normalizeArtist, findDuplicatePairs } from '../src/lib/duplicates.ts';
import { mergePlays, recentTrackIds, playKey, lastPlayedMap, MAX_ENTRIES } from '../src/lib/historyCore.ts';
import { chunk, randomSample, orderByNeglect, selectNeglectFirst } from '../src/lib/util.ts';
import { mapSavedTrack, type SavedTrackPageItem } from '../src/lib/mapping.ts';
import type { LikedTrack } from '../src/lib/types.ts';

let passed = 0;
function test(name: string, fn: () => void): void {
  try {
    fn();
    passed++;
    console.log(`  ok  ${name}`);
  } catch (err) {
    console.error(`FAIL  ${name}`);
    throw err;
  }
}

function track(partial: Partial<LikedTrack> & { id: string }): LikedTrack {
  return {
    uri: `spotify:track:${partial.id}`,
    name: '',
    artist: 'Artist',
    album: 'Album',
    releaseYear: '2000',
    durationMs: 200_000,
    addedAt: '2026-01-01T00:00:00Z',
    imageUrl: null,
    ...partial,
  };
}

// ---- normalizeName ----

test('strips remaster suffixes after a dash', () => {
  assert.equal(normalizeName('Blinded by the Light - 2011 Remaster'), 'blinded by the light');
  assert.equal(normalizeName('Song Name - Mono / Stereo Version'), 'song name');
});

test('strips bracketed edition markers', () => {
  assert.equal(normalizeName('Song Name (2011 Remastered Version)'), 'song name');
  assert.equal(normalizeName('Song Name [Live]'), 'song name');
  assert.equal(normalizeName('Song Name (feat. Someone)'), 'song name');
});

test('keeps dash suffixes that are not edition markers', () => {
  // "Part II" is a subtitle, not an edition marker — don't cut it.
  assert.equal(normalizeName('A Song - Part II'), 'a song part ii');
});

test('strips chained dash suffixes repeatedly and bare years', () => {
  assert.equal(normalizeName('Song - Live - 2011 Remaster'), 'song');
  assert.equal(normalizeName('Song - 1999'), 'song');
});

test('is accent- and punctuation-insensitive', () => {
  assert.equal(normalizeName('Beyoncé — Héllô!'), 'beyonce hello');
});

test('tracks whose name normalizes to empty are never paired', () => {
  const tracks = [track({ id: 'a', name: '???' }), track({ id: 'b', name: '!!!' })];
  const { near, weak } = findDuplicatePairs(tracks);
  assert.equal(near.length + weak.length, 0);
});

test('a track with unknown (0) duration pairs with any duration of the same song', () => {
  const tracks = [
    track({ id: 'a', name: 'Song', durationMs: 0 }),
    track({ id: 'b', name: 'Song - Remaster', durationMs: 400_000 }),
  ];
  const { near } = findDuplicatePairs(tracks);
  assert.equal(near.length, 1);
  assert.equal(near[0].durationDiffMs, 400_000);
});

// ---- normalizeArtist ----

test('strips featured artists', () => {
  assert.equal(normalizeArtist('Artist A feat. Artist B'), 'artist a');
  assert.equal(normalizeArtist('Artist A ft. B'), 'artist a');
  assert.equal(normalizeArtist('Artist A (with C)'), 'artist a');
});

// ---- findDuplicatePairs ----

test('flags same song on different releases as a near pair', () => {
  const tracks = [
    track({ id: 'a', name: 'Song', album: 'Original Album', releaseYear: '1973', durationMs: 200_000 }),
    track({ id: 'b', name: 'Song - 2011 Remaster', album: 'The Very Best Of', releaseYear: '2011', durationMs: 201_400 }),
  ];
  const { near, weak } = findDuplicatePairs(tracks);
  assert.equal(near.length, 1);
  assert.equal(weak.length, 0);
  assert.equal(near[0].a.id, 'a'); // older release first
  assert.equal(near[0].b.id, 'b');
});

test('does not flag same-name songs with far-apart durations', () => {
  const tracks = [
    track({ id: 'a', name: 'Song', durationMs: 200_000 }),
    track({ id: 'b', name: 'Song (Extended Dance Mix)', durationMs: 400_000 }),
  ];
  const { near } = findDuplicatePairs(tracks, { durationToleranceMs: 5000 });
  assert.equal(near.length, 0);
});

test('respects the duration tolerance option', () => {
  const tracks = [
    track({ id: 'a', name: 'Song', durationMs: 200_000 }),
    track({ id: 'b', name: 'Song - Remaster', durationMs: 208_000 }),
  ];
  assert.equal(findDuplicatePairs(tracks, { durationToleranceMs: 5000 }).near.length, 0);
  assert.equal(findDuplicatePairs(tracks, { durationToleranceMs: 10000 }).near.length, 1);
});

test('flags same song under different artists as weak (compilation case)', () => {
  const tracks = [
    track({ id: 'a', name: 'Song', artist: 'The Who', durationMs: 200_000 }),
    track({ id: 'b', name: 'Song', artist: 'Various Artists', durationMs: 200_500 }),
  ];
  const { near, weak } = findDuplicatePairs(tracks);
  assert.equal(near.length, 0);
  assert.equal(weak.length, 1);
});

test('flags a featured-artist variant as a near pair', () => {
  const tracks = [
    track({ id: 'a', name: 'Song', artist: 'A', durationMs: 200_000 }),
    track({ id: 'b', name: 'Song', artist: 'A feat. B', durationMs: 200_300 }),
  ];
  const { near } = findDuplicatePairs(tracks);
  assert.equal(near.length, 1);
});

test('produces no pairs for a clean library', () => {
  const tracks = [
    track({ id: 'a', name: 'Alpha' }),
    track({ id: 'b', name: 'Beta' }),
    track({ id: 'c', name: 'Alpha', artist: 'Other', durationMs: 100_000 }),
  ];
  const { near, weak } = findDuplicatePairs(tracks);
  assert.equal(near.length + weak.length, 0);
});

// ---- history merge ----

test('mergePlays dedupes by trackId+playedAt and sorts newest first', () => {
  const existing = [
    { trackId: 't1', playedAt: '2026-01-02T10:00:00Z' },
    { trackId: 't2', playedAt: '2026-01-01T10:00:00Z' },
  ];
  const incoming = [
    { trackId: 't1', playedAt: '2026-01-02T10:00:00Z' }, // duplicate
    { trackId: 't3', playedAt: '2026-01-03T09:00:00Z' },
    { trackId: '', playedAt: '2026-01-03T09:00:00Z' }, // invalid, dropped
  ];
  const merged = mergePlays(existing, incoming);
  assert.deepEqual(merged.map((e) => e.trackId), ['t3', 't1', 't2']);
});

test('playKey is stable', () => {
  assert.equal(playKey({ trackId: 'x', playedAt: 'y' }), 'x|y');
});

test('recentTrackIds honors the window', () => {
  const now = Date.parse('2026-01-10T00:00:00Z');
  const entries = [
    { trackId: 'recent', playedAt: '2026-01-09T12:00:00Z' },
    { trackId: 'old', playedAt: '2026-01-01T00:00:00Z' },
    { trackId: 'boundary', playedAt: '2026-01-03T00:00:00Z' }, // exactly at cutoff → included
    { trackId: 'garbage', playedAt: 'not-a-date' }, // unparseable → excluded
  ];
  const ids = recentTrackIds(entries, 7 * 24 * 3600_000, now);
  assert.ok(ids.has('recent'));
  assert.ok(ids.has('boundary'));
  assert.ok(!ids.has('old'));
  assert.ok(!ids.has('garbage'));
});

test('mergePlays caps at MAX_ENTRIES, dropping the oldest entries', () => {
  const base = Date.parse('2020-01-01T00:00:00Z');
  const existing = Array.from({ length: MAX_ENTRIES }, (_, i) => ({
    trackId: `t${i}`,
    playedAt: new Date(base + i * 60_000).toISOString(),
  }));
  const merged = mergePlays(existing, [
    { trackId: 'old', playedAt: '2019-01-01T00:00:00Z' }, // sorts last → sliced off
    { trackId: 'new', playedAt: '2026-12-01T00:00:00Z' }, // sorts first → survives
  ]);
  assert.equal(merged.length, MAX_ENTRIES);
  assert.ok(!merged.some((e) => e.trackId === 'old'));
  assert.equal(merged[0].trackId, 'new');
});

test('mergePlays dedupes repeated entries inside one incoming batch', () => {
  const merged = mergePlays([], [
    { trackId: 't1', playedAt: '2026-01-01T00:00:00Z' },
    { trackId: 't1', playedAt: '2026-01-01T00:00:00Z' }, // duplicate within batch
    { trackId: 't1', playedAt: '2026-01-01T00:00:01Z' },
  ]);
  assert.equal(merged.length, 2);
});

// ---- chunk ----

test('chunk splits into batches', () => {
  assert.deepEqual(chunk([1, 2, 3, 4, 5], 2), [[1, 2], [3, 4], [5]]);
  assert.deepEqual(chunk([], 40), []);
  assert.equal(chunk(new Array(100).fill(0), 40).length, 3);
});

test('chunk rejects non-positive sizes (would loop forever)', () => {
  assert.throws(() => chunk([1, 2], 0), /positive/);
  assert.throws(() => chunk([1, 2], -3), /positive/);
});

// ---- randomSample ----

test('randomSample returns the right count without duplicates', () => {
  const items = [1, 2, 3, 4, 5, 6, 7, 8];
  const picked = randomSample(items, 3, () => 0.3);
  assert.equal(picked.length, 3);
  assert.equal(new Set(picked).size, 3);
  for (const p of picked) assert.ok(items.includes(p));
  assert.equal(randomSample(items, 100, () => 0.5).length, 8); // capped at pool size
  assert.deepEqual(randomSample([], 3), []);
});

// ---- neglect-first selection ----

function negTrack(id: string, addedAt: string) {
  return { id, addedAt };
}

test('orderByNeglect puts never-played (oldest liked) before played (oldest last-play)', () => {
  const tracks = [
    negTrack('recent-like', '2026-11-20'), // never played, liked recently
    negTrack('old-like', '2015-01-01'), // never played, liked long ago
    negTrack('played-a', '2020-01-01'), // played 8 days ago
    negTrack('played-b', '2019-01-01'), // played 9 days ago
  ];
  const lastPlayed = new Map([
    ['played-a', '2026-11-14'],
    ['played-b', '2026-11-13'],
  ]);
  const ordered = orderByNeglect(tracks, lastPlayed);
  assert.deepEqual(ordered.map((t) => t.id), ['old-like', 'recent-like', 'played-b', 'played-a']);
});

test('lastPlayedMap keeps the most recent play per track', () => {
  const map = lastPlayedMap([
    { trackId: 'x', playedAt: '2026-01-01' },
    { trackId: 'x', playedAt: '2026-03-01' },
    { trackId: 'y', playedAt: '2026-02-01' },
  ]);
  assert.equal(map.get('x'), '2026-03-01');
  assert.equal(map.get('y'), '2026-02-01');
  assert.equal(map.size, 2);
});

test('selectNeglectFirst takes half from the neglect pool, half from the balance', () => {
  // 6 candidates, neglect pool of 4 (2 never-played + 2 old plays), 2 recent plays.
  const candidates = [
    negTrack('n-old', '2015-01-01'),
    negTrack('n-new', '2026-11-20'),
    negTrack('p-9d', '2019-01-01'),
    negTrack('p-8d', '2020-01-01'),
    negTrack('p-7.5d', '2021-01-01'),
    negTrack('p-7.2d', '2022-01-01'),
  ];
  const lastPlayed = new Map([
    ['p-9d', '2026-11-13'],
    ['p-8d', '2026-11-14'],
    ['p-7.5d', '2026-11-15'],
    ['p-7.2d', '2026-11-16'],
  ]);
  // rand() = 0 always → samples take pool items in order.
  const { picked, fromNeglect } = selectNeglectFirst(candidates, lastPlayed, 4, () => 0, 4);
  assert.equal(picked.length, 4);
  assert.equal(fromNeglect, 2);
  assert.deepEqual(picked.slice(0, 2).map((t) => t.id), ['n-old', 'n-new']); // neglect half
  assert.deepEqual(picked.slice(2).map((t) => t.id), ['p-7.5d', 'p-7.2d']); // balance = beyond the pool
  assert.equal(new Set(picked).size, 4); // no duplicates
});

test('selectNeglectFirst fills from the neglected pool when the balance runs short', () => {
  const candidates = [
    negTrack('a', '2015-01-01'),
    negTrack('b', '2016-01-01'),
    negTrack('c', '2017-01-01'),
    negTrack('d', '2018-01-01'),
  ]; // neglect pool of 4 = all candidates → balance empty → shortfall fill runs
  const { picked, fromNeglect } = selectNeglectFirst(candidates, new Map(), 4, () => 0, 4);
  assert.equal(picked.length, 4);
  assert.equal(new Set(picked).size, 4);
  assert.equal(fromNeglect, 2); // 2 direct + 2 filled, still reported as 2
});

test('selectNeglectFirst with size larger than candidates returns all candidates', () => {
  const candidates = [negTrack('a', '2020-01-01'), negTrack('b', '2021-01-01')];
  const { picked } = selectNeglectFirst(candidates, new Map(), 50, () => 0.5, 100);
  assert.equal(picked.length, 2);
});

test('selectNeglectFirst with zero or negative size returns empty', () => {
  const c = [negTrack('a', '2020-01-01')];
  assert.deepEqual(selectNeglectFirst(c, new Map(), 0).picked, []);
  assert.deepEqual(selectNeglectFirst(c, new Map(), -3).picked, []);
  assert.equal(selectNeglectFirst(c, new Map(), -3).fromNeglect, 0);
});

test('randomSample returns empty for zero or negative size', () => {
  assert.deepEqual(randomSample([1, 2, 3], 0), []);
  assert.deepEqual(randomSample([1, 2, 3], -1), []);
});

// ---- mapSavedTrack (pure wire→domain mapper) ----

function savedItem(partial: Partial<SavedTrackPageItem['track']> = {}): SavedTrackPageItem {
  return {
    added_at: '2026-01-01T00:00:00Z',
    track: {
      id: 'x',
      uri: 'spotify:track:x',
      name: 'Song',
      is_local: false,
      album: { name: 'Album', release_date: '2020-03-05', images: [{ url: 'big.jpg' }] },
      artists: [{ name: 'A' }],
      duration_ms: 200_000,
      ...partial,
    },
  };
}

test('mapSavedTrack drops local files and id-less entries', () => {
  assert.equal(mapSavedTrack(savedItem({ id: null })), null);
  assert.equal(mapSavedTrack(savedItem({ is_local: true })), null);
});

test('mapSavedTrack maps missing artist/images/release date defensively', () => {
  const t = mapSavedTrack(savedItem({ artists: [], album: { name: 'A', release_date: '', images: [] } }));
  assert.ok(t);
  assert.equal(t.artist, '');
  assert.equal(t.imageUrl, null);
  assert.equal(t.releaseYear, '');
  assert.equal(t.uri, 'spotify:track:x');
});

test('mapSavedTrack takes the largest image and trims the release year', () => {
  const t = mapSavedTrack(
    savedItem({ album: { name: 'A', release_date: '1999-12-31', images: [{ url: 'big' }, { url: 'small' }] } }),
  );
  assert.ok(t);
  assert.equal(t.imageUrl, 'big');
  assert.equal(t.releaseYear, '1999');
});

console.log(`\n${passed} tests passed`);
