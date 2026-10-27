/**
 * Building meshes from the architecture plan (architecture.ts): every
 * building's massing, crown, roof, rooftop clutter and facade details, merged
 * into a handful of meshes for the whole city.
 *
 * A building is a facade kit podium (facadeKit.ts: storefronts, stoops,
 * arcades...) under a shaft of facade walls (facadeMaterial.ts: one texture
 * array, procedural window light). The shaft is one or more masses: tiers
 * stepping back up a deco tower, narrow terrace houses along a rowhouse
 * block, a rounded-corner Miami block. Floors line up across tiers, and the
 * top is floor aligned so no window is cut by the roofline. Crowns and roofs
 * follow the style: stepped deco crowns with floodlights and spires, glass
 * tower LED bands, slants and pyramids, mansards, Spanish tile hips,
 * Victorian gables, heavy cornices and mid-century roof slabs. Roofs carry
 * water towers, bulkheads, AC units, masts with aviation lights and lit
 * billboards; facades carry fire escapes, bay windows, eyebrows, balconies,
 * fins and neon bands.
 *
 * Draw calls: shells, roofs, neon and the podium trim (which also takes the
 * cornices, slabs and balconies) as before, plus fire escapes, billboards and
 * aviation lights. Detail scales with the graphics tier (fire escapes, bay
 * brackets, balcony rails, clutter density, animated windows). Render only.
 *
 * This module is the plan: the city pass (recessing coplanar walls), one
 * building's massing, the plinth and the terrace houses, and the meshes they
 * merge into. The shared primitives live in buildingKit.ts, the crowns and
 * rooftop clutter in roofs.ts, the bolted-on wall details in facadeDetails.ts.
 */
import * as THREE from 'three';
import type { World } from '../../city/world';
import type { Building } from '../../city/blocks';
import { corridorClearance } from '../../city/blocks';
import { Vec2 } from '../../sim/math';
import { Rng } from '../../sim/prng';
import { SpatialGrid } from '../../city/spatial';
import { GeoBuilder } from '../geoBuilder';
import { GROUND_BAYS, GROUND_H, PODIUM_FLOOR_H, PodiumOutput, addPodiumFace, podiumExtrusions, podiumHeight } from './facadeKit';
import { LAYER, MODULE, facadeAtlas } from './facadeAtlas';
import { billboardAtlas } from '../textures/billboardAtlas';
import { createFacadeMaterials, TRIM_COLORS } from './facadeMaterial';
import { BuildingPlan, STYLES, StyleDef, planArchitecture } from './architecture';
import { planBacklots } from './backlots';
import { BLD, DETAIL, FLOOD, pastelNeon, neonColor, setNeonMood, LED, WHITE, NO_GLOW, wash, ShellGeo, Frame, edgeNormal, boxOutline, roundedOutline, lbox, cap, facet, walls, neonRing, neonPost, cornice, colorOf } from './buildingKit';
import type { Skin, Out, Detail } from './buildingKit';
import { FlickList, applyFlicker } from '../street/signage';
import { DRAG, routeNearness } from '../street/routeNearness';
import { waterTower, chimney, spire, pyramid, wedge, mansard, hipRoof, mast, light, roofLights, clutter, billboard } from './roofs';
import { bayWindow, fireEscapes, balcony, eyebrow, fin } from './facadeDetails';

export type { Detail };

export interface BuildingMeshes {
  meshes: THREE.Object3D[];
  /** Advance animated windows and aviation lights (s). */
  update(time: number): void;
  dispose(): void;
}

// ---------------------------------------------------------------------------
// The city
// ---------------------------------------------------------------------------

/**
 * Footprints may overlap (a corner building over the street building on the
 * same street sits on the same setback line), and two overlapping walls in
 * one plane z-fight: patches of both buildings' window light flicker through
 * each other. Where two walls face the same way in the same plane, the lower
 * building's wall steps back so the taller one wins (ties go to the later,
 * a corner building over the street row). A recessed wall can land in the
 * plane of a third building's, so the pass repeats until none share a plane.
 * Render only: the city keeps its footprints, so replays and the frontage
 * never notice.
 */
export function recessCoplanar(B: readonly Building[], plans: readonly BuildingPlan[]): Building[] {
  let out = B as Building[];
  for (let pass = 0; pass < 4; pass++) {
    const next = recessPass(out, plans);
    if (next === out) break;
    out = next;
  }
  return out;
}

