/**
 * Festoon string lights over the main drag: strands of small warm bulbs swagged between the route street's
 * lamp posts (zigzagging across the street from one side's pole to the next on the other, and across the mouths
 * of the side streets at its junctions), the way a night strip is lit for an event. They are the one thing the drag gets that no side
 * street has (routeNearness.ts covers the rest as odds), so the course reads as the place to be from a block
 * away. Planned from the world alone (`planStringLights`: the streetlights within the drag's core, in route
 * order, each paired with the next, a seeded share of the pairs strung, more in a home that shouts, fewer in
 * one that leans; a Philadelphia home also strings the odd side street, a few strands across it between the
 * poles on opposite sides: cityIdentity.ts `festoon`), then drawn as one merged additive mesh of soft glow bulbs
 * (three crossed quads each, so one draw call and no sorting), Medium and up. A strand hangs on its two poles
 * a little under the lamp heads so it never touches a pole top, sags like a catenary and ends at its poles.
 *
 * The streaks of the wet street take one emitter per strand (`stringEmitters`, the 'string' class the market
 * lantern strings use), so the strands reflect without a streak per bulb. Everything is decided at build from
 * `deriveSeed(world.seed, 'stringLights')`, so the menu city and the race of one seed agree; no per-frame work,
 * nothing reaches the sim.
 */
import * as THREE from 'three';
import type { World } from '../../city/world';
import { CITY } from '../../city/config';
import type { Streetlight } from '../../city/blocks';
import { Rng, deriveSeed } from '../../sim/prng';
import { GeoBuilder } from '../geoBuilder';
import { heightFogShader } from '../heightFog';
import { regionAt } from '../buildings/architecture';
import { signatureAt } from '../cityIdentity';
import { NEON_COLORS, makeRadialGlow } from '../textures/textures';
import { neonMood } from '../textures/cityMood';
import type { LightEmitter } from './lightFx';
import { STREETLIGHT_POLE_H } from './propGeometry';
import { routeNearness } from './routeNearness';

/** The strands: which poles pair up, how they hang and how bright the bulbs burn. */
export const STRINGS = {
  /** Nearness a pole needs (routeNearness.ts) to carry a strand: the drag's own street and the mouths of the side streets it crosses. */
  minNear: 0.9,
  /** Distance between two tie points a strand may span (m). */
  span: [16, 52] as [number, number],
  /** Share of eligible pole pairs that get a strand, times the home's drag strength (capped at 0.85). */
  share: 0.45,
  /** Most strands per city (a long route on a loud home is trimmed to the cap, shuffled). */
  maxStrands: 90,
  /** Where the strand ties on the pole: metres below the lamp head, and out toward the road. */
  below: 1.5,
  reach: 0.6,
  /** Sag at the middle (m): a floor plus a share of the span. */
  sagBase: 0.5,
  sagSpan: 0.03,
  /** Bulb pitch along a strand (m) and the glow quad's size (m). */
  pitch: 1.3,
  size: 0.55,
  /** Bulb colour gain (the additive glow's strength) and the share of strands in a neon accent rather than warm white. */
  gain: 1.5,
  accentShare: 0.35,
  warm: 0xffc66e,
} as const;

/** One strand: its two tie points (world, m), the sag at its middle (m) and its bulb colour. */
export interface Strand {
  a: THREE.Vector3;
  b: THREE.Vector3;
  sag: number;
  color: THREE.Color;
}

const plans = new WeakMap<World, Strand[]>();

/** The world's strands, planned once. Empty when no streetlight stands on the route's edges. */
export function planStringLights(world: World): Strand[] {
  let plan = plans.get(world);
  if (!plan) plans.set(world, (plan = plan_(world)));
  return plan;
}

