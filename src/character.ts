import RAPIER from '@dimforge/rapier3d';
import * as THREE from 'three';
import { CHAR_HALF_TOTAL, CONFIG } from './config';
import { GUN_IDS, MELEE_IDS, WEAPONS, isGun, makeWeaponMesh, type GunKind, type MeleeKind, type WeaponKind } from './combat';
import type { Game } from './game';
import type { AnimeRig } from './rig';
import { HAIR_COLORS, OUTFITS, type Style } from './style';
import { toon } from './toon';
import type { TrapKind } from './traps';

export interface CharInput {
  moveX: number;
  moveZ: number;
  sprint: boolean;
  jump: boolean;
}

const UP = { x: 0, y: 1, z: 0 };
const DOWN = { x: 0, y: -1, z: 0 };

/** Every weapon, for sending "which swing was that" over the wire. */
const ALL_IDS: WeaponKind[] = [...MELEE_IDS, ...GUN_IDS];
const LONG_GUNS: GunKind[] = ['pushgun', 'rocket', 'railgun'];

interface Snap {
  ts: number;
  p: THREE.Vector3;
  v: THREE.Vector3;
  yaw: number;
  flags: number;
  stun: number;
  root: number;
  swing: number;
  weapon: number;
  melee: number;
  swingKind: number;
  air: number;
  hp: number;
}

const r2 = (n: number) => Math.round(n * 100) / 100;

function makeLabel(text: string, color: number): THREE.Sprite {
  const c = document.createElement('canvas');
  c.width = 256;
  c.height = 64;
  const g = c.getContext('2d')!;
  g.font = '600 30px Bahnschrift, "Arial Narrow", system-ui, sans-serif';
  g.textAlign = 'center';
  g.textBaseline = 'middle';
  const w = Math.min(244, g.measureText(text).width + 34);
  g.fillStyle = 'rgba(10,14,20,0.45)';
  g.beginPath();
  g.roundRect(128 - w / 2, 14, w, 36, 6);
  g.fill();
  g.fillStyle = '#' + new THREE.Color(color).getHexString();
  g.fillRect(128 - w / 2 + 8, 26, 12, 12);
  g.fillStyle = '#f2f2f2';
  g.fillText(text.toUpperCase(), 128 + 8, 33);
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  // Constant on-screen size so tags stay readable without covering faces up close.
  const s = new THREE.Sprite(new THREE.SpriteMaterial({ map: tex, transparent: true, sizeAttenuation: false }));
  s.scale.set(0.15, 0.0375, 1);
  return s;
}

/**
 * Shared by the player and bots: kinematic capsule movement, knockback,
 * stun/root state and the animated soldier. All "getting shoved" logic lives here.
 */
export class Character {
  readonly body: RAPIER.RigidBody;
  readonly collider: RAPIER.Collider;
  readonly controller: RAPIER.KinematicCharacterController;
  readonly view = new THREE.Group();
  private readonly pivot = new THREE.Group();
  private rig: AnimeRig;
  private label: THREE.Sprite;
  private weaponMesh: THREE.Object3D | null = null;
  private meleeMesh: THREE.Object3D | null = null;

  readonly vel = new THREE.Vector3();
  readonly pos = new THREE.Vector3();
  readonly prevPos = new THREE.Vector3();
  readonly input: CharInput = { moveX: 0, moveZ: 0, sprint: false, jump: false };
  speedMul = 1;
  yaw = 0;
  private viewYaw = 0;
  grounded = false;
  didJump = false;
  private timeSinceGrounded = 0;
  private airPeakY = 0;