/** One recess pass; returns the same array when no two walls share a plane. */
function recessPass(B: Building[], plans: readonly BuildingPlan[]): Building[] {
  // Local frame of a footprint: u along local +X, w along local +Z; walls 0..3 face -w, +u, +w, -u.
  const frame = (b: Building) => ({ ux: Math.cos(b.yaw), uz: -Math.sin(b.yaw), wx: Math.sin(b.yaw), wz: Math.cos(b.yaw) });
  const walls = (b: Building) => {
    const { ux, uz, wx, wz } = frame(b);
    const hw = b.w / 2;
    const hd = b.d / 2;
    const c = (a: number, s: number) => ({ x: b.x + ux * a + wx * s, z: b.z + uz * a + wz * s });
    const P = [c(-hw, -hd), c(hw, -hd), c(hw, hd), c(-hw, hd)];
    return P.map((p, k) => ({ p, q: P[(k + 1) % 4] }));
  };
  let minX = Infinity;
  let minZ = Infinity;
  let maxX = -Infinity;
  let maxZ = -Infinity;
  for (const b of B) {
    minX = Math.min(minX, b.x);
    minZ = Math.min(minZ, b.z);
    maxX = Math.max(maxX, b.x);
    maxZ = Math.max(maxZ, b.z);
  }
  const grid = SpatialGrid.forBounds(minX, minZ, maxX + 1, maxZ + 1, 64);
  const radius = B.map((b) => Math.hypot(b.w, b.d) / 2);
  B.forEach((b, i) => grid.insertBox(i, b.x - radius[i], b.z - radius[i], b.x + radius[i], b.z + radius[i]));
  const recess = B.map(() => [false, false, false, false]);
  const near: number[] = [];
  for (let i = 0; i < B.length; i++) {
    const a = B[i];
    grid.query(a.x - radius[i], a.z - radius[i], a.x + radius[i], a.z + radius[i], near);
    const wa = walls(a);
    for (const j of near) {
      if (j <= i) continue;
      const b = B[j];
      if (Math.hypot(a.x - b.x, a.z - b.z) > radius[i] + radius[j]) continue;
      const wb = walls(b);
      const lower = plans[i].h < plans[j].h ? i : j;
      for (let ka = 0; ka < 4; ka++) {
        const { p, q } = wa[ka];
        const dx = q.x - p.x;
        const dz = q.z - p.z;
        const len = Math.hypot(dx, dz);
        for (let kb = 0; kb < 4; kb++) {
          const f = wb[kb];
          const ex = f.q.x - f.p.x;
          const ez = f.q.z - f.p.z;
          if ((dx * ex + dz * ez) / (len * Math.hypot(ex, ez)) < 0.9998) continue;
          const t0 = ((f.p.x - p.x) * dx + (f.p.z - p.z) * dz) / len;
          const t1 = ((f.q.x - p.x) * dx + (f.q.z - p.z) * dz) / len;
          const lo = Math.max(0, Math.min(t0, t1));
          const hi = Math.min(len, Math.max(t0, t1));
          if (hi - lo < 0.5) continue;
          // Plane gap where the walls come closest: at either end of the shared stretch, or at the other
          // wall's start (the walls may be a hair off parallel: a few mrad over a 20 m wall opens 0.1 m
          // from one end to the other, and a wall that starts in the plane and drifts out of it still
          // reads as one surface from the street).
          const gapAt = (t: number) => {
            const x = f.p.x + (ex * (t - t0)) / (t1 - t0);
            const z = f.p.z + (ez * (t - t0)) / (t1 - t0);
            return Math.abs(((x - p.x) * dz - (z - p.z) * dx) / len);
          };
          if (Math.min(gapAt(lo), gapAt(hi), gapAt(t0)) > BLD.coplanarTol) continue;
          recess[lower][lower === i ? ka : kb] = true;
        }
      }
    }
  }
  if (!recess.some((r) => r.some(Boolean))) return B;
  return B.map((b, i) => {
    const r = recess[i];
    if (!r.some(Boolean)) return b;
    const { ux, uz, wx, wz } = frame(b);
    const du = Math.min(BLD.recess, b.w * 0.05);
    const dw = Math.min(BLD.recess, b.d * 0.05);
    // Shift of the center along u and w: each recessed wall pulls its side in by its depth.
    const cu = ((r[3] ? du : 0) - (r[1] ? du : 0)) / 2;
    const cw = ((r[0] ? dw : 0) - (r[2] ? dw : 0)) / 2;
    return {
      ...b,
      x: b.x + ux * cu + wx * cw,
      z: b.z + uz * cu + wz * cw,
      w: b.w - (r[1] ? du : 0) - (r[3] ? du : 0),
      d: b.d - (r[0] ? dw : 0) - (r[2] ? dw : 0),
    };
  });
}

export function buildBuildings(world: World, podium: PodiumOutput, opts: { detail: Detail }): BuildingMeshes {
  const det = DETAIL[opts.detail];
  setNeonMood(world.seed);
  const atlas = facadeAtlas();
  const mats = createFacadeMaterials(atlas, { live: det.live });
  const plans = planArchitecture(world);
  const o: Out = {
    shell: new ShellGeo(),
    roofs: new GeoBuilder(true),
    trim: podium.trim,
    neon: new GeoBuilder(true),
    flick: new FlickList(world, 'roof'),
    escapes: new GeoBuilder(),
    boards: new GeoBuilder(true),
    lights: [],
    podium,
  };
  const g = world.graph;
  const scratch: number[] = [];
  const B = recessCoplanar(world.blocks.buildings, plans);
  // The main drag burns brighter than the side streets (street/routeNearness.ts): a window density multiplier per building, plus a nearness bucket for the lowest floors.
  const near = routeNearness(world);
  const dragOf = (b: Building, lowFloors: boolean): DragLight => ({
    windows: near.scale(DRAG.windows, b.x, b.z),
    bucket: lowFloors ? Math.round(near.at(b.x, b.z) * Math.min(1, near.strength) * FLAG_NEAR_MAX) : 0,
  });
  for (let i = 0; i < B.length; i++) buildOne(o, B[i], plans[i], det, (x, z) => corridorClearance(g, world.blocks.edgeGrid, x, z, scratch) < 2, world.heightAt, dragOf(B[i], true));
  // The blocks' middles (backlots.ts), Medium and up: no street fronts, so no shops or stoops on them.
  if (opts.detail !== 'low') {
    const back = planBacklots(world, plans);
    for (let i = 0; i < back.buildings.length; i++) buildOne(o, back.buildings[i], back.plans[i], det, () => false, world.heightAt, dragOf(back.buildings[i], false), true);
  }

  const disposables: { dispose(): void }[] = [mats];
  const track = <T extends { dispose(): void }>(x: T): T => {
    disposables.push(x);
    return x;
  };
  const meshes: THREE.Object3D[] = [];
  const shell = new THREE.Mesh(track(o.shell.build()), mats.facade);
  shell.name = 'buildings';
  meshes.push(shell);
  const roofMesh = new THREE.Mesh(track(o.roofs.build()), track(new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.88, metalness: 0.05, envMapIntensity: 0.5 })));
  roofMesh.name = 'roofs';
  meshes.push(roofMesh);
  if (o.neon.vertexCount) {
    const neonMat = track(new THREE.MeshBasicMaterial({ vertexColors: true }));
    neonMat.color.setScalar(1.5);
    applyFlicker(neonMat);
    const neonGeo = track(o.neon.build());
    neonGeo.setAttribute('aFlick', o.flick.attribute(o.neon.vertexCount));
    const m = new THREE.Mesh(neonGeo, neonMat);
    m.name = 'roofNeon';
    meshes.push(m);
  }
  if (o.escapes.vertexCount) {
    const m = new THREE.Mesh(
      track(o.escapes.build()),
      track(new THREE.MeshStandardMaterial({ map: atlas.fireEscape, alphaTest: 0.5, side: THREE.DoubleSide, roughness: 0.7, metalness: 0.4, color: 0xffffff })),
    );
    m.name = 'fireEscapes';
    meshes.push(m);
  }
  if (o.boards.vertexCount) {
    const mat = track(new THREE.MeshBasicMaterial({ map: billboardAtlas(world.seed), vertexColors: true }));
    const m = new THREE.Mesh(track(o.boards.build()), mat);
    m.name = 'billboards';
    meshes.push(m);
  }
  if (o.lights.length) {
    const n = o.lights.length;
    const pos = new Float32Array(n * 12);
    const corner = new Float32Array(n * 8);
    const light = new Float32Array(n * 8);
    const idx = new Uint32Array(n * 6);
    const C = [-1, -1, 1, -1, 1, 1, -1, 1];
    o.lights.forEach((l, k) => {
      for (let c = 0; c < 4; c++) {
        pos.set([l.x, l.y, l.z], k * 12 + c * 3);
        corner.set([C[c * 2], C[c * 2 + 1]], k * 8 + c * 2);
        light.set([l.phase, l.steady], k * 8 + c * 2);
      }
      idx.set([k * 4, k * 4 + 1, k * 4 + 2, k * 4, k * 4 + 2, k * 4 + 3], k * 6);
    });
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    geo.setAttribute('corner', new THREE.BufferAttribute(corner, 2));
    geo.setAttribute('light', new THREE.BufferAttribute(light, 2));
    geo.setIndex(new THREE.BufferAttribute(idx, 1));
    const m = new THREE.Mesh(track(geo), mats.aviation);
    m.frustumCulled = false;
    m.renderOrder = 2;
    m.name = 'aviationLights';
    meshes.push(m);
  }
  return {
    meshes,
    update(time) {
      mats.update(time);
    },
    dispose() {
      for (const d of disposables) d.dispose();
    },
  };
}

