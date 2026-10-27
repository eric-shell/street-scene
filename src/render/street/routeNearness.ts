/**
 * How close a spot is to the race route, as one number the eye can read: the route is the city's main drag, so
 * the streets on it (and within about a block of it) get denser, brighter dressing and the side streets go
 * quieter. Before this, every street rolled the same odds of blade signs, posters, banners, lit windows and
 * marquee bulbs, so the course looked like any other street. `routeNearness(world)` is 1 on the route's street
 * (the buildings that front it), 0 from about 80 m out, and a smooth ramp between; `.scale()` turns it into a
 * multiplier for one kind of dressing, with the city identity (cityIdentity.ts `drag`) setting how loud the
 * contrast is (a Miami or New York night shouts, San Francisco and Philadelphia only lean).
 *
 * The field is a coarse grid of the exact distance to the route polyline, filled once per world (a few ms: each
 * polyline segment stamps the cells within reach) and read by bilinear lookup, so thousands of calls at build
 * cost nothing and nothing here runs per frame. World only: it reads `world.route.points` and never the sim state,
 * so replays are untouched.
 *
 * `scale` keeps the city total where it was: the route's street is a small part of a city (a few percent of the
 * buildings on a short circuit), so knobs of 0.6 and 1.6 taken literally would leave the whole city with a fifth
 * less of everything. The knobs set the contrast (their ratio); each is divided by its own mean over the world's
 * buildings, so the side streets give up exactly what the drag gains.
 */
import type { World } from '../../city/world';
import { clamp, lerp, smoothstep } from '../../sim/math';
import { cityIdentity } from '../cityIdentity';

/** The gradient: how far it reaches and how hard each kind of dressing leans on it. A knob's far and on values set the contrast (their ratio); `scale` divides by the city mean, so only banners and strands read them as written. */
export const DRAG = {
  /** Distance from the route polyline (m) inside which a spot counts as on the drag: the street, its sidewalks and the buildings that front it. */
  core: 22,
  /** Width of the soft falloff beyond the core (m): nearness reaches 0 at core + falloff. */
  falloff: 60,
  /** Cell size of the distance grid (m). */
  cell: 10,
  /** Blade signs per building: odds multiplier away from the route and on it. */
  blades: { far: 0.6, on: 1.6 },
  /** Posters and flyers (alley stations, side wall pieces, street-front paper). */
  paper: { far: 0.6, on: 1.6 },
  /** Event banners: the cap on banners across the route, and the gap along it, scale with the on-route value. */
  banners: { far: 1, on: 1.6 },
  /** Lit window density (the style's range is multiplied). */
  windows: { far: 0.78, on: 1.3 },
  /** Extra chance (added to the window probability, at full nearness) for the two lowest shaft floors above the podium, fading with height; shader side, facadeMaterial.ts. */
  lowFloorLit: 0.3,
  /** Podium neon signs: brightness multiplier. */
  signGain: { far: 0.82, on: 1.18 },
  /** Marquee bulbs: odds multiplier on a sign's bulb chance, and the downtown factor a route podium is credited so it qualifies outside downtown. */
  bulbs: { far: 0.35, on: 2.2 },
  downtownCredit: 0.25,
} as const;

/** A knob of the gradient: the multiplier off the route and on it. */
export interface DragKnob {
  readonly far: number;
  readonly on: number;
}

export interface RouteNearness {
  /** 0 far from the route .. 1 on it, easing over DRAG.falloff beyond DRAG.core. */
  at(x: number, z: number): number;
  /** The multiplier for a kind of dressing at (x, z): the knob's far..on value by nearness, pulled toward 1 as the home's `drag` strength drops, and divided by the city mean so the total holds. */
  scale(knob: DragKnob, x: number, z: number): number;
  /** The knob's multiplier at (x, z) before the city mean is divided out, for a population that is not the buildings (the downtown signs, say) and normalises itself. */
  raw(knob: DragKnob, x: number, z: number): number;
  /** The knob's multiplier right on the route as written (nearness 1, strength applied, not normalised): for things that only exist on the route, like banners. */
  onRoute(knob: DragKnob): number;
  /** The mean nearness over the world's buildings (the share of the city that counts as the drag). */
  mean: number;
  /** The home's gradient strength (cityIdentity.ts), 1 = the knobs as written. */
  strength: number;
}

const cache = new WeakMap<World, RouteNearness>();

/** The world's route nearness, built once. */
export function routeNearness(world: World): RouteNearness {
  let n = cache.get(world);
  if (!n) cache.set(world, (n = build(world)));
  return n;
}

function build(world: World): RouteNearness {
  const strength = cityIdentity(world.seed).drag;
  const reach = DRAG.core + DRAG.falloff;
  const C = DRAG.cell;
  const pts = world.route.points;
  const dist = new Map<number, number>();
  // Cell (i, j) holds the distance from its centre to the polyline, for cells within reach only.
  const key = (i: number, j: number) => i * 65536 + (j + 32768);
  for (let k = 0; k + 1 < pts.length; k++) {
    const a = pts[k];
    const b = pts[k + 1];
    const abx = b.x - a.x;
    const abz = b.z - a.z;
    const len2 = abx * abx + abz * abz;
    const i0 = Math.floor((Math.min(a.x, b.x) - reach) / C);
    const i1 = Math.floor((Math.max(a.x, b.x) + reach) / C);
    const j0 = Math.floor((Math.min(a.z, b.z) - reach) / C);
    const j1 = Math.floor((Math.max(a.z, b.z) + reach) / C);
    for (let i = i0; i <= i1; i++) {
      for (let j = j0; j <= j1; j++) {
        const cx = (i + 0.5) * C;
        const cz = (j + 0.5) * C;
        const t = len2 > 0 ? clamp(((cx - a.x) * abx + (cz - a.z) * abz) / len2, 0, 1) : 0;
        const d = Math.hypot(cx - (a.x + abx * t), cz - (a.z + abz * t));
        if (d >= reach) continue;
        const id = key(i, j);
        const old = dist.get(id);
        if (old === undefined || d < old) dist.set(id, d);
      }
    }
  }
  const value = (i: number, j: number): number => {
    const d = dist.get(key(i, j));
    return d === undefined ? 0 : 1 - smoothstep(DRAG.core, reach, d);
  };
  const at = (x: number, z: number): number => {
    const fx = x / C - 0.5;
    const fz = z / C - 0.5;
    const i = Math.floor(fx);
    const j = Math.floor(fz);
    const u = fx - i;
    const v = fz - j;
    return lerp(lerp(value(i, j), value(i + 1, j), u), lerp(value(i, j + 1), value(i + 1, j + 1), u), v);
  };
  const mult = (knob: DragKnob, n: number): number => Math.max(0, 1 + strength * (lerp(knob.far, knob.on, n) - 1));
  const bs = world.blocks.buildings;
  let mean = 0;
  for (const b of bs) mean += at(b.x, b.z);
  mean = bs.length ? mean / bs.length : 0;
  // The multiplier is linear in nearness, so the city mean is the multiplier at the mean nearness.
  const norm = new Map<DragKnob, number>();
  const holdTotal = (knob: DragKnob): number => {
    let k = norm.get(knob);
    if (k === undefined) norm.set(knob, (k = 1 / Math.max(0.05, mult(knob, mean))));
    return k;
  };
  return {
    at,
    scale: (knob, x, z) => mult(knob, at(x, z)) * holdTotal(knob),
    raw: (knob, x, z) => mult(knob, at(x, z)),
    onRoute: (knob) => mult(knob, 1),
    mean,
    strength,
  };
}
