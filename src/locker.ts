import * as THREE from 'three';
import {
  BASE_NAMES,
  EYE_COLORS,
  EYE_NAMES,
  HAIR_COLORS,
  HAIR_NAMES,
  HAT_NAMES,
  OUTFITS,
  OUTFIT_NAMES,
  PRESETS,
  randomStyle,
  type Style,
} from './style';
import type { Game } from './game';

type Field = keyof Style;

const PREVIEW_SPOT = new THREE.Vector3(-12, 0, 0);

/** Character customisation screen with a turntable preview of your fighter. */
export class Locker {
  private style!: Style;
  private name = 'You';
  private spin = 0;
  private pending: Promise<void> = Promise.resolve();
  private readonly root = document.getElementById('locker')!;
  private readonly opts = document.getElementById('lockerOptions')!;
  private readonly nameInput = document.getElementById('lockerName') as HTMLInputElement;
  private readonly status = document.getElementById('lockerStatus')!;

  constructor(private readonly game: Game) {
    document.getElementById('lockerDone')!.addEventListener('click', () => this.close());
    document.getElementById('lockerRandom')!.addEventListener('click', () => this.apply({ ...randomStyle() }));
    this.nameInput.addEventListener('change', () => {
      this.name = this.nameInput.value.trim().slice(0, 14) || 'You';
      this.commit();
    });
    // Keep typing in the name box from triggering game keys.
    this.nameInput.addEventListener('keydown', (e) => e.stopPropagation());
  }

  open(): void {
    this.style = { ...this.game.profile.style };
    this.name = this.game.profile.name;
    this.nameInput.value = this.name;
    this.game.player.teleport(PREVIEW_SPOT);
    this.render();
    this.root.classList.remove('hidden');
  }

  private close(): void {
    this.root.classList.add('hidden');
    void this.pending.then(() => this.game.closeLocker());
  }

  updateCamera(dt: number): void {
    this.spin += dt * 0.6;
    const p = this.game.player;
    p.yaw = Math.PI / 2 + Math.sin(this.spin) * 0.9;
    const cam = this.game.cam.cam;
    const target = new THREE.Vector3(p.pos.x, p.pos.y + 0.25, p.pos.z);
    // Offset so the fighter sits on the right, clear of the options panel.
    cam.position.set(target.x + 2.7, target.y + 0.35, target.z + 0.9);
    cam.lookAt(target.x, target.y, target.z + 0.9);
  }

  private apply(next: Partial<Style>): void {
    this.style = { ...this.style, ...next };
    this.render();
    this.commit();
  }

  private commit(): void {
    const style = { ...this.style };
    const name = this.name;
    this.status.textContent = 'Updating…';
    this.pending = this.pending
      .then(() => this.game.setPlayerStyle(style, name))
      .catch((e: unknown) => console.error(e))
      .then(() => {
        this.status.textContent = '';
      });
  }

  private render(): void {
    const s = this.style;
    const section = (title: string, items: string[], field: Field, swatch?: (i: number) => string[]) => {
      const wrap = document.createElement('div');
      wrap.className = 'lockerSection';
      wrap.innerHTML = `<h3>${title}<span>${items[s[field]]}</span></h3>`;
      const row = document.createElement('div');
      row.className = 'chips';
      items.forEach((label, i) => {
        const b = document.createElement('button');
        b.className = 'chip' + (s[field] === i ? ' on' : '');
        b.title = label;
        const colors = swatch?.(i);
        if (colors && colors.length) {
          b.classList.add('swatch');
          b.style.background = colors.length === 1 ? colors[0] : `linear-gradient(135deg, ${colors.map((c, k) => `${c} ${(k * 100) / colors.length}% ${((k + 1) * 100) / colors.length}%`).join(', ')})`;
        } else {
          b.textContent = label;
        }
        b.addEventListener('click', () => this.apply({ [field]: i }));
        row.appendChild(b);
      });
      wrap.appendChild(row);
      return wrap;
    };

    this.opts.innerHTML = '';
    const presets = document.createElement('div');
    presets.className = 'lockerSection';
    presets.innerHTML = '<h3>Looks</h3>';
    const prow = document.createElement('div');
    prow.className = 'chips';
    for (const p of PRESETS) {
      const b = document.createElement('button');
      b.className = 'chip preset';
      b.textContent = p.name;
      b.title = p.blurb;
      b.addEventListener('click', () => this.apply({ ...p.style }));
      prow.appendChild(b);
    }
    presets.appendChild(prow);
    this.opts.appendChild(presets);
    this.opts.appendChild(section('Fighter', BASE_NAMES, 'base'));
    const natural = (hex: string | null) => (hex ? [hex] : ['#ffffff', '#d9d4cc']);
    this.opts.appendChild(section('Hair', HAIR_NAMES, 'hair', (i) => natural(HAIR_COLORS[i])));
    this.opts.appendChild(section('Outfit', OUTFIT_NAMES, 'outfit', (i) => OUTFITS[i] ?? ['#ffffff', '#d9d4cc']));
    this.opts.appendChild(section('Eyes', EYE_NAMES, 'eyes', (i) => natural(EYE_COLORS[i])));
    this.opts.appendChild(section('Headgear', HAT_NAMES, 'hat'));
  }
}
