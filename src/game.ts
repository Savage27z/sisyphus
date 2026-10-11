import RAPIER from '@dimforge/rapier3d';
import { VRMUtils } from '@pixiv/three-vrm';
import * as THREE from 'three';
import { Airdrops } from './airdrop';
import { createRig, type Assets } from './assets';
import { Sfx } from './audio';
import { Bot, type BotSkill } from './bots';
import { ThirdPersonCamera } from './camera';
import { Character } from './character';
import { Claims } from './claim';
import type { Arena, MapId } from './arena';
import { buildCity, type Backdrop } from './city';
import { createMap, mapInfo, nextMap } from './maps';
import { Combat } from './combat';
import { CONFIG, floorOf } from './config';
import { Director } from './director';
import { Flag } from './flag';
import { Fx } from './fx';
import { PadNav } from './gamepad';
import { goLandscape, TouchControls } from './touch';
import { Home } from './home';
import { Hud } from './hud';
import { Input } from './input';
import { Lobby } from './lobby';
import { Locker } from './locker';
import { money, ORDINAL } from './money';
import { Net, type RosterEntry } from './net';
import { PlayerController } from './player';
import { loadRecords, loadSettings, saveRecords, saveSettings, type Records, type Settings } from './prefs';
import type { AnimeRig } from './rig';
import { applyStyle, BASES, MALE_BASES, mulberry32, randomStyle, resolveStyle, saveProfile, type Profile, type Style } from './style';
import { Traps } from './traps';

type GameState = 'menu' | 'locker' | 'lobby' | 'playing' | 'paused' | 'over';
export type Mode = 'demo' | 'offline' | 'online';

const STEP = 1 / 60;
const MAX_FULL = 4; // fighters drawn with hair physics, face, outlines and shadows
const MAX_LITE = 4; // fighters drawn as plain animated models
const SEND_EVERY = 3; // fixed steps between state packets (20 Hz)
const INTERP_DELAY = 110; // ms of buffering for remote fighters
const GIRL_NAMES = ['Hana', 'Yuki', 'Mio', 'Rin', 'Aiko', 'Sakura', 'Nana'];
const BOY_NAMES = ['Kaito', 'Ren', 'Haru', 'Sora', 'Riku', 'Daichi', 'Kumo'];
const COLORS = [0x3ec1ff, 0xff6f91, 0xffc23d, 0x6fdc8c, 0xb08cff, 0xff8a3d, 0x4fe0c8, 0xf2f2f2, 0xd9a066, 0x8fa8ff, 0xd9ff5c];
const RAY_DOWN = { x: 0, y: -1, z: 0 };
/** Indices into style.ts BASES that are the male fighters. */

/** The server's word on how a public/friends round ended. */
interface RoundResult {
  who: string | null;
  reason: 'flag' | 'time';
  winnerName: string | null;
  bot: boolean;
  prizeRound: boolean;
  prize: number;
  currency: string;
  disqualified: boolean;
  /** Paid places in a prize round, in finishing order. */
  places?: { place: number; name: string; share: number; label: string }[];
}

function prizeLine(r: RoundResult): string {
  if (!r.prizeRound) return '';
  const places = r.places ?? [];
  const flagged = r.disqualified ? ' The winner was flagged for impossible movement, so the prize skipped them.' : '';
  if (!places.length) return `No real player finished in a paid place, so the ${money(r.prize, r.currency)} pot wasn't won.${flagged}`;
  return `Prizes: ${places.map((p) => `${ORDINAL[p.place - 1]} ${p.name} ${p.label}`).join(' · ')}.${flagged}`;
}

interface RosterSpec {
  netId: string;
  name: string;
  color: number;
  style: Style;
  /** Simulated on this machine (our player, or bots when we host / play offline). */
  local: boolean;
  bot: boolean;
  spawn: number;
}

const styleKey = (s: Style) => `${s.base}.${s.hair}.${s.outfit}.${s.eyes}.${s.hat}`;
const randomSkill = (): BotSkill => ({ speed: 0.8 + Math.random() * 0.14, aggression: 0.25 + Math.random() * 0.35, reflex: 0.3 + Math.random() * 0.5 });

export class Game {
  readonly scene = new THREE.Scene();
  readonly world: RAPIER.World;
  readonly input: Input;
  readonly padNav: PadNav;
  touch!: TouchControls;
  /** Fighters drawn in full / as plain models (fewer with low graphics). */
  /** Size the game is drawn at: the screen, or the screen turned sideways (see updateRotation). */
  viewW = window.innerWidth;
  viewH = window.innerHeight;
  private maxFull = MAX_FULL;
  private maxLite = MAX_LITE;
  private graphicsLow: boolean | null = null;
  readonly sfx = new Sfx();
  readonly fx: Fx;
  readonly hud: Hud;
  readonly cam: ThirdPersonCamera;
  /** The current map (any of them: the name is from when there was only the tower). */
  tower: Arena;
  readonly combat: Combat;
  readonly traps: Traps;
  readonly airdrops: Airdrops;
  readonly flag: Flag;
  readonly net = new Net();
  readonly characters: Character[] = [];
  readonly bots: Bot[] = [];
  readonly charByCollider = new Map<number, Character>();
  readonly charByNet = new Map<string, Character>();
  readonly player: Character;
  readonly playerCtl: PlayerController;
  private readonly locker: Locker;
  private readonly director: Director;
  readonly home: Home;
  readonly claims: Claims;
  readonly lobby: Lobby;
  settings: Settings;
  records: Records;
  mode: Mode = 'demo';
  /** The bot brain that drives your fighter in the home-page demo. */
  private demoBot: Bot;
  private roundBestFloor = 0;
  private roundBiggestFall = 0;
  private readonly sun: THREE.DirectionalLight;
  private readonly hemi: THREE.HemisphereLight;
  private readonly backdrop: Backdrop;
  private playerRig: AnimeRig;
  private readonly rigCache = new Map<string, AnimeRig[]>();
  private prefetching: Promise<void> = Promise.resolve();
  /** Styles of the offline bots, so we can rebuild the local roster after an online match. */
  private readonly offlineStyles: Style[];
  private rosterIsLocal = true;
  private nextCharId = 0;

