import RAPIER from '@dimforge/rapier3d-compat';
import * as THREE from 'three';
import './style.css';
import { createRig, loadAssets } from './assets';
import { CONFIG } from './config';
import { Game } from './game';
import { loadProfile, randomStyle } from './style';

async function boot(): Promise<void> {
  // Just a bar: the downloads fill the first 80%, setting up the rest.
  const fill = document.getElementById('loadFill')!;
  let shown = 0;
  const progress = (f: number) => {
    shown = Math.max(shown, Math.min(1, f));
    fill.style.width = `${(shown * 100).toFixed(1)}%`;
  };
  const canvas = document.getElementById('game') as HTMLCanvasElement;
  const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, powerPreference: 'high-performance' });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 1.75));
  renderer.setSize(window.innerWidth, window.innerHeight);

  const [assets] = await Promise.all([loadAssets((f) => progress(f * 0.8)), RAPIER.init()]);
  const profile = loadProfile();
  progress(0.85);
  const styles = [profile.style];
  for (let i = 0; i < CONFIG.BOT_COUNT; i++) {
    const s = randomStyle();
    // Keep the lobby mixed: a couple of the bots are always the male fighters.
    if (i === 0 || i === 2) s.base = 5 + (i / 2);
    styles.push(s);
  }
  // Different base fighters parse in parallel (image decoding happens off the main thread).
  const rigs = await Promise.all(styles.map((s) => createRig(assets, s)));

  progress(0.93);
  // Let the loading text paint (setTimeout, not rAF, so a background tab still finishes loading).
  await new Promise((r) => setTimeout(r, 0));
  const game = new Game(canvas, renderer, assets, rigs, styles, profile);
  // Compile the shaders behind the loading screen rather than as a stutter on the first frames
  // (capped, in case a driver is slow about it).
  await Promise.race([renderer.compileAsync(game.scene, game.cam.cam).catch(() => {}), new Promise((r) => setTimeout(r, 6000))]);
  progress(1);
  document.getElementById('loading')!.classList.add('hidden');
  game.start();
  // Handy for tuning from the browser console.
  if (import.meta.env.DEV) (window as unknown as { game: Game }).game = game;
}

boot().catch((err: unknown) => {
  console.error(err);
  document.getElementById('loadingText')!.textContent = 'Couldn’t start the game. Refresh the page to try again.';
});
