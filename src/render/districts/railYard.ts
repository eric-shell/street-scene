/**
 * Weekend special renderer: the Rail Yard (city/districts/railYard.ts). Everything is read from the area's layout
 * (railYardLayout.ts yardLayout, the same plan the sim's walls and terrain come from) and appended into the shared
 * kit's merged builders, so the whole yard costs two draw calls of its own: the freight cars (one textured mesh, the
 * side atlas, railYardCars.ts) and the floodlights' pools (Medium and up). Nothing moves, nothing runs per frame.
 *  - the ground: the whole region painted, ballast and cinders with dusty bands, laid as a grid in the travel frame
 *    draped on the terrain; the hump, the kicker, the dock and the banked corners get fine grids of their own (the
 *    shapes bend faster than the grid); concrete pads, the turnaround's asphalt, and every slick patch drawn as what
 *    it is (wet steel plates, black oil, grease, the diesel spill), so no patch that costs grip is invisible;
 *  - the throat road: concrete slabs over the spine's asphalt with joints, the lead track beside it;
 *  - the tracks: ballast beds, ties (Medium and up) and rails, all paint a few cm up, buffer stops at dead ends;
 *  - the freight: one textured mesh of cars on the consists the sim has as solids (look railcar);
 *  - the plant (railYardPlant.ts): the overbridge, the buildings, the crane, the containers, the signals, the floods;
 *  - light: floodlight towers every 100 m with pools on the ground, amber studs on the hump's crest and the kicker's lip
 *    (the hazard blink every jump lip in the city uses), lit doors and cab windows.
 * No sign and no arrow: light, surface and the shapes are how the lines read.
 */
import * as THREE from 'three';
import { CITY } from '../../city/config';
import type { Vec2 } from '../../sim/math';
import { yardLayout } from '../../city/districts/railYardLayout';
import type { YardLayout, YardPatch } from '../../city/districts/railYardLayout';
import { frameT, frameW, framePoint, rectPoint } from '../../city/districts/railYardFrame';
import { wedgeLength, wedgePoint, type WedgeSpec } from '../../city/districts/railYardShapes';
import type { BankedArc } from '../../city/districts/banking';
import { reachOf } from '../../city/districts/banking';
import { pointInPolygon } from '../../city/districts/geom';
import { GeoBuilder } from '../geoBuilder';
import { makeRadialGlow } from '../textures/textures';
import { makeYardAtlas } from '../textures/yardTextures';
import type { DistrictKit, DistrictRenderer } from './kit';
import { col, cylinder, drapeConvex, groundVertex } from './kit';
import { addCar, carMaterial } from './railYardCars';
import { drawBridge, drawSolids } from './railYardPlant';

const C = CITY.districts.railYard;

/** Cheap deterministic hash in [0, 1) for colour noise. */
function hash(a: number, b: number): number {
  let h = Math.imul(Math.round(a * 8) | 0, 374761393) ^ Math.imul(Math.round(b * 8) | 0, 668265263);
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}

const BALLAST = col(0x4d483f);
const CINDER = col(0x3b3732);
const DUST = col(0x5d5649);
const tmp = new THREE.Color();

/** Pool of light on the ground: a draped grid textured with the radial glow (as the roadworks' light towers). */
function poolOf(kit: DistrictKit) {
  return (gb: GeoBuilder, x: number, z: number, r: number, color: THREE.Color): void => {
    const N = 4;
    const ids: number[] = [];
    for (let j = 0; j <= N; j++) {
      for (let i = 0; i <= N; i++) {
        const px = x + (i / N - 0.5) * 2 * r;
        const pz = z + (j / N - 0.5) * 2 * r;
        ids.push(gb.vertex(px, kit.h(px, pz) + 0.09, pz, 0, 1, 0, i / N, j / N, color));
      }
    }
    for (let j = 0; j < N; j++) for (let i = 0; i < N; i++) gb.quadFacing(ids[j * (N + 1) + i], ids[j * (N + 1) + i + 1], ids[(j + 1) * (N + 1) + i + 1], ids[(j + 1) * (N + 1) + i], 0, 1, 0);
  };
}

