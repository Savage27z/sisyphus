import * as THREE from 'three';
import { money } from './money';
import { CONFIG, TOWER_HEIGHT, floorOf } from './config';
import { WEAPONS } from './combat';
import { TRAP_KINDS, TRAP_NAMES } from './traps';
import type { Character } from './character';
import type { Game } from './game';
import type { MapInfo } from './maps';

const $ = (id: string) => document.getElementById(id)!;
const hex = (c: number) => '#' + new THREE.Color(c).getHexString();

/** DOM overlay: floor meter, race bar, inventory, popups, kill feed, markers. */
export class Hud {
  private readonly root = $('hud');
  private readonly floorNum = $('floorNum');
  private readonly heightM = $('heightM');
  private readonly floorName = $('floorName');
  private readonly timer = $('timer');
  private readonly flagStatus = $('flagStatus');
  private readonly holdBar = $('holdBar');
  private readonly holdFill = $('holdFill');
  private readonly hpFill = $('hpFill');
  private readonly weapon = $('weapon');
  private readonly popupEl = $('popup');
  private readonly mapEl = $('mapTitle');
  private readonly feedEl = $('feed');
  private readonly raceTrack = $('raceTrack');
  private readonly markersEl = $('markers');
  private readonly slots: HTMLElement[] = [];
  private readonly dots = new Map<Character, HTMLElement>();
  private readonly markerPool: HTMLElement[] = [];
  private readonly tmp = new THREE.Vector3();

  constructor(private readonly game: Game) {
    const slotsEl = $('trapSlots');
    TRAP_KINDS.forEach((k, i) => {
      const s = document.createElement('div');
      s.className = 'slot';
      s.innerHTML = `<b>${i + 1}</b>${TRAP_NAMES[k]}<div class="n">0</div>`;
      slotsEl.appendChild(s);
      this.slots.push(s);
    });
  }

  setVisible(v: boolean): void {
    this.root.classList.toggle('hidden', !v);
    this.game.updateRotation();
  }

  get visible(): boolean {
    return !this.root.classList.contains('hidden');
  }

  popup(text: string, color = '#ffffff', small = false): void {
    const p = this.popupEl;
    p.textContent = text;
    p.style.color = color;
    p.classList.toggle('small', small);
    p.classList.remove('show');
    void p.offsetWidth; // restart the CSS animation
    p.classList.add('show');
  }

  /** Round start: which map this is. */
  showMap(map: MapInfo): void {
    const el = this.mapEl;
    el.innerHTML = '';
    const name = document.createElement('b');
    name.textContent = map.name;
    name.style.color = map.color;
    const blurb = document.createElement('span');
    blurb.textContent = map.blurb;
    el.append(name, blurb);
    el.classList.remove('show');
    void el.offsetWidth; // restart the CSS animation
    el.classList.add('show');
  }

  feed(text: string): void {
    const d = document.createElement('div');
    d.className = 'feedItem';
    d.textContent = text;
    this.feedEl.prepend(d);
    while (this.feedEl.children.length > 5) this.feedEl.lastElementChild!.remove();
    setTimeout(() => d.remove(), 6000);
  }

  clearFeed(): void {
    this.feedEl.innerHTML = '';
    this.popupEl.classList.remove('show');
    this.mapEl.classList.remove('show');
  }

  /** Public rounds: the prize on offer (or that it counts for the cup), under the timer. */
  setPrize(room: { prizeRound: boolean; prize: number; currency: string; minPlayers: number; cupRound?: boolean } | null): void {
    const el = document.getElementById('prizeBadge')!;
    el.classList.toggle('hidden', !room);
    if (!room) return;
    el.textContent = room.cupRound ? 'CUP ROUND · POINTS COUNT' : room.prizeRound ? `${money(room.prize, room.currency)} PRIZE ROUND` : 'WARM-UP ROUND';
    el.classList.toggle('warmup', !room.prizeRound && !room.cupRound);
  }

