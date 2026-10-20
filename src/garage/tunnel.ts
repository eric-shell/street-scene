/**
 * Street presentation set: a straight, flat road tunnel the car cruises
 * through. The car stays at the origin facing +Z and the tunnel scrolls past
 * toward -Z. Everything repeats every PERIOD meters, so instead of moving
 * individual segments the periodic pieces sit in one group shifted by
 * -(distance mod PERIOD) (segments recycle for free), and continuous surfaces
 * (road, walls) scroll their textures. A handful of point lights stream past
 * with distance fades so they never pop. Render only.
 */
import * as THREE from 'three';
import { makeAsphalt } from '../render/textures';
import { PALETTE } from '../ui/palette';

/** Spacing of the light fixtures and lane dashes (m). */
const PERIOD = 8;
const Z_MIN = -48;
const Z_MAX = 72;
const LEN = Z_MAX - Z_MIN;
/** Road half width (curb line), walkway outer edge, wall top and ceiling height. */
const ROAD = 5.2;
const WALL = 6.5;
const WALL_TOP = 4.1;
const CEIL = 5.8;
const CEIL_HALF = 4.4;
/** Texture scroll: meters per texture repeat along the tunnel. */
const ROAD_TILE = 4;
const WALL_TILE = 4;

function wallTexture(): THREE.CanvasTexture {
  const S = 256;
  const c = document.createElement('canvas');
  c.width = c.height = S;
  const ctx = c.getContext('2d')!;
  ctx.fillStyle = '#2b2e35';
  ctx.fillRect(0, 0, S, S);
  // Ceramic tiles: faint grout grid, a few slightly different tiles.
  for (let y = 0; y < S; y += 16) {
    for (let x = 0; x < S; x += 32) {
      const k = ((x * 7 + y * 13) % 5) * 3;
      ctx.fillStyle = `rgb(${43 + k},${46 + k},${53 + k})`;
      ctx.fillRect(x + 1, y + 1, 30, 14);
    }
  }
  // Panel seams every 2 m (the canvas spans WALL_TILE m along the tunnel).
  ctx.fillStyle = '#121318';
  for (let x = 0; x < S; x += S / 2) ctx.fillRect(x, 0, 3, S);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.anisotropy = 4;
  return t;
}

/**
 * Inward facing tunnel shell swept along Z from a half profile (mirrored).
 * u runs along the profile in meters / WALL_TILE, v along the tunnel.
 */