  time = 0;
  state: GameState = 'menu';
  /** Online: server time (ms) at which the match clock reads 0. */
  private matchAt = 0;
  private stepCount = 0;
  private lastCountdown = -1;
  private demoEndAt = -1;
  private acc = 0;
  private last = performance.now();
  private realTime = 0;
  private hadLock = false;
  private stats = { timesKnocked: 0, floorsLost: 0, floorsCaused: 0, biggest: { name: '-', floors: 0 } };

  constructor(
    canvas: HTMLCanvasElement,
    readonly renderer: THREE.WebGLRenderer,
    readonly assets: Assets,
    rigs: AnimeRig[],
    styles: Style[],
    readonly profile: Profile,
  ) {
    renderer.shadowMap.enabled = true;
    renderer.shadowMap.type = THREE.PCFShadowMap;
    renderer.toneMapping = THREE.NeutralToneMapping;
    renderer.toneMappingExposure = 1.05;

    // Anime lighting: bright sky fill + one warm key light. Everything is cel-shaded, so no
    // environment map (prefiltering one costs seconds of shader compiling on Windows).
    this.scene.fog = new THREE.Fog(0xdfeaf5, 140, 720);
    this.hemi = new THREE.HemisphereLight(0xeaf4ff, 0xc9b8a6, 1.9);
    this.scene.add(this.hemi);
    this.sun = this.addSun();
    this.backdrop = buildCity(this.scene);

    this.world = new RAPIER.World({ x: 0, y: 0, z: 0 });
    this.world.timestep = STEP;
    this.input = new Input(canvas);
    this.padNav = new PadNav(this);
    this.fx = new Fx(this.scene);
    this.hud = new Hud(this);
    this.cam = new ThirdPersonCamera(window.innerWidth / window.innerHeight);
    this.cam.dist = 5;
    this.tower = createMap('tower', this);
    this.backdrop.apply(this.tower.ambience, this.scene.fog as THREE.Fog, this.hemi, this.sun);
    this.combat = new Combat(this);
    this.traps = new Traps(this);
    this.airdrops = new Airdrops(this);
    this.flag = new Flag(this);

    // Your fighter persists across rounds and modes; everyone else is a roster entry.
    this.playerRig = rigs[0];
    this.player = this.makeCharacter(profile.name, COLORS[0], true, rigs[0]);
    this.offlineStyles = styles.slice(1);
    rigs.slice(1).forEach((r, i) => this.returnRig(styles[i + 1], r));
    this.buildRosterSync(this.offlineSpecs());
    this.demoBot = new Bot(this.player, randomSkill(), this);

    this.playerCtl = new PlayerController(this);
    this.touch = new TouchControls(this);
    this.locker = new Locker(this);
    this.director = new Director(this);
    this.settings = loadSettings();
    this.records = loadRecords();
    this.applySettings();
    this.claims = new Claims();
    this.claims.onChange = () => this.syncClaimButtons();
    this.home = new Home(this);
    this.lobby = new Lobby(this);
    for (const id of ['endClaim', 'arenaClaim']) document.getElementById(id)!.addEventListener('click', () => this.claims.open());
    this.syncClaimButtons();

    window.addEventListener('resize', () => this.updateRotation());
    document.addEventListener('pointerlockchange', () => {
      if (this.input.locked) this.hadLock = true;
      // Losing the mouse pauses, unless a finger took over (touch screens drop the lock on purpose).
      else if (this.state === 'playing' && this.hadLock && !this.touch.active) this.pause();
    });
    this.wireMenus();
    this.wireNet();
    this.startDemo();
  }

  // ------------------------------------------------------------------ roster

  private makeCharacter(name: string, color: number, isPlayer: boolean, rig: AnimeRig): Character {
    const c = new Character(this, this.nextCharId++, name, color, isPlayer, this.tower.spawnPoints[0], rig);
    this.characters.push(c);
    this.charByCollider.set(c.collider.handle, c);
    return c;
  }

  private returnRig(style: Style, rig: AnimeRig): void {
    const k = styleKey(style);
    const list = this.rigCache.get(k) ?? [];
    list.push(rig);
    this.rigCache.set(k, list);
  }

  /** A spare rig for this look: an exact match, or one of the same base fighter re-dressed (no VRM re-parse). */
  private takeCachedRig(style: Style): AnimeRig | null {
    const exact = this.rigCache.get(styleKey(style))?.pop();
    if (exact) return exact;
    for (const list of this.rigCache.values()) {
      const rig = list[list.length - 1];
      if (!rig || rig.base !== style.base) continue;
      list.pop();
      applyStyle(rig.vrm, style, rig.headSocket);
      return rig;
    }
    return null;
  }

  /** Online: keep one spare of every base fighter so bots in any look can be dressed without a re-parse. */
  warmRigPool(): void {
    this.prefetchRigs(BASES.map((_, base) => ({ base, hair: 0, outfit: 0, eyes: 0, hat: 0 })));
  }

  /** Online lobby: parse the fighters other players picked before the round starts. */
  prefetchRigs(styles: Style[]): void {
    this.prefetching = this.prefetching.then(async () => {
      const have = new Map<number, number>();
      const count = (b: number) => have.set(b, (have.get(b) ?? 0) + 1);
      for (const list of this.rigCache.values()) for (const r of list) count(r.base);
      for (const c of this.characters) if (c !== this.player) count(c.style.base);
      for (const s of styles) {
        const n = have.get(s.base) ?? 0;
        if (n > 0) {
          have.set(s.base, n - 1);
          continue;
        }
        this.returnRig(s, await createRig(this.assets, s));
      }
    }).catch(() => undefined);
  }