  stun = 0;
  rootT = 0;
  hp: number = CONFIG.HP_MAX;
  lastDamageAt = -99;
  /** The gun in your hand (the Blaster unless you've picked up something better) and its ammo. */
  weapon: GunKind = 'blaster';
  weaponUses = Infinity;
  /** Melee on its own button: Shove, or a picked-up knife / sledgehammer. */
  melee: MeleeKind = 'fists';
  meleeUses = Infinity;
  traps: Record<TrapKind, number>;
  gunCooldown = 0;
  meleeCooldown = 0;
  swingT = 0;
  /** What the last swing/shot was (picks the animation). */
  swingKind: WeaponKind = 'fists';
  /** Gun raised after a shot. */
  aimT = 0;
  /** Frozen by a Freeze Ray (visual; the hold itself is rootT). */
  frozenT = 0;
  lastHitBy: Character | null = null;
  lastHitAt = -99;
  slippery = false;
  springCooldown = 0;
  ignoreHandle = -1;
  ignoreTimer = 0;
  private squash = 0;
  private flop = 0;
  /** Drives the happy face (holding the flag, winning). */
  happy = false;
  /** Fall height of the most recent landing, consumed by the animation. */
  private pendingLand = 0;
  /** Extra ground velocity from conveyor belts this step. */
  readonly conveyor = new THREE.Vector3();
  /** Online: this fighter is simulated on another machine and puppeted from snapshots. */
  remote = false;
  /** Look this fighter was built with (for rig reuse). */
  style: Style = { base: 0, hair: 0, outfit: 0, eyes: 0, hat: 0 };
  /** Index into the tower's spawn points. */
  spawnIndex = 0;
  /** Online identity: "p:<client>" for humans, "b:<n>" for bots. */
  netId = '';
  private snaps: Snap[] = [];
  /** Level of detail, picked by the game each frame from distance and the camera's view. */
  lod: Lod = 'full';
  private standIn: THREE.Group | null = null;
  private liteDt = 0;
  private liteFrame = 0;

  constructor(
    private readonly game: Game,
    readonly id: number,
    public name: string,
    readonly color: number,
    readonly isPlayer: boolean,
    spawn: THREE.Vector3,
    rig: AnimeRig,
  ) {
    const world = game.world;
    this.body = world.createRigidBody(
      RAPIER.RigidBodyDesc.kinematicPositionBased().setTranslation(spawn.x, spawn.y + CHAR_HALF_TOTAL, spawn.z),
    );
    this.collider = world.createCollider(
      RAPIER.ColliderDesc.capsule(CONFIG.CAPSULE_HALF_HEIGHT, CONFIG.CAPSULE_RADIUS),
      this.body,
    );
    const cc = world.createCharacterController(0.04);
    cc.setUp(UP);
    cc.setMaxSlopeClimbAngle((50 * Math.PI) / 180);
    cc.setMinSlopeSlideAngle((55 * Math.PI) / 180);
    cc.enableAutostep(0.45, 0.2, false);
    cc.enableSnapToGround(0.3);
    cc.setSlideEnabled(true);
    cc.setApplyImpulsesToDynamicBodies(false);
    this.controller = cc;
    this.traps = { ...CONFIG.START_TRAPS };
    this.pos.set(spawn.x, spawn.y + CHAR_HALF_TOTAL, spawn.z);
    this.prevPos.copy(this.pos);

    // Animated anime fighter. The pivot sits at the feet so knockdowns tip the whole body.
    this.rig = rig;
    this.pivot.position.y = -CHAR_HALF_TOTAL;
    this.pivot.add(this.rig.object);
    this.view.add(this.pivot);

    this.label = makeLabel(name, color);
    this.label.position.y = 1.15;
    this.label.visible = !isPlayer;
    this.view.add(this.label);
    game.scene.add(this.view);
  }

  get feetY(): number {
    return this.pos.y - CHAR_HALF_TOTAL;
  }

  forward(out: THREE.Vector3): THREE.Vector3 {
    return out.set(Math.sin(this.yaw), 0, Math.cos(this.yaw));
  }

  /** Where shots come out: the gun's muzzle in the right hand. */
  handWorldPos(out: THREE.Vector3): THREE.Vector3 {
    this.rig.socket.getWorldPosition(out);
    return out.addScaledVector(this.forward(new THREE.Vector3()), LONG_GUNS.includes(this.weapon) ? 0.75 : 0.3);
  }

