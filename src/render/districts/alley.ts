/**
 * Alley renderer: strings of warm bulbs sagging across raceway alleys from
 * wall to wall, a few dim lamps over plain back alleys (they stay dark on
 * purpose), and a steel kicker deck over every back alley hump, following
 * the same height profile the sim drives on (hazard yellow at the toes and
 * the lip), between concrete cheek walls: a coping along each edge of the
 * deck and, outside it, the battered face where the sim's profile fades out
 * behind the building line (the terrain itself, draped, so a wheel on it sits
 * on what is drawn). The route's own shortcuts get pink and amber string
 * lights all the way through, leg by leg round their bends, between the
 * construction fences at their mouths (fences and the rest of the site
 * clutter are props, render/street/props.ts); a jump exit's ramp gets the
 * same deck and cheeks up to its lip, and the face under the lip (the
 * 'alleyLip' wall, exactly on the wall line) a concrete block with a hazard
 * band, wide enough to close the cheeks and deep enough to hide the road
 * mesh's drop behind it. Tables, crates, dumpsters and trash are destructible
 * props drawn by render/street/props.ts. Content to add: fire escapes, steam
 * vents, puddles.
 */
import * as THREE from 'three';
import { jumpProfile, jumpRampProfile } from '../../city/districts/alleyPath';
import type { Wall } from '../../city/blocks';
import { GeoBuilder } from '../geoBuilder';
import { makeRadialGlow } from '../textures/textures';
import { CITY } from '../../city/config';
import { routeSample } from '../../city/route';
import type { DistrictRenderer, DistrictKit } from './kit';
import { SHORTCUT_BULBS, col, cylinder, groundVertex, orientedBox } from './kit';

/** String lights: one string every STRING_STEP m along a raceway alley, a bulb every BULB_STEP m, sagging SAG m. */
const STRING_STEP = 7;
const BULB_STEP = 0.55;
const SAG = 0.75;
const STRING_Y = 5.9;
/** The kicker deck floats this far above the profile so the road mesh never shows through it (m); over the alley's sidewalk strips (a curb up) the same again. */
const DECK_LIFT = 0.06;
const WALK_LIFT = CITY.curbHeight + DECK_LIFT;
/** Deck rows every DECK_STEP m along the hump. */
const DECK_STEP = 0.5;
/** The alley's sidewalk strips either side of its road, which the deck steps up over (m). */
const WALK = CITY.sidewalkWidth.backAlley;
/** The profile fades out over this band behind the building line (districts/alleyDressing.ts): the cheeks' batter. */
const FADE = CITY.districts.backAlley.jumpFade;
/**
 * Cheek walls: the coping reaches `in` over the deck's edge and `out` past the building line, standing
 * `lift` above the deck; the batter below it is draped `drape` over the terrain, in `steps` strips out
 * to `beyond` past the fade, where the ground is level again.
 */
const CHEEK = { in: 0.3, out: 0.12, lift: 0.05, drape: 0.05, steps: 3, beyond: 0.3 } as const;
/** The lip block's hazard band: this tall along its top edge (m), in stripes this wide. */
const LIP_BAND = 0.3;
const LIP_STRIPE = 0.45;
/** Hazard lamps along the lip's top edge: one every this far across (m). */
const LIP_LAMP_STEP = 0.75;
/**
 * The barricade on each abutment beside a jump exit's lip: boards this wide (m) on two posts, the
 * boards' heights (m), the posts' height (m) and how far back from the lip it stands (m).
 */
const BARRICADE = { width: 1.3, boards: [0.5, 0.85, 1.2], board: 0.2, post: 1.42, back: 0.7 } as const;

/** Light pools under shortcut string lights: spacing along the alley and length (m), colour (additive). */
const POOL = { step: 9, length: 11, color: 0xff9a6a, strength: 0.5 } as const;

