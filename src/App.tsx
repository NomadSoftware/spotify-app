import { useCallback, useEffect, useState } from 'react';
import { beginLogin, handleCallbackIfPresent, hasClientId, logout, NotAuthenticatedError } from './lib/auth';
import { fetchProfile } from './lib/tracks';
import { startHistoryPolling } from './lib/history';
import { isLocalhost } from './lib/config';
import type { SpotifyProfile } from './lib/types';
import DuplicateFinder from './components/DuplicateFinder';
import PlaylistMaintainer from './components/PlaylistMaintainer';
import HistoryView from './components/HistoryView';

type Phase = 'checking' | 'login' | 'ready';
type Tab = 'duplicates' | 'playlist' | 'history';

export default function App() {
  const [phase, setPhase] = useState<Phase>('checking');
  const [fatal, setFatal] = useState<string | null>(null);
  const [profile, setProfile] = useState<SpotifyProfile | null>(null);
  const [tab, setTab] = useState<Tab>('duplicates');
  const [pollError, setPollError] = useState<string | null>(null);

  // Startup check, callable again from the UI: a transient failure (offline,
  // 5xx) is NOT the same as being logged out — only NotAuthenticatedError
  // sends the user to the login screen.
  const init = useCallback(async () => {
    setFatal(null);
    setPhase('checking');
    if (!hasClientId()) {
      setFatal(
        'VITE_SPOTIFY_CLIENT_ID is missing. Copy .env.local.example to .env.local, add your Client ID from the Spotify dashboard, and restart the dev server.',
      );
      setPhase('login');
      return;
    }
    try {
      await handleCallbackIfPresent();
      await fetchProfile();
      setPhase('ready');
    } catch (err) {
      if (err instanceof NotAuthenticatedError) {
        setPhase('login');
      } else {
        setFatal(err instanceof Error ? err.message : String(err));
        setPhase('login');
      }
    }
  }, []);

  useEffect(() => {
    void init();
  }, [init]);

  useEffect(() => {
    if (phase !== 'ready') return;
    fetchProfile()
      .then(setProfile)
      .catch((err) => {
        console.error('[app] profile load failed — header name hidden', err);
        setProfile(null);
      });
  }, [phase]);

  // History accumulation runs at app level, on every tab — not just while the
  // history view is mounted. Failures surface as a banner (a dead session
  // would otherwise silently stop history recording forever).
  useEffect(() => {
    if (phase !== 'ready') return;
    return startHistoryPolling(
      () => setPollError(null),
      (err) => setPollError(`Play-history sync failed: ${err.message} — history is not being recorded.`),
    );
  }, [phase]);

  if (phase !== 'ready') {
    return (
      <main className="center-screen">
        <div className="card login-card">
          <h1>🎧 Spotify Personal Tools</h1>
          {fatal ? (
            <>
              <p className="error">{fatal}</p>
              <div className="row gap center">
                <button className="btn" onClick={() => void init()}>
                  Try again
                </button>
                <button className="btn btn-ghost" onClick={() => beginLogin().catch((e) => setFatal(e.message))}>
                  Log in with Spotify
                </button>
              </div>
            </>
          ) : phase === 'checking' ? (
            <p className="muted">Checking session…</p>
          ) : (
            <>
              <p className="muted">
                A personal toolbox for your library: find duplicate liked songs and keep a playlist of
                songs you haven't heard lately.
              </p>
              <button className="btn btn-primary" onClick={() => beginLogin().catch((e) => setFatal(e.message))}>
                Log in with Spotify
              </button>
            </>
          )}
        </div>
      </main>
    );
  }

  return (
    <div className="app">
      <header className="header">
        <div className="header-row">
          <h1 className="title">🎧 Spotify Personal Tools</h1>
          <div className="spacer" />
          {profile?.display_name && <span className="muted">{profile.display_name}</span>}
          <button
            className="btn btn-ghost"
            onClick={() => {
              logout();
              location.assign('/');
            }}
          >
            Log out
          </button>
        </div>
        <nav className="tabs">
          {(
            [
              ['duplicates', 'Duplicate finder'],
              ['playlist', 'Not recently played'],
              ['history', 'Play history'],
            ] as [Tab, string][]
          ).map(([id, label]) => (
            <button
              key={id}
              className={`tab ${tab === id ? 'tab-active' : ''}`}
              onClick={() => setTab(id)}
            >
              {label}
            </button>
          ))}
        </nav>
      </header>
      {isLocalhost() && (
        <p className="warning">
          You opened this app via <code>localhost</code>. Spotify requires <code>127.0.0.1</code> —
          open <a href="http://127.0.0.1:5173/">http://127.0.0.1:5173/</a> instead.
        </p>
      )}
      {pollError && (
        <p className="warning">
          ⚠ {pollError} If this persists, log out and back in.
        </p>
      )}
      <main className="content">
        {tab === 'duplicates' && <DuplicateFinder />}
        {tab === 'playlist' && <PlaylistMaintainer />}
        {tab === 'history' && <HistoryView />}
      </main>
    </div>
  );
}
