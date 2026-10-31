/**
 * Tram tracks down the boulevards (and, on a New York or Philadelphia home, now and then an avenue): two pairs of
 * rails flush in the road along the centre lanes, one pair per direction, with the look of the cable car's track
 * (render/districts/cableCar.ts): a band of granite setts the car's width, a dark groove at each rail and a steel
 * head a few centimetres proud. They cross junctions straight through (a node with exactly two track edges, the
 * street carrying on) and stop at the mouth where a boulevard ends or a street's track does not go on.
 *
 * Two parts. `planTram` is the layout: which rows and columns get a track (seeded, from the plan and the home),
 * and each run's four rails and two bands as polylines; streetDecals.ts lays the bands and grooves into its decal
 * mesh (the setts cell) and keeps the rails' pieces for the session's rail tick. `buildTramRails` is the steel: one
 * merged mesh for the whole city, draped on the terrain so the rails climb a hill and follow the crown with the road.
 * Everything is paint and a thin rail on the sim's untouched road surface (a head this low is nothing to a tyre),
 * so replays stay identical. The lane arrows and worn paint of the lanes the tram owns are not drawn.
 */
import * as THREE from 'three';
import type { World } from '../../city/world';
import { chainOf, isChannelEdge, isFeatureEdge } from '../../city/roadGraph';
import type { Region } from '../../city/regions';
import type { Vec2 } from '../../sim/math';
import { Rng, deriveSeed } from '../../sim/prng';
import { GeoBuilder } from '../geoBuilder';
import { cityIdentity } from '../cityIdentity';

/** The track's tables. Lengths in m, angles in rad. */
export const TRAM = {
  /** Share of a seed's boulevard rows that carry a track (at least one does), and of an avenue column on `avenueHomes`. */
  boulevardChance: 0.75,
  avenueChance: 0.25,
  avenueHomes: ['nyc', 'philly'] as readonly Region[],
  /** Standard gauge between the rail heads' centres, and the width of one head. */
  gauge: 1.435,
  railWidth: 0.06,
  /** Rail head top over the terrain (m); the road surface sits ROAD_Y (2 cm) over it. */
  railTop: 0.055,
  /** The setts band is the gauge plus this margin; the dark groove round each head is this wide. */
  bandMargin: 0.9,
  groove: 0.13,
  /** An edge shorter than this gets no track; two track edges turning more than this at a node end their runs there. */
  minLength: 24,
  maxTurn: 0.5,
  /** Drape step along a rail (m), and the setts band's piece length (the cell is square, so the stones keep their shape). */
  step: 4,
  bandPiece: 2.3,
} as const;

export interface TramPlan {
  /** The four rails of every run, as polylines (x, z) in travel order. */
  rails: Vec2[][];
  /** The two setts bands (the lane centres) of every run. */
  bands: Vec2[][];
  /** Edges that carry a track: their inner lanes take no arrows nor worn paint. */
  edges: ReadonlySet<number>;
  /** Nodes a track runs through or stops at: no junction hatching there. */
  nodes: ReadonlySet<number>;
}

const EMPTY: TramPlan = { rails: [], bands: [], edges: new Set(), nodes: new Set() };