/** The boxes (world AABBs) the fine grids draw, which the coarse ground skips. */
function featureBoxes(lay: YardLayout): { minX: number; minZ: number; maxX: number; maxZ: number }[] {
  const out: { minX: number; minZ: number; maxX: number; maxZ: number }[] = [];
  const add = (pts: Vec2[]) => out.push({ minX: Math.min(...pts.map((p) => p.x)), maxX: Math.max(...pts.map((p) => p.x)), minZ: Math.min(...pts.map((p) => p.z)), maxZ: Math.max(...pts.map((p) => p.z)) });
  for (const w of [lay.hump, ...(lay.kicker ? [lay.kicker] : [])]) {
    const L = wedgeLength(w);
    const B = w.half + w.edge;
    add([wedgePoint(w, 0, -B), wedgePoint(w, L, -B), wedgePoint(w, L, B), wedgePoint(w, 0, B)]);
  }
  if (lay.dock) {
    const r = lay.dock.rect;
    add([rectPoint(r, 0, 0), rectPoint(r, r.L, 0), rectPoint(r, r.L, r.D + 3), rectPoint(r, 0, r.D + 3)]);
  }
  return out;
}

/** The whole region's ground: a grid in the travel frame, cells whose middle is inside the polygon, coloured by noise and band. */
function ground(kit: DistrictKit, lay: YardLayout): void {
  const f = lay.f;
  const poly = lay.region.polygon;
  let wMin = Infinity;
  let wMax = -Infinity;
  let tMin = Infinity;
  let tMax = -Infinity;
  for (const p of poly) {
    const t = frameT(f, p.x, p.z);
    const w = frameW(f, p.x, p.z);
    tMin = Math.min(tMin, t);
    tMax = Math.max(tMax, t);
    wMin = Math.min(wMin, w);
    wMax = Math.max(wMax, w);
  }
  const step = kit.quality === 'high' ? 6 : kit.quality === 'low' ? 10 : 8;
  const nt = Math.ceil((tMax - tMin) / step);
  const nw = Math.ceil((wMax - wMin) / step);
  const boxes = featureBoxes(lay);
  const g = kit.ground;
  const ids = new Map<number, number>();
  const vert = (i: number, j: number): number => {
    const key = j * (nt + 1) + i;
    let id = ids.get(key);
    if (id === undefined) {
      const t = tMin + i * step;
      const w = wMin + j * step;
      const p = framePoint(f, t, w);
      const n = 0.82 + hash(t, w) * 0.36;
      const band = hash(Math.floor(t / 23), Math.floor(w / 17));
      const base = band > 0.72 ? DUST : band < 0.25 ? CINDER : BALLAST;
      id = groundVertex(kit, g, p.x, p.z, 0.02, tmp.copy(base).multiplyScalar(n), 4);
      ids.set(key, id);
    }
    return id;
  };
  for (let j = 0; j < nw; j++) {
    for (let i = 0; i < nt; i++) {
      const m = framePoint(f, tMin + (i + 0.5) * step, wMin + (j + 0.5) * step);
      if (!pointInPolygon(m.x, m.z, poly)) continue;
      if (boxes.some((b) => m.x > b.minX - 2 && m.x < b.maxX + 2 && m.z > b.minZ - 2 && m.z < b.maxZ + 2)) continue;
      g.quadFacing(vert(i, j), vert(i + 1, j), vert(i + 1, j + 1), vert(i, j + 1), 0, 1, 0);
    }
  }
}

/**
 * The yard's sodium wash: a coarse grid over the whole region in the pools' additive mesh (its uv at the glow's middle, so
 * the vertex colour is the light), brighter near the floodlight towers: open ground the street lamps never reach reads
 * lit, the way areaLights washes a park, at no draw call of its own.
 */