function plan_(world: World): Strand[] {
  const near = routeNearness(world);
  const rng = new Rng(deriveSeed(world.seed, 'stringLights'));
  const mood = neonMood(world.seed);
  const accents = NEON_COLORS.map((c) => new THREE.Color(c));
  const share = Math.min(0.85, STRINGS.share * near.strength);
  // The poles of the drag in route order: a light is about one per side every 34 m, so consecutive ones zigzag
  // across the street (and across a side street's mouth where the route passes it).
  const poles = world.blocks.streetlights
    .filter((l) => near.at(l.x, l.z) >= STRINGS.minNear)
    .map((l) => ({ l, s: world.routeProgress(l.x, l.z).s }))
    .sort((a, b) => a.s - b.s || a.l.x - b.l.x || a.l.z - b.l.z);
  const tie = (p: { x: number; z: number; dx: number; dz: number }) => {
    const x = p.x + p.dx * STRINGS.reach;
    const z = p.z + p.dz * STRINGS.reach;
    return new THREE.Vector3(x, world.heightAt(p.x, p.z) + CITY.curbHeight + STREETLIGHT_POLE_H - STRINGS.below, z);
  };
  const out: Strand[] = [];
  for (let k = 0; k + 1 < poles.length; k++) {
    const a = tie(poles[k].l);
    const b = tie(poles[k + 1].l);
    const gap = a.distanceTo(b);
    // The draws happen for every pair, strung or not, so one pair's fate never shifts another's colour.
    const strung = rng.chance(share);
    const accent = rng.chance(STRINGS.accentShare);
    const hue = mood.neon(rng.next());
    if (!strung || gap < STRINGS.span[0] || gap > STRINGS.span[1]) continue;
    out.push({ a, b, sag: STRINGS.sagBase + STRINGS.sagSpan * gap, color: accent ? accents[hue].clone() : new THREE.Color(STRINGS.warm) });
  }
  festoonSideStreets(world, near, out);
  if (out.length > STRINGS.maxStrands) {
    rng.shuffle(out);
    out.length = STRINGS.maxStrands;
  }
  return out;
}

/**
 * A Philadelphia home's side streets: a seeded share of the edges off the drag (and inside a Philadelphia
 * region) get up to `perStreet` strands, each between two consecutive poles that stand on opposite sides, so
 * the strand crosses the street. Its own stream, so a seed of another home plans exactly what it did.
 */
function festoonSideStreets(world: World, near: ReturnType<typeof routeNearness>, out: Strand[]): void {
  const region = regionAt(world);
  const byEdge = new Map<number, Streetlight[]>();
  for (const l of world.blocks.streetlights) {
    if (near.at(l.x, l.z) >= STRINGS.minNear) continue;
    const list = byEdge.get(l.edge);
    if (list) list.push(l);
    else byEdge.set(l.edge, [l]);
  }
  const rng = new Rng(deriveSeed(world.seed, 'festoon'));
  const accents = NEON_COLORS.map((c) => new THREE.Color(c));
  const mood = neonMood(world.seed);
  for (const ei of [...byEdge.keys()].sort((a, b) => a - b)) {
    const lights = byEdge.get(ei)!;
    const sig = signatureAt(world.seed, region(lights[0].x, lights[0].z)).festoon;
    // The draws are taken for every edge, so one street's fate never shifts another's.
    const strung = rng.chance(sig?.streets ?? 0);
    const accent = rng.chance(STRINGS.accentShare);
    const hue = mood.neon(rng.next());
    if (!sig || !strung || lights.length < 2) continue;
    const e = world.graph.edges[ei];
    const A = world.graph.nodes[e.a];
    const B = world.graph.nodes[e.b];
    const len = Math.hypot(B.x - A.x, B.z - A.z) || 1;
    const along = (l: Streetlight) => ((l.x - A.x) * (B.x - A.x) + (l.z - A.z) * (B.z - A.z)) / len;
    lights.sort((p, q) => along(p) - along(q));
    const tie = (p: Streetlight) => new THREE.Vector3(p.x + p.dx * STRINGS.reach, world.heightAt(p.x, p.z) + CITY.curbHeight + STREETLIGHT_POLE_H - STRINGS.below, p.z + p.dz * STRINGS.reach);
    let made = 0;
    for (let k = 0; k + 1 < lights.length && made < sig.perStreet; k++) {
      const p = lights[k];
      const q = lights[k + 1];
      if (p.dx * q.dx + p.dz * q.dz > -0.5) continue;
      const a = tie(p);
      const b = tie(q);
      const gap = a.distanceTo(b);
      if (gap < STRINGS.span[0] || gap > STRINGS.span[1]) continue;
      out.push({ a, b, sag: STRINGS.sagBase + STRINGS.sagSpan * gap, color: accent ? accents[hue].clone() : new THREE.Color(STRINGS.warm) });
      made++;
      k++;
    }
  }
}

