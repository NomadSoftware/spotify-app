export interface TokenSet {
  access_token: string;
  refresh_token?: string;
  expires_at: number;
  scope?: string;
}

/** Minimal track shape we keep around — small enough for localStorage caching. */
export interface LikedTrack {
  id: string;
  uri: string;
  name: string;
  artist: string;
  album: string;
  releaseYear: string;
  durationMs: number;
  addedAt: string;
  imageUrl: string | null;
}

export interface DupPair {
  kind: 'near' | 'weak';
  a: LikedTrack;
  b: LikedTrack;
  durationDiffMs: number;
}

export interface PlayEntry {
  trackId: string;
  playedAt: string; // ISO timestamp
}

export interface SpotifyProfile {
  id: string;
  display_name: string | null;
}