/** The seed's tram layout (see the header). Pure of the sim: reads the world and its own seeded stream. */
export function planTram(world: World): TramPlan {
  const g = world.graph;
  const plan = g.plan;
  const rng = new Rng(deriveSeed(world.seed, 'tram'));
  // Draws are taken in a fixed order whatever the odds, so one table change never reshuffles the rest.
  const rows = plan.boulevardRows.filter(() => rng.chance(TRAM.boulevardChance));
  if (!rows.length && plan.boulevardRows.length) rows.push(plan.boulevardRows[rng.int(0, plan.boulevardRows.length - 1)]);
  const avenues = plan.avenueCols.filter(() => rng.chance(TRAM.avenueChance));
  const cols = TRAM.avenueHomes.includes(cityIdentity(world.seed).home) ? avenues : [];
  if (!rows.length && !cols.length) return EMPTY;

  const tram = new Set<number>();
  g.edges.forEach((e, ei) => {
    if (e.lanes !== 4 || e.length < TRAM.minLength || isChannelEdge(e) || isFeatureEdge(e) || !world.roadProfile.hasCrown(ei)) return;
    if (e.kind !== 'boulevard' && e.kind !== 'avenue') return;
    const c = chainOf(g, ei);
    const ends = [g.nodes[c.nodes[0]], g.nodes[c.nodes[c.nodes.length - 1]]];
    if (e.kind === 'boulevard') {
      const row = ends.find((n) => n.gj >= 0)?.gj;
      if (row !== undefined && rows.includes(row)) tram.add(ei);
    } else {
      const col = ends.find((n) => n.gi >= 0)?.gi;
      if (col !== undefined && cols.includes(col)) tram.add(ei);
    }
  });
  if (!tram.size) return EMPTY;

  const mouths = world.blocks.mouths;
  /** An edge walked from `from`: its two mouth centres, start and end, and the unit heading. */
  const pass = (ei: number, fromA: boolean) => {
    const m = mouths[ei];
    const a = { x: (m.aP.curb.x + m.aN.curb.x) / 2, z: (m.aP.curb.z + m.aN.curb.z) / 2 };
    const b = { x: (m.bP.curb.x + m.bN.curb.x) / 2, z: (m.bP.curb.z + m.bN.curb.z) / 2 };
    const s = fromA ? a : b;
    const t = fromA ? b : a;
    const l = Math.hypot(t.x - s.x, t.z - s.z) || 1;
    return { s, t, ux: (t.x - s.x) / l, uz: (t.z - s.z) / l };
  };
  /** The tram edge a track goes on along at `node` after arriving by `ei` (heading ux, uz), if the street carries on. */
  const onward = (node: number, ei: number, ux: number, uz: number): number | undefined => {
    const here = g.nodes[node];
    if (here.ring) return undefined;
    const others = here.edges.filter((o) => tram.has(o));
    if (others.length !== 2 || !others.includes(ei)) return undefined;
    const next = others[0] === ei ? others[1] : others[0];
    const fromA = g.edges[next].a === node;
    const p = pass(next, fromA);
    return Math.acos(Math.min(1, Math.max(-1, ux * p.ux + uz * p.uz))) <= TRAM.maxTurn ? next : undefined;
  };

  const rails: Vec2[][] = [];
  const bands: Vec2[][] = [];
  const nodes = new Set<number>();
  const used = new Set<number>();
  const walk = (start: number, fromA: boolean): { ei: number; fromA: boolean }[] => {
    const run: { ei: number; fromA: boolean }[] = [];
    let ei = start;
    let fa = fromA;
    for (let guard = 0; guard < g.edges.length; guard++) {
      run.push({ ei, fromA: fa });
      used.add(ei);
      const p = pass(ei, fa);
      const node: number = fa ? g.edges[ei].b : g.edges[ei].a;
      const next = onward(node, ei, p.ux, p.uz);
      if (next === undefined || used.has(next)) break;
      ei = next;
      fa = g.edges[next].a === node;
    }
    return run;
  };
  for (const first of tram) {
    if (used.has(first)) continue;
    // Back to the start of the run first (a node that is not a pass-through), then forward along it.
    let ei = first;
    let fa = true;
    for (let guard = 0; guard < g.edges.length; guard++) {
      const node: number = fa ? g.edges[ei].a : g.edges[ei].b;
      const p = pass(ei, !fa);
      const prev = onward(node, ei, p.ux, p.uz);
      if (prev === undefined || prev === first) break;
      fa = g.edges[prev].a !== node;
      ei = prev;
    }
    const run = walk(ei, fa);
    const lines: Vec2[][] = [[], [], [], []];
    const lanes: Vec2[][] = [[], []];
    for (const { ei: id, fromA } of run) {
      const p = pass(id, fromA);
      const nx = -p.uz;
      const nz = p.ux;
      // The centre of each direction's inner lane: a quarter of the width out from the centreline.
      const L = g.edges[id].width / 4;
      const lats = [-L - TRAM.gauge / 2, -L + TRAM.gauge / 2, L - TRAM.gauge / 2, L + TRAM.gauge / 2];
      nodes.add(g.edges[id].a);
      nodes.add(g.edges[id].b);
      lats.forEach((lat, k) => lines[k].push({ x: p.s.x + nx * lat, z: p.s.z + nz * lat }, { x: p.t.x + nx * lat, z: p.t.z + nz * lat }));
      [-L, L].forEach((lat, k) => lanes[k].push({ x: p.s.x + nx * lat, z: p.s.z + nz * lat }, { x: p.t.x + nx * lat, z: p.t.z + nz * lat }));
    }
    rails.push(...lines);
    bands.push(...lanes);
  }
  return { rails, bands, edges: tram, nodes };
}

