import * as THREE from 'three';

interface Particle {
  mesh: THREE.Mesh;
  vel: THREE.Vector3;
  life: number;
  max: number;
}

interface Tracer {
  line: THREE.Line;
  life: number;
}

/** Visual juice: hit sparks, tracers and camera shake. */
export class Fx {
  shake = 0;
  private readonly parts: Particle[] = [];
  private readonly tracers: Tracer[] = [];
  private readonly geo = new THREE.IcosahedronGeometry(0.06, 0);
  private readonly mats = new Map<number, THREE.MeshBasicMaterial>();
  private readonly flash: THREE.Mesh;
  private readonly flashLight = new THREE.PointLight(0xffb060, 0, 9, 2);
  private flashT = 0;

  private readonly beams: { mesh: THREE.Mesh; life: number }[] = [];
  constructor(private readonly scene: THREE.Scene) {
    this.flash = new THREE.Mesh(
      new THREE.SphereGeometry(0.12, 10, 8),
      new THREE.MeshBasicMaterial({ color: 0xffd080, transparent: true, opacity: 0.9, depthWrite: false }),
    );
    this.flash.visible = false;
    scene.add(this.flash, this.flashLight);
  }

  muzzle(pos: THREE.Vector3): void {
    this.flash.position.copy(pos);
    this.flashLight.position.copy(pos);
    this.flashT = 0.07;
  }

  private mat(color: number): THREE.MeshBasicMaterial {
    let m = this.mats.get(color);
    if (!m) {
      m = new THREE.MeshBasicMaterial({ color });
      this.mats.set(color, m);
    }
    return m;
  }

  burst(pos: THREE.Vector3, color: number, count = 12, speed = 6): void {
    for (let i = 0; i < count; i++) {
      const mesh = new THREE.Mesh(this.geo, this.mat(color));
      mesh.position.copy(pos);
      const vel = new THREE.Vector3(Math.random() - 0.5, Math.random() * 0.8 + 0.2, Math.random() - 0.5)
        .normalize()
        .multiplyScalar(speed * (0.5 + Math.random() * 0.7));
      const max = 0.35 + Math.random() * 0.3;
      this.parts.push({ mesh, vel, life: max, max });
      this.scene.add(mesh);
    }
  }

  tracer(from: THREE.Vector3, to: THREE.Vector3, color: number): void {
    const geo = new THREE.BufferGeometry().setFromPoints([from, to]);
    const mat = new THREE.LineBasicMaterial({ color, transparent: true, opacity: 1 });
    const line = new THREE.Line(geo, mat);
    this.scene.add(line);
    this.tracers.push({ line, life: 0.18 });
  }

  /** A thick shot beam (railgun, freeze ray, rocket trail) that fades out. */
  beam(from: THREE.Vector3, to: THREE.Vector3, color: number, width = 0.06): void {
    const len = from.distanceTo(to);
    if (len < 0.05) return;
    const geo = new THREE.CylinderGeometry(width, width, len, 6, 1, true);
    geo.rotateX(Math.PI / 2);
    const mat = new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 0.9, depthWrite: false });
    const mesh = new THREE.Mesh(geo, mat);
    mesh.position.copy(from).add(to).multiplyScalar(0.5);
    mesh.lookAt(to);
    this.scene.add(mesh);
    this.beams.push({ mesh, life: 0.28 });
  }

  addShake(amount: number): void {
    this.shake = Math.min(1, this.shake + amount);
  }

  update(dt: number): void {
    for (let i = this.beams.length - 1; i >= 0; i--) {
      const b = this.beams[i];
      b.life -= dt;
      (b.mesh.material as THREE.MeshBasicMaterial).opacity = Math.max(0, b.life / 0.28) * 0.9;
      b.mesh.scale.x = b.mesh.scale.y = 1 + (0.28 - b.life) * 2;
      if (b.life <= 0) {
        this.scene.remove(b.mesh);
        b.mesh.geometry.dispose();
        (b.mesh.material as THREE.Material).dispose();
        this.beams.splice(i, 1);
      }
    }
    this.shake = Math.max(0, this.shake - dt * 2.5);
    this.flashT = Math.max(0, this.flashT - dt);
    this.flash.visible = this.flashT > 0;
    this.flash.scale.setScalar(1 + Math.random() * 1.5);
    this.flashLight.intensity = this.flashT > 0 ? 40 : 0;
    for (let i = this.parts.length - 1; i >= 0; i--) {
      const p = this.parts[i];
      p.life -= dt;
      p.vel.y -= 18 * dt;
      p.mesh.position.addScaledVector(p.vel, dt);
      p.mesh.scale.setScalar(Math.max(0.01, p.life / p.max));
      if (p.life <= 0) {
        this.scene.remove(p.mesh);
        this.parts.splice(i, 1);
      }
    }
    for (let i = this.tracers.length - 1; i >= 0; i--) {
      const t = this.tracers[i];
      t.life -= dt;
      (t.line.material as THREE.LineBasicMaterial).opacity = Math.max(0, t.life / 0.18);
      if (t.life <= 0) {
        this.scene.remove(t.line);
        t.line.geometry.dispose();
        (t.line.material as THREE.Material).dispose();
        this.tracers.splice(i, 1);
      }
    }
  }

  clear(): void {
    for (const p of this.parts) this.scene.remove(p.mesh);
    for (const t of this.tracers) this.scene.remove(t.line);
    this.parts.length = 0;
    this.tracers.length = 0;
    this.shake = 0;
  }
}