function wash(kit: DistrictKit, lay: YardLayout, gb: GeoBuilder): void {
  const f = lay.f;
  const poly = lay.region.polygon;
  const step = 14;
  const ts = poly.map((p) => frameT(f, p.x, p.z));
  const ws = poly.map((p) => frameW(f, p.x, p.z));
  const t0 = Math.min(...ts);
  const w0 = Math.min(...ws);
  const nt = Math.ceil((Math.max(...ts) - t0) / step);
  const nw = Math.ceil((Math.max(...ws) - w0) / step);
  const ids = new Map<number, number>();
  const vert = (i: number, j: number): number => {
    const key = j * (nt + 1) + i;
    let id = ids.get(key);
    if (id === undefined) {
      const p = framePoint(f, t0 + i * step, w0 + j * step);
      let k = 0.012;
      for (const l of lay.lights) {
        const d = Math.hypot(p.x - l.p.x - l.fx * 25, p.z - l.p.z - l.fz * 25);
        if (d < 80) k += 0.035 * (1 - d / 80);
      }
      id = gb.vertex(p.x, kit.h(p.x, p.z) + 0.12, p.z, 0, 1, 0, 0.5, 0.5, tmp.setRGB(1, 0.78, 0.5).multiplyScalar(Math.min(0.06, k)));
      ids.set(key, id);
    }
    return id;
  };
  for (let j = 0; j < nw; j++) {
    for (let i = 0; i < nt; i++) {
      const m = framePoint(f, t0 + (i + 0.5) * step, w0 + (j + 0.5) * step);
      if (pointInPolygon(m.x, m.z, poly)) gb.quadFacing(vert(i, j), vert(i + 1, j), vert(i + 1, j + 1), vert(i, j + 1), 0, 1, 0);
    }
  }
}

/** A draped grid over a wedge (the hump, the kicker): fine along its grade, breaks at its taper. */
function wedgeGround(kit: DistrictKit, w: WedgeSpec, color: THREE.Color, crestColor: THREE.Color): void {
  const L = wedgeLength(w);
  const B = w.half + w.edge;
  const as: number[] = [];
  for (let a = 0; a < w.run; a += Math.max(0.8, w.run / 16)) as.push(a);
  as.push(w.run, w.run + w.top);
  for (let k = 1; k <= 8; k++) as.push(w.run + w.top + (w.fall * k) / 8);
  const bs: number[] = [-B - 2, -B, -w.half - w.edge / 2, -w.half];
  for (let b = -w.half + 3; b < w.half - 1; b += 3) bs.push(b);
  bs.push(w.half, w.half + w.edge / 2, B, B + 2);
  const asx = [-2, ...as.filter((a) => a <= L), L + 2];
  const ids: number[] = [];
  for (const b of bs) {
    for (const a of asx) {
      const p = wedgePoint(w, a, b);
      const crest = a >= w.run - 0.5 && a <= w.run + w.top + 0.5 && Math.abs(b) < w.half;
      ids.push(groundVertex(kit, kit.ground, p.x, p.z, 0.03, tmp.copy(crest ? crestColor : color).multiplyScalar(0.85 + hash(a, b) * 0.3), 4));
    }
  }
  const n = asx.length;
  for (let j = 0; j + 1 < bs.length; j++) for (let i = 0; i + 1 < n; i++) kit.ground.quadFacing(ids[j * n + i], ids[j * n + i + 1], ids[(j + 1) * n + i + 1], ids[(j + 1) * n + i], 0, 1, 0);
}