interface Pool {
  x: number;
  z: number;
  /** Alley direction (unit) and pool width across it (m). */
  ux: number;
  uz: number;
  w: number;
}

/** Additive radial glow quads draped on the floor (one merged mesh, one draw call for every shortcut). */
function lightPools(kit: DistrictKit, pools: Pool[]): void {
  const gb = new GeoBuilder();
  const N = 4;
  for (const p of pools) {
    const lx = -p.uz;
    const lz = p.ux;
    const ids: number[] = [];
    for (let j = 0; j <= N; j++) {
      for (let i = 0; i <= N; i++) {
        const a = (i / N - 0.5) * POOL.length;
        const c = (j / N - 0.5) * p.w;
        const x = p.x + p.ux * a + lx * c;
        const z = p.z + p.uz * a + lz * c;
        ids.push(gb.vertex(x, kit.h(x, z) + 0.12, z, 0, 1, 0, i / N, j / N));
      }
    }
    for (let j = 0; j < N; j++) for (let i = 0; i < N; i++) gb.quadFacing(ids[j * (N + 1) + i], ids[j * (N + 1) + i + 1], ids[(j + 1) * (N + 1) + i + 1], ids[(j + 1) * (N + 1) + i], 0, 1, 0);
  }
  const map = kit.track(makeRadialGlow());
  const mat = kit.track(
    new THREE.MeshBasicMaterial({
      map,
      color: new THREE.Color(POOL.color).multiplyScalar(POOL.strength),
      transparent: true,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
      polygonOffset: true,
      polygonOffsetFactor: -2,
      polygonOffsetUnits: -2,
    }),
  );
  const mesh = new THREE.Mesh(kit.track(gb.build()), mat);
  mesh.name = 'shortcutLightPools';
  mesh.renderOrder = 1;
  kit.group.add(mesh);
}

const WARM = [col(0xffb35c, 2.4), col(0xffc98a, 2.2), col(0xff9a5c, 2.3), col(0xff7ab0, 1.8), col(0xfff0c8, 2)];

function stringLights(kit: DistrictKit, ax: number, az: number, bx: number, bz: number, half: number, warm = WARM, from = 10, to = 10): void {
  const len = Math.hypot(bx - ax, bz - az);
  const ux = (bx - ax) / len;
  const uz = (bz - az) / len;
  const nx = -uz;
  const nz = ux;
  const wire = col(0x101114);
  for (let s = from, k = 0; s < len - to; s += STRING_STEP, k++) {
    // Strings run a little diagonal, alternating, so they read as hand hung.
    const skew = (k % 2 ? 1 : -1) * 1.2;
    const x0 = ax + ux * (s - skew) - nx * half;
    const z0 = az + uz * (s - skew) - nz * half;
    const x1 = ax + ux * (s + skew) + nx * half;
    const z1 = az + uz * (s + skew) + nz * half;
    const y0 = kit.h(x0, z0) + STRING_Y;
    const y1 = kit.h(x1, z1) + STRING_Y;
    const span = Math.hypot(x1 - x0, z1 - z0);
    const n = Math.max(2, Math.round(span / BULB_STEP));
    let px = x0;
    let pz = z0;
    let py = y0;
    for (let i = 0; i <= n; i++) {
      const t = i / n;
      const x = x0 + (x1 - x0) * t;
      const z = z0 + (z1 - z0) * t;
      const y = y0 + (y1 - y0) * t - SAG * 4 * t * (1 - t);
      if (i > 0) cylinder(kit.solid, (x + px) / 2, (z + pz) / 2, 0.012, Math.min(y, py) - 0.012, Math.max(y, py) + 0.012, 3, wire, false);
      if (i > 0 && i < n) cylinder(kit.glow, x, z, 0.07, y - 0.13, y, 5, warm[(i * 7 + k * 3) % warm.length]);
      px = x;
      pz = z;
      py = y;
    }
  }
}

