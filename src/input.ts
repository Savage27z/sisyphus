import { Pad } from './gamepad';

export class Input {
  readonly keys = new Set<string>();
  /** A game controller, if one's plugged in (polled by the game each frame). */
  readonly pad = new Pad();
  locked = false;
  mouseHeld = false;
  mouseClicked = false;
  rightClicked = false;
  private dragging = false;
  private dx = 0;
  private dy = 0;
  private wheel = 0;
  private pressed: string[] = [];

  constructor(private readonly el: HTMLElement) {
    window.addEventListener('keydown', (e) => {
      this.pad.active = false;
      if (!e.repeat) this.pressed.push(e.code);
      this.keys.add(e.code);
      if (e.code === 'Space' || e.code === 'Tab') e.preventDefault();
    });
    window.addEventListener('keyup', (e) => this.keys.delete(e.code));
    window.addEventListener('blur', () => {
      this.keys.clear();
      this.mouseHeld = false;
    });
    document.addEventListener('mousemove', (e) => {
      // Mouse-locked: free look. Not locked (lock refused by the browser): drag to look.
      if (!this.locked && !this.dragging) return;
      this.dx += e.movementX;
      this.dy += e.movementY;
    });
    el.addEventListener('mousedown', (e) => {
      this.pad.active = false;
      if (!this.locked) {
        this.dragging = true;
        return;
      }
      if (e.button === 2) {
        this.rightClicked = true;
        return;
      }
      if (e.button !== 0) return;
      this.mouseClicked = true;
      this.mouseHeld = true;
    });
    el.addEventListener('contextmenu', (e) => e.preventDefault());
    window.addEventListener('mouseup', (e) => {
      this.dragging = false;
      if (e.button === 0) this.mouseHeld = false;
    });
    window.addEventListener('wheel', (e) => (this.wheel += Math.sign(e.deltaY)), { passive: true });
    document.addEventListener('pointerlockchange', () => {
      this.locked = document.pointerLockElement === this.el;
      if (!this.locked) this.mouseHeld = false;
    });
  }

  requestLock(): void {
    try {
      const p = this.el.requestPointerLock() as unknown as Promise<void> | undefined;
      p?.catch?.(() => {});
    } catch {
      /* not allowed outside a user gesture */
    }
  }

  down(code: string): boolean {
    return this.keys.has(code);
  }

  consumePressed(): string[] {
    const p = this.pressed;
    this.pressed = [];
    return p;
  }

  consumeMouse(): { dx: number; dy: number; wheel: number } {
    const r = { dx: this.dx, dy: this.dy, wheel: this.wheel };
    this.dx = this.dy = this.wheel = 0;
    return r;
  }
}