function shellGeometry(): THREE.BufferGeometry {
  const half: [number, number][] = [
    [WALL, 0.22],
    [WALL, WALL_TOP],
    [CEIL_HALF, CEIL],
    [0, CEIL],
  ];
  const profile: [number, number][] = [...half, ...half.slice(0, -1).reverse().map(([x, y]) => [-x, y] as [number, number])];
  const pos: number[] = [];
  const uv: number[] = [];
  const idx: number[] = [];
  let u = 0;
  for (let i = 0; i < profile.length; i++) {
    if (i > 0) u += Math.hypot(profile[i][0] - profile[i - 1][0], profile[i][1] - profile[i - 1][1]);
    const [x, y] = profile[i];
    pos.push(x, y, Z_MIN, x, y, Z_MAX);
    uv.push(u / WALL_TILE, 0, u / WALL_TILE, LEN / WALL_TILE);
    if (i > 0) {
      const a = (i - 1) * 2;
      const b = i * 2;
      // Winding so faces point into the tunnel.
      idx.push(a, a + 1, b, b, a + 1, b + 1);
    }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
  g.setIndex(idx);
  g.computeVertexNormals();
  return g;
}

export class Tunnel {
  readonly group = new THREE.Group();
  /** Pieces that repeat every PERIOD meters. */
  private periodic = new THREE.Group();
  private lights: THREE.PointLight[] = [];
  private roadTex: THREE.Texture[] = [];
  private wallTex: THREE.Texture;
  private disposables: { dispose(): void }[] = [];

  constructor() {
    const track = <T extends { dispose(): void }>(x: T) => (this.disposables.push(x), x);
    const g = this.group;
    g.name = 'tunnel';

    // Road: wet-ish asphalt with scrolling texture.
    const asphalt = makeAsphalt(41);
    for (const t of [asphalt.map, asphalt.roughness]) {
      t.repeat.set((ROAD * 2) / ROAD_TILE, LEN / ROAD_TILE);
      this.roadTex.push(track(t));
    }
    const road = new THREE.Mesh(
      track(new THREE.PlaneGeometry(ROAD * 2, LEN).rotateX(-Math.PI / 2).translate(0, 0, (Z_MIN + Z_MAX) / 2)),
      track(new THREE.MeshStandardMaterial({ map: asphalt.map, roughnessMap: asphalt.roughness, roughness: 0.75, metalness: 0.05, envMapIntensity: 0.6 })),
    );
    g.add(road);

    // Walls and ceiling, with scrolling tiles.
    this.wallTex = track(wallTexture());
    const shell = new THREE.Mesh(track(shellGeometry()), track(new THREE.MeshStandardMaterial({ map: this.wallTex, roughness: 0.55, metalness: 0.1, side: THREE.DoubleSide })));
    g.add(shell);

    // Raised walkways with a cyan LED line along the curb (continuous, so static).
    const walkMat = track(new THREE.MeshStandardMaterial({ color: 0x3a3d44, roughness: 0.85 }));
    const ledMat = track(new THREE.MeshBasicMaterial({ color: new THREE.Color(PALETTE.orange).multiplyScalar(2.4) }));
    const lineMat = track(new THREE.MeshBasicMaterial({ color: 0x9a9480 }));
    const walkGeo = track(new THREE.BoxGeometry(WALL - ROAD, 0.22, LEN));
    const ledGeo = track(new THREE.BoxGeometry(0.03, 0.035, LEN));
    const lineGeo = track(new THREE.PlaneGeometry(0.14, LEN).rotateX(-Math.PI / 2));
    for (const side of [1, -1]) {
      const walk = new THREE.Mesh(walkGeo, walkMat);
      walk.position.set(side * (ROAD + WALL) * 0.5, 0.11, (Z_MIN + Z_MAX) / 2);
      const led = new THREE.Mesh(ledGeo, ledMat);
      led.position.set(side * (ROAD - 0.005), 0.15, (Z_MIN + Z_MAX) / 2);
      const edge = new THREE.Mesh(lineGeo, lineMat);
      edge.position.set(side * (ROAD - 0.45), 0.006, (Z_MIN + Z_MAX) / 2);
      g.add(walk, led, edge);
    }

    // Periodic pieces: ceiling light fixtures, lane dashes, curb reflectors.
    const count = Math.ceil(LEN / PERIOD) + 1;
    const m = new THREE.Matrix4();
    const instanced = (geo: THREE.BufferGeometry, mat: THREE.Material, place: (k: number, side: number) => [number, number, number] | null, sides: number[]) => {
      const mesh = new THREE.InstancedMesh(track(geo), track(mat), count * sides.length);
      let n = 0;
      for (let k = 0; k < count; k++) {
        for (const side of sides) {
          const p = place(k, side);
          if (!p) continue;
          mesh.setMatrixAt(n++, m.makeTranslation(p[0], p[1], p[2]));
        }
      }
      mesh.count = n;
      mesh.instanceMatrix.needsUpdate = true;
      mesh.frustumCulled = false;
      this.periodic.add(mesh);
      return mesh;
    };
    const z0 = (k: number) => Z_MIN + k * PERIOD;
    // Warm sodium-white strips on the ceiling shoulders: the lights that stream past.
    const fixture = instanced(new THREE.BoxGeometry(0.34, 0.08, 2.2), new THREE.MeshBasicMaterial({ color: new THREE.Color(0xffd9a8).multiplyScalar(3.2) }), (k, s) => [s * (CEIL_HALF + 0.55), CEIL - 0.42, z0(k)], [1, -1]);
    // Tilt the fixtures to follow the slanted ceiling shoulder.
    const tilt = Math.atan2(CEIL - WALL_TOP, WALL - CEIL_HALF);
    let n = 0;
    for (let k = 0; k < count; k++) {
      for (const s of [1, -1]) {
        m.makeRotationZ(s * tilt).setPosition(s * (CEIL_HALF + 0.55), CEIL - 0.42, z0(k));
        fixture.setMatrixAt(n++, m);
      }
    }
    fixture.instanceMatrix.needsUpdate = true;
    // Dashed lane lines: 3 m dash, 5 m gap.
    instanced(new THREE.PlaneGeometry(0.13, 3).rotateX(-Math.PI / 2), new THREE.MeshBasicMaterial({ color: 0xc8c2ae }), (k, s) => [s * 1.75, 0.007, z0(k) + PERIOD / 2], [1, -1]);
    // Amber reflectors on the curb face every half period.
    instanced(new THREE.BoxGeometry(0.02, 0.05, 0.12), new THREE.MeshBasicMaterial({ color: new THREE.Color(0xffa040).multiplyScalar(2) }), (k, s) => [s * (ROAD - 0.01), 0.1, z0(k) + PERIOD / 4], [1, -1]);
    g.add(this.periodic);

    // Soft ambient and a few streaming point lights.
    g.add(new THREE.HemisphereLight(0x9aa4c0, 0x1a1410, 0.35));
    for (let i = 0; i < 4; i++) {
      const l = new THREE.PointLight(0xffd6a6, 0, 15, 1.6);
      l.position.set(0, CEIL - 0.9, 0);
      this.lights.push(l);
      g.add(l);
    }
  }

  /** Place the tunnel for a driven distance (m). */
  update(distance: number): void {
    const s = ((distance % PERIOD) + PERIOD) % PERIOD;
    this.periodic.position.z = -s;
    // The road's v runs toward -Z, the shell's toward +Z.
    for (const t of this.roadTex) t.offset.y = -(distance % (ROAD_TILE * 64)) / ROAD_TILE;
    this.wallTex.offset.y = (distance % (WALL_TILE * 64)) / WALL_TILE;
    // Lights at (k - 1) * PERIOD - s cover [-16, 16]; the one leaving and the one
    // arriving at a wrap both sit at |z| = 16 where the fade is zero, so nothing pops.
    this.lights.forEach((l, i) => {
      const z = (i - 1) * PERIOD - s;
      const f = Math.max(0, 1 - (z / (PERIOD * 2)) ** 2);
      l.position.z = z;
      l.intensity = 34 * f * f;
    });
  }

  dispose(): void {
    this.group.removeFromParent();
    for (const d of this.disposables) d.dispose();
  }
}
