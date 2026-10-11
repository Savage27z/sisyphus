import { CONFIG } from './config';
import { apiUrl } from './endpoint';
import type { Game } from './game';
import { renderMapCards } from './maps';

const $ = (id: string) => document.getElementById(id)!;
const SHEETS = ['howto', 'records', 'settings', 'credits', 'leaderboard', 'mywins', 'practice'];
const esc = (s: string) => s.replace(/[&<>"']/g, (ch) => `&#${ch.charCodeAt(0)};`);
const clock = (s: number) => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, '0')}`;
/** Player chip colours, picked by outfit so the chip changes with the locker. */
const CHIP_COLORS = ['#ff6f91', '#3ec1ff', '#ffc23d', '#6fdc8c', '#b08cff', '#ff8a3d', '#4fe0c8', '#8fa8ff'];

interface ArenaStat {
  phase: 'lobby' | 'playing' | 'ended';
  humans: number;
  startsIn: number | null;
  endsIn: number | null;
  prizeRound: boolean;
}
interface PublicStats {
  online: number;
  playing: number;
  prize: number;
  currency: string;
  minPlayers: number;
  arenas: ArenaStat[];
}

/** The home page: player chip, menu, PLAY with the prize, live player count and round clock, sheets. */
export class Home {
  private readonly el = $('menu');
  private statsTimer: number | null = null;
  private lastStats: PublicStats | null = null;
  private statsAt = 0;

  constructor(private readonly game: Game) {
    $('playOnlineBtn').addEventListener('click', () => game.lobby.playOnline());
    $('friendsLink').addEventListener('click', (e) => {
      e.preventDefault();
      game.lobby.open();
    });
    $('practiceLink').addEventListener('click', (e) => {
      e.preventDefault();
      renderMapCards($('practiceMaps'), game.tower.id, (id) => {
        this.closeSheets();
        this.hide();
        game.setMap(id);
        game.startRound();
      });
      this.openSheet('practice');
    });
    const toLocker = (e: Event) => {
      e.preventDefault();
      this.hide();
      game.openLocker();
    };
    $('lockerBtn').addEventListener('click', toLocker);
    $('howtoBtn').addEventListener('click', () => this.openSheet('howto'));
    $('leaderBtn').addEventListener('click', () => {
      this.openSheet('leaderboard');
      void this.renderLeaderboard();
    });
    $('winsBtn').addEventListener('click', () => {
      this.openSheet('mywins');
      void this.renderMyWins();
    });
    $('recordsBtn').addEventListener('click', () => {
      this.renderRecords();
      this.openSheet('records');
    });
    $('settingsBtn').addEventListener('click', () => {
      this.syncSettings();
      this.openSheet('settings');
    });
    $('creditsLink').addEventListener('click', (e) => {
      e.preventDefault();
      this.openSheet('credits');
    });
    document.querySelectorAll<HTMLElement>('[data-close]').forEach((b) => b.addEventListener('click', () => this.closeSheets()));
    document.querySelectorAll<HTMLElement>('.sheetOverlay').forEach((o) =>
      o.addEventListener('click', (e) => {
        if (e.target === o && SHEETS.includes(o.id)) this.closeSheets();
      }),
    );
    window.addEventListener('keydown', (e) => {
      if (e.code === 'Escape') this.closeSheets();
    });

    const music = $('setMusic') as HTMLInputElement;
    const volume = $('setVolume') as HTMLInputElement;
    const sens = $('setSens') as HTMLInputElement;
    const invert = $('setInvert') as HTMLInputElement;
    const lowGfx = $('setLowGfx') as HTMLInputElement;
    lowGfx.addEventListener('change', () => game.updateSettings({ lowGraphics: lowGfx.checked }));
    music.addEventListener('change', () => game.updateSettings({ music: music.checked }));
    volume.addEventListener('input', () => game.updateSettings({ volume: Number(volume.value) / 100 }));
    sens.addEventListener('input', () => game.updateSettings({ sensitivity: Number(sens.value) / 100 }));
    invert.addEventListener('change', () => game.updateSettings({ invertY: invert.checked }));
    this.refresh();
    this.pollStats();
    // Tick the round clock between fetches.
    window.setInterval(() => {
      if (!this.el.classList.contains('hidden')) this.renderStats();
    }, 1000);
  }

  show(): void {
    this.refresh();
    this.el.classList.remove('hidden');
    this.pollStats();
  }

  hide(): void {
    this.closeSheets();
    this.el.classList.add('hidden');
    if (this.statsTimer !== null) clearInterval(this.statsTimer);
    this.statsTimer = null;
  }

  refresh(): void {
    const { name, style } = this.game.profile;
    $('homeName').textContent = name;
    const avatar = $('chipAvatar');
    avatar.textContent = (name.trim()[0] ?? '?').toUpperCase();
    avatar.style.setProperty('--chip', CHIP_COLORS[style.outfit % CHIP_COLORS.length]);
  }

  // ------------------------------------------------------------------ live stats

  private pollStats(): void {
    if (this.statsTimer !== null) return;
    void this.fetchStats();
    this.statsTimer = window.setInterval(() => void this.fetchStats(), 5000);
  }

  private async fetchStats(): Promise<void> {
    try {
      const res = await fetch(apiUrl('/api/stats'), { cache: 'no-store' });
      if (!res.ok) throw new Error(String(res.status));
      this.lastStats = (await res.json()) as PublicStats;
      this.statsAt = performance.now();
    } catch {
      this.lastStats = null;
    }
    this.renderStats();
  }

  private renderStats(): void {
    const s = this.lastStats;
    $('liveLine').classList.toggle('offline', !s);
    if (!s) {
      $('homePrize').textContent = '$25';
      $('homeOnline').textContent = "Can't reach the server";
      $('homeRound').textContent = 'Practice still works';
      return;
    }
    $('homePrize').textContent = `${s.currency}${s.prize}`;
    $('homeOnline').textContent = `${s.online} here now`;
    const elapsed = (performance.now() - this.statsAt) / 1000;
    const a = [...s.arenas].sort((x, y) => y.humans - x.humans)[0];
    let line: string;
    if (!a) line = `Prize rounds at ${s.minPlayers}+ players`;
    else if (a.phase === 'playing' && a.endsIn !== null) line = `Round ends in ${clock(Math.max(0, a.endsIn - elapsed))}`;
    else if (a.phase === 'lobby' && a.startsIn !== null) line = `Next round in ${clock(Math.max(0, a.startsIn - elapsed))}`;
    else line = 'Next round starting soon';
    $('homeRound').textContent = line;
  }

  private async renderLeaderboard(): Promise<void> {
    const list = $('leaderList');
    list.innerHTML = '<li class="dim">Loading…</li>';
    try {
      const res = await fetch(apiUrl('/api/leaderboard'), { cache: 'no-store' });
      const { top } = (await res.json()) as { top: { name: string; wins: number; rounds: number }[] };
      list.innerHTML = top.length
        ? top.map((p, i) => `<li><span class="rank">${i + 1}</span><span class="pname">${esc(p.name)}</span><b>${p.wins}</b><span class="dim">win${p.wins === 1 ? '' : 's'}</span></li>`).join('')
        : '<li class="dim">No winners yet — be the first.</li>';
    } catch {
      list.innerHTML = '<li class="dim">Leaderboard is unavailable offline.</li>';
    }
  }

  private async renderMyWins(): Promise<void> {
    const body = $('mywinsBody');
    const list = $('mywinsList');
    body.innerHTML = '';
    list.innerHTML = '<li class="dim">Loading…</li>';
    const me = await this.game.lobby.fetchMe();
    if (!me) {
      list.innerHTML = '<li class="dim">Couldn’t reach the game server.</li>';
      return;
    }
    body.innerHTML = [
      ['Public wins', String(me.wins)],
      ['Rounds played', String(me.rounds)],
    ]
      .map(([label, value]) => `<div class="stat"><b>${value}</b>${label}</div>`)
      .join('');
    list.innerHTML = me.recent.length
      ? me.recent.map((r) => `<li><b>${new Date(r.at).toLocaleString()}</b> — ${r.prizeRound ? 'prize round' : 'warm-up round'} (${r.reason === 'flag' ? 'held the flag' : 'highest at the bell'})</li>`).join('')
      : '<li class="dim">No wins yet. Grab that flag!</li>';
  }

  // ------------------------------------------------------------------ sheets

  private openSheet(id: string): void {
    this.closeSheets();
    $(id).classList.remove('hidden');
  }

  private closeSheets(): void {
    for (const s of SHEETS) $(s).classList.add('hidden');
  }

  private syncSettings(): void {
    const s = this.game.settings;
    ($('setMusic') as HTMLInputElement).checked = s.music;
    ($('setVolume') as HTMLInputElement).value = String(Math.round(s.volume * 100));
    ($('setSens') as HTMLInputElement).value = String(Math.round(s.sensitivity * 100));
    ($('setInvert') as HTMLInputElement).checked = s.invertY;
    ($('setLowGfx') as HTMLInputElement).checked = s.lowGraphics;
  }

  private renderRecords(): void {
    const r = this.game.records;
    const time = (t: number | null) => (t === null ? '—' : clock(t));
    const tiles: [string, string][] = [
      ['Rounds played', String(r.played)],
      ['Wins', String(r.wins)],
      ['Best floor', r.bestFloor >= CONFIG.FLOORS ? 'ROOF' : String(r.bestFloor)],
      ['Fastest win', time(r.fastestWin)],
      ['Biggest fall', `${r.biggestFall} fl`],
      ['Floors you sent rivals down', String(r.floorsSent)],
      ['Times knocked down', String(r.timesKnocked)],
    ];
    $('recordsBody').innerHTML = tiles.map(([label, value]) => `<div class="stat"><b>${value}</b>${label}</div>`).join('');
  }
}