/** The dock: its platform as a fine grid (the face's bevel, the ramps), concrete with a yellow edge line. */
function dockGround(kit: DistrictKit, lay: YardLayout): void {
  const d = lay.dock;
  if (!d) return;
  const r = d.rect;
  const us = [-1.5, 0];
  for (let k = 1; k <= 6; k++) us.push((d.ramp * k) / 6);
  for (let u = d.ramp + 6; u < r.L - d.ramp - 3; u += 6) us.push(u);
  for (let k = 6; k >= 0; k--) us.push(r.L - (d.ramp * k) / 6);
  us.push(r.L + 1.5);
  const vs = [-1.5, 0, C.dock.ease * 0.33, C.dock.ease * 0.66, C.dock.ease, C.dock.ease + 0.5, r.D * 0.5, r.D, r.D + 1.5, r.D + 3];
  const ids: number[] = [];
  for (const v of vs) {
    for (const u of us) {
      const p = rectPoint(r, u, v);
      const top = v > C.dock.ease && v < r.D && u > 0 && u < r.L;
      const edge = v > C.dock.ease && v < C.dock.ease + 0.5 && u > d.ramp && u < r.L - d.ramp;
      const c = edge ? col(0xd8b020) : top ? col(0x77777a) : col(0x57585c);
      ids.push(groundVertex(kit, kit.ground, p.x, p.z, 0.03, tmp.copy(c).multiplyScalar(0.9 + hash(u, v) * 0.2), 4));
    }
  }
  const n = us.length;
  for (let j = 0; j + 1 < vs.length; j++) for (let i = 0; i + 1 < n; i++) kit.ground.quadFacing(ids[j * n + i], ids[j * n + i + 1], ids[(j + 1) * n + i + 1], ids[(j + 1) * n + i], 0, 1, 0);
}

/** A banked corner: a polar grid of asphalt rising to its crest, concrete beyond. */
function bankGround(kit: DistrictKit, b: BankedArc): void {
  const r0 = b.rOut - b.rise - C.turnaround.width;
  const r1 = reachOf(b) + 0.5;
  const rs: number[] = [];
  for (let r = r0; r < b.rOut - b.rise; r += 2.5) rs.push(r);
  for (let k = 0; k <= 6; k++) rs.push(b.rOut - b.rise + (b.rise * k) / 6);
  rs.push(b.rOut + b.hold, b.rOut + b.hold + b.fall / 2, r1);
  const n = Math.max(6, Math.ceil((2 * b.half * b.rOut) / 3));
  const ids: number[] = [];
  for (const r of rs) {
    for (let i = 0; i <= n; i++) {
      const a = b.mid - b.half + (2 * b.half * i) / n;
      const x = b.cx + Math.cos(a) * r;
      const z = b.cz + Math.sin(a) * r;
      const c = r <= b.rOut + 0.1 ? col(0x303236) : col(0x6a6862);
      ids.push(groundVertex(kit, kit.paint, x, z, 0.04, tmp.copy(c).multiplyScalar(0.9 + hash(r, i) * 0.15), 4));
    }
  }
  const m = n + 1;
  for (let j = 0; j + 1 < rs.length; j++) for (let i = 0; i < n; i++) kit.paint.quadFacing(ids[j * m + i], ids[j * m + i + 1], ids[(j + 1) * m + i + 1], ids[(j + 1) * m + i], 0, 1, 0);
}

/** A strip along a->b (width w) at lift, draped every `step` m. */
function strip(kit: DistrictKit, gb: GeoBuilder, a: Vec2, b: Vec2, off: number, w: number, lift: number, color: THREE.Color, step: number): void {
  const len = Math.hypot(b.x - a.x, b.z - a.z);
  if (len < 0.1) return;
  const ux = (b.x - a.x) / len;
  const uz = (b.z - a.z) / len;
  const n = Math.max(1, Math.ceil(len / step));
  let pa = -1;
  let pb = -1;
  for (let k = 0; k <= n; k++) {
    const s = (len * k) / n;
    const cx = a.x + ux * s - uz * off;
    const cz = a.z + uz * s + ux * off;
    const ia = groundVertex(kit, gb, cx + uz * (w / 2), cz - ux * (w / 2), lift, color);
    const ib = groundVertex(kit, gb, cx - uz * (w / 2), cz + ux * (w / 2), lift, color);
    if (pa >= 0) gb.quadFacing(pa, ia, ib, pb, 0, 1, 0);
    pa = ia;
    pb = ib;
  }
}

