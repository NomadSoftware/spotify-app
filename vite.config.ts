import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  // Spotify requires 127.0.0.1 (not localhost) for dev redirect URIs, so bind
  // IPv4 loopback explicitly — otherwise Vite may listen on ::1 only.
  server: { host: '127.0.0.1' },
  preview: { host: '127.0.0.1' },
});
