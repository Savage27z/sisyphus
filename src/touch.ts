import { TRAP_KINDS } from './traps';
import type { Game } from './game';

/** Phones and tablets: no hover, a finger for a pointer. */
export const isTouchDevice =
  typeof matchMedia !== 'undefined' && (matchMedia('(hover: none) and (pointer: coarse)').matches || (navigator.maxTouchPoints > 0 && matchMedia('(pointer: coarse)').matches));

/**
 * Phones: full screen and sideways. Browsers only allow it straight from a tap, so the buttons
 * that start play call this (Android turns; iPhones can't be turned by a website, see
 * Game.updateRotation for what happens there instead).
 */
export function goLandscape(): void {
  if (!(isTouchDevice || document.body.classList.contains('touch')) || document.fullscreenElement) return;
  document.documentElement
    .requestFullscreen?.({ navigationUI: 'hide' })
    .then(() => (screen.orientation as unknown as { lock?: (o: string) => Promise<void> }).lock?.('landscape'))
    .catch(() => {});
}

const STICK_R = 58; // px the knob can travel
const LOOK_SPEED = 1.6; // swipe pixels → the same turn as this many mouse pixels

/**
 * On-screen controls for touch screens: a move stick wherever your left thumb lands (push it
 * all the way to sprint), swipe on the right to look, FIRE (hold for the Blaster; drag it to aim
 * while shooting), JUMP and PUNCH, trap slots you tap, and a pause button.
 */
export class TouchControls {
  /** The controls are on screen (a touch screen is being used). */
  enabled = false;
  /** The last input was a finger (aim assist). */
  active = false;
  moveX = 0;
  moveY = 0;
  sprint = false;
  firing = false;
  private readonly root: HTMLElement;
  private readonly stick: HTMLElement;
  private readonly knob: HTMLElement;
  private movePointer = -1;
  private moveOrigin = { x: 0, y: 0 };
  /** Pointers that turn the camera (a swipe, or a finger held on FIRE) and where they last were. */
  private readonly lookers = new Map<number, { x: number; y: number }>();
  private firePointer = -1;

  constructor(private readonly game: Game) {
    this.root = document.createElement('div');
    this.root.id = 'touch';
    this.root.innerHTML = `
      <div class="tStick"><div class="tKnob"></div></div>
      <button class="tBtn tFire" aria-label="Fire">FIRE</button>
      <button class="tBtn tJump" aria-label="Jump">JUMP</button>
      <button class="tBtn tMelee" aria-label="Punch">PUNCH</button>
      <button class="tPause" aria-label="Pause">II</button>
      <div id="rotateHint">Turn your phone sideways ↻</div>`;
    document.getElementById('hud')!.appendChild(this.root);
    this.stick = this.root.querySelector('.tStick')!;
    this.knob = this.root.querySelector('.tKnob')!;

    this.root.addEventListener('pointerdown', (e) => this.down(e));
    window.addEventListener('pointermove', (e) => this.move(e));
    window.addEventListener('pointerup', (e) => this.up(e));
    window.addEventListener('pointercancel', (e) => this.up(e));
    // Long-presses shouldn't open menus or select text.
    this.root.addEventListener('contextmenu', (e) => e.preventDefault());

    // Tap a trap slot to drop it.
    document.querySelectorAll<HTMLElement>('#trapSlots .slot').forEach((slot, i) =>
      slot.addEventListener('pointerdown', (e) => {
        if (!this.enabled) return;
        e.preventDefault();
        this.game.playerCtl.queueTrap(TRAP_KINDS[i]);
      }),
    );

    if (isTouchDevice) this.enable();
    window.addEventListener('touchstart', () => this.enable(), { passive: true });
    // Back on a keyboard, mouse or controller: the touch controls get out of the way.
    window.addEventListener('keydown', () => (this.active = false));
  }

  private enable(): void {
    this.active = true;
    if (this.enabled) return;
    this.enabled = true;
    document.body.classList.add('touch');
  }

  /** Called each frame: hide the controls while a controller is in use. */
  update(): void {
    document.body.classList.toggle('touchHidden', this.game.input.pad.active);
  }

  /** Round over or paused: let go of everything. */
  release(): void {
    this.movePointer = this.firePointer = -1;
    this.lookers.clear();
    this.moveX = this.moveY = 0;
    this.sprint = this.firing = false;
    this.restStick();
  }

  /** Back to its resting place (bottom left). */
  private restStick(): void {
    this.stick.classList.remove('on');
    this.stick.style.left = this.stick.style.top = '';
    this.knob.style.transform = '';
  }

  /** Where a finger is in the game's own frame, which is a quarter turn round when the game is. */
  private local(e: PointerEvent): { x: number; y: number } {
    if (!document.body.classList.contains('rotated')) return { x: e.clientX, y: e.clientY };
    return { x: e.clientY, y: window.innerWidth - e.clientX };
  }

  private down(e: PointerEvent): void {
    if (e.pointerType === 'mouse') return;
    e.preventDefault();
    this.enable();
    // A touchscreen laptop that started with the mouse: let go of the pointer lock, which zeroes
    // finger positions. This touch is lost; the next one works.
    if (document.pointerLockElement) {
      document.exitPointerLock();
      return;
    }
    const ctl = this.game.playerCtl;
    const t = e.target as HTMLElement;
    if (t.closest('.tPause')) {
      this.release();
      this.game.openPause();
      return;
    }
    if (t.closest('.tJump')) {
      ctl.queueJump();
      return;
    }
    if (t.closest('.tMelee')) {
      ctl.queueMelee();
      return;
    }
    const p = this.local(e);
    if (t.closest('.tFire')) {
      this.firePointer = e.pointerId;
      this.firing = true;
      ctl.queueFire();
      this.lookers.set(e.pointerId, p);
      return;
    }
    if (p.x < this.game.viewW * 0.42 && this.movePointer < 0) {
      this.movePointer = e.pointerId;
      this.moveOrigin = p;
      this.stick.style.left = `${p.x}px`;
      this.stick.style.top = `${p.y}px`;
      this.stick.classList.add('on');
      return;
    }
    this.lookers.set(e.pointerId, p);
  }

  private move(e: PointerEvent): void {
    const p = this.local(e);
    if (e.pointerId === this.movePointer) {
      let dx = p.x - this.moveOrigin.x;
      let dy = p.y - this.moveOrigin.y;
      const len = Math.hypot(dx, dy);
      if (len > STICK_R) {
        dx *= STICK_R / len;
        dy *= STICK_R / len;
      }
      this.moveX = dx / STICK_R;
      this.moveY = dy / STICK_R;
      this.sprint = len > STICK_R * 0.95;
      this.knob.style.transform = `translate(${dx}px, ${dy}px)`;
      return;
    }
    const last = this.lookers.get(e.pointerId);
    if (!last) return;
    this.game.input.addLook((p.x - last.x) * LOOK_SPEED, (p.y - last.y) * LOOK_SPEED);
    last.x = p.x;
    last.y = p.y;
  }

  private up(e: PointerEvent): void {
    if (e.pointerId === this.movePointer) {
      this.movePointer = -1;
      this.moveX = this.moveY = 0;
      this.sprint = false;
      this.restStick();
    }
    if (e.pointerId === this.firePointer) {
      this.firePointer = -1;
      this.firing = false;
    }
    this.lookers.delete(e.pointerId);
  }
}
