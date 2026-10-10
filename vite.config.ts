import { defineConfig } from 'vite';

export default defineConfig({
  server: {
    // In dev, the multiplayer server runs separately (npm run server); proxy its socket.
    proxy: {
      '/ws': { target: 'ws://localhost:8787', ws: true },
      '/api': { target: 'http://localhost:8787' },
    },
  },
  build: {
    // The main chunk carries Rapier's inlined WebAssembly (~2 MB gzipped); that's expected.
    chunkSizeWarningLimit: 6000,
  },
});
