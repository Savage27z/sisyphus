import { defineConfig } from 'vite';
import wasm from 'vite-plugin-wasm';

export default defineConfig({
  // Rapier's physics engine ships as a real .wasm file (smaller and faster to start than inlined).
  plugins: [wasm()],
  server: {
    // In dev, the multiplayer server runs separately (npm run server); proxy its socket.
    proxy: {
      '/ws': { target: 'ws://localhost:8787', ws: true },
      '/api': { target: 'http://localhost:8787' },
    },
  },
  build: {
    // Top-level await loads the physics engine before the game code runs.
    target: 'es2022',
    chunkSizeWarningLimit: 2000,
  },
});