/**
 * Dark concrete plinth where a building meets rising ground. The base sits at
 * the lowest footprint corner, so on a hillside the uphill faces are buried;
 * along each face the plinth climbs with the ground in short steps and stands
 * a hair proud of the facade, so a buried storefront reads as a retaining
 * wall with the shop glass above it, and the podium never floats where the
 * ground dips between two corners. Flat ground gets nothing.
 */
function plinth(o: Out, F: Frame, base: Vec2[], street: number, groundAt: (x: number, z: number) => number): void {
  const color = colorOf(0x34353b);
  const out = 0.12;
  const y0 = street - 0.6;
  for (let i = 0; i < 4; i++) {
    const p = base[i];
    const q = base[(i + 1) % 4];
    const n = edgeNormal(p, q);
    const nx = F.NX(n.x, n.z);
    const nz = F.NZ(n.x, n.z);
    const len = Math.hypot(q.x - p.x, q.z - p.z);
    const steps = Math.max(1, Math.ceil(len / 6));
    // Ground height per step, then neighbouring steps within 12 cm of each other (the run takes the highest, so it never sinks below the ground) share one run.
    const tops: number[] = [];
    for (let k = 0; k < steps; k++) {
      const t0 = k / steps;
      const t1 = (k + 1) / steps;
      const ax = F.X(p.x + (q.x - p.x) * t0, p.z + (q.z - p.z) * t0);
      const az = F.Z(p.x + (q.x - p.x) * t0, p.z + (q.z - p.z) * t0);
      const bx = F.X(p.x + (q.x - p.x) * t1, p.z + (q.z - p.z) * t1);
      const bz = F.Z(p.x + (q.x - p.x) * t1, p.z + (q.z - p.z) * t1);
      tops.push(Math.max(groundAt(ax + nx * 0.6, az + nz * 0.6), groundAt(bx + nx * 0.6, bz + nz * 0.6)) + 0.32);
    }
    for (let k = 0; k < steps; ) {
      let end = k + 1;
      let top = tops[k];
      while (end < steps && Math.abs(tops[end] - tops[k]) < 0.12) top = Math.max(top, tops[end++]);
      const t0 = k / steps;
      const t1 = end / steps;
      k = end;
      const ax = F.X(p.x + (q.x - p.x) * t0, p.z + (q.z - p.z) * t0);
      const az = F.Z(p.x + (q.x - p.x) * t0, p.z + (q.z - p.z) * t0);
      const bx = F.X(p.x + (q.x - p.x) * t1, p.z + (q.z - p.z) * t1);
      const bz = F.Z(p.x + (q.x - p.x) * t1, p.z + (q.z - p.z) * t1);
      if (top < street + 0.4) continue;
      const v = [
        o.trim.vertex(ax + nx * out, y0, az + nz * out, nx, 0, nz, 0, 0, color),
        o.trim.vertex(bx + nx * out, y0, bz + nz * out, nx, 0, nz, 1, 0, color),
        o.trim.vertex(bx + nx * out, top, bz + nz * out, nx, 0, nz, 1, 1, color),
        o.trim.vertex(ax + nx * out, top, az + nz * out, nx, 0, nz, 0, 1, color),
      ];
      o.trim.quadFacing(v[0], v[1], v[2], v[3], nx, 0, nz);
      const lip = [
        o.trim.vertex(ax, top, az, 0, 1, 0, 0, 0, color),
        o.trim.vertex(bx, top, bz, 0, 1, 0, 1, 0, color),
        o.trim.vertex(bx + nx * out, top, bz + nz * out, 0, 1, 0, 1, 1, color),
        o.trim.vertex(ax + nx * out, top, az + nz * out, 0, 1, 0, 0, 1, color),
      ];
      o.trim.quadFacing(lip[0], lip[1], lip[2], lip[3], 0, 1, 0);
    }
  }
}

/** How a building's windows lean toward the main drag: the density multiplier, and the nearness bucket (0..FLAG_NEAR_MAX, 0 for a backlot, whose ground floors nobody sees) that lifts its lowest floors. */
interface DragLight {
  windows: number;
  bucket: number;
}

