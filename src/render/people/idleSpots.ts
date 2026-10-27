/**
 * Where the idle people of the city wait, sit and chat: a pure planner (no
 * three.js) from the seeded world, so the menu city and the race place the
 * same people and a replay sees the same street. They stay with their props
 * (a bus stop's riders, a bench's pair, the cafe table's diners, someone by a
 * park lamp) and in front of shops (a standing pair under the awning), and
 * keep off everything the stands and meets own: the route corridor, the curb
 * lane, the gate stands, a meet's crowd and the night market's pens. The
 * seed's own mood scales how lively the street is (`liveliness`) and tints
 * the wardrobe warm or cool (`warmth`). Walks props in id order, then shop
 * fronts, then thins evenly to the cap (sitters to half of it, so the street
 * reads as people waiting and chatting). Render only (reads World).
 */
import type { World } from '../../city/world';
import type { Prop } from '../../city/props';
import { PLAZA } from '../../city/config';
import { PLAZA_HINT } from '../../city/districts/plazaDressing';
import { Rng, deriveSeed } from '../../sim/prng';
import { BACK, FWD, groundY, makePlacer, thin } from './placer';

/** What an idler is doing: stands easy, sits, leans back a little, or holds a phone up. */
export type IdlePose = 'stand' | 'sit' | 'lean' | 'phone';

export interface IdlePerson {
  x: number;
  /** Floor height under the feet (m). */
  y: number;
  z: number;
  /** Facing (three.js yaw, rad): forward is (sin, cos). */
  yaw: number;
  pose: IdlePose;
  /** The prop id this person sits at or stands beside (so a broken prop takes them with it), or -1. */
  anchorProp: number;
  /** Seeds the wardrobe and the animation phase. */
  lookSeed: number;
}

/** A shop's ground floor bay, pushed by the facade builder: the centre of the bay at the face and its outward (road side) normal. */
export interface ShopFront {
  x: number;
  z: number;
  nx: number;
  nz: number;
  kind: string;
}

/** The pieces of the scene the idlers keep clear of, as the scene already has them. */
export interface IdleAvoid {
  /** Start / finish gates (structurally a CrowdGate): route distance and position. */
  gates?: readonly { s: number; position: { x: number; z: number } }[];
  /** The street meets (structurally a MeetPlan): each zone's centroid and radius. */
  meets?: { zones: readonly { x: number; z: number; radius: number }[] };
  /** The night market's pens (planMarketCrowd): the people of each. */
  markets?: readonly (readonly { x: number; z: number }[])[];
}

export interface IdleOptions {
  /** 0..1 scale on every chance (graphics quality). */
  density: number;
  /** Most people returned. */
  cap: number;
  shopFronts?: readonly ShopFront[];
  avoid?: IdleAvoid;
}

export interface IdlePlan {
  people: IdlePerson[];
  /** -1 (cool) .. 1 (warm): how the seed's wardrobe leans. */
  warmth: number;
}

/** Gates own the sidewalk this far around their position (m). */
const GATE_CLEAR = 80;
/** Extra room around a meet's crowd (m). */
const MEET_CLEAR = 10;
/** Extra room around a market pen (m). */
const MARKET_CLEAR = 6;
/** The curb lane nobody waits in, the width of the road edge a car can mount (m). */
const CURB_LANE = 1.2;
/** Shop pairs keep this far from each other (m). */
const PAIR_GAP = 6;

/**
 * A furnished plaza is where people sit and wait: its benches, cafe tables and lanterns are this likely to have
 * company (the chances elsewhere are in planIdlers), and a standing group gathers at each centrepiece.
 */
const PLAZA_LIVELY = { bench: 0.3, cafeTable: 0.35, parkLamp: 0.4 } as const;

const CURB_DIRS = [
  [1, 0],
  [-1, 0],
  [0, 1],
  [0, -1],
] as const;

/** The round places the sidewalks' people keep out of: each meet's crowd and each market pen, grown by its clearance (squared radius). */
export function avoidCircles(avoid?: IdleAvoid): { x: number; z: number; r2: number }[] {
  const circles: { x: number; z: number; r2: number }[] = [];
  for (const z of avoid?.meets?.zones ?? []) circles.push({ x: z.x, z: z.z, r2: (z.radius + MEET_CLEAR) ** 2 });
  for (const pen of avoid?.markets ?? []) {
    if (!pen.length) continue;
    let cx = 0;
    let cz = 0;
    for (const p of pen) {
      cx += p.x;
      cz += p.z;
    }
    cx /= pen.length;
    cz /= pen.length;
    let r = 0;
    for (const p of pen) r = Math.max(r, Math.hypot(p.x - cx, p.z - cz));
    circles.push({ x: cx, z: cz, r2: (r + MARKET_CLEAR) ** 2 });
  }
  return circles;
}

