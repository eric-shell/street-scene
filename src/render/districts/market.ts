/**
 * Night market renderer (city/districts/market.ts): the red lacquered crowd
 * rail with a bulb on every post, lantern masts on the rails with strings of
 * paper lanterns zigzagging across the street between them, a gate at each
 * end of the market with its sign, a shuttered market wall wherever a pen's
 * frontage has no building behind it, and the warm light the lanterns throw
 * on the street: an additive wash brightest along the stall fronts, faked
 * like the street pools in lightFx (the real lights that follow the car pick
 * the market's light points too, see scene.ts and marketPlan.ts).
 *
 * Everything static is merged into the kit's builders (solid, glow) plus two
 * meshes of its own (the wash and the gate signs), so all markets together
 * cost two draw calls more than the kit and nothing per frame. Lantern
 * density follows the graphics quality, and so does the wash's tessellation.
 * Stalls, crates and carts are destructible props (render/street/props.ts); the
 * crowd is drawn by render/race/crowds.ts from marketPlan.ts.
 */
import * as THREE from 'three';
import { CITY } from '../../city/config';
import { BUILDING_SETBACK, insideBuilding } from '../../city/blocks';
import type { Wall } from '../../city/blocks';
import type { Area } from '../../city/districts/types';
import { MARKET_HINT } from '../../city/districts/market';
import { GeoBuilder } from '../geoBuilder';
import { MARKET_MAST, MarketEdgeView, MarketMast, marketEdges } from './marketPlan';
import type { DistrictKit, DistrictRenderer } from './kit';
import { col, cylinder, orientedBox, wallBox } from './kit';
import { heightFogShader } from '../heightFog';

const LOOK = {
  /** Crowd rail: height, post spacing, thickness into the pen (m) and colours. */
  railH: 1.05,
  postStep: 1.5,
  railThick: 0.07,
  post: col(0x5a1214),
  bar: col(0x8a1c1e),
  /** A warm bulb on top of every rail post. */
  bulb: col(0xffb060, 2),
  mast: col(0x4a1214),
  finial: col(0xffc060, 2.2),
  /** Lantern spacing along a string per quality (m), the strings' sag (m) and lantern radius (m). */
  lanternStep: { low: 2.3, medium: 1.6, high: 1.25 } as Record<string, number>,
  sag: 1.1,
  lanternR: 0.19,
  /** Red paper mostly, some amber, gold and rose. */
  lanterns: [col(0xff3a24, 2.4), col(0xff4a2a, 2.3), col(0xffa040, 2.1), col(0xff3a24, 2.4), col(0xff5a7a, 2), col(0xffc860, 2)],
  wire: col(0x141012),
  /** Shuttered market wall where a pen's frontage has no building: height and colours. */
  backdropH: 2.8,
  backdrop: col(0x3a2622),
  backdropGlow: col(0xffa050, 1.3),
  /** Gate: post height, beam depth and sign size (m). */
  gateH: 7.6,
  signW: 5.6,
  signH: 1.15,
  gate: col(0x7a1416),
  gold: col(0xc8902a),
} as const;

/** The lanterns' light on the street: colour (linear, additive), the wash's along-street step per quality (m). */
const WASH = {
  color: new THREE.Color(0xff9050).multiplyScalar(0.24),
  step: { low: 4.5, medium: 2.6, high: 1.8 } as Record<string, number>,
  /** Fades in over this far from the market's ends and the building lines (m). */
  fadeS: 8,
  fadeLat: 1.5,
  liftRoad: 0.06,
  liftWalk: CITY.curbHeight + 0.06,
} as const;