const STEEL = col(0x3a3d44);
const HAZARD = col(0xf2b81c);
const DARK = col(0x15161a);
const CONCRETE = col(0x5a5b60);
const COPING = col(0x6e6f74);
/** A jump exit's abutments: poured concrete, paler than the alley's cheek walls so the structure reads. */
const POURED = col(0x7a7b80);
const POURED_TOP = col(0x8c8d92);
/** Reflective sheeting on the lip band and the barricades: dim in the glow builder, so it reads at night without blooming. */
const SHEET_YELLOW = col(0xffc21a, 0.42);
const SHEET_DARK = col(0x101012, 0.2);
const POST = col(0xd4d6dc);

/**
 * A steel deck over a profile along a leg (origin a, direction u), from s0 to
 * s3, `profile` giving its height and slope and `band` which stations get the
 * hazard stripes. The deck follows the terrain (the sim's profile) exactly:
 * a plate over the road, stepping a curb up over the alley's sidewalk strips.
 * Either side, a cheek wall: a coping along the deck's edge and the battered
 * face below it, draped over the fade band where the profile dies out behind
 * the building line, out to level ground. With `abutment` the cheek is
 * poured concrete instead: its top carries the coping's height right across
 * the fade band and its outer face drops plumb to the ground beyond it, so
 * the draped slope is boxed in (a jump exit's ramp, which stands taller).
 */