/** Skin flag layout above the office / trim / glass bits (facadeMaterial.ts decodes them): nearness bucket from bit 9, the shaft's first module row from bit 12. */
const FLAG_NEAR = 512;
const FLAG_NEAR_MAX = 3;
const FLAG_BASE = 4096;

/** Everything for one building; a backlot (backlots.ts: no street, seen over walls and from above) has no podium, its shaft runs down to the ground. */
function buildOne(o: Out, b: Building, plan: BuildingPlan, det: (typeof DETAIL)[Detail], streetAt: (x: number, z: number) => boolean, groundAt: (x: number, z: number) => number, drag: DragLight, backlot = false): void {
  const S = STYLES[plan.style];
  const rng = new Rng((plan.seed ^ 0x6b1d5) >>> 0 || 1);
  const F = new Frame(b.x, b.z, b.yaw);
  const hw = b.w / 2;
  const hd = b.d / 2;
  const base = boxOutline(-hw, hw, -hd, hd);
  const front = base.map((p, i) => {
    const q = base[(i + 1) % 4];
    const n = edgeNormal(p, q);
    const mx = (p.x + q.x) / 2 + n.x * 1.5;
    const mz = (p.z + q.z) / 2 + n.z * 1.5;
    return streetAt(F.X(mx, mz), F.Z(mx, mz));
  });
  const street = b.baseY + 0.6;
  plinth(o, F, base, street, groundAt);
  const m = MODULE[S.layer];
  const fh = m.floor;
  const maxKit = Math.max(0, Math.floor((plan.h - 0.6 - GROUND_H) / PODIUM_FLOOR_H) - 1);
  const kit = Math.min(maxKit, rng.int(S.kitFloors[0], S.kitFloors[1]));
  const y0 = backlot ? street : street + podiumHeight(kit);
  const want = b.baseY + plan.h;
  let nF = Math.max(1, Math.round((want - y0) / fh));
  nF = Math.max(nF, Math.ceil((b.baseY + plan.flush - y0) / fh - 1e-6));
  const yTop = y0 + nF * fh;
  const flushFloor = Math.max(0, Math.ceil((b.baseY + plan.flush - y0) / fh - 1e-6));
  const vRef = y0 - rng.int(0, 7) * fh;
  const seed01 = ((plan.seed >>> 0) % 10007) / 10007;
  const makeSkin = (tintHex: number, layer = S.layer, litMul = 1): Skin => {
    const office = rng.chance(S.office) ? 1 : 0;
    const trim = rng.pick(S.trims);
    const glass = rng.pick(S.glass);
    const mm = MODULE[layer];
    // The facade shader reads, above the office/trim/glass bits, how near the drag the building stands (so its lowest
    // floors burn brighter) and which module row the shaft starts on (so it can tell those floors).
    const baseRow = Math.max(0, Math.min(15, Math.round((y0 - vRef) / mm.floor)));
    return {
      layer: LAYER[layer],
      seed: (seed01 + rng.next() * 0.37) % 1,
      lit: rng.range(S.lit[0], S.lit[1]) * litMul * drag.windows,
      flags: office + 2 * trim + 32 * glass + FLAG_NEAR * drag.bucket + FLAG_BASE * baseRow,
      tint: colorOf(tintHex, rng.range(0.88, 1.08)),
      bay: mm.bay,
      floor: mm.floor,
    };
  };
  const skin = makeSkin(rng.pick(S.palette));
  const trimColor = colorOf(TRIM_COLORS[(skin.flags >> 1) & 15], 0.85);
  const bays = S.ground.map((name) => GROUND_BAYS.indexOf(name));
  const podTint = new THREE.Color(1, 1, 1).lerp(skin.tint, 0.5);
  const sideSkin = S.side ? { ...makeSkin(rng.pick(S.palette), S.side, 0.4), tint: skin.tint } : null;

  // Terrace styles on a street split into narrow houses (half the brownstones stay one walk-up).
  const split = !!S.units && front[0] && (plan.style === 'brownstone' ? b.w >= 14 && rng.chance(0.5) : b.w >= S.units[0] * 1.6);
  if (split) {
    terrace(o, F, b, plan, S, rng, det, front, street, y0, nF, fh, vRef, flushFloor, makeSkin, bays);
    return;
  }

  // ----- Podium -----
  const ext = podiumExtrusions(rng, kit);
  for (let i = 0; i < (backlot ? 0 : 4); i++) {
    const p = base[i];
    const q = base[(i + 1) % 4];
    const n = edgeNormal(p, q);
    addPodiumFace(
      o.podium,
      { ax: F.X(p.x, p.z), az: F.Z(p.x, p.z), bx: F.X(q.x, q.z), bz: F.Z(q.x, q.z), nx: F.NX(n.x, n.z), nz: F.NZ(n.x, n.z), y0: street, yBase: b.baseY, front: front[i], bays, tint: podTint },
      kit,
      rng,
      ext,
    );
  }

  const faceSkin = sideSkin && (plan.style === 'brownstone' || plan.style === 'rowhouse') ? (i: number) => (front[i] || i === 2 ? skin : sideSkin) : undefined;
  const style = plan.style;
  const tall = yTop - street;

  // ----- Shaft and crown per style -----
  if (style === 'deco') {
    const lit = rng.chance(0.85);
    const flood = FLOOD[rng.chance(0.7) ? rng.int(0, 2) : rng.int(3, 5)];
    let x0 = -hw;
    let x1 = hw;
    let z0 = -hd;
    let z1 = hd;
    let yb = y0;
    const steps = nF >= 12 ? (plan.landmark ? 4 : rng.int(2, 3)) : nF >= 7 ? 1 : 0;
    const stepFloors = BLD.decoSteps.slice(0, steps).map((f) => Math.max(flushFloor + 1, Math.round(nF * f)));
    let prevFloor = 0;
    for (let k = 0; k <= steps; k++) {
      const topFloor = k < steps ? Math.min(nF - 1, stepFloors[k]) : nF;
      if (topFloor <= prevFloor) continue;
      const yt = y0 + topFloor * fh;
      const isTop = k === steps;
      const glow = lit && (isTop || k >= steps - 1) && steps > 0 ? wash(flood, yb, 1.15, yt, 0.25) : NO_GLOW;
      walls(o, F, skin, boxOutline(x0, x1, z0, z1), null, yb, yt, vRef, street, glow, rng, 'face');
      cap(o.roofs, F, boxOutline(x0, x1, z0, z1), yt, colorOf(0x1a1b20, rng.range(0.8, 1.2)));
      // Coping at every setback.
      cornice(o, F, x0, x1, z0, z1, yt + 0.35, 0.45, 0.12, trimColor, [true, true, true, true]);
      yb = yt;
      prevFloor = topFloor;
      const inset = Math.max(1.4, Math.min(x1 - x0, z1 - z0) * rng.range(0.08, 0.14));
      if (!isTop && x1 - x0 - 2 * inset > 6 && z1 - z0 - 2 * inset > 6) {
        x0 += inset;
        x1 -= inset;
        z0 += inset;
        z1 -= inset;
      }
    }
    // Stepped crown and spire, floodlit.
    let cy = yTop;
    const crownSteps = plan.landmark ? 3 : rng.int(1, 3);
    for (let k = 0; k < crownSteps; k++) {
      const inset = Math.min(x1 - x0, z1 - z0) * 0.17;
      if (x1 - x0 - 2 * inset < 2.5) break;
      x0 += inset;
      x1 -= inset;
      z0 += inset;
      z1 -= inset;
      const h = fh * rng.range(0.6, 1.1);
      walls(o, F, { ...skin, lit: skin.lit * 0.5 }, boxOutline(x0, x1, z0, z1), null, cy, cy + h, vRef, street, lit ? wash(flood, cy, 1.3, cy + h, 0.5) : NO_GLOW, rng, 'face');
      cap(o.roofs, F, boxOutline(x0, x1, z0, z1), cy + h, colorOf(0x1a1b20));
      cy += h;
    }
    if (plan.landmark || rng.chance(0.55)) {
      const sh = plan.landmark ? rng.range(22, 34) : rng.range(6, 15);
      const r = Math.min(x1 - x0, z1 - z0) * 0.32;
      spire(o, F, (x0 + x1) / 2, (z0 + z1) / 2, r, cy, cy + sh, skin, street, lit ? flood : null);
      light(o, F.X((x0 + x1) / 2, (z0 + z1) / 2), cy + sh + 0.4, F.Z((x0 + x1) / 2, (z0 + z1) / 2), rng, false);
    } else if (cy - street > BLD.aviationAbove) {
      roofLights(o, F, x0, x1, z0, z1, cy + 0.3, rng);
    }
    return;
  }

  if (style === 'glass') {
    let x0 = -hw;
    let x1 = hw;
    let z0 = -hd;
    let z1 = hd;
    let yb = y0;
    const setback = nF >= 10 && rng.chance(0.32) ? Math.max(flushFloor + 1, Math.round(nF * rng.range(0.62, 0.8))) : -1;
    if (setback > 0 && setback < nF) {
      const yt = y0 + setback * fh;
      walls(o, F, skin, boxOutline(x0, x1, z0, z1), null, yb, yt, vRef, street, NO_GLOW, rng, 'face');
      cap(o.roofs, F, boxOutline(x0, x1, z0, z1), yt, colorOf(0x2a2c30));
      const inset = rng.range(2, 4);
      if (x1 - x0 - 2 * inset > 8 && z1 - z0 - 2 * inset > 8) {
        x0 += inset;
        x1 -= inset;
        z0 += inset;
        z1 -= inset;
      }
      yb = yt;
    }
    const crown = plan.landmark ? 'pyramid' : plan.region === 'sf' && nF > 12 && rng.chance(0.12) ? 'pyramid' : rng.pick(['band', 'band', 'slant', 'penthouse', 'flat'] as const);
    const ledColor = LED[rng.int(0, LED.length - 1)];
    walls(o, F, skin, boxOutline(x0, x1, z0, z1), null, yb, yTop, vRef, street, NO_GLOW, rng, 'face');
    const outline = boxOutline(x0, x1, z0, z1);
    if (nF >= 8 && rng.chance(0.25)) {
      for (const p of outline) neonPost(o, F, p.x, p.z, yb + fh, yTop, ledColor, 0.06);
    }
    if (crown === 'pyramid') {
      const ph = Math.min(x1 - x0, z1 - z0) * (plan.landmark ? 1.6 : 0.8);
      pyramid(o, F, outline, yTop, yTop + ph, skin, street);
      light(o, F.X((x0 + x1) / 2, (z0 + z1) / 2), yTop + ph + 0.4, F.Z((x0 + x1) / 2, (z0 + z1) / 2), rng, false);
    } else if (crown === 'slant') {
      const sh = Math.min(x1 - x0, z1 - z0) * rng.range(0.3, 0.55);
      wedge(o, F, x0, x1, z0, z1, yTop, sh, skin, vRef, street, rng);
      neonRing(o, F, outline, yTop - 0.35, yTop - 0.1, ledColor);
      if (yTop + sh - street > BLD.aviationAbove) light(o, F.X((x0 + x1) / 2, z1), yTop + sh + 0.3, F.Z((x0 + x1) / 2, z1), rng, false);
    } else {
      cap(o.roofs, F, outline, yTop, colorOf(0x2a2c30, rng.range(0.8, 1.2)));
      cornice(o, F, x0, x1, z0, z1, yTop + 0.9, 0.9, 0.05, colorOf(0x30343a), [true, true, true, true]);
      if (crown === 'band') neonRing(o, F, outline, yTop + 0.25, yTop + 0.65, ledColor);
      if (crown === 'penthouse' || crown === 'band') {
        const ix = (x1 - x0) * 0.22;
        const iz = (z1 - z0) * 0.22;
        const ph = fh * rng.range(1, 1.6);
        walls(o, F, { ...skin, lit: 0.05 }, boxOutline(x0 + ix, x1 - ix, z0 + iz, z1 - iz), null, yTop, yTop + ph, vRef, street, NO_GLOW, rng, 'face');
        cap(o.roofs, F, boxOutline(x0 + ix, x1 - ix, z0 + iz, z1 - iz), yTop + ph, colorOf(0x24262a));
        mast(o, F, (x0 + x1) / 2 + ix * 0.6, (z0 + z1) / 2, yTop + ph, rng.range(5, 12), rng, tall > BLD.aviationAbove - 10);
      }
      if (tall > BLD.aviationAbove) roofLights(o, F, x0, x1, z0, z1, yTop + 1, rng);
      if (crown === 'flat') clutter(o, F, x0 + 1, x1 - 1, z0 + 1, z1 - 1, yTop, rng, det, 'ac', skin.tint);
    }
    return;
  }

  if (style === 'condo') {
    const glow = rng.chance(0.4) ? wash(pastelNeon(rng.next()), y0, 0.35, yTop, 0.05) : NO_GLOW;
    walls(o, F, skin, base, null, y0, yTop, vRef, street, glow, rng, 'face');
    cap(o.roofs, F, base, yTop, colorOf(0x3a3c40));
    // Balconies on the street faces, every floor above the podium.
    const slab = colorOf(0xf2f2ee, 0.9);
    const rail = colorOf(0x8fa8b8, 0.75);
    for (let i = 0; i < 4; i++) {
      if (!front[i]) continue;
      const depth = 1.5;
      for (let k = 1; k < nF; k++) {
        const y = y0 + k * fh;
        balcony(o, F, i, hw, hd, y, depth, slab, det.rails ? rail : null);
      }
    }
    cornice(o, F, -hw, hw, -hd, hd, yTop + 1, 1, 0.3, slab, [true, true, true, true]);
    if (rng.chance(0.6)) neonRing(o, F, base, yTop + 0.35, yTop + 0.7, LED[rng.int(0, LED.length - 1)]);
    if (rng.chance(0.35)) fin(o, F, hw, hd, yTop, rng.range(4, 9), slab, pastelNeon(rng.next()));
    if (tall > BLD.aviationAbove) roofLights(o, F, -hw, hw, -hd, hd, yTop + 1.1, rng);
    else clutter(o, F, -hw + 1.5, hw - 1.5, -hd + 1.5, hd - 1.5, yTop, rng, det, 'ac', skin.tint);
    return;
  }

  if (style === 'miamiDeco') {
    const neon = pastelNeon(rng.next());
    const round = !plan.signed && rng.chance(0.65);
    const corners = [front[3] && front[0], front[0] && front[1], front[1] && front[2], front[2] && front[3]].map((c) => c || (round && rng.chance(0.25)));
    const ol = round ? roundedOutline(-hw, hw, -hd, hd, Math.min(3, Math.min(hw, hd) * 0.45), corners.map((c) => c && round)) : { pts: base, smooth: null };
    // Colored uplight washing the facade, strongest at the shop fronts (mixed toward white so the
    // pastel underneath still shows).
    const glow = wash(neon.clone().lerp(WHITE, 0.45), y0, 0.3, yTop, 0.04);
    walls(o, F, skin, ol.pts, ol.smooth, y0, yTop, vRef, street, glow, rng, round ? 'perimeter' : 'face');
    cap(o.roofs, F, ol.pts, yTop + 0.5, colorOf(0x2c2c30));
    // Parapet band, neon tubes along the top and over the shop fronts.
    walls(o, F, { ...skin, lit: 0 }, ol.pts, ol.smooth, yTop, yTop + 0.5, vRef - 0.4, street, NO_GLOW, rng, round ? 'perimeter' : 'face');
    neonRing(o, F, ol.pts, yTop - 0.25, yTop - 0.05, neon);
    neonRing(o, F, ol.pts, street + GROUND_H - 0.05, street + GROUND_H + 0.12, pastelNeon(rng.next()), 0.62, (i) => {
      const p = ol.pts[i];
      const q = ol.pts[(i + 1) % ol.pts.length];
      const n = edgeNormal(p, q);
      return (n.z < -0.5 && front[0]) || (n.x > 0.5 && front[1]) || (n.z > 0.5 && front[2]) || (n.x < -0.5 && front[3]);
    });
    // Eyebrow sun shades over every floor's windows on the street faces.
    const brow = colorOf(TRIM_COLORS[(skin.flags >> 1) & 15], 0.9);
    for (let i = 0; i < 4; i++) {
      if (!front[i]) continue;
      for (let k = 0; k < nF; k++) eyebrow(o, F, i, hw, hd, round ? Math.min(3, Math.min(hw, hd) * 0.45) : 0, y0 + (k + 1) * fh - 0.62, brow);
    }
    if (rng.chance(0.45)) fin(o, F, hw, hd, yTop + 0.5, rng.range(3, 6.5), brow, neon);
    else if (rng.chance(0.4)) clutter(o, F, -hw + 1.5, hw - 1.5, -hd + 1.5, hd - 1.5, yTop + 0.5, rng, det, 'ac', skin.tint);
    return;
  }

  // Low and mid rise masonry and stucco: one mass, style specific top.
  let roofY = yTop;
  let x0 = -hw;
  let x1 = hw;
  let z0 = -hd;
  let z1 = hd;
  if (style === 'prewar' && nF >= 10 && rng.chance(0.5)) {
    const sf = Math.max(flushFloor + 1, Math.round(nF * rng.range(0.78, 0.88)));
    if (sf < nF) {
      const yt = y0 + sf * fh;
      walls(o, F, skin, base, null, y0, yt, vRef, street, NO_GLOW, rng, 'face', undefined, faceSkin);
      cap(o.roofs, F, base, yt, colorOf(0x1a1b20));
      cornice(o, F, x0, x1, z0, z1, yt + 0.6, 0.7, 0.45, trimColor, [true, true, true, true]);
      const inset = rng.range(2, 3.2);
      if (b.w - 2 * inset > 7 && b.d - 2 * inset > 7) {
        x0 += inset;
        x1 -= inset;
        z0 += inset;
        z1 -= inset;
      }
      walls(o, F, skin, boxOutline(x0, x1, z0, z1), null, yt, yTop, vRef, street, NO_GLOW, rng, 'face');
    } else walls(o, F, skin, base, null, y0, yTop, vRef, street, NO_GLOW, rng, 'face', undefined, faceSkin);
  } else {
    const glow = style === 'empire' && rng.chance(0.5) ? wash(FLOOD[1], y0, 0.45, y0 + fh * 2.2, 0) : NO_GLOW;
    walls(o, F, skin, base, null, y0, yTop, vRef, street, glow, rng, 'face', undefined, faceSkin);
  }
  const outline = boxOutline(x0, x1, z0, z1);

  if (style === 'empire') {
    cornice(o, F, x0, x1, z0, z1, yTop + 0.75, 0.75, 0.5, trimColor, [true, true, true, true]);
    mansard(o, F, x0, x1, z0, z1, yTop + 0.75, 4, { ...skin, layer: LAYER.mansard, bay: MODULE.mansard.bay, floor: MODULE.mansard.floor, tint: colorOf(0x9aa0a8) }, street, rng);
    roofY = yTop + 4.75;
    if (rng.chance(0.6)) for (let k = 0; k < 2; k++) chimney(o, F, rng.range(x0 + 2, x1 - 2), rng.chance(0.5) ? z0 + 1.8 : z1 - 1.8, roofY, colorOf(0x6a4a3a));
    return;
  }
  if (style === 'spanish') {
    if (rng.chance(0.72)) hipRoof(o, F, x0, x1, z0, z1, yTop, rng);
    else {
      cap(o.roofs, F, outline, yTop, colorOf(0x2a2622));
      cornice(o, F, x0, x1, z0, z1, yTop + 0.55, 0.55, 0.3, colorOf(0x8a3a24, rng.range(0.8, 1.1)), [true, true, true, true]);
      if (rng.chance(0.3)) billboard(o, F, x0, x1, z0, z1, yTop + 0.55, rng, front);
    }
    if (rng.chance(0.5)) chimney(o, F, rng.range(x0 + 1.5, x1 - 1.5), rng.range(z0 + 1.5, z1 - 1.5), yTop + 1.6, skin.tint.clone().multiplyScalar(0.8));
    return;
  }
  if (style === 'midcentury') {
    cap(o.roofs, F, outline, yTop, colorOf(0x26272b));
    // Thin roof slab cantilevered past the walls.
    lbox(o.trim, F, x0 - 0.9, x1 + 0.9, z0 - 0.9, z1 + 0.9, yTop, yTop + 0.3, colorOf(TRIM_COLORS[(skin.flags >> 1) & 15], 0.95));
    if (rng.chance(0.55)) billboard(o, F, x0, x1, z0, z1, yTop + 0.3, rng, front);
    else clutter(o, F, x0 + 1, x1 - 1, z0 + 1, z1 - 1, yTop + 0.3, rng, det, 'ac', skin.tint);
    if (rng.chance(0.25)) neonRing(o, F, outline, yTop - 0.5, yTop - 0.05, neonColor(rng.next()), 0.95);
    return;
  }
  // brownstone, prewar, and terrace styles that did not split (victorian / rowhouse on side streets).
  cap(o.roofs, F, outline, roofY, colorOf(0x16171c, rng.range(0.8, 1.4)));
  const heavy = style === 'brownstone' || style === 'prewar' || style === 'rowhouse' || style === 'victorian';
  if (heavy) cornice(o, F, x0, x1, z0, z1, roofY + 0.7, 0.75, 0.55, trimColor, [true, true, true, true]);
  if ((style === 'brownstone' || style === 'prewar') && nF <= 9 && det.escapes > 0) {
    for (let i = 0; i < 4; i++) {
      if (!front[i] || (i !== 0 && det.escapes < 1)) continue;
      if (!rng.chance(det.escapes * (i === 0 ? 0.85 : 0.4))) continue;
      fireEscapes(o, F, i, hw, hd, y0, nF, fh, skin.bay, rng);
    }
  }
  const nycish = plan.region === 'nyc' || plan.region === 'philly';
  if ((style === 'brownstone' || style === 'prewar') && rng.chance(nycish ? 0.6 : 0.28)) {
    const r = 2.6;
    if (x1 - x0 > 2 * r + 2 && z1 - z0 > 2 * r + 2) {
      const lx = rng.range(x0 + r + 1, x1 - r - 1);
      const lz = rng.range(z0 + r + 1, z1 - r - 1);
      waterTower(o, F.X(lx, lz), F.Z(lx, lz), roofY + 0.7, rng);
    }
  }
  if (style === 'brownstone' || style === 'prewar') {
    if (rng.chance(0.15) && plan.region !== 'philly') billboard(o, F, x0, x1, z0, z1, roofY + 0.7, rng, front);
    clutter(o, F, x0 + 1, x1 - 1, z0 + 1, z1 - 1, roofY, rng, det, 'bulkhead', skin.tint);
  } else chimney(o, F, rng.range(x0 + 1.2, x1 - 1.2), z1 - 1.5, roofY, colorOf(0x6a3a2c));
  if (tall > BLD.aviationAbove) roofLights(o, F, x0, x1, z0, z1, roofY + 1, rng);
}

