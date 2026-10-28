/**
 * The beach variant of the waterfront (city/districts/waterfrontBeach.ts), drawn from the area's walls, props and
 * hints so what stands is what the sim collides with (waterfront.ts, which calls this once, shares the coast, the water,
 * the breakwaters, the buoys and the ends' fences):
 *  - the sand: a strip draped on the sloping ground from the dune edge to the waterline, dry tan fading through wet
 *    to dark where the surf reaches, with a render only run on past an open end of the side;
 *  - the boardwalk: planks in bands from the street's frontage to the dune edge (the sim's 'boardwalk', which drives as
 *    cobbles), seams between the bands, the mouths' gate posts with their strings of bulbs and setts (the dock yard's,
 *    waterfrontYard.ts), palms in a row at its sea edge (the sim's solid trunks) with string lights hung palm to palm;
 *  - on the sand: lifeguard towers on stilts over a storage hut ('lifeguard' solids), painted volleyball courts (the nets
 *    and the umbrellas and loungers are destructible props, render/street/props.ts), tufts of sea oats along the dune
 *    edge and on the dune jumps' crests;
 *  - the pier ('pier' solid over the sand, drawn on out over the water): a plank deck on pile bents with a ramp up from
 *    the boardwalk, railings, lamps (reflected in the water) and a T head with a lit pavilion;
 *  - two or three small boats at anchor out past the surf, riding the swell with their anchor lights (boats.ts);
 *  - the surf: a low bank of foam along the waterline (the sim's 'surf' wall) and animated foam, additive strips on the
 *    water scrolled on the scene clock: the swash running up the sand, an inner and an outer break (Medium and High), set
 *    by the wind's gusts (sky/wind.ts); and gulls perched on the pier, the towers and a flock over the water.
 * Everything merges into the kit's builders except the foam (one small shader mesh, one uniform per frame). Render only.
 */
import * as THREE from 'three';
import { CITY } from '../../city/config';
import type { Area, AreaBuild, AreaHint } from '../../city/districts/types';
import { coastV, framePoint, frameU, frameV, harborFrame, waterLevel } from '../../city/districts/waterfrontShape';
import type { Vec2 } from '../../sim/math';
import { Rng } from '../../sim/prng';
import { GeoBuilder } from '../geoBuilder';
import { HEIGHT_FOG_GLSL, HEIGHT_FOG_UNIFORMS, heightFogShader } from '../heightFog';
import { WIND } from '../sky/wind';
import type { DistrictKit } from './kit';
import { col, cylinder, groundLine, groundVertex, stringLights, wallBox } from './kit';
import { BoatFleet, mooringPhase } from './boats';
import { palm } from './trees';
import { drawMouths, flock, gull, type YardTools } from './waterfrontYard';

const B = CITY.districts.waterfront.beach;

/** What the beach draws with: the harbor renderer's primitives, and a light out over the water for its reflection. */
export interface BeachTools extends YardTools {
  /** A light over the water for its reflection streak (colour, streak width in m). */
  light(x: number, y: number, z: number, c: THREE.Color, w: number): void;
}

const LOOK = {
  /** The sand by distance in from the waterline: dry, packed, wet and soaked. */
  sandDry: col(0xcbb98e),
  sandPacked: col(0xb09d76),
  sandWet: col(0x70664f),
  sandSoaked: col(0x413e38),
  plank: [col(0x8a6e4c), col(0x7a5f40), col(0x9a7c56)],
  seam: col(0x2e2218),
  court: col(0xe8e4d4),
  oat: [col(0xb9ad7a), col(0x8a9a58), col(0xcdbf88)],
  foam: col(0x7c8f99),
  towerWall: col(0xdad6ca),
  towerTrim: [col(0xb02a22), col(0x1f5aa8), col(0xe0a81c), col(0x1a8a84)],
  towerDark: col(0x2a2c30),
  window: col(0xffd28a, 1.6),
  beacon: col(0xffa21a, 2.2),
  deck: [col(0x82664a), col(0x735a40)],
  pile: col(0x2c2a27),
  pierRail: col(0xcfcabb),
  lamp: col(0xffb24a, 1.6),
  roof: col(0x2c4a5a),
  /** Foam bank on the surf wall: height (m) and how far it stands out to sea (m). */
  bank: { h: 0.45, thick: 0.6 },
  /** The moonlit sand's sheen (additive, over the sand): the dry sand's level and how much wet sand adds (linear light). */
  sheen: { dry: 0.035, wet: 0.085, tint: new THREE.Color(0.62, 0.72, 0.9) },
  /** Sand rows (m in from the waterline, down to just under the water), and the planks' bands across the boardwalk. */
  sandRows: [8, 6, 4.5, 3, 2, 1, 0.3, -0.8, -2.5],
  plankRows: 6,
} as const;

const CURB = CITY.curbHeight;

