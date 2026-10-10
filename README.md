# SISYPHUS

A browser party game for up to 24 players: race to the top of the map, grab the flag and hold it for 3 seconds while everyone else tries to blast you off. Four maps (Mount Olympus, The Tower, Construction Site, Haunted Hotel), public prize rounds, friend rooms with invite links, practice against bots, keyboard/mouse or controller.

Built with Vite, TypeScript, three.js, Rapier physics and three-vrm. The design doc is in [docs/GAME_DESIGN.md](docs/GAME_DESIGN.md).

## Run it

```bash
npm install
npm run server   # game server on :8787
npm run dev      # the game on http://localhost:5173
```

Production: `npm start` builds the game and serves it, the WebSocket and the stats API from one Node process. Server settings are environment variables (see the top of `server/index.mjs`).