  /** Swap to a different look (locker). */
  setRig(rig: AnimeRig): void {
    this.pivot.remove(this.rig.object);
    if (this.weaponMesh) this.rig.socket.remove(this.weaponMesh);
    if (this.meleeMesh) this.rig.socket.remove(this.meleeMesh);
    this.rig = rig;
    this.pivot.add(rig.object);
    if (this.meleeMesh) rig.socket.add(this.meleeMesh);
    rig.object.visible = this.lod === 'full' || this.lod === 'lite';
    rig.setDetail(this.lod === 'full');
    // The stand-in wears the old colours; rebuild it on demand.
    if (this.standIn) {
      this.pivot.remove(this.standIn);
      this.standIn = null;
      if (this.lod === 'proxy') this.lod = 'full';
    }
    if (this.weaponMesh) rig.socket.add(this.weaponMesh);
  }

  setLod(lod: Lod): void {
    if (lod === this.lod) return;
    this.lod = lod;
    this.view.visible = lod !== 'hidden';
    this.rig.object.visible = lod === 'full' || lod === 'lite';
    this.rig.setDetail(lod === 'full');
    if (lod === 'proxy' && !this.standIn) {
      this.standIn = makeStandIn(this.style, this.color);
      this.pivot.add(this.standIn);
    }
    if (this.standIn) this.standIn.visible = lod === 'proxy';
  }

  /** Name tags show for bots in play; hidden on the home page. */
  showLabel(v: boolean): void {
    this.label.visible = v && !this.isPlayer;
  }

  setLabel(text: string): void {
    this.name = text;
    this.view.remove(this.label);
    this.label = makeLabel(text, this.color);
    this.label.position.y = 1.15;
    this.label.visible = !this.isPlayer;
    this.view.add(this.label);
  }

  /** Equip a gun or a melee weapon (each has its own slot). */
  setWeapon(kind: WeaponKind): void {
    if (isGun(kind)) {
      this.weapon = kind;
      this.weaponUses = WEAPONS[kind].uses;
      if (this.weaponMesh) this.rig.socket.remove(this.weaponMesh);
      this.weaponMesh = makeWeaponMesh(kind);
      if (this.weaponMesh) this.rig.socket.add(this.weaponMesh);
    } else {
      this.melee = kind;
      this.meleeUses = WEAPONS[kind].uses;
      if (this.meleeMesh) this.rig.socket.remove(this.meleeMesh);
      this.meleeMesh = makeWeaponMesh(kind);
      if (this.meleeMesh) {
        this.meleeMesh.visible = false;
        this.rig.socket.add(this.meleeMesh);
      }
    }
  }

  /** A shot fired: picked-up guns run out, then it's back to the Blaster. */
  useGun(): void {
    if (this.weapon === 'blaster') return;
    if (--this.weaponUses <= 0) this.setWeapon('blaster');
  }

  useMelee(): void {
    if (this.melee === 'fists') return;
    if (--this.meleeUses <= 0) this.setWeapon('fists');
  }

  /** Apply a hit. `dir` is a horizontal unit vector. */
  knock(dir: THREE.Vector3, force: number, up: number, stun: number, by: Character | null): void {
    // Holding the flag makes you hard to budge: a shove alone won't take it, a big hit will.
    if (this.game.flag?.holder === this) {
      force *= 0.65;
      up *= 0.7;
      stun *= 0.6;
    }
    const mul = this.slippery ? 1.4 : 1;
    this.vel.x = dir.x * force * mul + this.vel.x * 0.2;
    this.vel.z = dir.z * force * mul + this.vel.z * 0.2;
    this.vel.y = Math.max(this.vel.y, up);
    this.stun = Math.max(this.stun, stun);
    this.rootT = 0;
    this.grounded = false;
    if (by) {
      this.lastHitBy = by;
      this.lastHitAt = this.game.time;
    }
  }

  /** Returns true when this damage knocks the character out. */
  damage(amount: number): boolean {
    // ...and hard to knock out: it takes a few people shooting together to end a hold.
    if (this.game.flag?.holder === this) amount *= 0.5;
    this.hp -= amount;
    this.lastDamageAt = this.game.time;
    if (this.hp <= 0) {
      this.hp = CONFIG.HP_MAX;
      return true;
    }
    return false;
  }