/** A stable hash of two numbers in 0..1, for the sand's mottling. */
const hash = (a: number, b: number): number => {
  const s = Math.sin(a * 127.1 + b * 311.7) * 43758.5453;
  return s - Math.floor(s);
};

/** The sand's colour d m in from the waterline, mottled by (i, j). */
function sandColour(d: number, S: number, i: number, j: number): THREE.Color {
  const L = LOOK;
  let c: THREE.Color;
  if (d >= 8) c = L.sandPacked.clone().lerp(L.sandDry, Math.min(1, (d - 8) / Math.max(1, S - 12)));
  else if (d >= 3.5) c = L.sandWet.clone().lerp(L.sandPacked, (d - 3.5) / 4.5);
  else c = L.sandSoaked.clone().lerp(L.sandWet, Math.max(0, d) / 3.5);
  return c.multiplyScalar(0.93 + 0.12 * hash(i, j));
}

/** Everything of a beach, once per area. */
export function drawBeach(kit: DistrictKit, a: Area, b: AreaBuild, t: BeachTools): void {
  const p = a.params;
  const low = kit.quality === 'low';
  const rng = new Rng((p.seed ^ 0xbeac4) >>> 0 || 1);
  const perches: { x: number; y: number; z: number; yaw: number }[] = [];

  // ----- The sand, and its run on past an open end (render only).
  // The moonlit sheen is an additive sheet over the whole sand: High only (a ladder knob, not a fixed cost).
  const sheen = kit.quality === 'high' ? new GeoBuilder(true) : null;
  sand(kit, a, p.pa, p.pb, low ? 6 : 4, sheen);
  for (const [open, u0, u1] of [
    [p.openA, p.pa - CITY.districts.waterfront.quayRun - 120, p.pa - 0.3],
    [p.openB, p.pb + 0.3, p.pb + CITY.districts.waterfront.quayRun + 120],
  ] as const) if (open) sand(kit, a, u0, u1, 8, sheen);
  if (sheen) sheenMesh(kit, sheen);

  boardwalk(kit, a, low);
  drawMouths(kit, a, b, t);
  duneGrass(kit, a, b, rng);

  // ----- Towers, courts, the pier.
  for (const h of b.hints) {
    if (h.kind === 'lifeguard') tower(kit, h, t, rng, perches);
    else if (h.kind === 'court') courtLines(kit, h);
    else if (h.kind === 'pier') pier(kit, a, h, t, rng, perches);
  }

  // ----- Palms along the boardwalk, string lights palm to palm.
  const palms = b.props.filter((pr) => pr.kind === 'palm');
  for (const pr of palms) palm(kit, pr.x, pr.z, pr.height, { y: kit.h(pr.x, pr.z) + CURB, trunk: B.palmTrunk });
  const step = low ? 2.4 : kit.quality === 'medium' ? 1.6 : 1.2;
  for (let i = 0; i + 1 < palms.length; i++) {
    const p0 = palms[i];
    const p1 = palms[i + 1];
    const span = Math.hypot(p1.x - p0.x, p1.z - p0.z);
    if (span > 21) continue;
    stringLights(kit, p0, p1, { ya: kit.h(p0.x, p0.z) + CURB + B.stringHeight, yb: kit.h(p1.x, p1.z) + CURB + B.stringHeight, sag: Math.min(1.2, span * 0.045), step });
  }

  // ----- The surf: a bank of foam on the wall, the animated foam on the water.
  for (const w of kit.walls.get('surf') ?? []) if (w.area === a.id) wallBox(kit, kit.solid, w, LOOK.bank.thick, LOOK.bank.h, LOOK.foam, -0.4);
  surf(kit, a);

  // ----- A few boats at anchor out past the surf, riding the swell (boats.ts).
  anchoredBoats(kit, a, b, t, rng);

  // ----- Gulls: perched on the pier's rail and the towers' roofs, a flock over the water.
  for (const g of perches) gull(kit, t, g.x, g.y, g.z, g.yaw, false);
  if (!low) flock(kit, t, a, rng);
}

/** The boats at anchor: how many, how far past the coast line (m), the room each keeps from the others and the pier (m), and their palette. */
const ANCHORED = {
  count: [2, 3] as [number, number],
  out: [58, 105] as [number, number],
  room: 45,
  pierRoom: 40,
  length: [5.5, 8.5] as [number, number],
  hull: [col(0xe8e6de), col(0x2f6aa8), col(0xd8d2b8), col(0x9a2a24)],
  boot: col(0x16181c),
  cabin: col(0xcfcbbd),
  anchor: col(0xffffff, 1.8),
  window: col(0xffd28a, 1.4),
} as const;

/**
 * Two or three small boats at anchor beyond the surf's outer break, bows to the sea, each with a cabin, a lit window
 * and an all round anchor light on a short mast (reflected in the water). They swing on their lines and ride the swell
 * with the rest of the fleet (boats.ts). Placed from the area's stream along the beach, clear of the pier and each other.
 */