  private botName(style: Style, used: Set<string>, seed = Math.random() * 1e9): string {
    const pool = MALE_BASES.includes(style.base) ? BOY_NAMES : GIRL_NAMES;
    for (let i = 0; i < pool.length; i++) {
      const n = pool[(Math.floor(seed) + i) % pool.length];
      if (!used.has(n)) {
        used.add(n);
        return n;
      }
    }
    return pool[Math.floor(seed) % pool.length];
  }

  private offlineSpecs(): RosterSpec[] {
    const used = new Set<string>();
    return this.offlineStyles.map((style, i) => ({
      netId: `b:${i + 1}`,
      name: this.botName(style, used, i * 7 + style.base),
      color: COLORS[(i + 1) % COLORS.length],
      style,
      local: true,
      bot: true,
      spawn: i + 1,
    }));
  }

  private clearRoster(): void {
    for (const c of [...this.characters]) {
      if (c === this.player) continue;
      this.charByCollider.delete(c.collider.handle);
      this.returnRig(c.style, c.dispose());
    }
    this.characters.length = 0;
    this.characters.push(this.player);
    this.bots.length = 0;
    this.charByNet.clear();
  }

  private addFromSpec(spec: RosterSpec, rig: AnimeRig): void {
    const c = this.makeCharacter(spec.name, spec.color, false, rig);
    c.style = spec.style;
    c.netId = spec.netId;
    c.remote = !spec.local;
    c.spawnIndex = spec.spawn;
    this.charByNet.set(spec.netId, c);
    if (spec.local && spec.bot) this.bots.push(new Bot(c, randomSkill(), this));
  }

  /** Offline roster from rigs we already have. */
  private buildRosterSync(specs: RosterSpec[]): void {
    this.clearRoster();
    this.player.netId = 'p:local';
    this.player.spawnIndex = 0;
    this.charByNet.set(this.player.netId, this.player);
    for (const spec of specs) {
      const rig = this.takeCachedRig(spec.style);
      if (rig) this.addFromSpec(spec, rig);
    }
    this.rosterIsLocal = true;
  }

  private async buildRoster(specs: RosterSpec[], playerNetId: string, playerSpawn: number): Promise<void> {
    await this.prefetching;
    // Free the demo fighters' rigs for reuse, then parse only what's still missing.
    this.clearRoster();
    const rigs: AnimeRig[] = [];
    for (const spec of specs) rigs.push(this.takeCachedRig(spec.style) ?? (await createRig(this.assets, spec.style)));
    this.player.netId = playerNetId;
    this.player.spawnIndex = playerSpawn;
    this.charByNet.set(playerNetId, this.player);
    specs.forEach((spec, i) => this.addFromSpec(spec, rigs[i]));
    this.rosterIsLocal = false;
  }

  // ------------------------------------------------------------------ lighting

  private addSun(): THREE.DirectionalLight {
    const sun = new THREE.DirectionalLight(0xfff0dc, 2.2);
    sun.castShadow = true;
    sun.shadow.mapSize.set(2048, 2048);
    const sc = sun.shadow.camera;
    sc.left = sc.bottom = -24;
    sc.right = sc.top = 24;
    sc.near = 0.05;
    sc.far = 90;
    sun.shadow.bias = -0.0004;
    sun.shadow.normalBias = 0.03;
    // Softer edges: the cel shading does the crisp look, hard shadow edges just look jagged.
    sun.shadow.radius = 2.5;
    this.scene.add(sun, sun.target);
    return sun;
  }

  /**
   * Keep the shadow box centred on the action. Slabs don't cast, so light reaches every floor;
   * the light sits just under the next floor up, so only things on this level cast shadows (not
   * the desks and stairs of every floor above, which used to blotch the floor you're on).
   */
  private updateSun(focus: THREE.Vector3): void {
    const dir = new THREE.Vector3(0.35, 0.85, 0.4).normalize();
    const texel = 48 / 2048;
    const fx = Math.round(focus.x / texel) * texel;
    const fz = Math.round(focus.z / texel) * texel;
    const floorY = Math.floor((focus.y + 0.3) / 6) * 6;
    this.sun.target.position.set(fx, floorY, fz);
    const d = 5.8 / dir.y;
    this.sun.position.set(fx + dir.x * d, floorY + dir.y * d, fz + dir.z * d);
  }

  // ------------------------------------------------------------------ menus & modes

  private wireMenus(): void {
    const show = (id: string, v: boolean) => document.getElementById(id)!.classList.toggle('hidden', !v);
    document.getElementById('pauseMenuBtn')!.addEventListener('click', () => this.leaveToMenu());
    document.getElementById('endMenuBtn')!.addEventListener('click', () => this.leaveToMenu());
    document.getElementById('resumeBtn')!.addEventListener('click', () => {
      show('pause', false);
      this.begin();
    });
    document.getElementById('restartBtn')!.addEventListener('click', () => {
      show('pause', false);
      this.startRound();
    });
    document.getElementById('againBtn')!.addEventListener('click', () => {
      show('end', false);
      if (this.mode === 'online') this.backToLobby();
      else this.startRound();
    });
  }

  /**
   * Swap maps: tear down the old one, build the new one, recolour the sky. Takes a second or
   * two, so it happens behind a menu or during the countdown. Callers reset the round after.
   */
  setMap(id: MapId): void {
    if (this.tower.id === id) return;
    this.traps.clear();
    this.airdrops.clearAll();
    this.flag.reset();
    this.tower.dispose();
    this.tower = createMap(id, this);
    this.backdrop.apply(this.tower.ambience, this.scene.fog as THREE.Fog, this.hemi, this.sun);
    for (const b of this.bots) b.reset();
    this.demoBot.reset();
    // Get the new surfaces' shaders compiling now, in parallel, rather than on first sight.
    void this.renderer.compileAsync(this.scene, this.cam.cam).catch(() => {});
  }

  /** Between online rounds: build the next round's map now and let the demo play on it behind the room sheet. */
  previewMap(id: MapId): void {
    if (this.mode !== 'demo' || this.tower.id === id) return;
    const state = this.state;
    this.setMap(id);
    this.startDemo();
    this.state = state;
  }