/** Rails and their end caps: posts, two bars and a bulb per post, standing on the sidewalk. */
function rails(kit: DistrictKit, walls: readonly Wall[]): void {
  for (const w of walls) {
    const len = Math.hypot(w.bx - w.ax, w.bz - w.az);
    if (len < 0.1) continue;
    const ux = (w.bx - w.ax) / len;
    const uz = (w.bz - w.az) / len;
    const ox = -w.nx * LOOK.railThick;
    const oz = -w.nz * LOOK.railThick;
    const n = Math.max(1, Math.round(len / LOOK.postStep));
    let px = 0;
    let pz = 0;
    let py = 0;
    for (let k = 0; k <= n; k++) {
      const x = w.ax + ((w.bx - w.ax) * k) / n;
      const z = w.az + ((w.bz - w.az) * k) / n;
      const y = kit.h(x, z) + CITY.curbHeight;
      orientedBox(kit.solid, x - ux * 0.04, z - uz * 0.04, x + ux * 0.04, z + uz * 0.04, ox * 1.2, oz * 1.2, y - 0.05, y + LOOK.railH + 0.05, LOOK.post);
      cylinder(kit.glow, x + ox * 0.6, z + oz * 0.6, 0.045, y + LOOK.railH + 0.05, y + LOOK.railH + 0.13, 4, LOOK.bulb);
      if (k > 0) {
        const base = Math.min(py, y);
        for (const [h0, h1] of [
          [LOOK.railH - 0.08, LOOK.railH],
          [0.5, 0.56],
        ]) {
          orientedBox(kit.solid, px, pz, x, z, ox, oz, base + h0, base + h1, LOOK.bar);
        }
      }
      px = x;
      pz = z;
      py = y;
    }
  }
}

/** One lantern string between two mast tops: sagging wire, a paper lantern on a short cord every step m. */
function lanternString(kit: DistrictKit, a: MarketMast, b: MarketMast, step: number, k: number): void {
  const y0 = a.y + MARKET_MAST.stringY;
  const y1 = b.y + MARKET_MAST.stringY;
  const span = Math.hypot(b.x - a.x, b.z - a.z);
  const n = Math.max(2, Math.round(span / step));
  let px = a.x;
  let pz = a.z;
  let py = y0;
  for (let i = 1; i <= n; i++) {
    const t = i / n;
    const x = a.x + (b.x - a.x) * t;
    const z = a.z + (b.z - a.z) * t;
    const y = y0 + (y1 - y0) * t - LOOK.sag * 4 * t * (1 - t);
    cylinder(kit.solid, (x + px) / 2, (z + pz) / 2, 0.012, Math.min(y, py) - 0.012, Math.max(y, py) + 0.012, 3, LOOK.wire, false);
    if (i < n) {
      const c = LOOK.lanterns[(i * 5 + k * 3) % LOOK.lanterns.length];
      const r = LOOK.lanternR;
      const yc = y - 0.36;
      cylinder(kit.solid, x, z, 0.008, yc + 0.17, y, 3, LOOK.wire, false);
      cylinder(kit.glow, x, z, r * 0.5, yc - 0.17, yc, 6, c, false, r);
      cylinder(kit.glow, x, z, r, yc, yc + 0.17, 6, c, true, r * 0.5);
    }
    px = x;
    pz = z;
    py = y;
  }
}

/** Masts on the rails and the strings zigzagging across the street between consecutive ones. */
function lanterns(kit: DistrictKit, edges: readonly MarketEdgeView[]): void {
  const step = LOOK.lanternStep[kit.quality] ?? LOOK.lanternStep.medium;
  edges.forEach((e, ei) => {
    for (const m of e.masts) {
      cylinder(kit.solid, m.x, m.z, 0.07, m.y - 0.05, m.y + MARKET_MAST.height, 6, LOOK.mast);
      cylinder(kit.glow, m.x, m.z, 0.1, m.y + MARKET_MAST.height, m.y + MARKET_MAST.height + 0.18, 6, LOOK.finial);
    }
    for (let k = 0; k + 1 < e.masts.length; k++) lanternString(kit, e.masts[k], e.masts[k + 1], step, k + ei * 7);
  });
}

