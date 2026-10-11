import RAPIER from '@dimforge/rapier3d-compat';
import * as THREE from 'three';
import type { Game } from './game';

const BASE_FOV = 72;

/** Over-the-shoulder orbit camera with wall collision and a fall FOV kick. */
export class ThirdPersonCamera {
  readonly cam: THREE.PerspectiveCamera;
  yaw = 0;
  /** Look speed multiplier, mouse and right stick (settings). */
  sensitivity = 1;
  invertY = false;
  pitch = 0.3;
  dist = 6.5;
  private curDist = 6.5;
  /** Right stick held at the edge: extra turn speed ramps in (0..1). */
  private turnBoost = 0;
  private fov = BASE_FOV;
  /** Point the camera orbits (right shoulder); the aim ray starts here. */
  readonly pivot = new THREE.Vector3();
  readonly fwd = new THREE.Vector3(0, 0, 1);

  constructor(aspect: number) {
    this.cam = new THREE.PerspectiveCamera(BASE_FOV, aspect, 0.1, 900);
  }

  resize(aspect: number): void {
    this.cam.aspect = aspect;
    this.cam.updateProjectionMatrix();
  }

  update(dt: number, target: THREE.Vector3, game: Game, fallSpeed: number): void {
    const m = game.input.consumeMouse();
    const sens = 0.0023 * this.sensitivity;
    this.yaw -= m.dx * sens;
    this.pitch = THREE.MathUtils.clamp(this.pitch + m.dy * sens * (this.invertY ? -1 : 1), -1.0, 1.35);
    this.dist = THREE.MathUtils.clamp(this.dist + m.wheel * 0.8, 2.5, 14);
    // Right stick: a gentle curve keeps small tilts precise without feeling sluggish, and holding
    // the stick at the edge ramps in a turn boost for quick 180s.
    const pad = game.input.pad;
    if (pad.connected && game.state === 'playing' && !game.padNav.capturing) {
      const curve = (v: number) => Math.sign(v) * Math.abs(v) ** 1.5;
      const rate = 4.4 * this.sensitivity;
      const atEdge = Math.abs(pad.rx) > 0.9;
      this.turnBoost = atEdge ? Math.min(1, this.turnBoost + dt / 0.3) : 0;
      this.yaw -= curve(pad.rx) * (rate + this.turnBoost * 3 * this.sensitivity) * dt;
      this.pitch = THREE.MathUtils.clamp(this.pitch + curve(pad.ry) * rate * 0.6 * dt * (this.invertY ? -1 : 1), -1.0, 1.35);
    } else {
      this.turnBoost = 0;
    }

    const cp = Math.cos(this.pitch);
    const sp = Math.sin(this.pitch);
    this.fwd.set(Math.sin(this.yaw) * cp, -sp, Math.cos(this.yaw) * cp);
    const rx = -Math.cos(this.yaw);
    const rz = Math.sin(this.yaw);
    this.pivot.set(target.x + rx * 0.55, target.y + 0.75, target.z + rz * 0.55);

    const back = this.fwd.clone().negate();
    const hit = game.world.castRay(
      new RAPIER.Ray(this.pivot, back),
      this.dist + 0.3,
      true,
      RAPIER.QueryFilterFlags.EXCLUDE_KINEMATIC | RAPIER.QueryFilterFlags.EXCLUDE_SENSORS,
    );
    const want = hit ? Math.max(0.5, hit.timeOfImpact - 0.3) : this.dist;
    this.curDist = want < this.curDist ? want : this.curDist + (want - this.curDist) * (1 - Math.exp(-dt * 5));

    const pos = this.pivot.clone().addScaledVector(back, this.curDist);
    const look = pos.clone().add(this.fwd);
    const s = game.fx.shake * game.fx.shake * 0.45;
    pos.x += (Math.random() - 0.5) * s;
    pos.y += (Math.random() - 0.5) * s;
    pos.z += (Math.random() - 0.5) * s;
    this.cam.position.copy(pos);
    this.cam.lookAt(look);

    const targetFov = BASE_FOV + THREE.MathUtils.clamp((fallSpeed - 15) / 25, 0, 1) * 14;
    this.fov += (targetFov - this.fov) * Math.min(1, dt * 4);
    if (Math.abs(this.cam.fov - this.fov) > 0.01) {
      this.cam.fov = this.fov;
      this.cam.updateProjectionMatrix();
    }
  }

  /** Controller Y: near, normal, far. */
  cycleDistance(): void {
    const steps = [4, 6.5, 10];
    const i = steps.findIndex((d) => d > this.dist + 0.5);
    this.dist = steps[i < 0 ? 0 : i];
  }

  /** Slow cinematic orbit for the menu background. */
  orbit(time: number): void {
    const a = time * 0.08;
    this.cam.position.set(Math.cos(a) * 50, 36, Math.sin(a) * 50);
    this.cam.lookAt(0, 27, 0);
  }

  aim(): { origin: THREE.Vector3; dir: THREE.Vector3 } {
    return { origin: this.pivot.clone(), dir: this.fwd.clone() };
  }
}