  teleport(feet: THREE.Vector3): void {
    // The small offset matters: a capsule standing still exactly on a box's diagonal (|x| == |z|
    // relative to its centre, e.g. a spawn at (-46, 0, -46) on the ground box) sinks through it
    // in Rapier 0.21. A centimetre off and it stands fine.
    const p = { x: feet.x + 0.013, y: feet.y + CHAR_HALF_TOTAL, z: feet.z - 0.007 };
    this.body.setTranslation(p, true);
    this.body.setNextKinematicTranslation(p);
    this.pos.set(p.x, p.y, p.z);
    this.prevPos.copy(this.pos);
    this.vel.set(0, 0, 0);
    this.grounded = false;
    this.airPeakY = p.y;
  }

  /** Place standing on the ground (no physics step needed), e.g. for the menu backdrop. */
  standAt(feet: THREE.Vector3, yaw: number): void {
    this.teleport(feet);
    this.yaw = this.viewYaw = yaw;
    this.grounded = true;
    this.timeSinceGrounded = 0;
    this.stun = 0;
  }

  reset(feet: THREE.Vector3, yaw: number): void {
    this.snaps = [];
    this.teleport(feet);
    this.yaw = this.viewYaw = yaw;
    this.stun = this.rootT = this.gunCooldown = this.meleeCooldown = this.swingT = this.springCooldown = this.ignoreTimer = 0;
    this.aimT = this.frozenT = 0;
    this.hp = CONFIG.HP_MAX;
    this.lastHitBy = null;
    this.lastHitAt = -99;
    this.traps = { ...CONFIG.START_TRAPS };
    this.setWeapon('blaster');
    this.setWeapon('fists');
  }