/** The shuttered market wall along a pen's frontage wherever no building stands behind it (the facade draws the rest). */
function backdrops(kit: DistrictKit, walls: readonly Wall[]): void {
  const buildings = kit.world.blocks.buildings;
  const probe = BUILDING_SETBACK + 0.7;
  for (const w of walls) {
    const len = Math.hypot(w.bx - w.ax, w.bz - w.az);
    if (len < 0.05) continue;
    const mx = (w.ax + w.bx) / 2;
    const mz = (w.az + w.bz) / 2;
    const reach = len / 2 + 40;
    const near = buildings.filter((b) => Math.abs(b.x - mx) < reach && Math.abs(b.z - mz) < reach);
    const n = Math.max(1, Math.round(len));
    const built = (k: number) => {
      const t = (k + 0.5) / n;
      const x = w.ax + (w.bx - w.ax) * t - w.nx * probe;
      const z = w.az + (w.bz - w.az) * t - w.nz * probe;
      return near.some((b) => insideBuilding(b, x, z, 0.7));
    };
    let from = -1;
    for (let k = 0; k <= n; k++) {
      const open = k < n && !built(k);
      if (open && from < 0) from = k;
      if (!open && from >= 0) {
        const t0 = from / n;
        const t1 = k / n;
        const seg: Wall = { ...w, ax: w.ax + (w.bx - w.ax) * t0, az: w.az + (w.bz - w.az) * t0, bx: w.ax + (w.bx - w.ax) * t1, bz: w.az + (w.bz - w.az) * t1 };
        wallBox(kit, kit.solid, seg, 0.5, LOOK.backdropH, LOOK.backdrop);
        // A warm sign band along the top, just proud of the wall.
        const y = Math.min(kit.h(seg.ax, seg.az), kit.h(seg.bx, seg.bz));
        orientedBox(kit.glow, seg.ax, seg.az, seg.bx, seg.bz, seg.nx * 0.03, seg.nz * 0.03, y + LOOK.backdropH - 0.55, y + LOOK.backdropH - 0.4, LOOK.backdropGlow);
        from = -1;
      }
    }
  }
}

/** Additive light on the street from the stalls' and strings' lanterns: one merged mesh for every market, faded into the fog. */
function lightWash(kit: DistrictKit, edges: readonly MarketEdgeView[]): void {
  const gb = new GeoBuilder(true);
  const c = new THREE.Color();
  const step = WASH.step[kit.quality] ?? WASH.step.medium;
  const smooth = (t: number) => (t <= 0 ? 0 : t >= 1 ? 1 : t * t * (3 - 2 * t));
  for (const e of edges) {
    if (e.hi <= e.lo) continue;
    const s0 = e.lo - 4;
    const s1 = e.hi + 4;
    const ns = Math.max(1, Math.ceil((s1 - s0) / step));
    const strips: [number, number, number][] = [
      [-e.outer, -e.curb, WASH.liftWalk],
      [-e.curb, e.curb, WASH.liftRoad],
      [e.curb, e.outer, WASH.liftWalk],
    ];
    for (const [l0, l1, lift] of strips) {
      const nl = 3;
      const ids: number[] = [];
      for (let j = 0; j <= nl; j++) {
        const lat = l0 + ((l1 - l0) * j) / nl;
        const a = Math.abs(lat);
        // Brightest along the stall fronts (their lanterns), a soft glow down the middle under the strings.
        const across = smooth((e.outer - a) / WASH.fadeLat) * (0.55 + 0.65 * Math.exp(-(((a - (e.curb + 0.6)) / 1.7) ** 2)));
        for (let i = 0; i <= ns; i++) {
          const s = s0 + ((s1 - s0) * i) / ns;
          const along = smooth((s - s0) / WASH.fadeS) * smooth((s1 - s) / WASH.fadeS);
          const x = e.ax + e.ux * s + e.nx * lat;
          const z = e.az + e.uz * s + e.nz * lat;
          c.copy(WASH.color).multiplyScalar(across * along);
          ids.push(gb.vertex(x, kit.h(x, z) + lift, z, 0, 1, 0, 0, 0, c));
        }
      }
      for (let j = 0; j < nl; j++) {
        for (let i = 0; i < ns; i++) {
          const v = j * (ns + 1) + i;
          gb.quadFacing(ids[v], ids[v + 1], ids[v + ns + 2], ids[v + ns + 1], 0, 1, 0);
        }
      }
    }
  }
  if (!gb.vertexCount) return;
  const mat = kit.track(
    new THREE.MeshBasicMaterial({ vertexColors: true, transparent: true, blending: THREE.AdditiveBlending, depthWrite: false, polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2 }),
  );
  // Light added on top fades out with distance (as in areaLights.ts): mixing it toward the fog colour would make a far market glow.
  mat.onBeforeCompile = (shader) => {
    heightFogShader(shader, true);
  };
  const mesh = new THREE.Mesh(kit.track(gb.build()), mat);
  mesh.name = 'marketLight';
  mesh.renderOrder = 1;
  kit.group.add(mesh);
}