/** The point on a strand at fraction t (0 at a, 1 at b): a parabola for the catenary, sagging at the middle. */
function onStrand(s: Strand, t: number, out: THREE.Vector3): THREE.Vector3 {
  out.lerpVectors(s.a, s.b, t);
  out.y -= s.sag * 4 * t * (1 - t);
  return out;
}

export interface StringLights {
  mesh: THREE.Mesh | null;
  /** Counts for the perf report and tests. */
  counts: { strands: number; bulbs: number };
  dispose(): void;
}

/** The merged additive mesh of every strand's bulbs: one draw call, 6 triangles a bulb; nothing on Low. */
export function buildStringLights(world: World, detail: 'low' | 'medium' | 'high'): StringLights {
  const strands = detail === 'low' ? [] : planStringLights(world);
  const counts = { strands: strands.length, bulbs: 0 };
  if (!strands.length) return { mesh: null, counts, dispose() {} };
  const gb = new GeoBuilder(true);
  const p = new THREE.Vector3();
  const r = STRINGS.size / 2;
  const col = new THREE.Color();
  for (const s of strands) {
    const n = Math.max(2, Math.round(s.a.distanceTo(s.b) / STRINGS.pitch));
    // Every other bulb a touch dimmer, so a strand reads as bulbs and not as a line.
    for (let k = 0; k <= n; k++) {
      onStrand(s, k / n, p);
      col.copy(s.color).multiplyScalar(STRINGS.gain * (k % 2 ? 0.75 : 1));
      // Two upright quads crossed at the strand's own heading and one flat quad: a glow from any side.
      const ex = s.b.x - s.a.x;
      const ez = s.b.z - s.a.z;
      const el = Math.hypot(ex, ez) || 1;
      const ux = (ex / el) * r;
      const uz = (ez / el) * r;
      const quad = (ox: number, oy: number, oz: number, px: number, py: number, pz: number) => {
        const a = gb.vertex(p.x - ox - px, p.y - oy - py, p.z - oz - pz, 0, 1, 0, 0, 0, col);
        const b = gb.vertex(p.x + ox - px, p.y + oy - py, p.z + oz - pz, 0, 1, 0, 1, 0, col);
        const c = gb.vertex(p.x + ox + px, p.y + oy + py, p.z + oz + pz, 0, 1, 0, 1, 1, col);
        const d = gb.vertex(p.x - ox + px, p.y - oy + py, p.z - oz + pz, 0, 1, 0, 0, 1, col);
        gb.quad(a, b, c, d);
      };
      quad(ux, 0, uz, 0, r, 0);
      quad(-uz, 0, ux, 0, r, 0);
      quad(ux, 0, uz, -uz, 0, ux);
      counts.bulbs++;
    }
  }
  const geo = gb.build();
  const map = makeRadialGlow();
  const mat = new THREE.MeshBasicMaterial({ map, vertexColors: true, transparent: true, blending: THREE.AdditiveBlending, depthWrite: false, side: THREE.DoubleSide });
  mat.onBeforeCompile = (shader) => {
    heightFogShader(shader, true);
  };
  mat.customProgramCacheKey = () => 'stringLights';
  const mesh = new THREE.Mesh(geo, mat);
  mesh.name = 'stringLights';
  return {
    mesh,
    counts,
    dispose() {
      geo.dispose();
      mat.dispose();
      map.dispose();
    },
  };
}

/** One streak emitter per strand, at its middle (the wet street reflects the strand as a whole). Empty on Low, like the mesh. */
export function stringEmitters(world: World, detail: 'low' | 'medium' | 'high'): LightEmitter[] {
  if (detail === 'low') return [];
  return planStringLights(world).map((s) => ({ pos: onStrand(s, 0.5, new THREE.Vector3()), color: s.color, cls: 'string' as const }));
}