function deck(kit: DistrictKit, ax: number, az: number, ux: number, uz: number, s0: number, s3: number, hw: number, profile: (s: number) => { h: number; dh: number }, band: (s: number) => boolean, extra: number[] = [], abutment = false): void {
  const lx = -uz;
  const lz = ux;
  const stations: number[] = [];
  for (let s = s0; s < s3; s += DECK_STEP) stations.push(s);
  stations.push(s3, ...extra);
  stations.sort((a, b) => a - b);
  const gb = kit.solid;
  const curb = hw - WALK;
  // Across the deck: the sidewalk strips (lifted a curb) and the road, with doubled vertices at each curb line for the step.
  const lanes: [number, number][] = [
    [-hw, WALK_LIFT],
    [-curb, WALK_LIFT],
    [-curb, DECK_LIFT],
    [0, DECK_LIFT],
    [curb, DECK_LIFT],
    [curb, WALK_LIFT],
    [hw, WALK_LIFT],
  ];
  // Across a cheek, from the coping's inner edge out: the coping, then the batter strips to level ground.
  const batter: number[] = [];
  if (!abutment) for (let k = 0; k <= CHEEK.steps; k++) batter.push(hw + CHEEK.out + ((FADE + CHEEK.beyond - CHEEK.out) * k) / CHEEK.steps);
  // An abutment's top reaches past the whole fade band; its foot sinks below the ground there.
  const out = abutment ? FADE + CHEEK.beyond : CHEEK.out;
  const [faceCol, topCol] = abutment ? [POURED, POURED_TOP] : [CONCRETE, COPING];
  let prev: number[] | null = null;
  let prevCheeks: number[][][] | null = null;
  let prevS = s0;
  for (const s of stations) {
    if (prev && s - prevS < 1e-3) continue;
    const p = profile(s);
    const c = band(s) ? (Math.floor((s - s0) / 0.3) % 2 ? HAZARD : DARK) : STEEL;
    // Slope normal along the alley: (-dh * u, 1) normalized.
    const nl = Math.hypot(p.dh, 1);
    const nx = (-p.dh * ux) / nl;
    const ny = 1 / nl;
    const nz = (-p.dh * uz) / nl;
    const at = (l: number) => ({ x: ax + ux * s + lx * l, z: az + uz * s + lz * l });
    const row = lanes.map(([l, lift]) => {
      const q = at(l);
      return gb.vertex(q.x, kit.h(q.x, q.z) + lift, q.z, nx, ny, nz, 0, 0, c);
    });
    if (prev) for (let k = 0; k + 1 < lanes.length; k++) if (lanes[k][0] !== lanes[k + 1][0]) gb.quadFacing(prev[k], prev[k + 1], row[k + 1], row[k], 0, 1, 0);
    // The cheeks: per side, the coping's vertices (inner edge, outer edge, top at both, outer face foot) and the batter's.
    const cheeks = [-1, 1].map((side) => {
      const edge = at(side * hw);
      const yCope = kit.h(edge.x, edge.z) + WALK_LIFT + CHEEK.lift;
      const inner = at(side * (hw - CHEEK.in));
      const outer = at(side * (hw + out));
      const yFoot = kit.h(outer.x, outer.z) + (abutment ? -0.3 : CHEEK.drape);
      const ox = lx * side;
      const oz = lz * side;
      const cope = [
        gb.vertex(inner.x, yCope, inner.z, nx, ny, nz, 0, 0, topCol),
        gb.vertex(outer.x, yCope, outer.z, nx, ny, nz, 0, 0, topCol),
        // The outer face, from the coping down to the batter's top (an abutment's to the ground), and the inner face down to the deck.
        gb.vertex(outer.x, yCope, outer.z, ox, 0, oz, 0, 0, faceCol),
        gb.vertex(outer.x, yFoot, outer.z, ox, 0, oz, 0, 0, faceCol),
        gb.vertex(inner.x, yCope, inner.z, -ox, 0, -oz, 0, 0, faceCol),
        gb.vertex(inner.x, kit.h(inner.x, inner.z) + WALK_LIFT, inner.z, -ox, 0, -oz, 0, 0, faceCol),
      ];
      const face = batter.map((l) => {
        const q = at(side * l);
        return groundVertex(kit, gb, q.x, q.z, CHEEK.drape, CONCRETE);
      });
      return [cope, face];
    });
    if (prev && prevCheeks) {
      for (let i = 0; i < 2; i++) {
        const side = i ? 1 : -1;
        const [pc, pf] = prevCheeks[i];
        const [cc, cf] = cheeks[i];
        gb.quadFacing(pc[0], pc[1], cc[1], cc[0], 0, 1, 0);
        gb.quadFacing(pc[3], pc[2], cc[2], cc[3], lx * side, 0, lz * side);
        gb.quadFacing(pc[5], pc[4], cc[4], cc[5], -lx * side, 0, -lz * side);
        for (let k = 0; k + 1 < batter.length; k++) gb.quadFacing(pf[k], pf[k + 1], cf[k + 1], cf[k], 0, 1, 0);
      }
    }
    prev = row;
    prevCheeks = cheeks;
    prevS = s;
  }
}

/** The jump exit's ramp deck: from the toe to the lip, striped at the toe and the lip. */
function rampDeck(kit: DistrictKit, ax: number, az: number, ux: number, uz: number, toe: number, length: number, rise: number, hw: number): void {
  const lip = toe + length;
  deck(
    kit,
    ax,
    az,
    ux,
    uz,
    toe,
    // Ends a hair short of the lip: the ramp's modifier stops there, and sampled on the boundary the terrain may already have dropped (the lip block reaches back over the gap).
    lip - 0.02,
    hw,
    (s) => jumpRampProfile(Math.min(s, lip) - toe, length, rise),
    (s) => s - toe < 0.6 || lip - s < 0.9,
    [],
    true,
  );
}

/**
 * A barricade standing on an abutment beside the lip, facing out along `f`: two white posts, three
 * boards in yellow and black reflective stripes across them, a blinking amber lamp on each post.
 */