/** The idle people of a world. Deterministic for (world, options). */
export function planIdlers(world: World, opts: IdleOptions): IdlePlan {
  const rng = new Rng(deriveSeed(world.seed, 'idlers'));
  const liveliness = rng.range(0.55, 1);
  const warmth = rng.range(-1, 1);
  const density = Math.max(0, Math.min(1, opts.density));
  const route = world.route;
  const L = route.length;
  const placer = makePlacer(world);
  const out: IdlePerson[] = [];
  const gates = opts.avoid?.gates ?? [];
  const circles = avoidCircles(opts.avoid);
  const covered = new Set(world.coveredProps);

  const wrap = (d: number) => (route.closed ? ((((d + L / 2) % L) + L) % L) - L / 2 : d);
  /** The global rejections: the route corridor, the gate stands, meets and markets. */
  const allowed = (x: number, z: number): boolean => {
    const rp = world.routeProgress(x, z);
    if (Math.abs(rp.lateral) < route.segWidth[rp.seg] / 2 + 1) return false;
    for (const g of gates) {
      const ds = wrap(rp.s - g.s);
      if (ds >= -BACK && ds <= FWD) return false;
      if ((x - g.position.x) ** 2 + (z - g.position.z) ** 2 < GATE_CLEAR * GATE_CLEAR) return false;
    }
    for (const c of circles) if ((x - c.x) ** 2 + (z - c.z) ** 2 < c.r2) return false;
    return true;
  };
  /** Nobody waits in the curb lane: no road within it. */
  const curbClear = (x: number, z: number): boolean => {
    for (const [dx, dz] of CURB_DIRS) if (world.surfaceAt(x + dx * CURB_LANE, z + dz * CURB_LANE) === 'road') return false;
    return world.surfaceAt(x, z) !== 'road';
  };

  const push = (x: number, z: number, yaw: number, pose: IdlePose, anchorProp: number, seated: boolean): boolean => {
    // Draw first so a rejection never shifts the stream.
    const lookSeed = rng.int(1, 0x3fffffff);
    if (!allowed(x, z)) return false;
    if (!seated && !curbClear(x, z)) return false;
    if (!placer.ok(x, z, anchorProp)) return false;
    placer.take(x, z);
    out.push({ x, y: groundY(world, x, z), z, yaw, pose, anchorProp, lookSeed });
    return true;
  };

  /** Prop-local (lx right, lz toward the road) to world. */
  const at = (p: Prop, lx: number, lz: number): [number, number] => {
    const c = Math.cos(p.yaw);
    const s = Math.sin(p.yaw);
    return [p.x + lx * c + lz * s, p.z - lx * s + lz * c];
  };
  const stands = (): IdlePose => (rng.chance(0.3) ? 'phone' : 'stand');
  /** Does this prop stand in a plaza (an infill plaza or corner pocket, the monument plaza)? */
  const inPlaza = (p: Prop): boolean => {
    const a = p.area === undefined ? undefined : world.areas[p.area];
    return !!a && (a.kind === 'monument' || (a.kind === 'infill' && (a.variant === 'plaza' || a.variant === 'cornerPlaza')) || (a.kind === 'roundabout' && a.variant === 'plaza'));
  };

  for (const p of world.props) {
    if (covered.has(p.id)) continue;
    switch (p.kind) {
      case 'busStop': {
        let n = 0;
        if (rng.chance(0.8 * liveliness * density)) {
          n = 1;
          if (rng.chance(0.45 * liveliness)) n++;
          if (n === 2 && rng.chance(0.3)) n++;
        }
        const seatsFree = [-0.8, 0.2];
        for (let i = 0; i < n; i++) {
          if (seatsFree.length && rng.chance(0.5)) {
            const sx = seatsFree.splice(rng.int(0, seatsFree.length - 1), 1)[0];
            const [x, z] = at(p, sx, -0.45);
            push(x, z, p.yaw + rng.range(-0.15, 0.15), 'sit', p.id, true);
          } else {
            // Standing in the shelter's mouth, never past 0.35 toward the road.
            const [x, z] = at(p, rng.range(-1.2, 1.0), rng.range(-0.2, 0.3));
            // Under the shelter's roof (local z <= 0.35): a solid prop, no car stands there, so the curb lane does not apply.
            push(x, z, p.yaw + rng.range(-0.5, 0.5), stands(), p.id, true);
          }
        }
        break;
      }
      case 'bench': {
        const n = rng.chance((inPlaza(p) ? PLAZA_LIVELY.bench : 0.12) * liveliness * density) ? (rng.chance(0.4) ? 2 : 1) : 0;
        if (!n) break;
        if (n === 2) {
          // A pair turned a little toward each other.
          const [x0, z0] = at(p, -0.4, -0.02);
          const [x1, z1] = at(p, 0.4, -0.02);
          push(x0, z0, p.yaw - 0.45, 'sit', p.id, true);
          push(x1, z1, p.yaw + 0.45, 'sit', p.id, true);
        } else {
          const [x, z] = at(p, rng.chance(0.5) ? -0.4 : 0.4, -0.02);
          push(x, z, p.yaw + rng.range(-0.2, 0.2), 'sit', p.id, true);
        }
        break;
      }
      case 'cafeTable': {
        const n = rng.chance((inPlaza(p) ? PLAZA_LIVELY.cafeTable : 0.22) * density) ? (rng.chance(0.5) ? 2 : 1) : 0;
        const first = rng.chance(0.5) ? -1 : 1;
        for (let i = 0; i < n; i++) {
          const side = i === 0 ? first : -first;
          // On the chair, facing the table across it.
          const [x, z] = at(p, side * 0.75, 0);
          const c = Math.cos(p.yaw);
          const s = Math.sin(p.yaw);
          const fx = -side * c;
          const fz = side * s;
          push(x, z, Math.atan2(fx, fz) + rng.range(-0.15, 0.15), 'sit', p.id, true);
        }
        break;
      }
      case 'parkLamp': {
        if (!rng.chance((inPlaza(p) ? PLAZA_LIVELY.parkLamp : 0.3) * liveliness * density)) break;
        // One metre off the lamp on the side away from the road, facing the lamp's way out.
        const [x, z] = at(p, rng.range(-0.3, 0.3), -1);
        push(x, z, p.yaw + rng.range(-0.4, 0.4), rng.chance(0.5) ? 'lean' : stands(), p.id, false);
        break;
      }
      default:
        break;
    }
  }

  // Plaza groups: a loose circle of people talking by each centrepiece (plazaDressing.ts 'gather' hints), thinned
  // evenly to PLAZA.gather.max so a city of many small plazas does not spend the cap on them.
  const spots: { x: number; z: number; count: number; r: number }[] = [];
  for (const a of world.areas) {
    if (a.kind !== 'monument' && a.kind !== 'infill' && a.kind !== 'roundabout') continue;
    for (const h of world.districts.builds[a.id]?.hints ?? []) if (h.kind === PLAZA_HINT.gather) spots.push({ x: h.points[0].x, z: h.points[0].z, count: h.values[0], r: h.values[1] });
  }
  const share = Math.min(1, PLAZA.gather.max / Math.max(1, spots.length));
  for (const sp of spots) {
    const go = rng.chance(share * (0.6 + 0.4 * liveliness) * density);
    const base = rng.range(0, Math.PI * 2);
    const first = out.length;
    let placed = 0;
    for (let i = 0; i < sp.count; i++) {
      const ang = base + (i / sp.count) * Math.PI * 2;
      // Drawn either way, so a skipped group shifts nothing.
      const pose = stands();
      const x = sp.x + Math.sin(ang) * sp.r;
      const z = sp.z + Math.cos(ang) * sp.r;
      if (go && push(x, z, Math.atan2(sp.x - x, sp.z - z) + rng.range(-0.3, 0.3), pose, -1, false)) placed++;
    }
    // A lone person is not a group.
    if (placed === 1) out.length = first;
  }

  // Shop fronts: a standing pair under the awning.
  const pairs: [number, number][] = [];
  for (const f of opts.shopFronts ?? []) {
    if (!rng.chance(0.25 * liveliness * density)) continue;
    const d = rng.range(0.6, 1.3);
    const cx = f.x + f.nx * d;
    const cz = f.z + f.nz * d;
    // Still sidewalk 1.2 m further toward the road.
    if (world.surfaceAt(cx + f.nx * CURB_LANE, cz + f.nz * CURB_LANE) === 'road') continue;
    if (pairs.some(([px, pz]) => (px - cx) ** 2 + (pz - cz) ** 2 < PAIR_GAP * PAIR_GAP)) continue;
    const tx = -f.nz;
    const tz = f.nx;
    const a = out.length;
    // Facing each other, drawn a little toward the road.
    const half = rng.range(0.4, 0.55);
    const ax = cx - tx * half;
    const az = cz - tz * half;
    const bx = cx + tx * half;
    const bz = cz + tz * half;
    const yawA = Math.atan2(tx + f.nx * 0.3, tz + f.nz * 0.3);
    const yawB = Math.atan2(-tx + f.nx * 0.3, -tz + f.nz * 0.3);
    const okA = push(ax, az, yawA, stands(), -1, false);
    const okB = push(bx, bz, yawB, stands(), -1, false);
    // A lone person is not a conversation.
    if (okA !== okB) out.length = a;
    if (okA && okB) pairs.push([cx, cz]);
  }

  // Sitters make up at most half the cap, thinned evenly; every stander, leaner and phone stays (thinned only if they alone pass the cap).
  const sitters = out.filter((q) => q.pose === 'sit');
  const others = out.filter((q) => q.pose !== 'sit');
  const people = thin(others.concat(thin(sitters, Math.floor(opts.cap / 2))), opts.cap);
  return { people, warmth };
}