  update(): void {
    const game = this.game;
    const p = game.player;
    const feet = Math.max(0, p.feetY);
    const fl = floorOf(feet);
    this.floorNum.textContent = fl >= CONFIG.FLOORS ? 'TOP' : String(fl);
    const names = game.tower.floorNames;
    this.floorName.textContent = names[Math.min(fl, names.length - 1)];
    this.heightM.textContent = `${feet.toFixed(1)} m`;

    const left = Math.max(0, game.matchSeconds - game.time);
    this.timer.textContent = `${Math.floor(left / 60)}:${String(Math.floor(left % 60)).padStart(2, '0')}`;
    this.timer.classList.toggle('urgent', left < 30);

    this.hpFill.style.width = `${(p.hp / CONFIG.HP_MAX) * 100}%`;
    const gun = WEAPONS[p.weapon];
    const melee = WEAPONS[p.melee];
    const count = (n: number) => (Number.isFinite(n) ? ` ×${n}` : '');
    this.weapon.textContent = `${gun.name}${count(p.weaponUses)} · ${melee.name}${count(p.meleeUses)}`;
    TRAP_KINDS.forEach((k, i) => {
      const n = p.traps[k];
      (this.slots[i].lastElementChild as HTMLElement).textContent = String(n);
      this.slots[i].classList.toggle('empty', n <= 0);
    });

    const h = game.flag.holder;
    if (h) {
      const left = Math.max(0, CONFIG.FLAG_HOLD_SECONDS - game.flag.holdTime);
      this.flagStatus.textContent = `${h.isPlayer ? 'YOU HAVE' : h.name.toUpperCase() + ' HAS'} THE FLAG — ${left.toFixed(1)}s`;
      this.flagStatus.style.color = hex(h.color);
      this.holdBar.classList.remove('hidden');
      this.holdFill.style.width = `${(game.flag.holdTime / Math.max(0.01, CONFIG.FLAG_HOLD_SECONDS)) * 100}%`;
      this.holdFill.style.background = hex(h.color);
    } else {
      this.flagStatus.textContent = '';
      this.holdBar.classList.add('hidden');
    }

    for (const c of game.characters) {
      let dot = this.dots.get(c);
      if (!dot) {
        dot = document.createElement('div');
        dot.className = c.isPlayer ? 'dot me' : 'dot';
        dot.style.background = hex(c.color);
        const label = document.createElement('span');
        label.textContent = c.isPlayer ? 'YOU' : c.name;
        dot.appendChild(label);
        this.raceTrack.appendChild(dot);
        this.dots.set(c, dot);
      }
      dot.style.bottom = `${THREE.MathUtils.clamp(c.feetY / TOWER_HEIGHT, 0, 1) * 100}%`;
    }
    // Fighters who left (online) or a rebuilt roster: drop their dots.
    if (this.dots.size > game.characters.length) {
      for (const [c, dot] of this.dots) {
        if (!game.characters.includes(c)) {
          dot.remove();
          this.dots.delete(c);
        }
      }
    }

    this.updateMarkers();
  }

  private updateMarkers(): void {
    const game = this.game;
    const cam = game.cam.cam;
    const W = game.viewW;
    const H = game.viewH;
    const items: { pos: THREE.Vector3; text: string; color: string }[] = [];
    // Racks are part of the floor plan; only parachuted supply drops get a marker.
    for (const crate of game.airdrops.crates) {
      if (crate.rack) continue;
      const pos = new THREE.Vector3(crate.target.x, crate.y + 1.4, crate.target.z);
      items.push({ pos, text: `SUPPLY ${Math.round(pos.distanceTo(game.player.pos))}m`, color: '#ffe066' });
    }
    const holder = game.flag.holder;
    if (holder !== game.player) {
      const pos = holder ? holder.pos.clone().add(new THREE.Vector3(0, 1.6, 0)) : game.tower.flagPos.clone().add(new THREE.Vector3(0, 3.6, 0));
      const d = Math.round(pos.distanceTo(game.player.pos));
      items.push({ pos, text: holder ? `FLAG — ${holder.name}` : `FLAG ${d}m`, color: '#ff5a4a' });
    }

    items.forEach((it, i) => {
      let el = this.markerPool[i];
      if (!el) {
        el = document.createElement('div');
        el.className = 'marker';
        el.innerHTML = '<div class="t"></div><div class="gem"></div>';
        this.markersEl.appendChild(el);
        this.markerPool.push(el);
      }
      const v = this.tmp.copy(it.pos).project(cam);
      let x = (v.x * 0.5 + 0.5) * W;
      let y = (-v.y * 0.5 + 0.5) * H;
      const behind = v.z > 1;
      if (behind) {
        // Behind the camera: mirror and pin to the bottom of the safe area.
        x = W - x;
        y = H;
      }
      // Keep markers inside a safe area clear of the HUD corners and bottom bar.
      const offscreen = behind || x < 90 || x > W - 90 || y < 200 || y > H - 180;
      x = THREE.MathUtils.clamp(x, 90, W - 90);
      y = THREE.MathUtils.clamp(y, 200, H - 180);
      el.classList.toggle('edge', offscreen);
      el.style.display = '';
      el.style.left = `${x}px`;
      el.style.top = `${y}px`;
      el.style.color = it.color;
      (el.firstElementChild as HTMLElement).textContent = it.text;
      (el.lastElementChild as HTMLElement).style.background = it.color;
    });
    for (let i = items.length; i < this.markerPool.length; i++) this.markerPool[i].style.display = 'none';
  }
}