/** Every track: ballast bed, ties (Medium and up), two rails; a buffer stop at the ends of storage tracks. */
function tracks(kit: DistrictKit, lay: YardLayout): void {
  const R = C.rail;
  const bed = col(0x4a443b);
  const tie = col(0x2c241e);
  const steel = col(0x8e9299);
  // Ties on Medium every second pitch (kilometres of track: the budget), every pitch on High, none on Low.
  const ties = kit.quality !== 'low';
  const tiePitch = kit.quality === 'high' ? R.tiePitch : R.tiePitch * 2;
  for (const t of lay.tracks) {
    const len = Math.hypot(t.b.x - t.a.x, t.b.z - t.a.z);
    if (len < 1) continue;
    const ux = (t.b.x - t.a.x) / len;
    const uz = (t.b.z - t.a.z) / len;
    strip(kit, kit.paint, t.a, t.b, 0, R.ballast, 0.012, bed, 9);
    if (ties) {
      for (let s = 0.4; s < len - 0.3; s += tiePitch) {
        const cx = t.a.x + ux * s;
        const cz = t.a.z + uz * s;
        const hx = -uz * (R.tie[0] / 2);
        const hz = ux * (R.tie[0] / 2);
        const q = [
          { x: cx - hx, z: cz - hz },
          { x: cx + hx, z: cz + hz },
          { x: cx + hx + ux * R.tie[1], z: cz + hz + uz * R.tie[1] },
          { x: cx - hx + ux * R.tie[1], z: cz - hz + uz * R.tie[1] },
        ].map((p) => groundVertex(kit, kit.paint, p.x, p.z, 0.022, tie));
        kit.paint.quadFacing(q[0], q[1], q[2], q[3], 0, 1, 0);
      }
    }
    for (const s of [-1, 1]) strip(kit, kit.paint, t.a, t.b, (s * R.gauge) / 2, R.head * 1.6, 0.03, steel, 8);
  }
}

/** Slick and pad patches as what they are. */
function patches(kit: DistrictKit, lay: YardLayout): void {
  const looks: Record<YardPatch['look'], THREE.Color> = {
    plate: col(0x58626e),
    oil: col(0x0c0c0e),
    grease: col(0x1a1712),
    spill: col(0x101418),
    concrete: col(0x6e6c68),
    asphalt: col(0x2b2d31),
    pad: col(0x5f5e5b),
  };
  for (const p of lay.patches) {
    const lift = p.surface === 'slick' ? 0.05 : 0.035;
    drapeConvex(kit, kit.paint, p.poly, lift, looks[p.look], 5);
    if (p.look === 'plate') {
      // The plates' sheen: a pale diagonal tread every metre.
      const [a, b, c, d] = p.poly;
      for (let k = 0.15; k < 1; k += 0.22) {
        const s0 = { x: a.x + (d.x - a.x) * k, z: a.z + (d.z - a.z) * k };
        const s1 = { x: b.x + (c.x - b.x) * k, z: b.z + (c.z - b.z) * k };
        strip(kit, kit.paint, s0, s1, 0, 0.12, 0.06, col(0x9aa6b4), 4);
      }
    }
  }
  // The pad's painted container slots: pale lines across it every 13 m.
  const f = lay.f;
  const t0 = frameT(f, lay.pad[0].x, lay.pad[0].z);
  const t1 = frameT(f, lay.pad[1].x, lay.pad[1].z);
  const w0 = frameW(f, lay.pad[0].x, lay.pad[0].z);
  const w1 = frameW(f, lay.pad[2].x, lay.pad[2].z);
  for (let t = Math.min(t0, t1) + 6; t < Math.max(t0, t1) - 2; t += 13) strip(kit, kit.paint, framePoint(f, t, w0), framePoint(f, t, w1), 0, 0.14, 0.05, col(0xc8c2a8, 0.7), 5);
}