/** Terrace of narrow houses (rowhouses, painted ladies, brownstone rows). */
function terrace(
  o: Out,
  F: Frame,
  b: Building,
  plan: BuildingPlan,
  S: StyleDef,
  rng: Rng,
  det: (typeof DETAIL)[Detail],
  front: boolean[],
  street: number,
  y0: number,
  nF: number,
  fh: number,
  vRef: number,
  flushFloor: number,
  makeSkin: (tint: number, layer?: StyleDef['layer'], litMul?: number) => Skin,
  bays: number[],
): void {
  const hw = b.w / 2;
  const hd = b.d / 2;
  const n = Math.max(2, Math.round(b.w / rng.range(S.units![0], S.units![1])));
  const uw = b.w / n;
  const style = plan.style;
  const tops: number[] = [];
  const skins: Skin[] = [];
  let lastTint = -1;
  for (let k = 0; k < n; k++) {
    let ti = rng.int(0, S.palette.length - 1);
    if (ti === lastTint) ti = (ti + 1) % S.palette.length;
    lastTint = ti;
    skins.push(makeSkin(S.palette[ti]));
    const df = rng.chance(0.25) ? rng.pick([-1, 1]) : 0;
    tops.push(y0 + Math.max(flushFloor, Math.max(1, nF + df)) * fh);
  }
  const shingle = colorOf(0x2a2a30);
  for (let k = 0; k < n; k++) {
    const x0 = -hw + k * uw;
    const x1 = x0 + uw;
    const s = skins[k];
    const top = tops[k];
    const tint = new THREE.Color(1, 1, 1).lerp(s.tint, 0.55);
    const trim = colorOf(TRIM_COLORS[(s.flags >> 1) & 15], 0.9);
    // Podium: the house's ground floor on its exposed faces (no protrusions, so neighbours never overlap).
    const out = boxOutline(x0, x1, -hd, hd);
    for (let i = 0; i < 4; i++) {
      if ((i === 1 && k < n - 1) || (i === 3 && k > 0)) continue;
      const p = out[i];
      const q = out[(i + 1) % 4];
      const nn = edgeNormal(p, q);
      addPodiumFace(
        o.podium,
        { ax: F.X(p.x, p.z), az: F.Z(p.x, p.z), bx: F.X(q.x, q.z), bz: F.Z(q.x, q.z), nx: F.NX(nn.x, nn.z), nz: F.NZ(nn.x, nn.z), y0: street, yBase: b.baseY, front: front[i], bays, tint },
        0,
        rng,
        [0],
      );
    }
    const left = k > 0 ? tops[k - 1] : -Infinity;
    const right = k < n - 1 ? tops[k + 1] : -Infinity;
    walls(o, F, s, out, null, y0, top, vRef, street, NO_GLOW, rng, 'face', (i) => {
      if (i === 1) return k < n - 1 ? (top > right + 0.05 ? [right, top] : null) : [y0, top];
      if (i === 3) return k > 0 ? (top > left + 0.05 ? [left, top] : null) : [y0, top];
      return [y0, top];
    });
    const gable = style === 'victorian' && rng.chance(0.5) && uw <= 9;
    if (!gable) cap(o.roofs, F, out, top, colorOf(0x17181c, rng.range(0.8, 1.3)));
    // Cornice on the street face (and the back), brackets under it on high detail.
    cornice(o, F, x0, x1, -hd, hd, top + 0.6, 0.65, style === 'victorian' ? 0.6 : 0.45, trim, [true, k === n - 1, true, k === 0]);
    if (det.brackets && style === 'victorian') {
      for (let x = x0 + 0.4; x < x1 - 0.2; x += 0.8) lbox(o.trim, F, x - 0.08, x + 0.08, -hd - 0.5, -hd, top - 0.35, top - 0.05, trim);
    }
    if (style === 'victorian' && uw >= 5) {
      const cx = x0 + uw * (k % 2 ? 0.62 : 0.38);
      bayWindow(o, F, s, cx, -hd, Math.min(BLD.bayW, uw - 1.6), BLD.bayD, y0, top - 0.05, vRef, street, trim);
    }
    if (gable) {
      const gh = uw * 0.45;
      const yb = top + 0.6;
      const tri: [number, number, number][] = [
        [F.X(x0, -hd - 0.3), yb, F.Z(x0, -hd - 0.3)],
        [F.X(x1, -hd - 0.3), yb, F.Z(x1, -hd - 0.3)],
        [F.X((x0 + x1) / 2, -hd - 0.3), yb + gh, F.Z((x0 + x1) / 2, -hd - 0.3)],
      ];
      facet(o.trim, tri, s.tint.clone().lerp(trim, 0.35), [F.NX(0, -1), 0, F.NZ(0, -1)]);
      const back: [number, number, number][] = [
        [F.X(x0, hd), yb, F.Z(x0, hd)],
        [F.X((x0 + x1) / 2, hd), yb + gh, F.Z((x0 + x1) / 2, hd)],
        [F.X(x1, hd), yb, F.Z(x1, hd)],
      ];
      facet(o.trim, back, s.tint.clone().multiplyScalar(0.7), [F.NX(0, 1), 0, F.NZ(0, 1)]);
      // Pitched roof behind the gable, ridge running back from the street.
      const ridgeF: [number, number, number] = [F.X((x0 + x1) / 2, -hd - 0.3), yb + gh, F.Z((x0 + x1) / 2, -hd - 0.3)];
      const ridgeB: [number, number, number] = [F.X((x0 + x1) / 2, hd + 0.2), yb + gh, F.Z((x0 + x1) / 2, hd + 0.2)];
      facet(o.roofs, [[F.X(x0 - 0.2, -hd - 0.3), yb - 0.1, F.Z(x0 - 0.2, -hd - 0.3)], ridgeF, ridgeB, [F.X(x0 - 0.2, hd + 0.2), yb - 0.1, F.Z(x0 - 0.2, hd + 0.2)]], shingle);
      facet(o.roofs, [[F.X(x1 + 0.2, -hd - 0.3), yb - 0.1, F.Z(x1 + 0.2, -hd - 0.3)], [F.X(x1 + 0.2, hd + 0.2), yb - 0.1, F.Z(x1 + 0.2, hd + 0.2)], ridgeB, ridgeF], shingle);
    } else if (style === 'rowhouse' || style === 'brownstone') {
      if (rng.chance(0.5)) chimney(o, F, rng.range(x0 + 0.8, x1 - 0.8), hd - 1.2, top, colorOf(0x6a3a2c));
    }
    if (style === 'brownstone') {
      if (det.escapes > 0 && rng.chance(0.35 * det.escapes)) fireEscapes(o, F, 0, hw, hd, y0, Math.round((top - y0) / fh), fh, s.bay, rng, (x0 + x1) / 2);
      if (rng.chance(0.25) && uw > 7) waterTower(o, F.X((x0 + x1) / 2, hd * 0.2), F.Z((x0 + x1) / 2, hd * 0.2), top + 0.6, rng);
    }
  }
}
