import type { Game } from './game';

/** Buttons in the browser's "standard" gamepad layout (Xbox names; PlayStation in brackets). */
export const BTN = {
  A: 0, // ✕
  B: 1, // ○
  X: 2, // □
  Y: 3, // △
  LB: 4, // L1
  RB: 5, // R1
  LT: 6, // L2
  RT: 7, // R2
  Back: 8, // Share
  Start: 9, // Options
  L3: 10,
  R3: 11,
  Up: 12,
  Down: 13,
  Left: 14,
  Right: 15,
} as const;

const DEAD = 0.16;

/** Radial deadzone, rescaled so just past the deadzone is just above zero. */
function stick(x: number, y: number): [number, number] {
  const m = Math.hypot(x, y);
  if (m < DEAD) return [0, 0];
  const k = Math.min(1, (m - DEAD) / (1 - DEAD)) / m;
  return [x * k, y * k];
}

interface Rumbler {
  playEffect?(type: string, params: { duration: number; strongMagnitude: number; weakMagnitude: number }): Promise<unknown>;
}

/** The first connected controller, polled once a frame. */
export class Pad {
  connected = false;
  /** The last thing used was the controller (not mouse or keyboard): aim assist, focus rings. */
  active = false;
  lx = 0;
  ly = 0;
  rx = 0;
  ry = 0;
  lt = 0;
  rt = 0;
  private held: boolean[] = [];
  private prev: boolean[] = [];
  private index = -1;

  poll(): void {
    const pads = navigator.getGamepads ? navigator.getGamepads() : [];
    let gp: Gamepad | null = null;
    for (const p of pads) {
      if (!p || !p.connected) continue;
      if (!gp || (p.mapping === 'standard' && gp.mapping !== 'standard')) gp = p;
    }
    this.prev = this.held;
    if (!gp) {
      this.connected = false;
      this.held = [];
      this.lx = this.ly = this.rx = this.ry = this.lt = this.rt = 0;
      return;
    }
    this.connected = true;
    this.index = gp.index;
    [this.lx, this.ly] = stick(gp.axes[0] ?? 0, gp.axes[1] ?? 0);
    [this.rx, this.ry] = stick(gp.axes[2] ?? 0, gp.axes[3] ?? 0);
    this.held = gp.buttons.map((b) => b.pressed || b.value > 0.5);
    this.lt = gp.buttons[BTN.LT]?.value ?? 0;
    this.rt = gp.buttons[BTN.RT]?.value ?? 0;
    if (this.held.some(Boolean) || this.lx || this.ly || this.rx || this.ry) this.active = true;
  }

  down(b: number): boolean {
    return !!this.held[b];
  }

  /** Went down since the last poll. */
  pressed(b: number): boolean {
    return !!this.held[b] && !this.prev[b];
  }

  rumble(strong: number, weak: number, ms: number): void {
    if (!this.connected || !this.active) return;
    const gp = navigator.getGamepads?.()[this.index];
    const act = (gp as unknown as { vibrationActuator?: Rumbler } | null)?.vibrationActuator;
    act?.playEffect?.('dual-rumble', { duration: ms, strongMagnitude: strong, weakMagnitude: weak })?.catch(() => {});
  }
}

const FOCUSABLE = 'button, a[href], input, select';

const shown = (el: Element) => !el.closest('.hidden') && el.getClientRects().length > 0 && getComputedStyle(el).visibility !== 'hidden';

/**
 * Menus with a controller: the d-pad or left stick moves a highlight between the buttons of
 * whatever's on top (home page, a sheet, the pause or results screen, the locker), A presses,
 * B goes back, left/right change sliders.
 */
export class PadNav {
  /** A menu is on screen and has the controller (the game ignores it meanwhile). */
  capturing = false;
  private layer: HTMLElement | null = null;
  private focused: HTMLElement | null = null;
  private repeatDir = '';
  private repeatAt = 0;
  private readonly toast: HTMLElement;

  constructor(private readonly game: Game) {
    // Back on the mouse: drop the highlight.
    window.addEventListener('mousemove', (e) => {
      if (Math.abs(e.movementX) + Math.abs(e.movementY) < 2) return;
      this.game.input.pad.active = false;
      this.clear();
    });
    this.toast = document.createElement('div');
    this.toast.className = 'padToast';
    document.body.appendChild(this.toast);
    window.addEventListener('gamepadconnected', () => this.say('Controller connected'));
    window.addEventListener('gamepaddisconnected', () => this.say('Controller disconnected'));
  }

  private say(text: string): void {
    this.toast.textContent = text;
    this.toast.classList.remove('show');
    void this.toast.offsetWidth;
    this.toast.classList.add('show');
  }

  /** Which menu is in front, if any. */
  private activeLayer(): HTMLElement | null {
    const sheets = [...document.querySelectorAll<HTMLElement>('.sheetOverlay')].filter(shown);
    if (sheets.length) return sheets[sheets.length - 1];
    for (const id of ['end', 'pause', 'locker']) {
      const el = document.getElementById(id);
      if (el && shown(el)) return el;
    }
    const st = this.game.state;
    if (st === 'menu' || st === 'lobby') {
      const home = document.getElementById('menu');
      if (home && shown(home)) return home;
    }
    return null;
  }

