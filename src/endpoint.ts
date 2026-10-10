/**
 * Where the multiplayer server lives. Set VITE_GAME_SERVER when building (for example
 * https://sisyphus-server.up.railway.app) if the game is hosted somewhere that can't run it,
 * like a static host; otherwise the site that served the game is the server too.
 */
const BASE = String(import.meta.env.VITE_GAME_SERVER ?? '').replace(/\/+$/, '');

export const apiUrl = (path: string): string => BASE + path;

export function socketUrl(): string {
  if (BASE) return `${BASE.replace(/^http/, 'ws')}/ws`;
  return `${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/ws`;
}