/** The gate sign's face: the market's name in warm neon on lacquer red. */
function signTexture(): THREE.CanvasTexture {
  const W = 512;
  const H = 104;
  const c = document.createElement('canvas');
  c.width = W;
  c.height = H;
  const ctx = c.getContext('2d')!;
  ctx.fillStyle = '#3a0608';
  ctx.fillRect(0, 0, W, H);
  ctx.strokeStyle = '#c8902a';
  ctx.lineWidth = 6;
  ctx.strokeRect(5, 5, W - 10, H - 10);
  ctx.font = '800 58px "Google Sans Flex", system-ui, sans-serif';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.shadowColor = '#ff6a1a';
  ctx.shadowBlur = 16;
  ctx.fillStyle = '#ffd27a';
  ctx.fillText('NIGHT MARKET', W / 2, H / 2 + 2);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

/**
 * A gate over each end of every market: lacquered posts inside the pens'
 * end corners (so the rail and its cap are their collision), a double beam
 * and the sign, read from both ways. Signs are one merged mesh.
 */
function gates(kit: DistrictKit, areas: readonly Area[], edges: readonly MarketEdgeView[], signs: GeoBuilder): void {
  for (const area of areas) {
    const pens = kit.builds[area.id].hints.filter((h) => h.kind === MARKET_HINT.pen);
    for (const end of [area.path[0], area.path[area.path.length - 1]]) {
      if (!end) continue;
      const e = edges.find((v) => v.area === area && (Math.hypot(v.ax - end.x, v.az - end.z) < 0.01 || Math.hypot(v.ax + v.ux * v.length - end.x, v.az + v.uz * v.length - end.z) < 0.01));
      if (!e) continue;
      const atA = Math.hypot(e.ax - end.x, e.az - end.z) < 0.01;
      // Rail end nearest this end on each side, pulled a little into the pen.
      const posts: { x: number; z: number }[] = [];
      for (const side of [1, -1]) {
        const p = pens.find((h) => h.values[0] === e.edge && h.values[1] === side);
        if (!p) continue;
        const r = atA ? p.points[0] : p.points[1];
        const inward = atA ? 1 : -1;
        posts.push({ x: r.x + e.ux * 0.25 * inward - p.values[2] * 0.25, z: r.z + e.uz * 0.25 * inward - p.values[3] * 0.25 });
      }
      if (posts.length < 2) continue;
      const [L, R] = posts;
      let top = -Infinity;
      for (const p of posts) {
        const y = kit.h(p.x, p.z) + CITY.curbHeight;
        top = Math.max(top, y + LOOK.gateH);
        orientedBox(kit.solid, p.x - 0.16 * e.ux - 0.16 * e.nx, p.z - 0.16 * e.uz - 0.16 * e.nz, p.x + 0.16 * e.ux - 0.16 * e.nx, p.z + 0.16 * e.uz - 0.16 * e.nz, 0.32 * e.nx, 0.32 * e.nz, y - 0.1, y + LOOK.gateH, LOOK.gate);
        cylinder(kit.solid, p.x, p.z, 0.22, y - 0.05, y + 0.5, 6, LOOK.gold);
      }
      // Two beams: one between the posts, a longer one over it with gold trim.
      const bx = R.x - L.x;
      const bz = R.z - L.z;
      const bl = Math.hypot(bx, bz) || 1;
      const ax = bx / bl;
      const az = bz / bl;
      const hx = e.ux * 0.18;
      const hz = e.uz * 0.18;
      orientedBox(kit.solid, L.x - hx, L.z - hz, R.x - hx, R.z - hz, hx * 2, hz * 2, top - 1.15, top - 0.8, LOOK.gate);
      orientedBox(kit.solid, L.x - ax * 1 - hx * 1.4, L.z - az * 1 - hz * 1.4, R.x + ax * 1 - hx * 1.4, R.z + az * 1 - hz * 1.4, hx * 2.8, hz * 2.8, top - 0.1, top + 0.25, LOOK.gate);
      orientedBox(kit.solid, L.x - ax * 1.05 - hx * 1.5, L.z - az * 1.05 - hz * 1.5, R.x + ax * 1.05 - hx * 1.5, R.z + az * 1.05 - hz * 1.5, hx * 3, hz * 3, top + 0.25, top + 0.33, LOOK.gold);
      // The sign under the low beam, a face each way.
      const cx = (L.x + R.x) / 2;
      const cz = (L.z + R.z) / 2;
      const yTop = top - 1.25;
      for (const face of [1, -1]) {
        const fx = e.ux * face;
        const fz = e.uz * face;
        // Read from in front (looking along -f), the text runs to the viewer's right, (fz, -fx).
        const rx = fz;
        const rz = -fx;
        const ox = cx + fx * 0.2;
        const oz = cz + fz * 0.2;
        const w = LOOK.signW / 2;
        const v = [
          signs.vertex(ox - rx * w, yTop - LOOK.signH, oz - rz * w, fx, 0, fz, 0, 0),
          signs.vertex(ox + rx * w, yTop - LOOK.signH, oz + rz * w, fx, 0, fz, 1, 0),
          signs.vertex(ox + rx * w, yTop, oz + rz * w, fx, 0, fz, 1, 1),
          signs.vertex(ox - rx * w, yTop, oz - rz * w, fx, 0, fz, 0, 1),
        ];
        signs.quadFacing(v[0], v[1], v[2], v[3], fx, 0, fz);
      }
      // Hangers from the beam to the sign.
      for (const k of [-0.42, 0.42]) {
        const x = cx + ax * LOOK.signW * k;
        const z = cz + az * LOOK.signW * k;
        cylinder(kit.solid, x, z, 0.03, yTop - 0.02, top - 1.15, 4, LOOK.gold, false);
      }
    }
  }
}

export const marketRenderer: DistrictRenderer = {
  kinds: ['market'],
  build(kit, areas) {
    if (!areas.length) return;
    const edges = marketEdges(kit.world);
    rails(kit, kit.walls.get('marketRail') ?? []);
    backdrops(kit, kit.walls.get('marketFront') ?? []);
    lanterns(kit, edges);
    lightWash(kit, edges);
    const signs = new GeoBuilder();
    gates(kit, areas, edges, signs);
    if (signs.vertexCount) {
      const mat = kit.track(new THREE.MeshBasicMaterial({ map: kit.track(signTexture()), color: new THREE.Color(1.5, 1.5, 1.5) }));
      const mesh = new THREE.Mesh(kit.track(signs.build()), mat);
      mesh.name = 'marketSigns';
      kit.group.add(mesh);
    }
  },
};