  step(dt: number): void {
    const C = CONFIG;
    const game = this.game;
    this.stun = Math.max(0, this.stun - dt);
    this.rootT = Math.max(0, this.rootT - dt);
    this.gunCooldown = Math.max(0, this.gunCooldown - dt);
    this.meleeCooldown = Math.max(0, this.meleeCooldown - dt);
    this.aimT = Math.max(0, this.aimT - dt);
    this.frozenT = Math.max(0, this.frozenT - dt);
    this.springCooldown = Math.max(0, this.springCooldown - dt);
    this.ignoreTimer = Math.max(0, this.ignoreTimer - dt);
    this.swingT = Math.max(0, this.swingT - dt * (this.swingKind === 'bat' ? 2.2 : 4));
    if (game.time - this.lastDamageAt > C.HP_REGEN_DELAY) {
      this.hp = Math.min(C.HP_MAX, this.hp + C.HP_REGEN_RATE * dt);
    }

    const canMove = this.stun <= 0 && this.rootT <= 0;
    let hx = this.vel.x;
    let hz = this.vel.z;

    if (this.rootT > 0 && this.stun <= 0) {
      hx = hz = 0;
    } else if (!canMove) {
      // Stunned: no control, just ground friction so knockback carries.
      if (this.grounded) {
        const f = Math.max(0, 1 - (this.slippery ? 0.6 : C.STUN_FRICTION) * dt);
        hx *= f;
        hz *= f;
      }
    } else {
      let wx = this.input.moveX;
      let wz = this.input.moveZ;
      const wl = Math.hypot(wx, wz);
      if (wl > 1) {
        wx /= wl;
        wz /= wl;
      }
      const speed = (this.input.sprint ? C.SPRINT_SPEED : C.WALK_SPEED) * this.speedMul;
      wx *= speed;
      wz *= speed;
      const accel = this.grounded ? (this.slippery ? C.SLIPPERY_ACCEL : C.GROUND_ACCEL) : C.AIR_ACCEL;
      const dx = wx - hx;
      const dz = wz - hz;
      const dl = Math.hypot(dx, dz);
      const maxd = accel * dt;
      if (dl <= maxd) {
        hx = wx;
        hz = wz;
      } else {
        hx += (dx / dl) * maxd;
        hz += (dz / dl) * maxd;
      }
    }

    // Jump with coyote time.
    this.timeSinceGrounded = this.grounded ? 0 : this.timeSinceGrounded + dt;
    this.didJump = false;
    if (this.input.jump && canMove && this.timeSinceGrounded <= C.COYOTE_TIME) {
      // Safety nets are trampolines: a jump off one clears the floor edge above.
      const g = this.grounded ? this.game.groundHandle(this) : null;
      this.vel.y = g !== null && this.game.tower.isNet(g) ? C.JUMP_SPEED * 1.45 : C.JUMP_SPEED;
      this.didJump = true;
      this.timeSinceGrounded = 99;
      this.grounded = false;
    }
    if (this.grounded && !this.didJump && this.vel.y <= 0) this.vel.y = -1.5;
    else this.vel.y = Math.max(this.vel.y - C.GRAVITY * dt, -C.MAX_FALL_SPEED);

    // Ride moving platforms.
    const t = this.body.translation();
    let px = 0;
    let py = 0;
    let pz = 0;
    if (this.grounded) {
      const hit = game.world.castRay(
        new RAPIER.Ray({ x: t.x, y: t.y - CHAR_HALF_TOTAL + 0.1, z: t.z }, DOWN),
        0.45,
        true,
        RAPIER.QueryFilterFlags.EXCLUDE_FIXED,
        undefined,
        this.collider,
      );
      const plat = hit ? game.tower.platformByCollider.get(hit.collider.handle) : undefined;
      if (plat) {
        px = plat.delta.x;
        py = plat.delta.y;
        pz = plat.delta.z;
      }
    }

    if (this.grounded) {
      px += this.conveyor.x * dt;
      pz += this.conveyor.z * dt;
    }
    const desired = { x: hx * dt + px, y: this.vel.y * dt + py, z: hz * dt + pz };
    const ign = this.ignoreTimer > 0 ? this.ignoreHandle : -1;
    this.controller.computeColliderMovement(
      this.collider,
      desired,
      RAPIER.QueryFilterFlags.EXCLUDE_SENSORS,
      undefined,
      ign >= 0 ? (c: RAPIER.Collider) => c.handle !== ign : undefined,
    );
    const mv = this.controller.computedMovement();
    this.body.setNextKinematicTranslation({ x: t.x + mv.x, y: t.y + mv.y, z: t.z + mv.z });
    const wasGrounded = this.grounded;
    this.grounded = this.controller.computedGrounded();

    // Lose velocity into whatever blocked us — only when knocked around or airborne.
    // Walking keeps its speed so the controller can step up stairs and slide along walls.
    const ax = mv.x - px;
    const ay = mv.y - py;
    const az = mv.z - pz;
    const dX = canMove && this.grounded ? 0 : hx * dt;
    const dZ = canMove && this.grounded ? 0 : hz * dt;
    if (Math.abs(dX) > 1e-4) {
      const r = ax / dX;
      if (r < 0.9) hx *= Math.max(0, r);
    }
    if (Math.abs(dZ) > 1e-4) {
      const r = az / dZ;
      if (r < 0.9) hz *= Math.max(0, r);
    }
    if (this.vel.y > 0 && ay < this.vel.y * dt * 0.5) this.vel.y = 0;
    if (this.grounded && this.vel.y < 0) this.vel.y = 0;
    this.vel.x = hx;
    this.vel.z = hz;

    // Hanging motionless under the floor lip above a safety net? Slip back into the net.
    if (!this.grounded && Math.abs(mv.y) < 0.002 && this.vel.y <= 0 && game.tower.netAt(t.x, t.y - CHAR_HALF_TOTAL, t.z)) {
      const r = Math.hypot(t.x, t.z) || 1;
      this.vel.x = (-t.x / r) * 3;
      this.vel.z = (-t.z / r) * 3;
    }

    // Track fall height for "knocked down X floors".
    const newY = t.y + mv.y;
    if (!this.grounded) {
      this.airPeakY = wasGrounded ? Math.max(t.y, newY) : Math.max(this.airPeakY, newY);
    } else if (!wasGrounded) {
      const drop = this.airPeakY - newY;
      // Measure the next fall from here (a net bounce keeps us airborne without a grounded frame).
      this.airPeakY = newY;
      if (drop > 1.2) this.squash = Math.min(1, drop / 8 + 0.3);
      this.pendingLand = Math.max(this.pendingLand, drop);
      game.onLanded(this, drop);
    }
  }