function anchoredBoats(kit: DistrictKit, a: Area, b: AreaBuild, t: BeachTools, rng: Rng): void {
  const p = a.params;
  const f = harborFrame(a);
  const A = ANCHORED;
  const fleet = new BoatFleet();
  const piers = b.hints.filter((h) => h.kind === 'pier').map((h) => frameU(f, h.points[1].x, h.points[1].z));
  const placed: number[] = [];
  const want = kit.quality === 'low' ? A.count[0] : rng.int(A.count[0], A.count[1]);
  for (let tries = 0; tries < 40 && placed.length < want; tries++) {
    const u = rng.range(p.pa + 40, p.pb - 40);
    const out = rng.range(A.out[0], A.out[1]);
    const yaw = Math.atan2(f.vx, f.vz) + rng.range(-0.5, 0.5);
    const L = rng.range(A.length[0], A.length[1]);
    const color = A.hull[Math.floor(rng.range(0, A.hull.length))];
    if (placed.some((q) => Math.abs(q - u) < A.room) || piers.some((q) => Math.abs(q - u) < A.pierRoom)) continue;
    placed.push(u);
    const c = framePoint(f, u, coastV(p, u) + out);
    const W = waterLevel(p, u);
    const fx = Math.sin(yaw);
    const fz = Math.cos(yaw);
    const rx = fz;
    const rz = -fx;
    const B = L * 0.36;
    const pt = (s: number, o: number): Vec2 => ({ x: c.x + fx * s + rx * o, z: c.z + fz * s + rz * o });
    const mark = fleet.begin();
    // The hull: a boot stripe at the waterline, topsides to the gunwale, a deck over it.
    const ring: [number, number][] = [[-L / 2, -B * 0.4], [L * 0.1, -B / 2], [L * 0.38, -B * 0.28], [L / 2, 0], [L * 0.38, B * 0.28], [L * 0.1, B / 2], [-L / 2, B * 0.4]];
    const band = (y0: number, k0: number, y1: number, k1: number, col2: THREE.Color) => {
      for (let i = 0; i < ring.length; i++) {
        const [s0, o0] = ring[i];
        const [s1, o1] = ring[(i + 1) % ring.length];
        const p0 = pt(s0 * k0, o0 * k0);
        const p1 = pt(s1 * k0, o1 * k0);
        const q0 = pt(s0 * k1, o0 * k1);
        const q1 = pt(s1 * k1, o1 * k1);
        let nx = p1.z - p0.z;
        let nz = -(p1.x - p0.x);
        const l = Math.hypot(nx, nz) || 1;
        nx /= l;
        nz /= l;
        if (((p0.x + p1.x) / 2 - c.x) * nx + ((p0.z + p1.z) / 2 - c.z) * nz < 0) {
          nx = -nx;
          nz = -nz;
        }
        const v = [fleet.solid.vertex(p0.x, y0, p0.z, nx, 0, nz, 0, 0, col2), fleet.solid.vertex(p1.x, y0, p1.z, nx, 0, nz, 1, 0, col2), fleet.solid.vertex(q1.x, y1, q1.z, nx, 0, nz, 1, 1, col2), fleet.solid.vertex(q0.x, y1, q0.z, nx, 0, nz, 0, 1, col2)];
        fleet.solid.quadFacing(v[0], v[1], v[2], v[3], nx, 0, nz);
      }
    };
    const deck = W + 0.85;
    band(W - 0.5, 0.8, W + 0.1, 0.97, A.boot);
    band(W + 0.1, 0.97, deck, 1, color);
    const centre = fleet.solid.vertex(c.x, deck, c.z, 0, 1, 0, 0, 0, A.cabin);
    const deckRing = ring.map(([s, o]) => {
      const q = pt(s, o);
      return fleet.solid.vertex(q.x, deck, q.z, 0, 1, 0, 0, 0, A.cabin);
    });
    for (let i = 0; i < deckRing.length; i++) fleet.solid.triFacing(centre, deckRing[i], deckRing[(i + 1) % deckRing.length], 0, 1, 0);
    // The cabin forward of amidships, a lit window across its front, the mast with the anchor light.
    const cab = pt(L * 0.1, 0);
    t.boxAt(fleet.solid, cab.x, deck, cab.z, fx, fz, L * 0.17, B * 0.34, 1.05, A.cabin);
    const win = pt(L * 0.1 + L * 0.17 + 0.02, 0);
    t.boxAt(fleet.glow, win.x, deck + 0.4, win.z, rx, rz, B * 0.24, 0.02, 0.4, A.window);
    const mast = pt(L * 0.1 - L * 0.05, 0);
    t.beam(fleet.solid, mast.x, deck + 1.05, mast.z, mast.x, deck + 2.7, mast.z, 0.04, A.cabin);
    t.lamp(fleet.glow, mast.x, deck + 2.8, mast.z, 0.2, A.anchor);
    t.light(mast.x, deck + 2.8, mast.z, A.anchor.clone().multiplyScalar(0.12), 0.9);
    fleet.end(mark, { x: c.x, z: c.z, y: W, phase: mooringPhase(c.x, c.z), kind: 'anchored' });
  }
  fleet.mount(kit, 'beachBoats');
}