  private items(): HTMLElement[] {
    if (!this.layer) return [];
    return [...this.layer.querySelectorAll<HTMLElement>(FOCUSABLE)].filter((el) => !(el as HTMLButtonElement).disabled && shown(el));
  }

  private clear(): void {
    this.focused?.classList.remove('padFocus');
    this.focused = null;
  }

  private focus(el: HTMLElement | null): void {
    if (this.focused === el) return;
    this.clear();
    if (!el) return;
    this.focused = el;
    el.classList.add('padFocus');
    el.scrollIntoView({ block: 'nearest', inline: 'nearest' });
  }

  private pickDefault(): HTMLElement | null {
    const items = this.items();
    return items.find((el) => el.matches('.bigPlay, #resumeBtn, #againBtn, #lockerDone, .mapCard.selected')) ?? items.find((el) => !el.matches('.closeX')) ?? items[0] ?? null;
  }

  update(now: number): void {
    const pad = this.game.input.pad;
    const layer = pad.connected ? this.activeLayer() : null;
    this.capturing = !!layer;
    if (!layer) {
      if (this.layer) this.clear();
      this.layer = null;
      return;
    }
    if (layer !== this.layer) {
      this.layer = layer;
      this.clear();
    }
    if (this.focused && (!this.focused.isConnected || !shown(this.focused))) this.clear();
    if (!pad.active) return;

    const dir =
      pad.down(BTN.Up) || pad.ly < -0.55
        ? 'up'
        : pad.down(BTN.Down) || pad.ly > 0.55
          ? 'down'
          : pad.down(BTN.Left) || pad.lx < -0.55
            ? 'left'
            : pad.down(BTN.Right) || pad.lx > 0.55
              ? 'right'
              : '';
    if (dir) {
      if (dir !== this.repeatDir) {
        this.move(dir);
        this.repeatDir = dir;
        this.repeatAt = now + 380;
      } else if (now >= this.repeatAt) {
        this.move(dir);
        this.repeatAt = now + 110;
      }
    } else {
      this.repeatDir = '';
    }
    if (pad.pressed(BTN.A)) this.activate();
    if (pad.pressed(BTN.B)) this.back();
    if (pad.pressed(BTN.Start) && layer.id === 'pause') document.getElementById('resumeBtn')?.click();
  }

  private move(dir: string): void {
    const cur = this.focused;
    if (!cur) {
      this.focus(this.pickDefault());
      return;
    }
    // Sliders and dropdowns take left/right themselves.
    if ((dir === 'left' || dir === 'right') && this.adjust(cur, dir === 'right' ? 1 : -1)) return;
    const a = cur.getBoundingClientRect();
    const ax = a.left + a.width / 2;
    const ay = a.top + a.height / 2;
    let best: HTMLElement | null = null;
    let bestScore = Infinity;
    for (const el of this.items()) {
      if (el === cur) continue;
      const b = el.getBoundingClientRect();
      const bx = b.left + b.width / 2;
      const by = b.top + b.height / 2;
      const horiz = dir === 'left' || dir === 'right';
      const primary = dir === 'right' ? b.left - a.right : dir === 'left' ? a.left - b.right : dir === 'down' ? b.top - a.bottom : a.top - b.bottom;
      const centre = dir === 'right' ? bx - ax : dir === 'left' ? ax - bx : dir === 'down' ? by - ay : ay - by;
      if (centre <= 1 || primary < -Math.min(a.width, a.height) * 0.5) continue;
      // Overlapping on the other axis counts as straight ahead.
      const overlap = horiz ? Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top) : Math.min(a.right, b.right) - Math.max(a.left, b.left);
      const off = overlap > 0 ? 0 : horiz ? Math.abs(by - ay) : Math.abs(bx - ax);
      const score = Math.max(0, primary) + off * 2.5;
      if (score < bestScore) {
        bestScore = score;
        best = el;
      }
    }
    if (best) this.focus(best);
  }

  private adjust(el: HTMLElement, step: number): boolean {
    if (el instanceof HTMLInputElement && el.type === 'range') {
      const min = Number(el.min || 0);
      const max = Number(el.max || 100);
      el.value = String(Math.min(max, Math.max(min, Number(el.value) + step * Math.max(1, Math.round((max - min) / 20)))));
      el.dispatchEvent(new Event('input', { bubbles: true }));
      el.dispatchEvent(new Event('change', { bubbles: true }));
      return true;
    }
    if (el instanceof HTMLSelectElement) {
      el.selectedIndex = Math.min(el.options.length - 1, Math.max(0, el.selectedIndex + step));
      el.dispatchEvent(new Event('change', { bubbles: true }));
      return true;
    }
    return false;
  }

  private activate(): void {
    const el = this.focused;
    if (!el) {
      this.focus(this.pickDefault());
      return;
    }
    if (el instanceof HTMLInputElement && el.type !== 'checkbox' && el.type !== 'range') {
      el.focus();
      return;
    }
    el.click();
  }

  private back(): void {
    const layer = this.layer;
    if (!layer) return;
    const close = [...layer.querySelectorAll<HTMLElement>('.closeX, #arenaLeave, #roomLeave')].find(shown);
    if (close) close.click();
    else if (layer.id === 'pause') document.getElementById('resumeBtn')?.click();
    else if (layer.id === 'locker') document.getElementById('lockerDone')?.click();
  }
}
