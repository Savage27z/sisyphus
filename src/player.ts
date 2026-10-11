import * as THREE from 'three';
import { WEAPONS } from './combat';
import { CONFIG } from './config';
import { BTN } from './gamepad';
import { TRAP_KINDS, type TrapKind } from './traps';
import type { Game } from './game';

const toTarget = new THREE.Vector3();

/** Maps keyboard/mouse (and a controller) into the player's Character intents. */
export class PlayerController {
  private jumpBuffer = 0;
  private trapQueued: TrapKind | null = null;
  private attackQueued = false;
  private meleeQueued = false;
  /** Controller: right trigger held (automatic guns keep firing). */
  private padFire = false;
  /** Controller: clicked the left stick to sprint (until the stick is let go). */
  private sprintLatch = false;

  constructor(private readonly game: Game) {}

  reset(): void {
    this.jumpBuffer = 0;
    this.trapQueued = null;
    this.attackQueued = false;
    this.meleeQueued = false;
    this.padFire = false;
    this.sprintLatch = false;
  }

  // On-screen buttons (touch screens).
  queueJump(): void {
    this.jumpBuffer = CONFIG.JUMP_BUFFER;
  }

  queueFire(): void {
    this.attackQueued = true;
  }

  queueMelee(): void {
    this.meleeQueued = true;
  }

  queueTrap(kind: TrapKind): void {
    this.trapQueued = kind;
  }

  handleKeys(codes: string[]): void {
    for (const code of codes) {
      if (code === 'Space') this.jumpBuffer = CONFIG.JUMP_BUFFER;
      if (code === 'KeyF') this.attackQueued = true;
      if (code === 'KeyE') this.meleeQueued = true;
      const m = /^Digit([1-4])$/.exec(code);
      if (m) this.trapQueued = TRAP_KINDS[Number(m[1]) - 1];
    }
  }

  /**
   * Controller, once a frame: A jump, RT shoot (hold for the Blaster), RB or X melee,
   * LB (or click the left stick) sprint, d-pad traps, Y camera distance, Start pause.
   */
  handlePad(): void {
    const pad = this.game.input.pad;
    if (!pad.connected) {
      this.padFire = false;
      return;
    }
    if (pad.pressed(BTN.A)) this.jumpBuffer = CONFIG.JUMP_BUFFER;
    if (pad.pressed(BTN.RT)) this.attackQueued = true;
    this.padFire = pad.rt > 0.5;
    if (pad.pressed(BTN.RB) || pad.pressed(BTN.X)) this.meleeQueued = true;
    if (pad.pressed(BTN.L3)) this.sprintLatch = !this.sprintLatch;
    if (!pad.lx && !pad.ly) this.sprintLatch = false;
    const traps: [number, TrapKind][] = [
      [BTN.Up, TRAP_KINDS[0]],
      [BTN.Right, TRAP_KINDS[1]],
      [BTN.Down, TRAP_KINDS[2]],
      [BTN.Left, TRAP_KINDS[3]],
    ];
    for (const [b, kind] of traps) if (pad.pressed(b)) this.trapQueued = kind;
    if (pad.pressed(BTN.Y)) this.game.cam.cycleDistance();
    if (pad.pressed(BTN.Start)) this.game.openPause();
  }

  fixedUpdate(dt: number): void {
    const { input, cam, player: c, touch } = this.game;
    const pad = input.pad;
    const usePad = pad.connected && !this.game.padNav.capturing;
    const key = (...codes: string[]) => codes.some((k) => input.down(k));
    let f = (key('KeyW', 'ArrowUp') ? 1 : 0) - (key('KeyS', 'ArrowDown') ? 1 : 0);
    let r = (key('KeyD', 'ArrowRight') ? 1 : 0) - (key('KeyA', 'ArrowLeft') ? 1 : 0);
    // The stick is analog: tilt it a little to walk slowly. Pushed (nearly) all the way counts as
    // full and sprints, like the touch stick.
    const padTilt = usePad ? Math.hypot(pad.lx, pad.ly) : 0;
    const padFull = padTilt > 0.88;
    if (padTilt > 0) {
      const k = padFull ? 1 / padTilt : 1;
      f = -pad.ly * k;
      r = pad.lx * k;
    }
    if (touch.enabled && (touch.moveX || touch.moveY)) {
      f = -touch.moveY;
      r = touch.moveX;
    }
    const s = Math.sin(cam.yaw);
    const co = Math.cos(cam.yaw);
    c.input.moveX = s * f - co * r;
    c.input.moveZ = co * f + s * r;
    c.input.sprint = key('ShiftLeft', 'ShiftRight') || (usePad && (pad.down(BTN.LB) || this.sprintLatch || padFull)) || touch.sprint;
    c.yaw = cam.yaw;
    this.jumpBuffer = Math.max(0, this.jumpBuffer - dt);
    c.input.jump = this.jumpBuffer > 0;

    // Shoot: one shot per click (or F, or trigger pull); automatic guns keep firing while held.
    const auto = WEAPONS[c.weapon].auto && (input.mouseHeld || key('KeyF') || (usePad && this.padFire) || touch.firing);
    if (input.mouseClicked || this.attackQueued || auto) {
      const aim = cam.aim();
      if (pad.active || touch.active) this.assist(aim);
      const heavy = c.weapon === 'rocket' || c.weapon === 'railgun' || c.weapon === 'pushgun';
      if (this.game.combat.shoot(c, aim) && heavy) pad.rumble(0.35, 0.5, 90);
      input.mouseClicked = false;
      this.attackQueued = false;
    }
    // Melee: right click or E.
    if (input.rightClicked || this.meleeQueued) {
      this.game.combat.melee(c);
      input.rightClicked = false;
      this.meleeQueued = false;
    }
    if (this.trapQueued) {
      this.game.traps.tryPlace(c, this.trapQueued);
      this.trapQueued = null;
    }
  }

  /**
   * Controller aim assist: a shot that would just miss someone bends toward them. The cone is a
   * few degrees, wider up close, and only within the gun's range.
   */
  private assist(aim: { origin: THREE.Vector3; dir: THREE.Vector3 }): void {
    const game = this.game;
    const me = game.player;
    const range = WEAPONS[me.weapon].range;
    const dir = aim.dir.clone().normalize();
    let best: THREE.Vector3 | null = null;
    let bestScore = 0;
    for (const t of game.characters) {
      if (t === me) continue;
      toTarget.copy(t.pos).setY(t.pos.y + 0.15).sub(aim.origin);
      const d = toTarget.length();
      if (d < 0.5 || d > range) continue;
      const cone = 0.07 + 0.6 / d;
      const ang = toTarget.angleTo(dir);
      if (ang > cone) continue;
      const score = 1 - ang / cone;
      if (score > bestScore) {
        bestScore = score;
        best = toTarget.clone().normalize();
      }
    }
    if (best) aim.dir.copy(dir.lerp(best, 0.75).normalize());
  }

  postStep(): void {
    if (this.game.player.didJump) this.jumpBuffer = 0;
  }
}
