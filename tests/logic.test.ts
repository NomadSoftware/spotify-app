import assert from 'node:assert/strict';
import { normalizeName, normalizeArtist, findDuplicatePairs } from '../src/lib/duplicates.ts';
import { mergePlays, recentTrackIds, playKey } from '../src/lib/historyCore.ts';
import { chunk } from '../src/lib/util.ts';
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
  // "Stop The World I Wanna Get Off With You" is a real subtitle, not an edition.
  assert.equal(normalizeName('A Song - Part II'), 'a song part ii');
});

test('is accent- and punctuation-insensitive', () => {
  assert.equal(normalizeName('Beyoncé — Héllô!'), 'beyonce hello');
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
  ];
  const ids = recentTrackIds(entries, 7 * 24 * 3600_000, now);
  assert.ok(ids.has('recent'));
  assert.ok(!ids.has('old'));
});

// ---- chunk ----

test('chunk splits into batches', () => {
  assert.deepEqual(chunk([1, 2, 3, 4, 5], 2), [[1, 2], [3, 4], [5]]);
  assert.deepEqual(chunk([], 40), []);
  assert.equal(chunk(new Array(100).fill(0), 40).length, 3);
});

console.log(`\n${passed} tests passed`);