/** A polyline cut into pieces no longer than `step`. */
export function resample(path: readonly Vec2[], step: number): Vec2[] {
  const out: Vec2[] = [];
  for (let i = 0; i + 1 < path.length; i++) {
    const a = path[i];
    const b = path[i + 1];
    const n = Math.max(1, Math.ceil(Math.hypot(b.x - a.x, b.z - a.z) / step));
    if (i === 0) out.push(a);
    for (let k = 1; k <= n; k++) out.push({ x: a.x + ((b.x - a.x) * k) / n, z: a.z + ((b.z - a.z) * k) / n });
  }
  return out;
}

const STEEL = new THREE.Color(0xb4bbc4);

/**
 * The steel: every rail of the plan as a head (top and two sides) draped on the terrain, in one mesh. Null without a
 * track. The head stands `railTop` over the terrain; the road surface is 2 cm of that.
 */
export function buildTramRails(world: World, plan: TramPlan): THREE.Mesh | null {
  if (!plan.rails.length) return null;
  const gb = new GeoBuilder(true);
  const h = world.heightAt;
  const w = TRAM.railWidth / 2;
  for (const rail of plan.rails) {
    const pts = resample(rail, TRAM.step);
    for (let i = 0; i + 1 < pts.length; i++) {
      const a = pts[i];
      const b = pts[i + 1];
      const l = Math.hypot(b.x - a.x, b.z - a.z) || 1;
      const nx = -(b.z - a.z) / l;
      const nz = (b.x - a.x) / l;
      const at = (p: Vec2, o: number, top: boolean): [number, number, number] => {
        const x = p.x + nx * o;
        const z = p.z + nz * o;
        return [x, h(x, z) + (top ? TRAM.railTop : 0.02), z];
      };
      const face = (p: [number, number, number][], n: [number, number, number]) => {
        const v = p.map(([x, y, z]) => gb.vertex(x, y, z, n[0], n[1], n[2], 0, 0, STEEL));
        gb.quadFacing(v[0], v[1], v[2], v[3], n[0], n[1], n[2]);
      };
      face([at(a, -w, true), at(b, -w, true), at(b, w, true), at(a, w, true)], [0, 1, 0]);
      face([at(a, w, false), at(b, w, false), at(b, w, true), at(a, w, true)], [nx, 0, nz]);
      face([at(a, -w, false), at(b, -w, false), at(b, -w, true), at(a, -w, true)], [-nx, 0, -nz]);
    }
  }
  const mesh = new THREE.Mesh(
    gb.build(),
    new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.38, metalness: 0.75, envMapIntensity: 1.6, polygonOffset: true, polygonOffsetFactor: -5, polygonOffsetUnits: -10 }),
  );
  mesh.name = 'tramRails';
  return mesh;
}