  // ---------------------------------------------------------------- network

  /** Compact state for the wire: [netId, x, feetY, z, vx, vy, vz, yaw, flags, stun, root, swing, gun, air, hp, melee, swingKind]. */
  snapshot(): (string | number)[] {
    const flags = (this.grounded ? 1 : 0) | (this.happy ? 2 : 0) | (this.aimT > 0 ? 4 : 0);
    return [
      this.netId,
      r2(this.pos.x),
      r2(this.feetY),
      r2(this.pos.z),
      r2(this.vel.x),
      r2(this.vel.y),
      r2(this.vel.z),
      r2(this.yaw),
      flags,
      r2(this.stun),
      r2(this.rootT),
      r2(this.swingT),
      GUN_IDS.indexOf(this.weapon),
      r2(Math.min(this.timeSinceGrounded, 9)),
      Math.round(this.hp),
      MELEE_IDS.indexOf(this.melee),
      ALL_IDS.indexOf(this.swingKind),
    ];
  }

  pushSnapshot(ts: number, a: (string | number)[]): void {
    const n = (i: number) => Number(a[i]) || 0;
    this.snaps.push({
      ts,
      p: new THREE.Vector3(n(1), n(2) + CHAR_HALF_TOTAL, n(3)),
      v: new THREE.Vector3(n(4), n(5), n(6)),
      yaw: n(7),
      flags: n(8),
      stun: n(9),
      root: n(10),
      swing: n(11),
      weapon: n(12),
      air: n(13),
      hp: n(14),
      melee: n(15),
      swingKind: n(16),
    });
    if (this.snaps.length > 30) this.snaps.splice(0, this.snaps.length - 30);
  }

  /** Puppet a remote fighter at server time `t` (already delayed for smoothing). */
  applyRemote(t: number): void {
    const s = this.snaps;
    if (!s.length) return;
    let a = s[0];
    let b = s[s.length - 1];
    for (let i = s.length - 1; i >= 0; i--) {
      if (s[i].ts <= t) {
        a = s[i];
        b = s[Math.min(i + 1, s.length - 1)];
        break;
      }
    }
    const target = new THREE.Vector3();
    if (b !== a && b.ts > a.ts) {
      const k = THREE.MathUtils.clamp((t - a.ts) / (b.ts - a.ts), 0, 1);
      target.lerpVectors(a.p, b.p, k);
    } else {
      // No newer data: extrapolate briefly along the last velocity.
      const ahead = THREE.MathUtils.clamp((t - b.ts) / 1000, 0, 0.2);
      target.copy(b.p).addScaledVector(b.v, ahead);
    }
    const latest = b.ts <= t ? b : a;
    this.prevPos.copy(this.pos);
    this.pos.copy(target);
    this.body.setNextKinematicTranslation(target);
    this.vel.copy(latest.v);
    let dy = latest.yaw - this.yaw;
    dy = Math.atan2(Math.sin(dy), Math.cos(dy));
    this.yaw += dy * 0.5;
    this.grounded = (latest.flags & 1) === 1;
    this.happy = (latest.flags & 2) === 2;
    this.stun = latest.stun;
    this.rootT = latest.root;
    this.swingT = Math.max(this.swingT * 0.8, latest.swing);
    this.timeSinceGrounded = latest.air;
    this.hp = latest.hp;
    this.aimT = latest.flags & 4 ? 0.3 : 0;
    this.frozenT = this.rootT > 0 && this.stun <= 0 ? this.rootT : 0;
    this.swingKind = ALL_IDS[latest.swingKind] ?? 'fists';
    const gun = GUN_IDS[latest.weapon] ?? 'blaster';
    if (gun !== this.weapon) this.setWeapon(gun);
    const melee = MELEE_IDS[latest.melee] ?? 'fists';
    if (melee !== this.melee) this.setWeapon(melee);
  }