/** Sand draped on the ground from the dune edge to the waterline over [u0, u1], columns `step` m apart. */
function sand(kit: DistrictKit, a: Area, u0: number, u1: number, step: number, sheen: GeoBuilder | null): void {
  const p = a.params;
  const f = harborFrame(a);
  const S = p.sand;
  const rows = [S, S - 3, S - 6, S - 9, S - 12, ...LOOK.sandRows];
  const n = Math.max(1, Math.ceil((u1 - u0) / step));
  let prev: number[] | null = null;
  let prevSheen: number[] | null = null;
  for (let i = 0; i <= n; i++) {
    const u = u0 + ((u1 - u0) * i) / n;
    const cur = rows.map((d, j) => {
      const q = framePoint(f, u, coastV(p, u) - d);
      return groundVertex(kit, kit.ground, q.x, q.z, CURB + 0.012, sandColour(d, S, i, j));
    });
    if (prev) for (let j = 0; j + 1 < rows.length; j++) kit.ground.quadFacing(prev[j], cur[j], cur[j + 1], prev[j + 1], 0, 1, 0);
    prev = cur;
    if (sheen) {
      const sh = rows.map((d) => {
        const q = framePoint(f, u, coastV(p, u) - d);
        const wet = Math.max(0, Math.min(1, (14 - d) / 12));
        const edge = Math.max(0, Math.min(1, (S - d) / 4));
        return sheenVertex(kit, sheen, q.x, q.z, (LOOK.sheen.dry + LOOK.sheen.wet * wet) * edge);
      });
      if (prevSheen) for (let j = 0; j + 1 < rows.length; j++) sheen.quadFacing(prevSheen[j], sh[j], sh[j + 1], prevSheen[j + 1], 0, 1, 0);
      prevSheen = sh;
    }
  }
}

/** The sheen as one additive mesh, faded to black in fog like the drift zones' wash. */
function sheenMesh(kit: DistrictKit, gb: GeoBuilder): void {
  const mat = kit.track(new THREE.MeshBasicMaterial({ vertexColors: true, transparent: true, blending: THREE.AdditiveBlending, depthWrite: false, polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2 }));
  mat.onBeforeCompile = (shader) => {
    heightFogShader(shader, true);
  };
  const mesh = new THREE.Mesh(kit.track(gb.build()), mat);
  mesh.name = 'beachSheen';
  mesh.renderOrder = 1;
  kit.group.add(mesh);
}

/** A vertex of the sand's sheen: the sand's height over the ground, a cool grey of the given brightness. */
function sheenVertex(kit: DistrictKit, gb: GeoBuilder, x: number, z: number, k: number): number {
  return gb.vertex(x, kit.h(x, z) + CURB + 0.03, z, 0, 1, 0, 0, 0, LOOK.sheen.tint.clone().multiplyScalar(k));
}

/** The planking from the frontage (the quay's back chain) to the dune edge, in bands across, with the seams between the bands. */
function boardwalk(kit: DistrictKit, a: Area, low: boolean): void {
  const p = a.params;
  const f = harborFrame(a);
  const back = a.polygon.slice(0, p.nBack);
  const R = LOOK.plankRows;
  let prev: number[] | null = null;
  let prevU = 0;
  const pts: Vec2[][] = [];
  back.forEach((q) => {
    const u = frameU(f, q.x, q.z);
    const v1 = coastV(p, u) - p.sand;
    const v0 = Math.min(frameV(f, q.x, q.z), v1 - 1);
    const bay = ((Math.floor(u / 5) % 2) + 2) % 2;
    const cur: number[] = [];
    const col3: Vec2[] = [];
    for (let k = 0; k <= R; k++) {
      const v = v0 + ((v1 - v0) * k) / R;
      const w = framePoint(f, u, v);
      col3.push(w);
      // The band a vertex starts: three woods, rotating with the band and, a little, with the bay along the walk.
      const tone = LOOK.plank[(Math.min(k, R - 1) + bay) % 3];
      cur.push(groundVertex(kit, kit.ground, w.x, w.z, CURB, tone));
    }
    if (prev && u - prevU > 1e-4) for (let k = 0; k < R; k++) kit.ground.quadFacing(prev[k], cur[k], cur[k + 1], prev[k + 1], 0, 1, 0);
    prev = cur;
    prevU = u;
    pts.push(col3);
  });
  if (low) return;
  // Seams between the bands, in the paint layer, a segment per pair of columns.
  for (let i = 0; i + 1 < pts.length; i++) {
    if (Math.hypot(pts[i + 1][0].x - pts[i][0].x, pts[i + 1][0].z - pts[i][0].z) < 0.5) continue;
    for (let k = 1; k < R; k++) groundLine(kit, kit.paint, pts[i][k], pts[i + 1][k], 0.06, CURB + 0.014, LOOK.seam);
  }
}