  /** Home page PLAY: a local round against bots (on whatever map is loaded; see setMap). */
  startRound(): void {
    if (!this.rosterIsLocal) this.buildRosterSync(this.offlineSpecs());
    this.mode = 'offline';
    this.matchSeconds = CONFIG.MATCH_SECONDS;
    this.setPauseButtons(true);
    this.reset();
    this.hud.showMap(mapInfo(this.tower.id));
    this.begin();
  }

  openLocker(): void {
    this.state = 'locker';
    this.locker.open();
  }

  /** Called by the locker when done. */
  closeLocker(): void {
    this.startDemo();
    this.home.show();
    if (this.net.connected) this.net.send({ t: 'profile', name: this.profile.name, style: this.profile.style });
  }

  /** Leave whatever we're doing (including an online room) and go home. */
  leaveToMenu(): void {
    if (this.mode === 'online' || this.net.room) this.net.send({ t: 'leave' });
    this.net.room = null;
    this.returnToMenu();
  }

  returnToMenu(): void {
    for (const id of ['pause', 'end']) document.getElementById(id)!.classList.add('hidden');
    document.exitPointerLock?.();
    this.startDemo();
    this.home.show();
  }

  /** Online: round over, back to the room or arena (the demo plays behind it). */
  backToLobby(): void {
    for (const id of ['pause', 'end']) document.getElementById(id)!.classList.add('hidden');
    document.exitPointerLock?.();
    this.startDemo();
    this.state = 'lobby';
    this.lobby.openFor(this.net.room);
  }

  /** Home-page background: a live match of bots, filmed by the director camera. */
  private startDemo(): void {
    this.touch?.release();
    if (!this.rosterIsLocal) this.buildRosterSync(this.offlineSpecs());
    this.mode = 'demo';
    this.state = 'menu';
    this.hud.setVisible(false);
    this.sfx.setWind(0);
    this.sfx.muted = true;
    this.reset();
    this.demoBot.reset();
    for (const c of this.characters) c.showLabel(false);
    this.director.reset();
    this.demoEndAt = -1;
  }

  private setPauseButtons(offline: boolean, arena = false): void {
    document.getElementById('restartBtn')!.classList.toggle('hidden', !offline);
    document.getElementById('againBtn')!.textContent = offline ? 'PLAY AGAIN' : arena ? 'NEXT ROUND' : 'BACK TO LOBBY';
    document.getElementById('pauseMenuBtn')!.textContent = offline ? 'MENU' : arena ? 'LEAVE' : 'LEAVE ROOM';
    document.getElementById('endMenuBtn')!.textContent = offline ? 'MENU' : arena ? 'LEAVE' : 'LEAVE ROOM';
    if (offline) this.hud.setPrize(null);
  }

  applySettings(): void {
    const s = this.settings;
    this.sfx.setVolume(s.volume);
    this.sfx.musicOn = s.music;
    this.cam.sensitivity = s.sensitivity;
    this.cam.padSensitivity = s.padSensitivity;
    this.cam.invertY = s.invertY;
    this.applyGraphics(s.lowGraphics);
  }

