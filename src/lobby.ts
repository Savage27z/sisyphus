import type { Game } from './game';
import { mapName, renderMapCards } from './maps';
import { money } from './money';
import { playerSecret, type RoomInfo } from './net';
import { goLandscape } from './touch';

const $ = (id: string) => document.getElementById(id)!;
const esc = (s: string) => s.replace(/[&<>"']/g, (ch) => `&#${ch.charCodeAt(0)};`);
const clock = (s: number) => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, '0')}`;

export interface MyWins {
  name: string;
  wins: number;
  rounds: number;
  recent: { at: number; prizeRound: boolean; reason: string }[];
}

/**
 * Online UI: PLAY ONLINE (a public arena: wait for the next round or drop into the one
 * going on) and play-with-friends rooms (create / join with a code, the host starts).
 */
export class Lobby {
  private readonly sheet = $('online');
  private readonly arena = $('arena');
  private pendingJoin: string | null = null;
  private arenaTick: number | null = null;

  constructor(private readonly game: Game) {
    const net = game.net;

    // ---- friends rooms
    $('onlineClose').addEventListener('click', () => this.close());
    $('createRoomBtn').addEventListener('click', () => {
      goLandscape();
      void this.withConnection($('onlineName') as HTMLInputElement, () => net.send({ t: 'create' }));
    });
    const join = () => {
      const code = ($('joinCode') as HTMLInputElement).value.trim().toUpperCase();
      if (code.length < 4) return this.setStatus('Type the 5-letter room code.');
      void this.withConnection($('onlineName') as HTMLInputElement, () => net.send({ t: 'join', code }));
    };
    $('joinRoomBtn').addEventListener('click', () => {
      goLandscape();
      join();
    });
    $('onlineName').addEventListener('keydown', (e) => e.stopPropagation());
    $('joinCode').addEventListener('keydown', (e) => {
      e.stopPropagation();
      if ((e as KeyboardEvent).key === 'Enter') join();
    });
    $('copyInvite').addEventListener('click', () => this.copyInvite());
    $('roomBots').addEventListener('change', () => net.send({ t: 'bots', on: ($('roomBots') as HTMLInputElement).checked }));
    $('roomStart').addEventListener('click', () => {
      this.setStatus('Starting…');
      net.send({ t: 'start' });
    });
    $('roomLeave').addEventListener('click', () => {
      net.send({ t: 'leave' });
      net.room = null;
      this.render();
    });

    // ---- public arena
    $('arenaClose').addEventListener('click', () => this.leaveArena());
    $('arenaLeave').addEventListener('click', () => this.leaveArena());
    $('arenaName').addEventListener('keydown', (e) => {
      e.stopPropagation();
      if ((e as KeyboardEvent).key === 'Enter') this.playOnline();
    });
    $('arenaGo').addEventListener('click', () => this.playOnline());

    net.on('room', (m) => {
      const room = m as unknown as RoomInfo;
      // Waiting for the next round: build its map now, so the round starts without a hitch.
      if (room.phase === 'lobby' && room.map) game.previewMap(room.map);
      if (room.public) {
        this.renderArena();
        return;
      }
      this.setStatus('');
      this.render();
      if (room.phase === 'lobby') {
        game.prefetchRigs(room.players.filter((p) => p.id !== net.id && p.style).map((p) => p.style!));
      }
    });
    net.on('error', (m) => {
      this.setStatus(m.msg);
      $('arenaStatus').textContent = m.msg;
    });
    net.on('disconnected', () => {
      this.render();
      this.setStatus('Disconnected from the server.');
      $('arenaStatus').textContent = 'Disconnected from the server.';
    });

    // Invite links: ?room=CODE drops you straight into the room.
    const code = new URLSearchParams(location.search).get('room');
    if (code) {
      this.pendingJoin = code.toUpperCase();
      queueMicrotask(() => this.open());
    }
  }

  // ------------------------------------------------------------------ public arena

  /** PLAY ONLINE: into the next public round (or the one in progress). */
  playOnline(): void {
    goLandscape();
    this.game.home.hide();
    this.arena.classList.remove('hidden');
    this.game.warmRigPool();
    $('arenaTitle').textContent = 'PLAY ONLINE';
    $('arenaPrize').textContent = '';
    $('arenaMap').textContent = '';
    $('arenaClock').textContent = '';
    $('arenaCount').textContent = '';
    $('arenaPlayers').innerHTML = '';
    if (this.game.profile.name === 'You') {
      const input = $('arenaName') as HTMLInputElement;
      const typed = input.value.trim().slice(0, 14);
      if (typed && typed.toLowerCase() !== 'you') {
        this.game.renamePlayer(typed);
      } else {
        $('arenaNameRow').classList.remove('hidden');
        $('arenaGo').classList.remove('hidden');
        $('arenaStatus').textContent = 'Pick a name so everyone knows who just shoved them.';
        input.focus();
        return;
      }
    }
    $('arenaNameRow').classList.add('hidden');
    $('arenaGo').classList.add('hidden');
    $('arenaStatus').textContent = 'Finding a round…';
    void this.connect().then((ok) => {
      if (ok) this.game.net.send({ t: 'quick' });
      else $('arenaStatus').textContent = 'Couldn’t reach the game server. Try again, or practice offline.';
    });
    this.startArenaTick();
  }

  /** Back to the arena's waiting screen after a round (we're still in the arena). */
  openArena(): void {
    this.arena.classList.remove('hidden');
    $('arenaNameRow').classList.add('hidden');
    $('arenaGo').classList.add('hidden');
    this.renderArena();
    this.startArenaTick();
  }

  private leaveArena(): void {
    this.game.net.send({ t: 'leave' });
    this.game.net.room = null;
    this.hideArena();
    this.game.state = 'menu';
    this.game.home.show();
  }

  private hideArena(): void {
    this.arena.classList.add('hidden');
    if (this.arenaTick !== null) clearInterval(this.arenaTick);
    this.arenaTick = null;
  }

  private startArenaTick(): void {
    if (this.arenaTick === null) this.arenaTick = window.setInterval(() => this.renderArenaClock(), 250);
  }

  private renderArena(): void {
    const room = this.game.net.room;
    if (!room || !room.public) return;
    const n = room.players.length;
    $('arenaTitle').textContent = room.prizeRound ? 'PRIZE ROUND' : 'WARM-UP ROUND';
    const split = room.split ?? [100];
    const prize =
      split.length > 1
        ? `${money(room.prize, room.currency)} pot · the top ${split.length} get paid (${split.join('/')})`
        : `${money(room.prize, room.currency)} to whoever holds the flag`;
    if (room.phase === 'lobby') {
      $('arenaPrize').textContent = room.prizeRound ? prize : `Prize rounds need ${room.minPlayers} players — ${Math.max(0, room.minPlayers - n)} more to go`;
    } else {
      // The prize is settled when a round starts; joining partway doesn't change it.
      $('arenaPrize').textContent = room.prizeRound ? prize : 'This one’s a warm-up — no prize this round';
    }
    if (room.map) $('arenaMap').innerHTML = `${room.phase === 'playing' ? 'Now on' : 'Next map'}: <b>${esc(mapName(room.map))}</b>`;
    $('arenaCount').textContent = `${n} player${n === 1 ? '' : 's'} here · bots fill the empty spots`;
    $('arenaPlayers').innerHTML = room.players
      .map((p) => `<li><span class="pname">${esc(p.name)}</span>${p.id === this.game.net.id ? '<span class="ptag">you</span>' : ''}</li>`)
      .join('');
    $('arenaStatus').textContent = room.phase === 'playing' ? 'Joining the round in progress…' : room.phase === 'ended' ? 'Round over — next one coming up.' : '';
    this.renderArenaClock();
  }

  private renderArenaClock(): void {
    const room = this.game.net.room;
    if (!room || !room.public || this.arena.classList.contains('hidden')) return;
    if (room.phase === 'lobby' && room.nextAt) {
      const s = Math.max(0, (room.nextAt - this.game.net.serverNow()) / 1000);
      $('arenaClock').textContent = `Next round in ${clock(Math.ceil(s))}`;
    } else if (room.phase === 'playing') {
      $('arenaClock').textContent = 'Round in progress';
    } else {
      $('arenaClock').textContent = '';
    }
  }

  /** Your public-round wins (needs the server). */
  async fetchMe(): Promise<MyWins | null> {
    if (!(await this.connect())) return null;
    return new Promise((resolve) => {
      const timer = window.setTimeout(() => resolve(null), 5000);
      this.game.net.once('me', (m) => {
        clearTimeout(timer);
        resolve(m as unknown as MyWins);
      });
      this.game.net.send({ t: 'me' });
    });
  }

  // ------------------------------------------------------------------ friends rooms

  open(): void {
    this.game.home.hide();
    this.sheet.classList.remove('hidden');
    const name = this.game.profile.name;
    ($('onlineName') as HTMLInputElement).value = name === 'You' ? '' : name;
    this.render();
    this.game.warmRigPool();
    if (this.pendingJoin) {
      const code = this.pendingJoin;
      this.pendingJoin = null;
      ($('joinCode') as HTMLInputElement).value = code;
      if (this.game.profile.name === 'You') {
        this.setStatus('Pick a name, then press JOIN.');
        ($('onlineName') as HTMLInputElement).focus();
      } else {
        void this.withConnection($('onlineName') as HTMLInputElement, () => this.game.net.send({ t: 'join', code }));
      }
    }
  }

  /** After a round: back to whichever room we're in. */
  openFor(room: RoomInfo | null): void {
    if (room?.phase === 'lobby' && room.map) this.game.previewMap(room.map);
    if (room?.public) this.openArena();
    else this.open();
  }

  /** The round is starting: get out of the way. */
  hide(): void {
    this.sheet.classList.add('hidden');
    this.hideArena();
  }

  /** Closing the sheet means leaving the room and going home. */
  close(): void {
    this.sheet.classList.add('hidden');
    if (this.game.mode === 'online') return;
    if (this.game.net.room) {
      this.game.net.send({ t: 'leave' });
      this.game.net.room = null;
      this.render();
    }
    this.game.state = 'menu';
    this.game.home.show();
  }

  setStatus(msg: string): void {
    $('onlineStatus').textContent = msg;
  }

  /** Connect (once) and introduce ourselves. */
  private async connect(): Promise<boolean> {
    const net = this.game.net;
    if (net.connected) return true;
    try {
      await net.connect();
      net.send({ t: 'hello', name: this.game.profile.name, style: this.game.profile.style, secret: playerSecret() });
      return true;
    } catch {
      return false;
    }
  }

  /** Everyone in a room needs a real name — "You" means nothing on a friend's screen. */
  private claimName(input: HTMLInputElement): boolean {
    const name = input.value.trim().slice(0, 14);
    if (!name || name.toLowerCase() === 'you') {
      this.setStatus('Pick a name first so your friends know who you are.');
      input.focus();
      return false;
    }
    if (name !== this.game.profile.name) this.game.renamePlayer(name);
    return true;
  }

  private async withConnection(nameInput: HTMLInputElement, then: () => void): Promise<void> {
    if (!this.claimName(nameInput)) return;
    this.setStatus('Connecting…');
    if (!(await this.connect())) {
      this.setStatus('Couldn’t reach the game server.');
      return;
    }
    this.setStatus('');
    then();
  }

  private inviteLink(code: string): string {
    return `${location.origin}${location.pathname}?room=${code}`;
  }

  private copyInvite(): void {
    const room = this.game.net.room;
    if (!room) return;
    const link = this.inviteLink(room.code);
    navigator.clipboard?.writeText(link).then(
      () => this.setStatus('Invite link copied — send it to your friends!'),
      () => this.setStatus(link),
    );
  }

  private render(): void {
    const net = this.game.net;
    const room: RoomInfo | null = net.room && !net.room.public ? net.room : null;
    $('onlineStart').classList.toggle('hidden', !!room);
    $('onlineRoom').classList.toggle('hidden', !room);
    if (!room) return;
    $('roomCode').textContent = room.code;
    $('roomPlayers').innerHTML = room.players
      .map((p) => {
        const tags = [p.id === room.host ? 'host' : '', p.id === net.id ? 'you' : ''].filter(Boolean).join(' · ');
        return `<li><span class="pname">${esc(p.name)}</span>${tags ? `<span class="ptag">${tags}</span>` : ''}</li>`;
      })
      .join('');
    const host = net.isHost;
    const lobby = room.phase === 'lobby';
    renderMapCards($('roomMaps'), room.map, host && lobby ? (id) => net.send({ t: 'map', map: id }) : null);
    ($('roomBots') as HTMLInputElement).checked = room.bots;
    ($('roomBots') as HTMLInputElement).disabled = !host || !lobby;
    $('roomStart').classList.toggle('hidden', !host || !lobby);
    const wait = $('roomWait');
    wait.classList.toggle('hidden', host && lobby);
    wait.textContent = lobby ? 'Waiting for the host to start…' : 'A round is in progress — you’ll join the next one.';
    const n = room.players.length;
    $('roomCount').textContent = `${n} player${n === 1 ? '' : 's'}${room.bots ? ` + ${Math.max(0, 8 - n)} bots` : ''}`;
  }
}
