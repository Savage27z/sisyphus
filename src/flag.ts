import * as THREE from 'three';
import { toon } from './toon';
import { CONFIG } from './config';

/** Light hits (the Blaster) jostle the flag holder; only a real knockdown makes them drop it. */
const FLAG_DROP_STUN = 0.5;
import type { Character } from './character';
import type { Game } from './game';

/** The summit flag: grab it, then survive the hold timer to win. */
export class Flag {
  holder: Character | null = null;
  holdTime = 0;
  private readonly group = new THREE.Group();
  private readonly cloth: THREE.Mesh;
  private readonly clothBase: Float32Array;
  private readonly zone: THREE.Mesh;
  private readonly zoneMat: THREE.MeshBasicMaterial;

  constructor(private readonly game: Game) {
    const pole = new THREE.Mesh(
      new THREE.CylinderGeometry(0.06, 0.06, 3.2, 10),
      toon(0xf4f4f4),
    );
    pole.position.y = 1.6;
    pole.castShadow = true;
    const knob = new THREE.Mesh(new THREE.SphereGeometry(0.12, 12, 8), toon(0xffd23f));
    knob.position.y = 3.25;
    const clothGeo = new THREE.PlaneGeometry(1.5, 0.95, 12, 4);
    clothGeo.translate(0.75, 0, 0);
    this.clothBase = (clothGeo.attributes.position.array as Float32Array).slice();
    this.cloth = new THREE.Mesh(clothGeo, toon(0xe8322c, { double: true }));
    this.cloth.position.set(0.06, 2.65, 0);
    this.cloth.castShadow = true;
    this.group.add(pole, knob, this.cloth);
    game.scene.add(this.group);

    this.zoneMat = new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.55, side: THREE.DoubleSide });
    this.zone = new THREE.Mesh(
      new THREE.RingGeometry(CONFIG.FLAG_HOLD_RADIUS - 0.15, CONFIG.FLAG_HOLD_RADIUS, 48).rotateX(-Math.PI / 2),
      this.zoneMat,
    );
    this.zone.position.copy(game.tower.flagPos).add(new THREE.Vector3(0, 0.04, 0));
    game.scene.add(this.zone);
    this.reset();
  }

  reset(): void {
    this.holder = null;
    this.holdTime = 0;
    this.since = 0;
    this.lastTry = -1;
    this.group.position.copy(this.game.tower.flagPos);
    this.group.rotation.set(0, 0, 0);
    this.group.scale.setScalar(1);
  }

  private since = 0;
  private lastTry = -1;

  /** Online: the server says who holds the flag (and since when, server ms). */
  setHolder(c: Character | null, since: number): void {
    const prev = this.holder;
    this.holder = c;
    this.since = since;
    this.holdTime = 0;
    const game = this.game;
    if (c) {
      game.hud.feed(`${c.name} grabbed the flag!`);
      game.sfx.flagGrab();
      if (c.isPlayer) game.hud.popup('HOLD THE ZONE!', '#ffd23f');
    } else if (prev) {
      game.hud.feed(`${prev.name} dropped the flag!`);
      if (prev.isPlayer) game.hud.popup('FLAG DROPPED!', '#ff5050');
    }
  }

  /** Online: we only ask to grab/drop; the server times the hold and declares the win. */
  private updateOnline(): void {
    const game = this.game;
    const fp = game.tower.flagPos;
    const h = this.holder;
    if (h) {
      this.holdTime = Math.max(0, (game.net.serverNow() - this.since) / 1000);
      const d = Math.hypot(h.pos.x - fp.x, h.pos.z - fp.z);
      if (!h.remote && (h.stun > FLAG_DROP_STUN || d > CONFIG.FLAG_HOLD_RADIUS || h.feetY < fp.y - 0.6)) {
        game.net.send({ t: 'flagDrop', who: h.netId });
        this.setHolder(null, 0);
      }
      return;
    }
    if (game.time - this.lastTry < 0.3) return;
    for (const c of game.characters) {
      if (c.remote || c.stun > 0 || Math.abs(c.feetY - fp.y) > 1) continue;
      if (Math.hypot(c.pos.x - fp.x, c.pos.z - fp.z) < CONFIG.FLAG_GRAB_RADIUS) {
        game.net.send({ t: 'flagTry', who: c.netId });
        this.lastTry = game.time;
        return;
      }
    }
  }

  update(dt: number): void {
    const game = this.game;
    if (game.mode === 'online') {
      this.updateOnline();
      return;
    }
    const fp = game.tower.flagPos;
    const h = this.holder;
    if (h) {
      const d = Math.hypot(h.pos.x - fp.x, h.pos.z - fp.z);
      if (h.stun > FLAG_DROP_STUN || d > CONFIG.FLAG_HOLD_RADIUS || h.feetY < fp.y - 0.6) {
        this.holder = null;
        this.holdTime = 0;
        game.hud.feed(`${h.name} dropped the flag!`);
        if (h.isPlayer) game.hud.popup('FLAG DROPPED!', '#ff5050');
        else if (h.lastHitBy?.isPlayer) game.hud.popup('FLAG STOLEN BACK!', '#ffd23f');
        return;
      }
      this.holdTime += dt;
      if (this.holdTime >= CONFIG.FLAG_HOLD_SECONDS) game.win(h);
      return;
    }
    let best: Character | null = null;
    let bestD = CONFIG.FLAG_GRAB_RADIUS;
    for (const c of game.characters) {
      if (c.stun > 0 || Math.abs(c.feetY - fp.y) > 1) continue;
      const d = Math.hypot(c.pos.x - fp.x, c.pos.z - fp.z);
      if (d < bestD) {
        bestD = d;
        best = c;
      }
    }
    if (!best) return;
    this.holder = best;
    this.holdTime = 0;
    game.hud.feed(`${best.name} grabbed the flag!`);
    game.sfx.flagGrab();
    if (best.isPlayer) game.hud.popup('HOLD THE ZONE!', '#ffd23f');
    if (CONFIG.FLAG_HOLD_SECONDS <= 0) game.win(best);
  }

  updateView(time: number): void {
    // Wave the cloth.
    const pos = this.cloth.geometry.attributes.position;
    const arr = pos.array as Float32Array;
    for (let i = 0; i < arr.length; i += 3) {
      const x = this.clothBase[i];
      arr[i + 2] = Math.sin(x * 4 - time * 7) * 0.12 * x;
    }
    pos.needsUpdate = true;

    const h = this.holder;
    if (h) {
      const back = new THREE.Vector3(-Math.sin(h.yaw), 0, -Math.cos(h.yaw));
      this.group.position.copy(h.view.position).addScaledVector(back, 0.38).add(new THREE.Vector3(0, -0.5, 0));
      this.group.rotation.y = h.view.rotation.y + Math.PI / 2;
      this.group.scale.setScalar(0.7);
      this.zoneMat.color.setHex(h.color);
      this.zoneMat.opacity = 0.5 + 0.35 * Math.sin(time * 10);
    } else {
      this.group.position.copy(this.game.tower.flagPos);
      this.group.rotation.y = time * 0.3;
      this.group.scale.setScalar(1);
      this.zoneMat.color.setHex(0xffffff);
      this.zoneMat.opacity = 0.55;
    }
  }
}