function barricade(kit: DistrictKit, x: number, z: number, y: number, fx: number, fz: number): void {
  const lx = -fz;
  const lz = fx;
  const hw = BARRICADE.width / 2;
  for (const k of [-1, 1]) {
    const px = x + lx * k * (hw - 0.12);
    const pz = z + lz * k * (hw - 0.12);
    orientedBox(kit.solid, px - lx * 0.04 - fx * 0.04, pz - lz * 0.04 - fz * 0.04, px + lx * 0.04 - fx * 0.04, pz + lz * 0.04 - fz * 0.04, fx * 0.08, fz * 0.08, y - 0.1, y + BARRICADE.post, POST);
    cylinder(kit.solid, px, pz, 0.1, y + BARRICADE.post, y + BARRICADE.post + 0.05, 6, DARK);
    cylinder(kit.hazard, px, pz, 0.085, y + BARRICADE.post + 0.05, y + BARRICADE.post + 0.2, 6, DARK);
  }
  // Each board striped on the diagonal (stripes slanting down toward the middle, as on a real barricade),
  // both faces, the stripes clipped to the board's ends.
  const gb = kit.glow;
  const w = 0.24;
  const h = BARRICADE.board;
  for (const by of BARRICADE.boards) {
    const y0 = y + by;
    for (const [face, off] of [
      [1, 0.065],
      [-1, 0.035],
    ] as const) {
      for (let k = -8; k <= 8; k++) {
        // Bottom edge [a, a + w] along the board, the top edge shifted by the slant toward the outer end.
        const a = k * w - w / 2;
        const sl = Math.sign(a + w / 2) * h || h;
        const pts = [
          [a, 0],
          [a + w, 0],
          [a + w + sl, h],
          [a + sl, h],
        ].map(([t, v]) => [Math.max(-hw, Math.min(hw, t)), v] as const);
        if (Math.max(...pts.map((p) => p[0])) - Math.min(...pts.map((p) => p[0])) < 0.01) continue;
        const c = k % 2 ? SHEET_DARK : SHEET_YELLOW;
        const ids = pts.map(([t, v]) => gb.vertex(x + lx * t + fx * off, y0 + v, z + lz * t + fz * off, fx * face, 0, fz * face, 0, 0, c));
        gb.quadFacing(ids[0], ids[1], ids[2], ids[3], fx * face, 0, fz * face);
      }
    }
    // The board's edges and back plate, dark.
    orientedBox(kit.solid, x - lx * hw + fx * 0.04, z - lz * hw + fz * 0.04, x + lx * hw + fx * 0.04, z + lz * hw + fz * 0.04, fx * 0.02, fz * 0.02, y0, y0 + h, DARK);
  }
}

/**
 * The face under a jump exit's lip: a concrete block whose street face is
 * the 'alleyLip' wall itself, reaching back to the lip (the terrain drops to
 * street level between them, and the road mesh's step with it), as high as
 * the deck's end, a hazard band along its top edge. It runs past both ends
 * of the wall to close the cheeks' batter, which drops with the terrain too.
 */
function lipFace(kit: DistrictKit, wall: Wall, depth: number, ext: number, top: number): void {
  const len = Math.hypot(wall.bx - wall.ax, wall.bz - wall.az) || 1;
  const dx = ((wall.bx - wall.ax) / len) * ext;
  const dz = ((wall.bz - wall.az) / len) * ext;
  const ax = wall.ax - dx;
  const az = wall.az - dz;
  const bx = wall.bx + dx;
  const bz = wall.bz + dz;
  const base = Math.min(kit.h(ax + wall.nx, az + wall.nz), kit.h(bx + wall.nx, bz + wall.nz)) - 0.3;
  orientedBox(kit.solid, ax, az, bx, bz, -wall.nx * depth, -wall.nz * depth, base, top - LIP_BAND, POURED);
  orientedBox(kit.solid, ax, az, bx, bz, -wall.nx * depth, -wall.nz * depth, top - LIP_BAND, top, HAZARD);
  // The band's reflective stripes on the street face (a hair proud of it), and the hazard lamps along its top edge.
  const span = Math.hypot(bx - ax, bz - az);
  const tx = (bx - ax) / span;
  const tz = (bz - az) / span;
  const n = Math.max(2, Math.round(span / LIP_STRIPE));
  for (let i = 0; i < n; i++) {
    const t0 = (span * i) / n;
    const t1 = (span * (i + 1)) / n;
    orientedBox(kit.glow, ax + tx * t0 + wall.nx * 0.02, az + tz * t0 + wall.nz * 0.02, ax + tx * t1 + wall.nx * 0.02, az + tz * t1 + wall.nz * 0.02, -wall.nx * 0.01, -wall.nz * 0.01, top - LIP_BAND + 0.03, top - 0.03, i % 2 ? SHEET_DARK : SHEET_YELLOW);
  }
  const lamps = Math.max(2, Math.round(span / LIP_LAMP_STEP));
  for (let i = 0; i <= lamps; i++) {
    const t = 0.25 + ((span - 0.5) * i) / lamps;
    cylinder(kit.hazard, ax + tx * t - wall.nx * 0.12, az + tz * t - wall.nz * 0.12, 0.07, top - 0.02, top + 0.05, 6, DARK);
  }
}

