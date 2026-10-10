import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import type { Ambience } from './arena';
import { StaticBatcher, canvasTexture, toon } from './toon';

/** Sky, clouds and surroundings, recoloured per map (day city, sunset site, night hotel, Olympus sea). */
export interface Backdrop {
  clouds: THREE.Group;
  apply(a: Ambience, fog: THREE.Fog, hemi: THREE.HemisphereLight, sun: THREE.DirectionalLight): void;
}

/** Anime sky dome, puffy clouds and a city skyline seen through the windows. */
export function buildCity(scene: THREE.Scene): Backdrop {
  const skyline = new THREE.Group();
  scene.add(skyline);
  // Sky: vertical gradient on a big inverted sphere.
  const sky = new THREE.Mesh(
    new THREE.SphereGeometry(950, 32, 16),
    new THREE.ShaderMaterial({
      side: THREE.BackSide,
      depthWrite: false,
      fog: false,
      uniforms: {
        top: { value: new THREE.Color(0x2f86e8) },
        mid: { value: new THREE.Color(0x8fd0ff) },
        bottom: { value: new THREE.Color(0xfff1df) },
      },
      vertexShader: /* glsl */ `
        varying float vY;
        void main() {
          vY = normalize(position).y;
          gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
          // Always just inside the far plane: the dome is bigger than the camera's range, and
          // without this the middle of the view (the farthest part) got clipped to black.
          gl_Position.z = gl_Position.w * 0.99999;
        }`,
      fragmentShader: /* glsl */ `
        uniform vec3 top; uniform vec3 mid; uniform vec3 bottom;
        varying float vY;
        void main() {
          vec3 c = vY > 0.12 ? mix(mid, top, smoothstep(0.12, 0.7, vY)) : mix(bottom, mid, smoothstep(-0.05, 0.12, vY));
          gl_FragColor = vec4(c, 1.0);
          #include <colorspace_fragment>
        }`,
    }),
  );
  sky.renderOrder = -1;
  scene.add(sky);

  // Clouds that slowly drift (returned so the game can rotate them).
  // (One merged mesh: ~200 separate puffs cost as many draw calls.)
  const clouds = new THREE.Group();
  const puff = new THREE.IcosahedronGeometry(1, 2);
  const puffs: THREE.BufferGeometry[] = [];
  const holder = new THREE.Object3D();
  const piece = new THREE.Object3D();
  holder.add(piece);
  for (let i = 0; i < 34; i++) {
    const a = Math.random() * Math.PI * 2;
    const r = 260 + Math.random() * 380;
    holder.position.set(Math.cos(a) * r, 70 + Math.random() * 160, Math.sin(a) * r);
    holder.lookAt(0, holder.position.y, 0);
    const n = 4 + Math.floor(Math.random() * 4);
    for (let j = 0; j < n; j++) {
      const s = 7 + Math.random() * 9;
      piece.scale.set(s * 1.3, s * 0.8, s);
      piece.position.set((j - n / 2) * 9 + Math.random() * 4, Math.random() * 6 - (j % 2) * 3, Math.random() * 8 - 4);
      holder.updateMatrixWorld(true);
      puffs.push(puff.clone().applyMatrix4(piece.matrixWorld));
    }
  }
  clouds.add(new THREE.Mesh(mergeGeometries(puffs), toon(0xffffff)));
  scene.add(clouds);

  // Streets and blocks.
  const ground = new THREE.Mesh(new THREE.PlaneGeometry(2400, 2400), toon(0x8d939b));
  ground.rotation.x = -Math.PI / 2;
  ground.position.y = -0.25;
  ground.receiveShadow = true;
  skyline.add(ground);

  const windowTex = canvasTexture(
    64,
    64,
    (g) => {
      g.fillStyle = '#ffffff';
      g.fillRect(0, 0, 64, 64);
      g.fillStyle = '#9cc9ec';
      g.fillRect(8, 10, 20, 26);
      g.fillRect(36, 10, 20, 26);
      g.fillStyle = '#d8e9f7';
      g.fillRect(8, 10, 20, 6);
      g.fillRect(36, 10, 20, 6);
    },
    true,
  );
  const palette = [0xf2ead8, 0xe0e6ee, 0xd7dbe4, 0xf5d9c8, 0xcfe3f2, 0xe8d6ef, 0xf0f0f0, 0xd9e8d6];
  const mats = palette.map((c) => toon(c, { map: windowTex }));
  const roofMat = toon(0x9aa3ad);
  const batch = new StaticBatcher();
  const m4 = new THREE.Matrix4();
  const q = new THREE.Quaternion();
  for (let gx = -16; gx <= 16; gx++) {
    for (let gz = -16; gz <= 16; gz++) {
      const cx = gx * 26 + (Math.random() - 0.5) * 6;
      const cz = gz * 26 + (Math.random() - 0.5) * 6;
      const d = Math.hypot(cx, cz);
      if (d < 64 || d > 440) continue;
      const w = 10 + Math.random() * 10;
      const dd = 10 + Math.random() * 10;
      const near = THREE.MathUtils.clamp((d - 64) / 160, 0, 1);
      const h = 12 + Math.random() * (30 + 90 * near) + (Math.random() < 0.08 ? 60 : 0);
      const geo = new THREE.BoxGeometry(w, h, dd);
      const uv = geo.attributes.uv as THREE.BufferAttribute;
      const dims: [number, number][] = [[dd, h], [dd, h], [0, 0], [0, 0], [w, h], [w, h]];
      for (let f = 0; f < 6; f++)
        for (let v = 0; v < 4; v++) {
          const i = f * 4 + v;
          uv.setXY(i, (uv.getX(i) * dims[f][0]) / 4, (uv.getY(i) * dims[f][1]) / 3.5);
        }
      batch.add(geo, mats[Math.floor(Math.random() * mats.length)], m4.compose(new THREE.Vector3(cx, h / 2 - 0.25, cz), q, new THREE.Vector3(1, 1, 1)), { cast: false });
      batch.box(new THREE.Vector3(cx, h + 0.2, cz), new THREE.Vector3(w / 2 - 0.4, 0.4, dd / 2 - 0.4), q, roofMat, { cast: false, outline: false });
    }
  }
  batch.flush(skyline);

  // Landmark: a red-and-white lattice tower on the skyline.
  const tower = new THREE.Group();
  const red = toon(0xe8452c);
  const white = toon(0xf7f7f7);
  const H = 190;
  for (let i = 0; i < 4; i++) {
    const a = (i / 4) * Math.PI * 2 + Math.PI / 4;
    const leg = new THREE.Mesh(new THREE.CylinderGeometry(0.8, 2.2, H, 6), i % 2 ? red : white);
    leg.position.set(Math.cos(a) * 9, H / 2, Math.sin(a) * 9);
    leg.rotation.set(Math.sin(a) * 0.05, 0, -Math.cos(a) * 0.05);
    tower.add(leg);
  }
  for (const [y, r] of [[60, 14], [120, 9]] as const) {
    const deck = new THREE.Mesh(new THREE.CylinderGeometry(r, r, 5, 16), white);
    deck.position.y = y;
    tower.add(deck);
  }
  const spire = new THREE.Mesh(new THREE.CylinderGeometry(0.3, 2.5, 70, 8), red);
  spire.position.y = H + 25;
  tower.add(spire);
  tower.position.set(-230, 0, 260);
  skyline.add(tower);

  // Olympus: open sea with a few far-off islands instead of streets.
  const sea = new THREE.Group();
  const ocean = new THREE.Mesh(new THREE.PlaneGeometry(2400, 2400), toon(0x2f8fd6, { emissive: 0x0a2a4a }));
  ocean.rotation.x = -Math.PI / 2;
  ocean.position.y = -1.5;
  sea.add(ocean);
  const isle = toon(0xd8c79a);
  const green = toon(0x6aa84f);
  for (let i = 0; i < 9; i++) {
    const a = (i / 9) * Math.PI * 2 + 0.4;
    const r = 320 + (i % 3) * 120;
    const h = 30 + (i % 4) * 22;
    const cone = new THREE.Mesh(new THREE.ConeGeometry(40 + (i % 3) * 15, h, 9), i % 2 ? green : isle);
    cone.position.set(Math.cos(a) * r, h / 2 - 2, Math.sin(a) * r);
    sea.add(cone);
  }
  sea.visible = false;
  scene.add(sea);

  const uniforms = (sky.material as THREE.ShaderMaterial).uniforms;
  return {
    clouds,
    apply(a, fog, hemi, sun) {
      uniforms.top.value.setHex(a.skyTop);
      uniforms.mid.value.setHex(a.skyMid);
      uniforms.bottom.value.setHex(a.skyBottom);
      fog.color.setHex(a.fog);
      hemi.color.setHex(a.hemiSky);
      hemi.groundColor.setHex(a.hemiGround);
      hemi.intensity = a.hemiIntensity;
      sun.color.setHex(a.sun);
      sun.intensity = a.sunIntensity;
      skyline.visible = a.city;
      sea.visible = a.sea;
    },
  };
}
