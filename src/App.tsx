import { useEffect, useState } from 'react';
import { beginLogin, handleCallbackIfPresent, hasClientId, logout } from './lib/auth';
import { fetchProfile } from './lib/tracks';
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

  useEffect(() => {
    (async () => {
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
        if (err instanceof Error && err.message === 'Not logged in.') {
          setPhase('login');
        } else {
          setFatal(err instanceof Error ? err.message : String(err));
          setPhase('login');
        }
      }
    })();
  }, []);

  useEffect(() => {
    if (phase !== 'ready') return;
    fetchProfile().then(setProfile).catch(() => setProfile(null));
  }, [phase]);

  if (phase !== 'ready') {
    return (
      <main className="center-screen">
        <div className="card login-card">
          <h1>🎧 Spotify Personal Tools</h1>
          {fatal ? (
            <>
              <p className="error">{fatal}</p>
              <button className="btn" onClick={() => beginLogin().catch((e) => setFatal(e.message))}>
                Retry login
              </button>
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
      <main className="content">
        {tab === 'duplicates' && <DuplicateFinder />}
        {tab === 'playlist' && <PlaylistMaintainer />}
        {tab === 'history' && <HistoryView />}
      </main>
    </div>
  );
}
