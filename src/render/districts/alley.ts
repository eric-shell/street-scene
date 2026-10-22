/**
 * Alley renderer: strings of warm bulbs sagging across raceway alleys from
 * wall to wall, a few dim lamps over plain back alleys (they stay dark on
 * purpose), and a steel kicker deck over every back alley hump, following
 * the same height profile the sim drives on (hazard yellow at the toes and
 * the lip). The route's own shortcuts get pink and amber string lights all
 * the way through, leg by leg round their bends, between the construction
 * fences at their mouths (fences and the rest of the site clutter are props,
 * render/street/props.ts); a jump exit's ramp gets the same steel deck up to its lip
 * and the face under the lip (the 'alleyLip' wall) a concrete block with a
 * hazard band. Tables, crates, dumpsters and trash are destructible props
 * drawn by render/street/props.ts. Content to add: fire escapes, graffiti, steam
 * vents, puddles.
 */
import * as THREE from 'three';
import { jumpProfile, jumpRampProfile } from '../../city/districts/alley';
import { GeoBuilder } from '../geoBuilder';
import { makeRadialGlow } from '../textures/textures';
import { CITY } from '../../city/config';
import { routeSample } from '../../city/route';
import type { DistrictRenderer, DistrictKit } from './kit';
import { col, cylinder, orientedBox } from './kit';

/** String lights: one string every STRING_STEP m along a raceway alley, a bulb every BULB_STEP m, sagging SAG m. */
const STRING_STEP = 7;
const BULB_STEP = 0.55;
const SAG = 0.75;
const STRING_Y = 5.9;
/** The kicker deck floats this far above the profile so the road mesh never shows through it (m). */
const DECK_LIFT = 0.06;
/** Deck rows every DECK_STEP m along the hump. */
const DECK_STEP = 0.5;

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
/** Route shortcut bulbs: hot pink with amber, the shortcut sign's colours. */
const SHORTCUT_BULBS = [col(0xff4fd8, 2.2), col(0xffb35c, 2.3), col(0xff2bd6, 2), col(0xffd08a, 2.1)];

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

/**
 * A steel deck over a profile along a leg (origin a, direction u), from s0 to
 * s3, `profile` giving its height and slope and `band` which stations get the
 * hazard stripes, with skirts from the deck's edges down to the ground.
 */
function deck(kit: DistrictKit, ax: number, az: number, ux: number, uz: number, s0: number, s3: number, hw: number, profile: (s: number) => { h: number; dh: number }, band: (s: number) => boolean, extra: number[] = []): void {
  const lx = -uz;
  const lz = ux;
  const stations: number[] = [];
  for (let s = s0; s < s3; s += DECK_STEP) stations.push(s);
  stations.push(s3, ...extra);
  stations.sort((a, b) => a - b);
  const gb = kit.solid;
  let prev: number[] | null = null;
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
    const row = [-hw, 0, hw].map((l) => {
      const x = ax + ux * s + lx * l;
      const z = az + uz * s + lz * l;
      return gb.vertex(x, kit.h(x, z) + DECK_LIFT, z, nx, ny, nz, 0, 0, c);
    });
    if (prev) for (let k = 0; k < 2; k++) gb.quadFacing(prev[k], prev[k + 1], row[k + 1], row[k], 0, 1, 0);
    // Side skirts from the deck edge down to the unmodified ground.
    if (prev) {
      for (const side of [-1, 1]) {
        const at = (ss: number) => {
          const x = ax + ux * ss + lx * side * hw;
          const z = az + uz * ss + lz * side * hw;
          const y = kit.h(x, z) + DECK_LIFT;
          return { x, z, y, base: y - profile(ss).h - 0.2 };
        };
        const a = at(prevS);
        const b = at(s);
        const v0 = gb.vertex(a.x, a.base, a.z, lx * side, 0, lz * side, 0, 0, DARK);
        const v1 = gb.vertex(b.x, b.base, b.z, lx * side, 0, lz * side, 0, 0, DARK);
        const v2 = gb.vertex(b.x, b.y, b.z, lx * side, 0, lz * side, 0, 0, DARK);
        const v3 = gb.vertex(a.x, a.y, a.z, lx * side, 0, lz * side, 0, 0, DARK);
        gb.quadFacing(v0, v1, v2, v3, lx * side, 0, lz * side);
      }
    }
    prev = row;
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
    lip,
    hw,
    (s) => jumpRampProfile(Math.min(s, lip) - toe, length, rise),
    (s) => s - toe < 0.6 || lip - s < 0.9,
  );
}

/** The block under a jump exit's lip reaches this far behind its face (m): over the terrain's drop one metre behind it, so the road mesh's step never shows. */
const LIP_BLOCK = 1.4;

/** The face under a jump exit's lip: a concrete block from the street up to the deck, a hazard band along its top edge. */
function lipFace(kit: DistrictKit, wall: { ax: number; az: number; bx: number; bz: number; nx: number; nz: number }): void {
  const mx = (wall.ax + wall.bx) / 2;
  const mz = (wall.az + wall.bz) / 2;
  const top = kit.h(mx - wall.nx * LIP_BLOCK, mz - wall.nz * LIP_BLOCK) + DECK_LIFT;
  const base = Math.min(kit.h(wall.ax + wall.nx, wall.az + wall.nz), kit.h(wall.bx + wall.nx, wall.bz + wall.nz)) - 0.3;
  // The block stands behind the face (under the ramp's end); the band is a thin box on its street side.
  orientedBox(kit.solid, wall.ax, wall.az, wall.bx, wall.bz, -wall.nx * LIP_BLOCK, -wall.nz * LIP_BLOCK, base, top - 0.3, CONCRETE);
  orientedBox(kit.solid, wall.ax, wall.az, wall.bx, wall.bz, -wall.nx * LIP_BLOCK, -wall.nz * LIP_BLOCK, top - 0.3, top, HAZARD);
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
          rampDeck(kit, o.x, o.z, d.x - o.x, d.z - o.z, toe, length, rise, hw);
        }
      }
    }
    for (const w of kit.walls.get('alleyLip') ?? []) lipFace(kit, w);
    if (pools.length) lightPools(kit, pools);
  },
};