/** Tufts of sea oats along the dune edge and on each dune's crest: crossed blades leaning out, in the foliage builder. */
function duneGrass(kit: DistrictKit, a: Area, b: AreaBuild, rng: Rng): void {
  const p = a.params;
  const f = harborFrame(a);
  const tuft = (x: number, z: number): void => {
    const y = kit.h(x, z) + CURB;
    const c = LOOK.oat[rng.int(0, LOOK.oat.length - 1)];
    for (let k = 0, m = rng.int(5, 7); k < m; k++) {
      const ang = rng.range(0, Math.PI * 2);
      const lean = rng.range(0.15, 0.5);
      const h = rng.range(0.45, 0.95);
      const w = 0.045;
      const bx = x + Math.cos(ang) * 0.08;
      const bz = z + Math.sin(ang) * 0.08;
      const tx = bx + Math.cos(ang) * lean;
      const tz = bz + Math.sin(ang) * lean;
      const px = -Math.sin(ang) * w;
      const pz = Math.cos(ang) * w;
      const dark = c.clone().multiplyScalar(0.6);
      const v0 = kit.foliage.vertex(bx - px, y, bz - pz, 0, 1, 0, 0, 0, dark);
      const v1 = kit.foliage.vertex(bx + px, y, bz + pz, 0, 1, 0, 1, 0, dark);
      const v2 = kit.foliage.vertex(tx, y + h, tz, 0, 1, 0, 0.5, 1, c);
      kit.foliage.tri(v0, v1, v2);
      kit.foliage.tri(v0, v2, v1);
    }
  };
  for (let u = p.pa + 3; u < p.pb - 3; u += rng.range(3.5, 6.5)) {
    const q = framePoint(f, u, coastV(p, u) - (p.sand - 0.8 + rng.range(-1.2, 1.2)));
    tuft(q.x, q.z);
  }
  for (const h of b.hints) {
    if (h.kind !== 'dune') continue;
    const [u0, span, crest] = h.values;
    for (let u = u0 + 4; u < u0 + span - 4; u += rng.range(3, 5)) {
      const q = framePoint(f, u, coastV(p, u) - (crest + rng.range(-1.2, 1.2)));
      tuft(q.x, q.z);
    }
  }
}

/** The white lines of a volleyball court (hint 'court': its four corners): the outline and the line under the net. */
function courtLines(kit: DistrictKit, h: AreaHint): void {
  const [c0, c1, c2, c3] = h.points;
  const lift = CURB + 0.02;
  const pairs: [Vec2, Vec2][] = [
    [c0, c1],
    [c1, c2],
    [c2, c3],
    [c3, c0],
    [{ x: (c0.x + c3.x) / 2, z: (c0.z + c3.z) / 2 }, { x: (c1.x + c2.x) / 2, z: (c1.z + c2.z) / 2 }],
  ];
  for (const [s, e] of pairs) groundLine(kit, kit.paint, s, e, 0.08, lift, LOOK.court);
}