  /** Low: no shadows, 1× resolution, fewer fighters in full detail. */
  private applyGraphics(low: boolean): void {
    if (this.graphicsLow === low) return;
    const first = this.graphicsLow === null;
    this.graphicsLow = low;
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, low ? 1 : 1.75));
    this.renderer.setSize(this.viewW, this.viewH);
    this.maxFull = low ? 2 : MAX_FULL;
    this.maxLite = low ? 3 : MAX_LITE;
    if (this.renderer.shadowMap.enabled === !low) return;
    this.renderer.shadowMap.enabled = !low;
    this.sun.castShadow = !low;
    // Materials already compiled need rebuilding without (or with) shadows.
    if (!first)
      this.scene.traverse((o) => {
        const m = (o as THREE.Mesh).material;
        for (const mat of Array.isArray(m) ? m : m ? [m] : []) mat.needsUpdate = true;
      });
  }

  updateSettings(patch: Partial<Settings>): void {
    const musicChanged = patch.music !== undefined && patch.music !== this.settings.music;
    this.settings = { ...this.settings, ...patch };
    saveSettings(this.settings);
    this.applySettings();
    if (musicChanged) {
      this.sfx.init();
      this.sfx.setMusic(this.settings.music);
    }
  }

  /** Fold a finished round into the lifetime records. */
  private recordRound(winner: Character | null): void {
    const r = this.records;
    r.played++;
    if (winner?.isPlayer) {
      r.wins++;
      r.fastestWin = r.fastestWin === null ? this.time : Math.min(r.fastestWin, this.time);
    }
    r.bestFloor = Math.max(r.bestFloor, this.roundBestFloor);
    r.biggestFall = Math.max(r.biggestFall, this.roundBiggestFall);
    r.floorsSent += this.stats.floorsCaused;
    r.timesKnocked += this.stats.timesKnocked;
    saveRecords(r);
  }

  /** Change the player's name everywhere (profile, label, home page, current room). */
  renamePlayer(name: string): void {
    this.profile.name = name;
    saveProfile(this.profile);
    this.player.setLabel(name);
    this.player.name = name;
    this.home.refresh();
    if (this.net.connected) this.net.send({ t: 'profile', name, style: this.profile.style });
  }

  /** Apply a style to the player. Changing the base character re-parses its VRM. */
  async setPlayerStyle(style: Style, name: string): Promise<void> {
    const prevBase = this.profile.style.base;
    this.profile.style = style;
    this.profile.name = name;
    saveProfile(this.profile);
    if (name !== this.player.name) this.player.setLabel(name);
    this.player.style = style;
    if (style.base !== prevBase) {
      const rig = await createRig(this.assets, style);
      const old = this.playerRig;
      this.playerRig = rig;
      this.player.setRig(rig);
      VRMUtils.deepDispose(old.vrm.scene);
    } else {
      applyStyle(this.playerRig.vrm, style, this.playerRig.headSocket);
    }
  }

  private begin(): void {
    // Phones: full screen, sideways (where the browser allows it; it needs a tap to start).
    if (this.touch.enabled) goLandscape();
    this.sfx.init();
    this.sfx.muted = false;
    this.sfx.startMusic();
    // Mouse look only. While the pointer is locked the browser reports every finger at 0,0,
    // which would leave the move stick and swipe-to-look dead on phones.
    if (!this.touch.enabled) this.input.requestLock();
    this.state = 'playing';
    this.last = performance.now();
    this.hud.setVisible(true);
  }

  /**
   * A phone held upright during a round: turn the whole game a quarter turn so it plays sideways
   * once the phone is turned, even with rotation lock on. (Android has usually gone landscape on the
   * PLAY tap already; iPhones can't be turned by a website, so this is how they get there.)
   */
  updateRotation(): void {
    const w = window.innerWidth;
    const h = window.innerHeight;
    const rotate = this.touch.enabled && this.hud.visible && h > w;
    const body = document.body;
    body.classList.toggle('rotated', rotate);
    body.style.setProperty('--rot-w', `${rotate ? h : w}px`);
    body.style.setProperty('--rot-h', `${rotate ? w : h}px`);
    this.viewW = rotate ? h : w;
    this.viewH = rotate ? w : h;
    this.renderer.setSize(this.viewW, this.viewH);
    this.cam.resize(this.viewW / this.viewH);
  }

  /** Start on the controller. */
  openPause(): void {
    this.pause();
  }

  private pause(): void {
    document.getElementById('pause')!.classList.remove('hidden');
    this.touch.release();
    // An online match can't stop for one player; only offline rounds actually pause.
    if (this.mode === 'online') return;
    this.state = 'paused';
    this.sfx.setWind(0);
  }

  reset(): void {
    this.time = 0;
    this.acc = 0;
    this.stepCount = 0;
    this.traps.clear();
    this.airdrops.reset();
    this.flag.reset();
    this.fx.clear();
    this.hud.clearFeed();
    for (const c of this.characters) {
      const i = c.spawnIndex % this.tower.spawnPoints.length;
      c.reset(this.tower.spawnPoints[i], this.tower.spawnYaw);
      c.happy = false;
      c.showLabel(true);
    }
    this.bots.forEach((b) => b.reset());
    this.player.speedMul = 1;
    this.playerCtl.reset();
    this.cam.yaw = this.tower.spawnYaw;
    this.cam.pitch = 0.25;
    this.stats = { timesKnocked: 0, floorsLost: 0, floorsCaused: 0, biggest: { name: '-', floors: 0 } };
    this.roundBestFloor = 0;
    this.roundBiggestFall = 0;
  }

  // ------------------------------------------------------------------ online

  private wireNet(): void {
    const net = this.net;
    net.on('start', (m) => void this.startOnline(m.at, m.roster as RosterEntry[], m.map as MapId | undefined, m.flag, m.crates));
    net.on('s', (m) => {
      if (this.mode !== 'online') return;
      (m.d as (string | number)[][]).forEach((e, i) => {
        const c = this.charByNet.get(String(e[0]));
        if (c && c.remote) c.pushSnapshot(m.w ? m.w[i] : m.ts, e);
      });
    });
    // Public arenas: people drop into a round in progress (a bot may make room for them).
    net.on('joined', (m) => this.mode === 'online' && void this.addOnline(m.entry as RosterEntry));
    net.on('drop', (m) => this.mode === 'online' && this.removeNet(String(m.netId)));
    net.on('hit', (m) => {
      const target = this.charByNet.get(m.target);
      if (!target || target.remote || this.mode !== 'online') return;
      const by = this.charByNet.get(m.by) ?? null;
      this.combat.applyHit(target, by, new THREE.Vector3(m.dir[0], 0, m.dir[1]), m.force, m.up, m.stun, m.dmg, m.root ?? 0);
    });
    net.on('trap', (m) => this.mode === 'online' && this.traps.addRemote(m, this.charByNet.get(m.owner) ?? null));
    net.on('trapUse', (m) => this.mode === 'online' && this.traps.markUsed(m.id));
    net.on('flag', (m) => this.mode === 'online' && this.flag.setHolder(m.holder ? this.charByNet.get(m.holder) ?? null : null, m.since));
    net.on('crate', (m) => this.mode === 'online' && this.airdrops.spawnAt(m.id, m.spot, !!m.rack));
    net.on('gone', (m) => this.mode === 'online' && this.airdrops.taken(m.id, this.charByNet.get(m.who) ?? null, m.weapon, m.trap));
    net.on('prize', (m) => {
      this.claims.won({ token: String(m.token), place: Number(m.place), share: Number(m.share), label: String(m.label), pot: String(m.pot), map: String(m.map), at: Number(m.at) || Date.now() });
    });
    net.on('win', (m) => {
      if (this.mode !== 'online' || (this.state !== 'playing' && this.state !== 'paused')) return;
      this.finish(this.charByNet.get(m.who) ?? null, m.reason === 'time', m as unknown as RoundResult);
    });
    net.on('left', (m) => {
      if (this.mode !== 'online') return;
      const c = this.charByNet.get(`p:${m.id}`);
      if (c) this.hud.feed(`${c.name} left the room`);
      this.removeNet(`p:${m.id}`);
    });
    // The server moves bot simulation to a player whose tab is in front (background tabs stop ticking).
    net.on('botOwner', (m) => this.mode === 'online' && this.setBotOwner(m.id === net.id));
    const reportFocus = () => net.send({ t: 'focus', on: !document.hidden });
    document.addEventListener('visibilitychange', reportFocus);
    net.on('welcome', () => queueMicrotask(reportFocus));
    net.on('disconnected', () => {
      if (this.mode === 'online') {
        this.returnToMenu();
        this.hud.popup('DISCONNECTED', '#ff5050');
      }
    });
  }

  /** Online: start or stop simulating the room's bots on this machine. */
  private setBotOwner(mine: boolean): void {
    for (const ch of this.characters) {
      if (!ch.netId.startsWith('b:')) continue;
      if (mine && ch.remote) {
        ch.setRemote(false);
        const bot = new Bot(ch, randomSkill(), this);
        bot.retarget();
        this.bots.push(bot);
      } else if (!mine && !ch.remote) {
        ch.setRemote(true);
        const i = this.bots.findIndex((b) => b.c === ch);
        if (i >= 0) this.bots.splice(i, 1);
      }
    }
  }

  /** Server said go: build everyone, spawn, count down to the shared clock. */
  private onlineSpec(e: RosterEntry, i: number, used: Set<string>): RosterSpec {
    // Another player's look comes over the network: always bring it into range before using it.
    const style = e.kind === 'human' && e.style ? resolveStyle(e.style) : randomStyle(mulberry32(e.seed ?? i));
    const name = e.kind === 'human' ? e.name ?? 'Player' : this.botName(style, used, e.seed ?? i);
    return {
      netId: e.netId,
      name,
      color: COLORS[(i + 1) % COLORS.length],
      style,
      local: e.kind === 'bot' && e.owner === this.net.id,
      bot: e.kind === 'bot',
      spawn: e.spawn,
    };
  }

  /** Server said go (or we dropped into a round in progress): build everyone, spawn, count down. */
  private async startOnline(
    at: number,
    roster: RosterEntry[],
    map: MapId | undefined,
    flag?: { holder: string | null; since: number },
    crates?: [number, { spot: number; rack?: boolean }][],
  ): Promise<void> {
    const me = `p:${this.net.id}`;
    if (map) this.setMap(map);
    this.usedNames.clear();
    const specs: RosterSpec[] = [];
    let mySpawn = 0;
    roster.forEach((e, i) => {
      if (e.netId === me) mySpawn = e.spawn;
      else specs.push(this.onlineSpec(e, i, this.usedNames));
    });
    this.lobby.setStatus('Loading fighters…');
    await this.buildRoster(specs, me, mySpawn);
    this.lobby.hide();
    this.home.hide();
    // Arenas start the next round on their own, maybe while we're still reading the last result.
    for (const id of ['pause', 'end']) document.getElementById(id)!.classList.add('hidden');
    if (this.claims.isOpen) {
      this.claims.close();
      this.hud.popup('PRIZE SAVED: CLAIM IT AFTER THIS ROUND', '#ffe14d', true);
    }
    this.mode = 'online';
    this.matchSeconds = this.net.room?.matchSeconds ?? CONFIG.MATCH_SECONDS;
    this.matchAt = at;
    this.lastCountdown = -1;
    this.setPauseButtons(false, !!this.net.room?.public);
    this.reset();
    if (flag?.holder) this.flag.setHolder(this.charByNet.get(flag.holder) ?? null, flag.since);
    for (const [id, c] of crates ?? []) this.airdrops.spawnAt(id, c.spot, !!c.rack);
    this.hud.setPrize(this.net.room?.public ? this.net.room : null);
    this.hud.showMap(mapInfo(this.tower.id));
    this.begin();
  }

  /** Someone dropped into the round. */
  private async addOnline(e: RosterEntry): Promise<void> {
    if (this.charByNet.has(e.netId) || e.netId === `p:${this.net.id}`) return;
    const spec = this.onlineSpec(e, this.characters.length, this.usedNames);
    const rig = this.takeCachedRig(spec.style) ?? (await createRig(this.assets, spec.style));
    if (this.mode !== 'online' || this.charByNet.has(e.netId)) {
      this.returnRig(spec.style, rig);
      return;
    }
    this.addFromSpec(spec, rig);
    const c = this.charByNet.get(e.netId)!;
    c.reset(this.tower.spawnPoints[c.spawnIndex % this.tower.spawnPoints.length], this.tower.spawnYaw);
    this.hud.feed(`${spec.name} joined the round`);
  }

  /** Take a fighter out of the round (left, or a bot making room). */
  private removeNet(netId: string): void {
    const c = this.charByNet.get(netId);
    if (!c || c === this.player) return;
    const bi = this.bots.findIndex((b) => b.c === c);
    if (bi >= 0) this.bots.splice(bi, 1);
    if (this.flag.holder === c) this.flag.setHolder(null, 0);
    this.charByNet.delete(netId);
    this.characters.splice(this.characters.indexOf(c), 1);
    this.charByCollider.delete(c.collider.handle);
    this.returnRig(c.style, c.dispose());
  }

  /** Online match clock in seconds (negative during the countdown). */
  private matchClock(): number {
    return (this.net.serverNow() - this.matchAt) / 1000;
  }

  // ------------------------------------------------------------------ loop

  start(): void {
    requestAnimationFrame(this.frame);
  }

  private frame = (now: number): void => {
    requestAnimationFrame(this.frame);
    const dt = Math.min(0.1, (now - this.last) / 1000);
    this.last = now;
    this.realTime += dt;
    const pressed = this.input.consumePressed();
    this.input.pad.poll();
    this.padNav.update(now);
    this.touch.update();

    if (pressed.includes('KeyM') && this.state !== 'locker') {
      this.updateSettings({ music: !this.settings.music });
      this.hud.popup(this.settings.music ? 'MUSIC ON' : 'MUSIC OFF', '#7fd4ff', true);
    }
    const simulating = this.state === 'playing' || this.state === 'menu' || this.state === 'lobby' || (this.state === 'over' && this.mode === 'online');
    if (this.state === 'playing') {
      if (pressed.includes('KeyR') && this.mode === 'offline') this.reset();
      this.playerCtl.handleKeys(pressed);
      if (!this.padNav.capturing) this.playerCtl.handlePad();
    } else if (this.state === 'over' && pressed.includes('KeyR') && this.mode === 'offline') {
      document.getElementById('end')!.classList.add('hidden');
      this.startRound();
    }
    if (simulating) {
      this.acc += dt;
      while (this.acc >= STEP) {
        this.fixedStep(STEP);
        this.acc -= STEP;
      }
    }
    this.render(dt, simulating ? this.acc / STEP : 1);
  };

  private fixedStep(dt: number): void {
    const online = this.mode === 'online';
    const demo = this.mode === 'demo';
    let countdown = false;
    if (online) {
      const clock = this.matchClock();
      countdown = clock < 0;
      this.time = Math.max(0, clock);
    } else {
      this.time += dt;
    }
    this.stepCount++;
    this.tower.update(dt, this.time);
    this.traps.update(dt);
    if (!countdown && this.state === 'playing') this.playerCtl.fixedUpdate(dt);
    if (demo) this.demoBot.update(dt);
    if (!countdown) for (const b of this.bots) b.update(dt);
    const renderT = this.net.serverNow() - INTERP_DELAY;
    for (const c of this.characters) {
      if (c.remote) c.applyRemote(renderT);
      else if (!countdown) c.step(dt);
    }
    this.playerCtl.postStep();
    this.world.step();
    for (const c of this.characters) if (!c.remote) c.syncFromBody();
    this.airdrops.update(dt);
    this.flag.update(dt);
    if (!demo) this.roundBestFloor = Math.max(this.roundBestFloor, floorOf(this.player.feetY));
    for (const c of this.characters) {
      if (!online) c.happy = c === this.flag.holder;
      else if (!c.remote) c.happy = c === this.flag.holder;
      if (!c.remote && c.pos.y < -30) this.respawn(c);
    }
    if (online && this.stepCount % SEND_EVERY === 0) {
      const d = [this.player.snapshot(), ...this.bots.map((b) => b.c.snapshot())];
      this.net.send({ t: 's', d });
    }
    if (!online && this.time >= this.matchSeconds) this.timeUp();
    // Demo rounds restart a few seconds after someone wins.
    if (demo && this.demoEndAt > 0 && this.realTime > this.demoEndAt) {
      // On the home page the background match moves through every map in turn.
      if (this.state === 'menu') this.setMap(nextMap(this.tower.id));
      this.startDemo();
    }
  }

  private readonly usedNames = new Set<string>();
  /** Round length: the config offline, whatever the server says online. */
  matchSeconds = CONFIG.MATCH_SECONDS;
  private readonly frustum = new THREE.Frustum();
  private readonly projView = new THREE.Matrix4();
  private readonly lodSphere = new THREE.Sphere(new THREE.Vector3(), 1.3);

  /** Full detail near the camera, cheaper further out, nothing off screen (24 fighters on a laptop GPU). */
  private updateLod(): void {
    const cam = this.cam.cam;
    cam.updateMatrixWorld();
    this.projView.multiplyMatrices(cam.projectionMatrix, cam.matrixWorldInverse);
    this.frustum.setFromProjectionMatrix(this.projView);
    // Nearest on-screen fighters get the expensive tiers, with a cap so a crowd at the start
    // line costs the same as a spread-out field.
    const onScreen: { c: Character; d: number }[] = [];
    let full = 0;
    let lite = 0;
    for (const c of this.characters) {
      if (c.isPlayer && (this.mode !== 'demo' || this.state === 'locker')) {
        c.setLod('full');
        full++;
        continue;
      }
      this.lodSphere.center.copy(c.view.position);
      const d = this.lodSphere.center.distanceTo(cam.position);
      if (d > 110 || !this.frustum.intersectsSphere(this.lodSphere)) c.setLod('hidden');
      else onScreen.push({ c, d });
    }
    onScreen.sort((p, q) => p.d - q.d);
    for (const { c, d } of onScreen) {
      if (d < 20 && full < this.maxFull) {
        c.setLod('full');
        full++;
      } else if (d < 42 && lite < this.maxLite) {
        c.setLod('lite');
        lite++;
      } else c.setLod('proxy');
    }
  }

  private render(dt: number, alpha: number): void {
    this.updateLod();
    this.tower.cullFloors(this.cam.cam.position.y);
    for (const c of this.characters) c.updateView(alpha, dt, this.realTime);
    this.tower.syncView(alpha, dt);
    this.flag.updateView(this.realTime);
    this.fx.update(dt);
    this.backdrop.clouds.rotation.y += dt * 0.004;
    if (this.mode === 'demo' && this.state !== 'locker') {
      const focus = this.director.update(dt);
      this.updateSun(focus);
    } else if (this.state === 'locker') {
      this.locker.updateCamera(dt);
      this.updateSun(this.player.view.position);
    } else {
      this.updateSun(this.player.view.position);
      this.cam.update(dt, this.player.view.position, this, -this.player.vel.y);
      this.hud.update();
      if (this.mode === 'online' && this.state === 'playing') this.countdownTick();
    }
    const fall = this.state === 'playing' ? THREE.MathUtils.clamp((-this.player.vel.y - 12) / 25, 0, 1) : 0;
    this.sfx.setWind(fall);
    this.renderer.render(this.scene, this.cam.cam);
  }

  private countdownTick(): void {
    const clock = this.matchClock();
    if (clock >= 0.6) return;
    const n = Math.ceil(-clock);
    if (n !== this.lastCountdown) {
      this.lastCountdown = n;
      if (n > 0) this.hud.popup(String(n), '#ffe14d');
      else {
        this.hud.popup('CLIMB!', '#7ee05a');
        this.sfx.flagGrab();
      }
    }
  }

  private respawn(c: Character): void {
    const i = c.spawnIndex % this.tower.spawnPoints.length;
    c.teleport(this.tower.spawnPoints[i]);
    if (c.isPlayer && this.mode !== 'demo') this.hud.popup('BACK TO THE START', '#ff5050');
    this.bots.find((b) => b.c === c)?.retarget();
    if (c === this.player && this.mode === 'demo') this.demoBot.retarget();
  }

  /** The collider directly under a character's feet, if any. */
  groundHandle(c: Character): number | null {
    const hit = this.world.castRay(
      new RAPIER.Ray({ x: c.pos.x, y: c.feetY + 0.2, z: c.pos.z }, RAY_DOWN),
      0.6,
      true,
      RAPIER.QueryFilterFlags.EXCLUDE_SENSORS,
      undefined,
      c.collider,
    );
    return hit ? hit.collider.handle : null;
  }

  /** True while the home-page demo is running (no sounds, popups or records). */
  get quiet(): boolean {
    return this.mode === 'demo';
  }

  // ------------------------------------------------------------------ events

  onLanded(c: Character, drop: number): void {
    const quiet = this.quiet;
    const nearPlayer = !quiet && (c.isPlayer || c.pos.distanceTo(this.player.pos) < 20);
    // Safety nets bounce you back up a little.
    const g = drop > 1 ? this.groundHandle(c) : null;
    if (g !== null && this.tower.isNet(g)) {
      c.vel.y = Math.min(15, Math.sqrt(2 * CONFIG.GRAVITY * drop) * 0.55);
      c.grounded = false;
      if (nearPlayer) this.sfx.boing();
    } else if (drop > 3 && nearPlayer) {
      this.sfx.thud(Math.min(1, drop / 15));
      if (c.isPlayer) this.input.pad.rumble(Math.min(1, drop / 12), 0.3, 180);
    }
    if (quiet) {
      if (drop >= 4.5) this.director.notice(c);
      return;
    }
    if (c.isPlayer && drop > 2) this.fx.addShake(Math.min(0.7, drop / 25));
    if (c.isPlayer && drop >= 4.5) this.roundBiggestFall = Math.max(this.roundBiggestFall, Math.round(drop / CONFIG.FLOOR_HEIGHT));
    if (drop < 4.5) return;
    const floors = Math.round(drop / CONFIG.FLOOR_HEIGHT);
    if (floors < 1) return;
    const by = c.lastHitBy && this.time - c.lastHitAt < 5 && c.lastHitBy !== c ? c.lastHitBy : null;
    const fl = `${floors} FLOOR${floors > 1 ? 'S' : ''}`;
    if (c.isPlayer) {
      this.stats.timesKnocked++;
      this.stats.floorsLost += floors;
      this.hud.popup(by ? `${by.name.toUpperCase()} SENT YOU DOWN ${fl}!` : `FELL ${fl}!`, '#ff5050');
    } else if (by?.isPlayer) {
      this.stats.floorsCaused += floors;
      this.hud.popup(`YOU SENT ${c.name.toUpperCase()} DOWN ${fl}!`, '#ffd23f');
    }
    this.hud.feed(by ? `${by.name} sent ${c.name} down ${fl.toLowerCase()}` : `${c.name} fell ${fl.toLowerCase()}`);
    if (floors > this.stats.biggest.floors) this.stats.biggest = { name: c.isPlayer ? 'You' : c.name, floors };
    c.lastHitBy = null;
  }

  onObstacleHit(c: Character): void {
    if (!this.quiet) {
      if (c.isPlayer) {
        this.sfx.hit(0.8);
        this.fx.addShake(0.4);
      } else if (c.pos.distanceTo(this.player.pos) < 20) {
        this.sfx.hit(0.3);
      }
    }
    this.fx.burst(c.pos, 0xffffff, 8, 5);
  }

  /** Offline/demo win from the local flag logic. Online wins come from the server. */
  win(c: Character): void {
    if (this.mode === 'demo') {
      if (this.demoEndAt < 0) {
        this.demoEndAt = this.realTime + 5;
        this.director.notice(c, 6);
      }
      return;
    }
    if (this.mode === 'online' || this.state !== 'playing') return;
    this.finish(c, false);
  }

  private finish(c: Character | null, timeUp: boolean, result?: RoundResult): void {
    this.state = 'over';
    this.touch.release();
    this.recordRound(c);
    if (c) c.happy = true;
    this.sfx.setWind(0);
    if (c?.isPlayer) this.sfx.win();
    else this.sfx.lose();
    const title = c ? (c.isPlayer ? 'YOU WIN!' : `${c.name.toUpperCase()} WINS`) : 'ROUND OVER';
    const sub = timeUp
      ? `Time's up — ${c?.isPlayer ? 'you were' : (c?.name ?? 'nobody') + ' was'} highest.`
      : c?.isPlayer
        ? 'Flag captured. Nobody could stop you.'
        : 'They held the flag for 3 seconds.';
    this.showEnd(title, result ? `${sub} ${prizeLine(result)}` : sub);
  }

  private timeUp(): void {
    if (this.mode === 'demo') {
      this.startDemo();
      return;
    }
    const top = [...this.characters].sort((a, b) => b.feetY - a.feetY)[0];
    this.finish(top, true);
  }

  private showEnd(title: string, sub: string): void {
    document.exitPointerLock?.();
    document.getElementById('endTitle')!.textContent = title;
    document.getElementById('endSub')!.textContent = sub;
    const s = this.stats;
    document.getElementById('endStats')!.innerHTML = [
      `Times you got knocked down: <b>${s.timesKnocked}</b> (${s.floorsLost} floors lost)`,
      `Floors you sent others down: <b>${s.floorsCaused}</b>`,
      `Biggest fall: <b>${s.biggest.name.replace(/[&<>"']/g, (ch) => `&#${ch.charCodeAt(0)};`)}</b> — ${s.biggest.floors} floor${s.biggest.floors === 1 ? '' : 's'}`,
    ].join('<br/>');
    document.getElementById('endHint')!.classList.toggle('hidden', this.mode === 'online');
    document.getElementById('end')!.classList.remove('hidden');
    this.syncClaimButtons();
  }

  /** "Claim your prize" shows wherever it can be reached while a prize still needs a wallet. */
  syncClaimButtons(): void {
    const waiting = this.claims.unclaimed().length > 0;
    for (const id of ['endClaim', 'arenaClaim']) document.getElementById(id)!.classList.toggle('hidden', !waiting);
    document.getElementById('winsBtn')!.classList.toggle('hasPrize', waiting);
  }
}
