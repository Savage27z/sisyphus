import { prizeKey } from './claim';
import { CONFIG } from './config';
import { apiUrl } from './endpoint';
import type { Game } from './game';
import type { MyWins } from './lobby';
import { MAPS, renderMapCards } from './maps';
import { isSymbol, money, ordinal } from './money';
import type { CupSummary } from './net';
import { goLandscape } from './touch';

const $ = (id: string) => document.getElementById(id)!;
const SHEETS = ['howto', 'records', 'settings', 'credits', 'leaderboard', 'mywins', 'practice'];
const esc = (s: string) => s.replace(/[&<>"']/g, (ch) => `&#${ch.charCodeAt(0)};`);
const clock = (s: number) => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, '0')}`;
/** "3d 04h", "5h 12m", "12m 30s" */
function untilEnd(s: number): string {
  const t = Math.max(0, Math.floor(s));
  const d = Math.floor(t / 86400);
  const h = Math.floor((t % 86400) / 3600);
  const m = Math.floor((t % 3600) / 60);
  const pad = (n: number) => String(n).padStart(2, '0');
  return d ? `${d}d ${pad(h)}h` : h ? `${h}h ${pad(m)}m` : `${m}m ${pad(t % 60)}s`;
}
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
  split?: number[];
  minPlayers: number;
  cup?: CupSummary | null;
  arenas: ArenaStat[];
}

interface CupView extends CupSummary {
  rows: { name: string; points: number; wins: number }[];
}
interface Board {
  top: { name: string; wins: number; rounds: number }[];
  cup: CupView | null;
  rules?: { places: number[]; climb: number; minFloor: number; minPlayers: number };
}

/** The home page: player chip, menu, PLAY with the prize, live player count and round clock, sheets. */
export class Home {
  private readonly el = $('menu');
  private statsTimer: number | null = null;
  private lastStats: PublicStats | null = null;
  private statsAt = 0;
  private board: Board | null = null;
  private boardAt = 0;
  private boardTab: 'cup' | 'all' = 'cup';
  private myCup: MyWins['cup'] = null;

  constructor(private readonly game: Game) {
    $('playOnlineBtn').addEventListener('click', () => game.lobby.playOnline());
    $('friendsLink').addEventListener('click', (e) => {
      e.preventDefault();
      game.lobby.open();
    });
    $('practiceLink').addEventListener('click', (e) => {
      e.preventDefault();
      renderMapCards($('practiceMaps'), game.tower.id, (id) => {
        goLandscape();
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
    document.querySelectorAll<HTMLElement>('#leaderTabs [data-tab]').forEach((b) =>
      b.addEventListener('click', () => {
        this.boardTab = b.dataset.tab === 'all' ? 'all' : 'cup';
        this.drawBoard();
      }),
    );
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
    const padSens = $('setPadSens') as HTMLInputElement;
    const invert = $('setInvert') as HTMLInputElement;
    const lowGfx = $('setLowGfx') as HTMLInputElement;
    lowGfx.addEventListener('change', () => game.updateSettings({ lowGraphics: lowGfx.checked }));
    music.addEventListener('change', () => game.updateSettings({ music: music.checked }));
    volume.addEventListener('input', () => game.updateSettings({ volume: Number(volume.value) / 100 }));
    sens.addEventListener('input', () => game.updateSettings({ sensitivity: Number(sens.value) / 100 }));
    padSens.addEventListener('input', () => game.updateSettings({ padSensitivity: Number(padSens.value) / 100 }));
    invert.addEventListener('change', () => game.updateSettings({ invertY: invert.checked }));
    this.refresh();
    this.pollStats();
    // Tick the round clock (and the cup's) between fetches.
    window.setInterval(() => {
      if (this.el.classList.contains('hidden')) return;
      this.renderStats();
      if (!$('leaderboard').classList.contains('hidden')) this.tickCupClock();
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
    const elapsed = (performance.now() - this.statsAt) / 1000;
    this.renderCupLine(s?.cup ?? null, elapsed);
    if (!s) {
      this.renderPot(0, '$', [100]);
      $('homeOnline').textContent = "Can't reach the server";
      $('homeRound').textContent = 'Practice still works';
      return;
    }
    if (s.cup?.running) this.renderCupSticker(s.cup);
    else this.renderPot(s.prize, s.currency, s.split ?? [100]);
    $('homeOnline').textContent = `${s.online} here now`;
    const a = [...(s.arenas ?? [])].sort((x, y) => y.humans - x.humans)[0];
    let line: string;
    if (!a) line = s.cup?.open ? `Cup rounds at ${s.minPlayers}+ players` : s.prize > 0 ? `Prize rounds at ${s.minPlayers}+ players` : 'Bots fill the empty spots';
    else if (a.phase === 'playing' && a.endsIn !== null) line = `Round ends in ${clock(Math.max(0, a.endsIn - elapsed))}`;
    else if (a.phase === 'lobby' && a.startsIn !== null) line = `Next round in ${clock(Math.max(0, a.startsIn - elapsed))}`;
    else line = 'Next round starting soon';
    $('homeRound').textContent = line;
  }

  /** The sticker on PLAY: "WIN $25", or "POT 2.5 SOL" when the top places share it (hidden with no prize). */
  private renderPot(amount: number, currency: string, split: number[]): void {
    this.renderSticker(split.length > 1 ? 'POT' : 'WIN', amount, currency);
  }

  /** While a cup runs the sticker shows everything it pays out. */
  private renderCupSticker(cup: CupSummary): void {
    this.renderSticker('CUP', cup.prizes.reduce((a, b) => a + b, 0), cup.currency);
  }

  private renderSticker(top: string, amount: number, currency: string): void {
    document.querySelector('.prizeBurst')!.classList.toggle('hidden', !(amount > 0));
    const n = String(Math.round(amount * 1e4) / 1e4);
    const symbol = isSymbol(currency);
    $('homePrizeTop').textContent = top;
    $('homePrize').textContent = symbol ? `${currency}${n}` : n;
    $('homePrizeUnit').textContent = symbol ? '' : currency;
    $('homePrize').classList.toggle('long', (symbol ? n.length + 1 : n.length) > 4);
  }

  /** Under PLAY: how long the cup has left (or the usual line when there's no cup). */
  private renderCupLine(cup: CupSummary | null, elapsed: number): void {
    const sub = document.querySelector('#playOnlineBtn .goSub')!;
    if (!cup?.running) {
      sub.textContent = 'PUBLIC ROUND · UP TO 24 CLIMBERS';
      return;
    }
    const left = cup.endsIn - elapsed;
    sub.textContent = left > 0 ? `CUP ENDS IN ${untilEnd(left).toUpperCase()} · TOP ${cup.prizes.length} WIN` : 'CUP CLOSING · LAST ROUNDS';
  }

  private async renderLeaderboard(): Promise<void> {
    const list = $('leaderList');
    $('leaderTabs').classList.add('hidden');
    $('cupHead').classList.add('hidden');
    list.innerHTML = '<li class="dim">Loading…</li>';
    try {
      const res = await fetch(apiUrl('/api/leaderboard'), { cache: 'no-store' });
      this.board = (await res.json()) as Board;
      this.boardAt = performance.now();
    } catch {
      this.board = null;
      list.innerHTML = '<li class="dim">Leaderboard is unavailable offline.</li>';
      $('leaderHint').textContent = '';
      return;
    }
    this.boardTab = this.board.cup ? 'cup' : 'all';
    this.myCup = null;
    this.drawBoard();
    // Where you stand: asked over the game's own connection, which knows this browser.
    if (this.board.cup) {
      const me = await this.game.lobby.fetchMe();
      this.myCup = me?.cup ?? null;
      if (this.boardTab === 'cup') this.drawBoard();
    }
  }

  /** The cup table (when there is a cup) or the all-time wins. */
  private drawBoard(): void {
    const d = this.board;
    if (!d) return;
    const list = $('leaderList');
    const cup = d.cup;
    $('leaderTabs').classList.toggle('hidden', !cup);
    document.querySelectorAll<HTMLElement>('#leaderTabs [data-tab]').forEach((b) => b.classList.toggle('on', b.dataset.tab === this.boardTab));
    const showCup = !!cup && this.boardTab === 'cup';
    $('cupHead').classList.toggle('hidden', !showCup);
    if (!cup || !showCup) {
      list.innerHTML = d.top.length
        ? d.top.map((p, i) => `<li><span class="rank">${i + 1}</span><span class="pname">${esc(p.name)}</span><b>${p.wins}</b><span class="dim">win${p.wins === 1 ? '' : 's'}</span></li>`).join('')
        : '<li class="dim">No winners yet — be the first.</li>';
      $('leaderHint').textContent = 'Most wins in public rounds, all time.';
      return;
    }
    const r = d.rules ?? { places: [10, 6, 4], climb: 1, minFloor: 3, minPlayers: 4 };
    $('cupPrizes').innerHTML = cup.prizes.map((p, i) => `<span class="cupPrize"><i>${ordinal(i + 1)}</i>${esc(money(p, cup.currency))}</span>`).join('');
    $('cupRules').textContent =
      `Points each cup round: ${r.places.map((p, i) => `${ordinal(i + 1)} ${p}`).join(' · ')} · everyone else above floor ${r.minFloor} gets ${r.climb}. ` +
      `Cup rounds need ${r.minPlayers}+ players.`;
    const me = this.myCup;
    $('cupYou').innerHTML = me
      ? `You’re <b>${ordinal(me.rank)}</b> with <b>${me.points}</b> pts${me.rank <= cup.prizes.length ? ' — in the prizes!' : ''}`
      : cup.running
        ? 'You haven’t scored yet. Finish a cup round in the top 3, or above floor 3.'
        : '';
    $('cupYou').classList.toggle('hidden', !$('cupYou').innerHTML);
    this.tickCupClock();
    list.innerHTML = cup.rows.length
      ? cup.rows
          .map((p, i) => {
            const cls = [i < cup.prizes.length ? 'paid' : '', me?.rank === i + 1 ? 'me' : ''].filter(Boolean).join(' ');
            return `<li${cls ? ` class="${cls}"` : ''}><span class="rank">${i + 1}</span><span class="pname">${esc(p.name)}</span><b>${p.points}</b><span class="dim">pts</span></li>`;
          })
          .join('')
      : '<li class="dim">No points yet — be the first on the board.</li>';
    $('leaderHint').textContent = cup.running
      ? 'Points are saved in this browser, so keep playing on the same one. When the cup ends, the winners claim their prize right here in the game.'
      : 'Final table. Winners: your prize is waiting in MY WINS.';
  }

  private tickCupClock(): void {
    const cup = this.board?.cup;
    if (!cup) return;
    const left = cup.endsIn - (performance.now() - this.boardAt) / 1000;
    $('cupClock').innerHTML = !cup.running ? 'THE CUP IS OVER' : left > 0 ? `ENDS IN <b>${untilEnd(left)}</b>` : 'LAST ROUNDS — RESULTS SOON';
  }

  private async renderMyWins(): Promise<void> {
    const body = $('mywinsBody');
    const list = $('mywinsList');
    this.renderPrizes();
    body.innerHTML = '';
    list.innerHTML = '<li class="dim">Loading…</li>';
    const me = await this.game.lobby.fetchMe();
    if (!me) {
      list.innerHTML = '<li class="dim">Couldn’t reach the game server.</li>';
      return;
    }
    const tiles: [string, string][] = [
      ['Public wins', String(me.wins)],
      ['Rounds played', String(me.rounds)],
    ];
    if (me.cup) tiles.push([`In the cup · ${me.cup.points} pts`, ordinal(me.cup.rank)]);
    body.innerHTML = tiles
      .map(([label, value]) => `<div class="stat"><b>${value}</b>${label}</div>`)
      .join('');
    list.innerHTML = me.recent.length
      ? me.recent.map((r) => `<li><b>${new Date(r.at).toLocaleString()}</b> — ${r.prizeRound ? 'prize round' : 'warm-up round'} (${r.reason === 'flag' ? 'held the flag' : 'highest at the bell'})</li>`).join('')
      : '<li class="dim">No wins yet. Grab that flag!</li>';
  }

  /** Prizes won in this browser: claim the ones still waiting for a wallet. */
  private renderPrizes(): void {
    const box = $('mywinsPrizes');
    const prizes = this.game.claims.all();
    box.classList.toggle('hidden', !prizes.length);
    box.innerHTML = prizes
      .map((p) => {
        const where = p.cup ? 'The cup' : (MAPS.find((m) => m.id === p.map)?.name ?? p.map ?? '');
        const what = `<b>${ordinal(p.place)}</b> · ${esc(p.label)} · ${esc(where)}`;
        const action = p.wallet
          ? `<span class="dim">sent to ${esc(p.wallet.slice(0, 4))}…${esc(p.wallet.slice(-4))}</span>`
          : `<button class="claimBtn small" data-key="${esc(prizeKey(p))}">CLAIM</button>`;
        return `<li>${what}${action}</li>`;
      })
      .join('');
    box.querySelectorAll<HTMLElement>('[data-key]').forEach((b) =>
      b.addEventListener('click', () => {
        this.closeSheets();
        this.game.claims.open(b.dataset.key);
      }),
    );
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
    ($('setPadSens') as HTMLInputElement).value = String(Math.round(s.padSensitivity * 100));
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