function kickerDeck(kit: DistrictKit, ax: number, az: number, ux: number, uz: number, center: number, ramp: number, top: number, height: number, hw: number): void {
  const s0 = center - top / 2 - ramp;
  const s1 = center - top / 2;
  const s2 = center + top / 2;
  const s3 = center + top / 2 + ramp;
  deck(
    kit,
    ax,
    az,
    ux,
    uz,
    s0,
    s3,
    hw,
    (s) => jumpProfile(s, center, ramp, top, height),
    (s) => s - s0 < 0.6 || s3 - s < 0.6 || Math.abs(s - s1) < 0.35 || Math.abs(s - s2) < 0.35,
    [s1, s2],
  );
}

export const alleyRenderer: DistrictRenderer = {
  kinds: ['alley', 'backAlley'],
  build(kit, areas) {
    const g = kit.world.graph;
    const pools: Pool[] = [];
    for (const a of areas) {
      if (a.kind === 'alley') {
        for (const eid of a.edges) {
          const e = g.edges[eid];
          const p = g.nodes[e.a];
          const q = g.nodes[e.b];
          stringLights(kit, p.x, p.z, q.x, q.z, e.width / 2 + e.sidewalk - 0.1);
        }
        continue;
      }
      // Route shortcuts: strung with lights all the way through, leg by leg round the bends.
      const sc = kit.world.route.shortcuts.find((x) => a.edges.includes(x.edges[0]));
      if (sc) {
        const e = g.edges[sc.edges[0]];
        const half = e.width / 2 + e.sidewalk - 0.1;
        const pts = sc.points;
        const legs = pts.length - 1;
        const route = kit.world.route;
        // Keep the strings inside the alley, clear of the streets at both ends: a diagonal mouth
        // reaches further along the alley (the acute corner side).
        const mouthAt = (s: number, o: { x: number; z: number }, d: { x: number; z: number }) => {
          const t = routeSample(route, s);
          const len = Math.hypot(d.x - o.x, d.z - o.z);
          const ux = (d.x - o.x) / len;
          const uz = (d.z - o.z) / len;
          const sinA = Math.max(0.35, Math.abs(t.tx * uz - t.tz * ux));
          const cosA = Math.abs(t.tx * ux + t.tz * uz);
          return Math.min(len * 0.4, (route.segWidth[t.seg] / 2 + CITY.sidewalk + half * cosA) / sinA + 1);
        };
        // A jump exit's strings stop at the ramp's toe (the lip's fence and face take over from there).
        const J = CITY.districts.backAlley.route.jump;
        const lastLen = Math.hypot(pts[legs].x - pts[legs - 1].x, pts[legs].z - pts[legs - 1].z);
        const m0 = mouthAt(sc.sIn, pts[0], pts[1]);
        const m1 = a.params.jumpExit ? Math.min(lastLen * 0.6, a.params.lipS + J.length + 1) : mouthAt(sc.sOut, pts[legs], pts[legs - 1]);
        for (let i = 0; i < legs; i++) {
          const o = pts[i];
          const d = pts[i + 1];
          const from = i === 0 ? m0 : 2.5;
          const to = i === legs - 1 ? m1 : 2.5;
          stringLights(kit, o.x, o.z, d.x, d.z, half, SHORTCUT_BULBS, from, to);
          // Warm light the strings throw on the floor, so the site clutter reads against it.
          const len = Math.hypot(d.x - o.x, d.z - o.z);
          const ux = (d.x - o.x) / len;
          const uz = (d.z - o.z) / len;
          for (let s = from + POOL.step / 2; s < len - to; s += POOL.step) pools.push({ x: o.x + ux * s, z: o.z + uz * s, ux, uz, w: half * 2 });
        }
      }
      // Back alleys: a few dim lamps (low light on purpose) and the kicker.
      const dim = col(0xffb35c, 1.1);
      for (const eid of sc ? [] : a.edges) {
        const e = g.edges[eid];
        const p = g.nodes[e.a];
        const q = g.nodes[e.b];
        const len = Math.hypot(q.x - p.x, q.z - p.z);
        const nx = -(q.z - p.z) / len;
        const nz = (q.x - p.x) / len;
        const half = e.width / 2 + e.sidewalk * 0.5;
        for (let s = 16, k = 0; s < len - 16; s += 22, k++) {
          const side = k % 2 ? 1 : -1;
          const x = p.x + ((q.x - p.x) * s) / len + nx * half * side;
          const z = p.z + ((q.z - p.z) * s) / len + nz * half * side;
          const y = kit.h(x, z) + 4.2;
          cylinder(kit.glow, x, z, 0.12, y, y + 0.2, 4, dim);
        }
      }
      for (const h of kit.builds[a.id].hints) {
        const [o, d] = h.points;
        if (h.kind === 'jump') {
          const [center, ramp, top, height, hw] = h.values;
          kickerDeck(kit, o.x, o.z, d.x - o.x, d.z - o.z, center, ramp, top, height, hw);
        } else if (h.kind === 'jumpExit') {
          const [toe, length, rise, hw] = h.values;
          const ux = d.x - o.x;
          const uz = d.z - o.z;
          rampDeck(kit, o.x, o.z, ux, uz, toe, length, rise, hw);
          // The block under the lip: from the area's lip wall back to the lip, as high as the deck's road ends.
          const lip = toe + length;
          // Sampled a hair short of the lip: the ramp's modifier ends there, and at the exact boundary float noise decides whether the drop is already in.
          const top = kit.h(o.x + ux * (lip - 0.02), o.z + uz * (lip - 0.02)) + DECK_LIFT;
          for (const w of kit.walls.get('alleyLip') ?? []) {
            if (w.area !== a.id) continue;
            const depth = ((w.ax + w.bx) / 2 - o.x) * ux + ((w.az + w.bz) / 2 - o.z) * uz - lip;
            lipFace(kit, w, Math.max(0.5, depth) + 0.05, FADE + CHEEK.beyond, top);
          }
          // A barricade on each abutment just back from the lip, outside the alley's walls (nothing reaches
          // it), facing the street the car flies out over.
          const sb = lip - BARRICADE.back;
          for (const side of [-1, 1]) {
            const l = side * (hw + (FADE + CHEEK.beyond) / 2);
            const bx = o.x + ux * sb - uz * l;
            const bz = o.z + uz * sb + ux * l;
            const ex = o.x + ux * sb - uz * side * hw;
            const ez = o.z + uz * sb + ux * side * hw;
            barricade(kit, bx, bz, kit.h(ex, ez) + WALK_LIFT + CHEEK.lift, ux, uz);
          }
        }
      }
    }
    if (pools.length) lightPools(kit, pools);
  },
};