  /** Online: hand simulation of this fighter to or from another machine. */
  setRemote(on: boolean): void {
    if (on === this.remote) return;
    this.remote = on;
    this.snaps = [];
    if (!on) {
      // Pick up where the last snapshot left it, with physics back in our hands.
      const v = this.vel.clone();
      this.teleport(new THREE.Vector3(this.pos.x, this.feetY, this.pos.z));
      this.vel.copy(v);
    }
  }

  /** Remove from the world and scene (roster changes). The rig is detached for reuse. */
  dispose(): AnimeRig {
    const game = this.game;
    game.world.removeCharacterController(this.controller);
    game.world.removeRigidBody(this.body);
    game.scene.remove(this.view);
    this.pivot.remove(this.rig.object);
    if (this.weaponMesh) this.rig.socket.remove(this.weaponMesh);
    if (this.meleeMesh) this.rig.socket.remove(this.meleeMesh);
    return this.rig;
  }

  syncFromBody(): void {
    this.prevPos.copy(this.pos);
    const t = this.body.translation();
    this.pos.set(t.x, t.y, t.z);
  }

  updateView(alpha: number, dt: number, time: number): void {
    this.view.position.lerpVectors(this.prevPos, this.pos, alpha);
    let d = this.yaw - this.viewYaw;
    d = Math.atan2(Math.sin(d), Math.cos(d));
    this.viewYaw += this.isPlayer ? d : d * Math.min(1, dt * 12);
    this.view.rotation.y = this.viewYaw;

    // Short stuns (springs) don't flop; longer ones knock you flat, and you get up just before control returns.
    const flopTarget = this.stun > 0.3 && this.rootT <= 0 ? 1 : 0;
    this.flop += (flopTarget - this.flop) * Math.min(1, dt * (flopTarget ? 12 : 5));
    this.pivot.rotation.x = -this.flop * 1.45;
    this.pivot.rotation.z = Math.sin(time * 7 + this.id) * 0.12 * this.flop;
    this.squash = Math.max(0, this.squash - dt * 4);
    const s = this.squash * 0.35;
    this.pivot.scale.set(1 + 0.25 * s, 1 - 0.3 * s, 1 + 0.25 * s);

    // Far away: animate every other frame (with both frames' time); off screen: not at all.
    if (this.lod === 'proxy' || this.lod === 'hidden') {
      this.pendingLand = 0;
      return;
    }
    if (this.lod === 'lite') {
      this.liteDt += dt;
      if (++this.liteFrame % 2) return;
      dt = this.liteDt;
    }
    this.liteDt = 0;
    // A melee swing with a blade or hammer: that's what's in your hand for the swing.
    const meleeOut = !isGun(this.swingKind) && this.swingKind !== 'fists' && this.swingT > 0.15;
    if (this.meleeMesh) this.meleeMesh.visible = meleeOut;
    if (this.weaponMesh) this.weaponMesh.visible = !meleeOut;
    this.rig.update({
      dt,
      time,
      speed: Math.hypot(this.vel.x, this.vel.z),
      grounded: this.grounded,
      vy: this.vel.y,
      stunned: this.stun > 0.3,
      rooted: this.rootT > 0,
      swing: this.swingT,
      swingKind: this.swingKind,
      aiming: this.aimT > 0,
      weapon: this.weapon,
      happy: this.happy,
      airTime: this.timeSinceGrounded,
      landed: this.pendingLand,
    });
    this.pendingLand = 0;
  }
}

export type Lod = 'full' | 'lite' | 'proxy' | 'hidden';

const STANDIN_BODY = new THREE.CapsuleGeometry(0.27, 0.72, 3, 8).translate(0, 0.72, 0);
const STANDIN_HEAD = new THREE.SphereGeometry(0.19, 10, 8).translate(0, 1.5, 0);

/** Two-draw-call figure in the fighter's colours, for when they're far from the camera. */
function makeStandIn(style: Style, color: number): THREE.Group {
  const g = new THREE.Group();
  const outfit = OUTFITS[style.outfit];
  const body = new THREE.Mesh(STANDIN_BODY, toon(outfit ? outfit[0] : color));
  const head = new THREE.Mesh(STANDIN_HEAD, toon(HAIR_COLORS[style.hair] ?? '#3a3f4b'));
  g.add(body, head);
  return g;
}