/** The throat road: concrete slabs over the spine's asphalt, joints every 6 m. */
function throat(kit: DistrictKit, lay: YardLayout): void {
  const path = lay.region.path;
  const slabC = col(0x6a6964);
  for (let i = 0; i + 1 < path.length; i++) {
    const a = path[i];
    const b = path[i + 1];
    const w = i === 0 ? lay.region.widthE : i === path.length - 2 ? lay.region.widthX : lay.region.spineWidth;
    strip(kit, kit.paint, a, b, 0, w - 0.3, 0.025, slabC, 6);
    const len = Math.hypot(b.x - a.x, b.z - a.z);
    for (let s = 6; s < len; s += 6) {
      const k = s / len;
      const cx = a.x + (b.x - a.x) * k;
      const cz = a.z + (b.z - a.z) * k;
      const ux = (b.x - a.x) / len;
      const uz = (b.z - a.z) / len;
      strip(kit, kit.paint, { x: cx + uz * (w / 2 - 0.3), z: cz - ux * (w / 2 - 0.3) }, { x: cx - uz * (w / 2 - 0.3), z: cz + ux * (w / 2 - 0.3) }, 0, 0.08, 0.03, col(0x3a3936), 8);
    }
  }
}

export const railYardRenderer: DistrictRenderer = {
  kinds: ['railYard'],
  build(kit, areas) {
    const low = kit.quality === 'low';
    const pools = low ? null : new GeoBuilder(true);
    const pool = poolOf(kit);
    const cars = new GeoBuilder(true);
    for (const a of areas) {
      const lay = yardLayout(a);
      if (!lay) continue;
      ground(kit, lay);
      if (pools) wash(kit, lay, pools);
      wedgeGround(kit, lay.hump, col(0x4a4438), col(0x6a6458));
      if (lay.kicker) wedgeGround(kit, lay.kicker, col(0x4a4438), col(0x7a828c));
      dockGround(kit, lay);
      for (const b of lay.banks) bankGround(kit, b);
      patches(kit, lay);
      throat(kit, lay);
      tracks(kit, lay);
      for (const cs of lay.consists) {
        for (const car of cs.cars) addCar(kit, cars, kit.glow, car.c, car.ux, car.uz, -car.uz, car.ux, car.len, ['boxcar', 'tank', 'hopper', 'flatcar', 'caboose', 'autorack'].indexOf(car.kind), car.tex, kit.quality === 'high');
      }
      drawBridge(kit, lay);
      drawSolids(kit, lay, pools, pool);
      // Amber studs flush on the hump's crest and along the kicker's lip: the city's jump lip blink.
      for (const w of [lay.hump, ...(lay.kicker ? [lay.kicker] : [])]) {
        for (let b = -w.half + 0.8; b <= w.half - 0.8; b += w === lay.hump ? 3 : 1.2) {
          const p = wedgePoint(w, w.run, b);
          const y = kit.h(p.x, p.z);
          cylinder(kit.hazard, p.x, p.z, 0.16, y + 0.02, y + 0.07, 6, col(0xffa020));
        }
      }
      // Lanterns at the fence's mouths: a warm pool on the sidewalk either side.
      if (pools) for (const m of lay.mouths) pool(pools, m.x, m.z, 9, col(0xffd8a0, 0.22));
    }
    if (cars.vertexCount) {
      const mesh = new THREE.Mesh(kit.track(cars.build()), carMaterial(kit, kit.track(makeYardAtlas())));
      mesh.name = 'railYardCars';
      kit.group.add(mesh);
    }
    if (pools?.vertexCount) {
      const mat = kit.track(new THREE.MeshBasicMaterial({ map: kit.track(makeRadialGlow()), vertexColors: true, transparent: true, blending: THREE.AdditiveBlending, depthWrite: false, polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2 }));
      const mesh = new THREE.Mesh(kit.track(pools.build()), mat);
      mesh.name = 'railYardLightPools';
      mesh.renderOrder = 1;
      kit.group.add(mesh);
    }
  },
};
