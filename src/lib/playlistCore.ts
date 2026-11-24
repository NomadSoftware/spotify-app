// Pure decision logic for finding the playlist this app manages. No browser
// or network access, so it runs in plain Node (tests/logic.test.ts).

/** Written into every playlist this app creates. Also how the app recognizes
 *  its own playlist when the stored id is gone: Spotify's playlist listing
 *  does not reliably return app-created playlists, so name alone is not
 *  enough to know a playlist is safe to overwrite. */
export const MANAGED_DESCRIPTION =
  'Kept fresh by Spotify Personal Tools — songs I have not heard recently.';

// localStorage: { [spotifyUserId]: playlistId }. Keyed by user so a second
// account on the same browser can't inherit it; kept across logout.
export const PLAYLIST_REGISTRY_KEY = 'sp.playlistIds';

export interface PlaylistCandidate {
  id: string;
  name: string;
  description: string;
  ownerId: string | null;
  url: string;
  trackTotal: number | null;
}

export interface ManagedPlaylist {
  id: string;
  name: string;
  url: string;
}

export type UnresolvedReason = 'ambiguous' | 'unmanaged' | 'none';

export type Resolution =
  | { kind: 'resolved'; playlist: ManagedPlaylist }
  | { kind: 'ambiguous'; candidates: PlaylistCandidate[] }
  | { kind: 'unmanaged'; candidates: PlaylistCandidate[] }
  | { kind: 'none' };

const BARE_SPOTIFY_ID = /^[A-Za-z0-9]{22}$/;

/** Playlist id from a Spotify link, a `spotify:playlist:` URI, or a bare id. */
export function parsePlaylistRef(input: string): string | null {
  const s = input.trim();
  if (!s) return null;
  const uri = /^spotify:playlist:([A-Za-z0-9]+)$/i.exec(s);
  if (uri) return uri[1];
  // Tolerates locale prefixes (/intl-de/playlist/…) and ?si=… share params.
  const path = /\/playlist\/([A-Za-z0-9]+)(?![A-Za-z0-9])/.exec(s);
  if (path) return path[1];
  return BARE_SPOTIFY_ID.test(s) ? s : null;
}

/**
 * Decide what to do with the user's playlists named `name`.
 *
 * Only a playlist this app created (same name and the managed description) is
 * adopted without asking, and only when it is the only one. So the app never
 * overwrites a playlist it didn't create, and never guesses between leftovers
 * from earlier duplicates.
 */
export function decidePlaylist(
  found: readonly PlaylistCandidate[],
  name: string,
  userId: string,
): Resolution {
  const matching = dedupeById(found.filter((c) => c.ownerId === userId && c.name === name));
  const managed = matching.filter((c) => c.description.trim() === MANAGED_DESCRIPTION);

  if (managed.length === 1) {
    const c = managed[0];
    return { kind: 'resolved', playlist: { id: c.id, name: c.name, url: c.url } };
  }
  if (managed.length > 1) return { kind: 'ambiguous', candidates: managed };
  if (matching.length > 0) return { kind: 'unmanaged', candidates: matching };
  return { kind: 'none' };
}

function dedupeById(candidates: readonly PlaylistCandidate[]): PlaylistCandidate[] {
  const seen = new Set<string>();
  return candidates.filter((c) => {
    if (seen.has(c.id)) return false;
    seen.add(c.id);
    return true;
  });
}