/** A lifeguard tower inside its solid's footprint: a storage hut, a deck on top of it, the cabin with a lit window, a roof, a flag and a beacon. */
function tower(kit: DistrictKit, h: AreaHint, t: BeachTools, rng: Rng, perches: { x: number; y: number; z: number; yaw: number }[]): void {
  const L = LOOK;
  const c = h.points[0];
  const yaw = h.values[0];
  const trim = L.towerTrim[h.values[1] % L.towerTrim.length];
  const fx = Math.sin(yaw);
  const fz = Math.cos(yaw);
  const rx = fz;
  const rz = -fx;
  const y = kit.h(c.x, c.z) + CURB;
  const half = B.tower / 2 - 0.1;
  // The hut: a white box with a coloured band, its door on the street side.
  t.boxAt(kit.solid, c.x, y - 0.1, c.z, fx, fz, half, half, 1.4, L.towerWall);
  t.boxAt(kit.solid, c.x, y + 0.9, c.z, fx, fz, half + 0.01, half + 0.01, 0.25, trim);
  t.boxAt(kit.solid, c.x - fx * (half + 0.01), y, c.z - fz * (half + 0.01), fx, fz, 0.02, 0.55, 1.2, L.towerDark);
  // The deck, a railing round it, the cabin on it.
  const dy = y + 1.3;
  t.boxAt(kit.solid, c.x, dy, c.z, fx, fz, half + 0.12, half + 0.12, 0.12, trim);
  t.boxAt(kit.solid, c.x, dy + 0.12, c.z, fx, fz, 0.9, 0.9, 1.95, L.towerWall);
  t.boxAt(kit.glow, c.x + fx * 0.9, dy + 0.9, c.z + fz * 0.9, fx, fz, 0.02, 0.6, 0.6, L.window);
  t.boxAt(kit.solid, c.x, dy + 2.05, c.z, fx, fz, 1.35, 1.35, 0.14, trim);
  // The rail: posts at the deck's corners and a bar between them on the seaward side.
  for (const s of [-1, 1]) for (const o of [-1, 1]) t.beam(kit.solid, c.x + fx * s * (half + 0.05) + rx * o * (half + 0.05), dy + 0.12, c.z + fz * s * (half + 0.05) + rz * o * (half + 0.05), c.x + fx * s * (half + 0.05) + rx * o * (half + 0.05), dy + 1.0, c.z + fz * s * (half + 0.05) + rz * o * (half + 0.05), 0.03, L.towerWall);
  t.beam(kit.solid, c.x + fx * (half + 0.05) - rx * half, dy + 1.0, c.z + fz * (half + 0.05) - rz * half, c.x + fx * (half + 0.05) + rx * half, dy + 1.0, c.z + fz * (half + 0.05) + rz * half, 0.03, L.towerWall);
  // A flag on a pole at the roof's corner, a beacon on the roof.
  const px = c.x + rx * 1.1 - fx * 1.1;
  const pz = c.z + rz * 1.1 - fz * 1.1;
  t.beam(kit.solid, px, dy + 2.2, pz, px, dy + 3.9, pz, 0.025, L.towerDark);
  t.boxAt(kit.solid, px + rx * 0.3, dy + 3.4, pz + rz * 0.3, rx, rz, 0.3, 0.012, 0.4, L.towerTrim[0]);
  t.lamp(kit.glow, c.x, dy + 2.35, c.z, 0.18, L.beacon);
  if (rng.chance(0.5)) perches.push({ x: c.x + rx * 0.9, y: dy + 2.2, z: c.z + rz * 0.9, yaw: rng.range(0, Math.PI * 2) });
}

/**
 * The pier (hint 'pier': root on the boardwalk, tip out over the water; values: width, the deck's height over the boardwalk, the solid's length):
 * a ramp up from the boardwalk over the solid's first metres, the plank deck in alternating bays on pile bents, railings,
 * lamps, a wider T head with a lit pavilion at the tip.
 */
