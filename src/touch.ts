import { TRAP_KINDS } from './traps';
import type { Game } from './game';

/** Phones and tablets: no hover, a finger for a pointer. */
export const isTouchDevice =
  typeof matchMedia !== 'undefined' && (matchMedia('(hover: none) and (pointer: coarse)').matches || (navigator.maxTouchPoints > 0 && matchMedia('(pointer: coarse)').matches));

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

  private down(e: PointerEvent): void {
    if (e.pointerType === 'mouse') return;
    e.preventDefault();
    this.enable();
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
    if (t.closest('.tFire')) {
      this.firePointer = e.pointerId;
      this.firing = true;
      ctl.queueFire();
      this.lookers.set(e.pointerId, { x: e.clientX, y: e.clientY });
      return;
    }
    if (e.clientX < window.innerWidth * 0.42 && this.movePointer < 0) {
      this.movePointer = e.pointerId;
      this.moveOrigin = { x: e.clientX, y: e.clientY };
      this.stick.style.left = `${e.clientX}px`;
      this.stick.style.top = `${e.clientY}px`;
      this.stick.classList.add('on');
      return;
    }
    this.lookers.set(e.pointerId, { x: e.clientX, y: e.clientY });
  }

  private move(e: PointerEvent): void {
    if (e.pointerId === this.movePointer) {
      let dx = e.clientX - this.moveOrigin.x;
      let dy = e.clientY - this.moveOrigin.y;
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
    this.game.input.addLook((e.clientX - last.x) * LOOK_SPEED, (e.clientY - last.y) * LOOK_SPEED);
    last.x = e.clientX;
    last.y = e.clientY;
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