function pier(kit: DistrictKit, a: Area, h: AreaHint, t: BeachTools, rng: Rng, perches: { x: number; y: number; z: number; yaw: number }[]): void {
  const L = LOOK;
  const [root, tip] = h.points;
  const [W, H, solidLen] = h.values;
  const len = Math.hypot(tip.x - root.x, tip.z - root.z);
  const fx = (tip.x - root.x) / len;
  const fz = (tip.z - root.z) / len;
  const rx = fz;
  const rz = -fx;
  const at = (s: number, o = 0) => ({ x: root.x + fx * s + rx * o, z: root.z + fz * s + rz * o });
  const y0 = kit.h(root.x, root.z) + CURB;
  const yDeck = y0 + H;
  const ramp = 3;
  const head = 14;
  const headW = 12;
  // The ramp: a sloped plank quad strip over the first metres.
  {
    const q = [at(0, -W / 2), at(0, W / 2), at(ramp, W / 2), at(ramp, -W / 2)];
    const ys = [y0, y0, yDeck, yDeck];
    const ids = q.map((v, i) => kit.solid.vertex(v.x, ys[i], v.z, 0, 1, 0, 0, 0, L.deck[0]));
    kit.solid.quadFacing(ids[0], ids[1], ids[2], ids[3], 0, 1, 0);
  }
  // The deck in 2.4 m bays, a thickness of 0.3 under it.
  for (let s = ramp; s < len - head; s += 2.4) {
    const e = Math.min(len - head, s + 2.4);
    const c = at((s + e) / 2);
    t.boxAt(kit.solid, c.x, yDeck - 0.3, c.z, fx, fz, (e - s) / 2, W / 2, 0.3, L.deck[Math.floor(s / 2.4) % 2]);
  }
  // The T head: a wider deck.
  {
    const c = at(len - head / 2);
    t.boxAt(kit.solid, c.x, yDeck - 0.3, c.z, fx, fz, head / 2, headW / 2, 0.3, L.deck[1]);
  }
  // Railings down both sides and round the head: bar and mid rail between posts every 2.4 m.
  const rail = (s0: number, s1: number, o: number): void => {
    const p0 = at(s0, o);
    const p1 = at(s1, o);
    t.beam(kit.solid, p0.x, yDeck + 1.0, p0.z, p1.x, yDeck + 1.0, p1.z, 0.04, L.pierRail);
    t.beam(kit.solid, p0.x, yDeck + 0.5, p0.z, p1.x, yDeck + 0.5, p1.z, 0.025, L.pierRail);
    for (let s = s0; s <= s1 + 1e-6; s += 2.4) {
      const q = at(s, o);
      t.beam(kit.solid, q.x, yDeck, q.z, q.x, yDeck + 1.0, q.z, 0.04, L.pierRail);
    }
  };
  for (const o of [-W / 2 + 0.1, W / 2 - 0.1]) rail(ramp, len - head, o);
  for (const o of [-headW / 2 + 0.1, headW / 2 - 0.1]) rail(len - head, len - 0.1, o);
  rail(len - 0.1, len - 0.1, 0);
  {
    const p0 = at(len - 0.1, -headW / 2 + 0.1);
    const p1 = at(len - 0.1, headW / 2 - 0.1);
    t.beam(kit.solid, p0.x, yDeck + 1.0, p0.z, p1.x, yDeck + 1.0, p1.z, 0.04, L.pierRail);
    t.beam(kit.solid, p0.x, yDeck + 0.5, p0.z, p1.x, yDeck + 0.5, p1.z, 0.025, L.pierRail);
  }
  // Pile bents: two piles and a cross beam every 4.8 m, down to the ground (the sea floor out on the water).
  const wl = (x: number, z: number) => waterLevel(a.params, frameU(harborFrame(a), x, z));
  for (let s = ramp + 1.2; s < len; s += 4.8) {
    const wide = s > len - head ? headW : W;
    for (const o of [-wide / 2 + 0.5, wide / 2 - 0.5]) {
      const q = at(s, o);
      cylinder(kit.solid, q.x, q.z, 0.22, Math.min(kit.h(q.x, q.z), wl(q.x, q.z) - 1) - 0.2, yDeck - 0.28, 6, L.pile);
    }
    const c = at(s);
    t.boxAt(kit.solid, c.x, yDeck - 0.62, c.z, rx, rz, wide / 2 - 0.3, 0.1, 0.3, L.pile);
  }
  // Lamps every pierLamp m, alternating sides: a post, a warm lantern, its reflection once out over the water.
  let side = 1;
  for (let s = ramp + 4; s < len - head; s += B.pierLamp) {
    const q = at(s, (W / 2 - 0.1) * side);
    t.beam(kit.solid, q.x, yDeck, q.z, q.x, yDeck + 3.6, q.z, 0.05, L.pile);
    t.lamp(kit.glow, q.x, yDeck + 3.75, q.z, 0.32, L.lamp);
    if (s > solidLen) t.light(q.x, yDeck + 3.75, q.z, L.lamp.clone().multiplyScalar(0.35), 1.8);
    side = -side;
  }
  // The pavilion on the head: a small hut with a roof, lit windows on all four faces, and a lamp on each head corner.
  {
    const c = at(len - head / 2);
    t.boxAt(kit.solid, c.x, yDeck, c.z, fx, fz, 2.2, 1.6, 2.5, col(0xcfc8b8));
    t.boxAt(kit.solid, c.x, yDeck + 2.5, c.z, fx, fz, 2.7, 2.1, 0.18, L.roof);
    for (const sgn of [-1, 1]) {
      t.boxAt(kit.glow, c.x + fx * sgn * 2.21, yDeck + 1.0, c.z + fz * sgn * 2.21, fx, fz, 0.02, 1.0, 0.8, L.window);
      t.boxAt(kit.glow, c.x + rx * sgn * 1.61, yDeck + 1.0, c.z + rz * sgn * 1.61, rx, rz, 0.02, 1.2, 0.8, L.window);
    }
    for (const sgn of [-1, 1]) {
      const q = at(len - 0.8, sgn * (headW / 2 - 0.3));
      t.beam(kit.solid, q.x, yDeck, q.z, q.x, yDeck + 3.6, q.z, 0.05, L.pile);
      t.lamp(kit.glow, q.x, yDeck + 3.75, q.z, 0.32, L.lamp);
      t.light(q.x, yDeck + 3.75, q.z, L.lamp.clone().multiplyScalar(0.35), 1.8);
    }
  }
  for (let s = ramp + 3; s < len - head; s += 12 + rng.range(0, 14)) {
    const q = at(s, (W / 2 - 0.1) * (rng.chance(0.5) ? 1 : -1));
    perches.push({ x: q.x, y: yDeck + 1.04, z: q.z, yaw: rng.range(0, Math.PI * 2) });
  }
}

/** Foam strips: the swash on the sand, the inner and the outer break. Params ride in the vertex colour: (strength, speed, 0). */
const FOAM_STRIPS = [
  { d0: 1.4, d1: -4, k: 0.55, speed: 0.17 },
  { d0: -6, d1: -11, k: 0.5, speed: 0.1 },
  { d0: -17, d1: -24, k: 0.34, speed: 0.065 },
] as const;

function surf(kit: DistrictKit, a: Area): void {
  const p = a.params;
  const f = harborFrame(a);
  const gb = new GeoBuilder(true);
  const strips = FOAM_STRIPS.slice(0, kit.quality === 'low' ? 1 : kit.quality === 'medium' ? 2 : 3);
  const n = Math.max(1, Math.ceil((p.pb - p.pa + 80) / 5));
  for (const s of strips) {
    const params = new THREE.Color(s.k, s.speed, 0);
    let prev: number[] | null = null;
    for (let i = 0; i <= n; i++) {
      const u = p.pa - 40 + ((p.pb - p.pa + 80) * i) / n;
      const cur: number[] = [];
      for (let j = 0; j <= 3; j++) {
        const d = s.d0 + ((s.d1 - s.d0) * j) / 3;
        const q = framePoint(f, u, coastV(p, u) - d);
        const wl = waterLevel(p, u);
        // On the sand the foam rides the ground (the drive height); over the water, the surface.
        const y = Math.max(kit.h(q.x, q.z) + CURB, wl) + 0.03;
        cur.push(gb.vertex(q.x, y, q.z, 0, 1, 0, u, j / 3, params));
      }
      if (prev) for (let j = 0; j < 3; j++) gb.quadFacing(prev[j], cur[j], cur[j + 1], prev[j + 1], 0, 1, 0);
      prev = cur;
    }
  }
  const mat = new THREE.ShaderMaterial({
    vertexShader: FOAM_VERT,
    fragmentShader: FOAM_FRAG,
    uniforms: { time: { value: 0 }, gust: WIND.sway, fogDensity: { value: 0.005 }, ...HEIGHT_FOG_UNIFORMS },
    vertexColors: true,
    transparent: true,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
    side: THREE.DoubleSide,
    polygonOffset: true,
    polygonOffsetFactor: -2,
    polygonOffsetUnits: -2,
  });
  const mesh = new THREE.Mesh(kit.track(gb.build()), kit.track(mat));
  mesh.name = 'beachSurf';
  mesh.frustumCulled = false;
  mesh.renderOrder = 2;
  kit.group.add(mesh);
  kit.animate((time) => {
    mat.uniforms.time.value = time;
  });
}

const FOAM_VERT = /* glsl */ `
  uniform float fogDensity;
  ${HEIGHT_FOG_GLSL}
  varying vec2 vUv;
  varying vec3 vPar;
  varying float vFog;
  void main() {
    vUv = uv;
    vPar = color;
    vec4 mv = modelViewMatrix * vec4(position, 1.0);
    float d = length(mv.xyz);
    vFog = exp(-fogDensity * fogDensity * d * d * hfMulView(mv.xyz));
    gl_Position = projectionMatrix * mv;
  }
`;

/**
 * uv.x is metres along the coast, uv.y 0 at a strip's landward edge to 1 at its seaward one. A wave front starts at the sea
 * edge and runs landward once per 1 / speed seconds, its phase wandering along the coast so the line breaks into peaks and
 * comes in sets; a bright lead, a bubbly wake behind it, faded at both edges. Additive, so it fades to black in fog.
 */
const FOAM_FRAG = /* glsl */ `
  uniform float time;
  uniform float gust;
  varying vec2 vUv;
  varying vec3 vPar;
  varying float vFog;
  float hash(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
  float vnoise(vec2 p) {
    vec2 i = floor(p);
    vec2 f = fract(p);
    f = f * f * (3.0 - 2.0 * f);
    return mix(mix(hash(i), hash(i + vec2(1.0, 0.0)), f.x), mix(hash(i + vec2(0.0, 1.0)), hash(i + vec2(1.0, 1.0)), f.x), f.y);
  }
  void main() {
    float t = time * (0.85 + 0.15 * gust);
    float x = vUv.x;
    float ph = fract(t * vPar.y + 0.35 * vnoise(vec2(x * 0.035, floor(t * vPar.y) * 1.7)) + 0.12 * sin(x * 0.11 + t * 0.3));
    float dd = vUv.y - (1.0 - ph);
    float lead = smoothstep(0.08, 0.0, abs(dd)) * (0.35 + 0.65 * vnoise(vec2(x * 0.7 + t * 0.15, floor(t * vPar.y))));
    float wake = step(0.0, dd) * exp(-dd * 4.5);
    float bub = smoothstep(0.35, 0.8, vnoise(vec2(x * 1.7 + t * 0.3 * gust, vUv.y * 9.0 - t * 0.6)));
    float edge = smoothstep(0.0, 0.12, vUv.y) * smoothstep(1.0, 0.82, vUv.y);
    float sets = 0.12 + 0.88 * smoothstep(0.38, 0.7, vnoise(vec2(x * 0.16 - t * 0.05 * gust, t * vPar.y * 0.5 + floor(t * vPar.y) * 3.1)));
    float a = (lead * 0.9 + wake * bub * 0.55) * edge * sets * vPar.x;
    gl_FragColor = vec4(vec3(0.62, 0.78, 0.9) * a * vFog, 1.0);
  }
`;
