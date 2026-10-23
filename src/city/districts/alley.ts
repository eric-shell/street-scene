/**
 * Alleys, two variants (two modules, one file):
 *
 * 'alley': a narrow raceway street. A chain of 2-3 straight grid street
 * edges away from the center becomes kind 'alley' (CITY.width.alley, thin
 * sidewalks). Routes may use it like any street; the racing line and AI
 * follow the narrower route.segWidth automatically.
 *
 * 'backAlley': a skinny shortcut through a block. Two opposite sides of a
 * four sided block are split at their middles (new T junction nodes) and
 * joined by a 'backAlley' edge flagged `shortcut: true`. Routes never drive
 * shortcut edges. One that joins two points of a route and saves distance
 * (shortcutSpan) stays open as that route's shortcut and race progress
 * credits the stretch it skips (race.ts); any other is closed off at the
 * route's junctions like a side street (buildRoute).
 *
 * Route shortcuts (carveRouteShortcuts): the random back alleys above only
 * meet a route by luck, so once both routes are picked every circuit and
 * sprint gets its own: a 'backAlley' area (variant 'routeShortcut') whose
 * path joins two points of the route and skips a real stretch of it. Corner
 * cuts run across the inside block of a sharp turn; U cuts cross a block the
 * route wraps on three sides. Both are wider than a plain back alley, kept
 * clear of other streets and of the corner rails, and built like any back
 * alley (clutter, often a kicker). A route shortcut is never a straight shot:
 * where the block has room its path is a dogleg or a gentle arc (one or two
 * free bend nodes, gi -1 and degree 2, every edge of the chain 'backAlley'
 * flagged shortcut), bent away from the corner it cuts. The chain is walked
 * by shortcutChain; route.ts lists it as one RouteShortcut (entry first) and
 * race progress credits the whole chain.
 *
 * Jump exits (about half the cuts, cfg.route.jump): the last leg meets the
 * exit street at a shallow angle and climbs a parabolic ramp to a lip just
 * inside the alley's walls; a construction fence stands across the lip and
 * the car flies over the mouth onto the route's street, landing on it heading
 * down it. The drop under the lip is a wall facing the street (look
 * 'alleyLip', Wall.top: street cars cannot drive into the exit, the launching
 * car passes over). The landing zone is planned like the car park's: a run-up
 * speed bound gives the furthest landing (alleyFlightReach), the street past
 * the mouth must be free of junctions for the flight plus a roll-out, corner
 * rails crossing the flight are cut (shortcutJumpRails) and reserved circles
 * keep street furniture off it; soft clutter lies below the lip and around
 * the landing side. The entry end stays a normal flared mouth.
 *
 * Every alley is cobbled curb to curb between its mouths (surface 'cobble':
 * a little less grip and more rolling drag than asphalt, see
 * drivingParams.json; the junction fans stay asphalt). Raceway alleys are
 * lined, block after block, with restaurant fronts (cafe tables between
 * planter pots), storage clutter (crates, barrels, pallets, trash bags) and
 * street works (hoarding panels along the wall, sandbags, a water barrier,
 * sawhorses and cones spilling off the curb); back alleys with dumpsters,
 * trash bags and crates against the walls, and most get a kicker hump (a
 * terrain height modifier, exact gradient) that throws a fast car into the
 * air in either direction. All of it is destructible except the hump; a
 * dumpster only goes flying when hit hard. Nothing that can stop a car ever
 * stands in the line down the middle: a car's width plus a margin (LANE).
 *
 * Content to add (render/districts/alley.ts): fire escapes, steam
 * vents, puddles and grime on back alleys.
 *
 * This file holds the two district modules; alleyPath.ts the path and chain
 * helpers, alleyDressing.ts the mouths, clutter, humps and jump exits, and
 * alleyShortcuts.ts the route shortcut planner.
 */
import { CITY } from '../config';
import { addEdge, chainPoint, chainSnap, gridChain, isBendNode, splitChainAt } from '../roadGraph';
import { faceSides } from '../blocks';
import { Rng } from '../../sim/prng';
import type { PropKind } from '../props';
import { type DistrictModule, emptyBuild } from './types';
import { sideSpot, pathCum, corridor, gridIndex, BEND_CLEAR, unit } from './alleyPath';
import { mouthReach, mouthPatches, cobblePatch, bendPatch, constructionSite, addJumpExit, funnelClutter, FUNNEL_MIX, addJump } from './alleyDressing';
import { segmentAt } from './geom';

export const alleyModule: DistrictModule = {
  kind: 'alley',
  phase: 'graph',
  plan(ctx) {
    const cfg = CITY.districts.alley;
    if (!cfg.enabled) return;
    const g = ctx.graph;
    const rng = ctx.rng;
    const count = rng.int(cfg.count[0], cfg.count[1]);
    const at = gridIndex(g);
    const cx = (g.bounds.minX + g.bounds.maxX) / 2;
    const cz = (g.bounds.minZ + g.bounds.maxZ) / 2;
    const chains: { nodes: number[]; edges: number[] }[] = [];
    for (const n of g.nodes) {
      if (n.gi < 0) continue;
      for (const [di, dj] of [
        [1, 0],
        [0, 1],
      ]) {
        const L = rng.int(cfg.chain[0], cfg.chain[1]);
        const nodes = [n.id];
        const edges: number[] = [];
        let ok = true;
        for (let k = 1; k <= L && ok; k++) {
          const next = at.get((n.gj + dj * k) * 1000 + n.gi + di * k);
          if (next === undefined) {
            ok = false;
            break;
          }
          // Grid neighbours are joined by a chain of pieces through bend nodes (roadGraph.ts): the
          // alley takes the whole street, pieces and bends.
          const chain = gridChain(g, nodes[nodes.length - 1], next);
          if (!chain || chain.edges.some((e) => g.edges[e].kind !== 'street' || g.edges[e].bridge || ctx.claims.edge.has(e))) {
            ok = false;
            break;
          }
          nodes.push(...chain.nodes.slice(1));
          edges.push(...chain.edges);
        }
        if (!ok) continue;
        if (nodes.some((id) => ctx.claims.node.has(id) || g.nodes[id].ring)) continue;
        const mid = g.nodes[nodes[nodes.length >> 1]];
        if (Math.hypot(mid.x - cx, mid.z - cz) < 280) continue;
        chains.push({ nodes, edges });
      }
    }
    rng.shuffle(chains);
    const used = new Set<number>();
    let made = 0;
    for (const c of chains) {
      if (made >= count) break;
      if (c.nodes.some((id) => used.has(id))) continue;
      let length = 0;
      for (const e of c.edges) length += g.edges[e].length;
      const footprint = length * (CITY.width.alley + 2 * CITY.sidewalkWidth.alley);
      if (ctx.budget.used + footprint > ctx.budget.total) break;
      for (const e of c.edges) {
        const edge = g.edges[e];
        edge.kind = 'alley';
        edge.width = CITY.width.alley;
        edge.sidewalk = CITY.sidewalkWidth.alley;
        edge.lanes = CITY.lanes.alley;
      }
      c.nodes.forEach((id) => used.add(id));
      const path = c.nodes.map((id) => ({ x: g.nodes[id].x, z: g.nodes[id].z }));
      ctx.addArea(
        { kind: 'alley', variant: 'raceway', polygon: corridor(path, CITY.width.alley / 2 + CITY.sidewalkWidth.alley), path, nodes: c.nodes.slice(1, -1), edges: c.edges, faces: [], params: { length, seed: rng.int(1, 0x7ffffffe) } },
        footprint,
      );
      made++;
    }
    if (made) ctx.graphChanged();
  },
  build(ctx, area) {
    const b = emptyBuild();
    const cfg = CITY.districts.alley;
    const g = ctx.graph;
    const rng = new Rng(((area.params.seed ?? 0) >>> 0) || 1);
    const push = (kind: PropKind, p: { x: number; z: number; yaw: number }, jitter = 0.2, lift: number = CITY.curbHeight, yaw?: number) =>
      b.destructibles.push({ kind, x: p.x, z: p.z, yaw: (yaw ?? p.yaw) + rng.range(-jitter, jitter), lift, area: area.id });
    for (const eid of area.edges) {
      const e = g.edges[eid];
      const A = g.nodes[e.a];
      const B = g.nodes[e.b];
      const len = Math.hypot(B.x - A.x, B.z - A.z);
      const walk = e.sidewalk;
      const half = e.width / 2;
      const mid = half + walk / 2;
      const ux = (B.x - A.x) / len;
      const uz = (B.z - A.z) / len;
      // Hoarding panels lie along the alley (local +X), their banners facing the road.
      const along = Math.atan2(-uz, ux);
      b.surfaces.push(cobblePatch(ctx, eid, area.id));
      for (const side of [1, -1]) {
        // Clear of the crossing streets at both ends (their road, sidewalk and a corner rail's line);
        // a bend node between two of the alley's pieces is no crossing (roadGraph.ts).
        const from = isBendNode(g, e.a) ? 0 : Math.max(cfg.endClear, mouthReach(g, e.a, area.edges, ux, uz, half + walk, side));
        const to = len - (isBendNode(g, e.b) ? 0 : Math.max(cfg.endClear, mouthReach(g, e.b, area.edges, -ux, -uz, half + walk, -side)));
        let s = from + rng.range(0, 2);
        while (s < to - 3) {
          const block = rng.range(7, 13);
          const end = Math.min(to, s + block);
          const r = rng.next();
          if (r < 0.4) {
            // Restaurant front: pots at both ends, tables between.
            push('planterPot', sideSpot(A, B, s + 0.6, side * mid));
            for (let t = s + 2.2; t < end - 1.6; t += cfg.tableSpacing) if (rng.chance(0.9)) push('cafeTable', sideSpot(A, B, t, side * mid), 0.5);
            push('planterPot', sideSpot(A, B, end - 0.6, side * mid));
          } else if (r < 0.72) {
            // Deliveries and trash out back of the kitchens.
            for (let t = s + 0.8; t < end - 0.6; t += rng.range(1.1, 1.8)) {
              const k = rng.next();
              const kind: PropKind = k < 0.3 ? 'crate' : k < 0.5 ? 'barrel' : k < 0.72 ? 'trashBags' : k < 0.86 ? 'pallets' : 'newsBox';
              push(kind, sideSpot(A, B, t, side * (mid + rng.range(-0.2, 0.2))), 3);
            }
          } else {
            // Street works: hoarding along the wall (clear of the road), heavy pieces on the sidewalk and
            // soft ones spilling off the curb onto the cobbles, where they break at a touch.
            for (let t = s + 1.3; t < end - 1.2; t += 2.4) push('fencePanel', sideSpot(A, B, t, side * (half + walk - 0.45)), 0.08, CITY.curbHeight, along);
            push(rng.chance(0.5) ? 'sandbags' : 'waterBarrier', sideSpot(A, B, s + rng.range(1, 3), side * mid), 0.1, CITY.curbHeight, along);
            push('sawhorse', sideSpot(A, B, s + rng.range(3, block - 2), side * (half - 0.5)), 0.2, 0, along + Math.PI / 2);
            for (let k = 0; k < 3; k++) push('trafficCone', sideSpot(A, B, s + rng.range(0.5, block - 0.5), side * (half - rng.range(0.3, 1.1))), 3, 0);
            if (rng.chance(0.5)) push('pallets', sideSpot(A, B, end - 1, side * mid), 3);
          }
          s = end + rng.range(1, 3);
        }
      }
    }
    return b;
  },
};

export const backAlleyModule: DistrictModule = {
  kind: 'backAlley',
  phase: 'graph',
  plan(ctx) {
    const cfg = CITY.districts.backAlley;
    if (!cfg.enabled) return;
    const g = ctx.graph;
    const rng = ctx.rng;
    const count = rng.int(cfg.count[0], cfg.count[1]);
    // Four sided blocks: a side is one street, its pieces through bend nodes (blocks.ts faceSides).
    const sidesOf = new Map<number, ReturnType<typeof faceSides>>();
    const faces = ctx.faces().filter((f) => {
      if (f.outer || f.area < 9000 || f.area > 26000) return false;
      const sides = faceSides(g, f);
      if (sides.length !== 4) return false;
      sidesOf.set(f.id, sides);
      if (f.corners.some((c) => g.nodes[c.node].ring)) return false;
      return f.edges.every((e) => {
        const k = g.edges[e].kind;
        return (k === 'street' || k === 'avenue' || k === 'boulevard') && !g.edges[e].bridge && !ctx.claims.edge.has(e);
      });
    });
    rng.shuffle(faces);
    const touched = new Set<number>();
    let made = 0;
    for (const f of faces) {
      if (made >= count) break;
      if (f.edges.some((e) => touched.has(e))) continue;
      const sides = sidesOf.get(f.id)!;
      const pairs = [
        [sides[0], sides[2]],
        [sides[1], sides[3]],
      ].filter(([a, b]) => a.length >= cfg.minSide && b.length >= cfg.minSide);
      if (!pairs.length) continue;
      const [sa, sb] = pairs[rng.int(0, pairs.length - 1)];
      // Mouths near the middle of each side, a mouth within BEND_CLEAR of a bend node taking the bend node.
      const sA = chainSnap(g, sa, (0.5 + rng.range(-0.1, 0.1)) * sa.length, BEND_CLEAR);
      const sB = chainSnap(g, sb, (0.5 + rng.range(-0.1, 0.1)) * sb.length, BEND_CLEAR);
      const A = chainPoint(g, sa, sA);
      const B = chainPoint(g, sb, sB);
      const length = Math.hypot(B.x - A.x, B.z - A.z);
      if (length < 50) continue;
      const footprint = length * (CITY.width.backAlley + 2 * CITY.sidewalkWidth.backAlley);
      if (ctx.budget.used + footprint > ctx.budget.total) break;
      const edgesBefore = g.edges.length;
      const na = splitChainAt(g, sa, sA, BEND_CLEAR);
      const nb = splitChainAt(g, sb, sB, BEND_CLEAR);
      const id = addEdge(g, na, nb, 'backAlley');
      g.edges[id].shortcut = true;
      f.edges.forEach((e) => touched.add(e));
      for (let e = edgesBefore; e < id; e++) touched.add(e);
      // The mouths as placed (a split snapped onto a bend node lands on the bend node).
      const path = [
        { x: g.nodes[na].x, z: g.nodes[na].z },
        { x: g.nodes[nb].x, z: g.nodes[nb].z },
      ];
      // A kicker hump in the middle or two thirds of the way along, clear of both (flared) mouths.
      const half = cfg.jumpRamp + cfg.jumpTop / 2;
      const end = half + 15 + cfg.mouth.alley;
      const jump = rng.chance(cfg.jumpChance) && length > 2 * end ? 1 : 0;
      const jumpS = Math.max(end, Math.min(length - end, length * rng.pick([0.5, 0.35, 0.65])));
      ctx.addArea(
        { kind: 'backAlley', variant: 'shortcut', polygon: corridor(path, CITY.width.backAlley / 2 + CITY.sidewalkWidth.backAlley), path, nodes: [na, nb], edges: [id], faces: [], params: { length, jump, jumpS, seed: rng.int(1, 0x7ffffffe) } },
        footprint,
      );
      made++;
    }
    if (made) ctx.graphChanged();
  },
  build(ctx, area) {
    const b = emptyBuild();
    const cfg = CITY.districts.backAlley;
    const P = area.params;
    const path = area.path;
    const cum = pathCum(path);
    const hw = (P.width ?? CITY.width.backAlley) / 2 + CITY.sidewalkWidth.backAlley;
    // The kicker sits on one leg (jumpS is a position along the whole chain).
    if (P.jump) {
      const i = segmentAt(cum, P.jumpS);
      const u = unit(path[i], path[i + 1]);
      addJump(b, path[i], u.x, u.z, hw, P.jumpS - cum[i]);
    }
    for (const eid of area.edges) b.surfaces.push(cobblePatch(ctx, eid, area.id));
    for (const nid of area.nodes) b.surfaces.push(...mouthPatches(ctx, nid, area.id));
    // A bend between two legs: the wedge outside both legs' strips is cobbled too.
    for (let i = 1; i + 1 < area.nodes.length; i++) b.surfaces.push(bendPatch(ctx, area.nodes[i], area.id));
    const rng = new Rng(((P.seed ?? 0) >>> 0) || 1);
    if (area.variant === 'routeShortcut') {
      const jumpClear = (s: number, r: number) => !P.jump || Math.abs(s - P.jumpS) > cfg.jumpRamp + cfg.jumpTop / 2 + 2 + r;
      if (P.jumpExit) addJumpExit(ctx, area, b, path, hw, rng);
      constructionSite(ctx, area, b, rng, path, cum, hw, jumpClear);
      return b;
    }
    // Plain back alleys are one straight edge.
    const [A, B] = path;
    const len = cum[1] || 1;
    const ux = (B.x - A.x) / len;
    const uz = (B.z - A.z) / len;
    const g = ctx.graph;
    // A shortcut's corners flare (blocks.ts computeSectors): its mouths reach further in.
    const flare = cfg.mouth.alley;
    const lo = [1, -1].map((sd) => mouthReach(g, area.nodes[0], area.edges, ux, uz, hw, sd) + flare);
    // Seen from B the alley runs backwards, so its left is our right.
    const hi = [1, -1].map((sd) => len - mouthReach(g, area.nodes[1], area.edges, -ux, -uz, hw, -sd) - flare);
    const sLo = Math.min(lo[0], lo[1]);
    const sHi = Math.max(hi[0], hi[1]);
    // Dumpsters against the walls, alternating sides, with bags and crates around them.
    const clear = (s: number, lateral = 0) => {
      const k = lateral < 0 ? 1 : 0;
      const a = lateral === 0 ? Math.max(lo[0], lo[1]) : lo[k];
      const z = lateral === 0 ? Math.min(hi[0], hi[1]) : hi[k];
      return s >= a && s <= z && (!P.jump || Math.abs(s - P.jumpS) > cfg.jumpRamp + cfg.jumpTop / 2 + 4);
    };
    const push = (kind: PropKind, s: number, lateral: number, jitter: number, yaw?: number) => {
      if (!clear(s, lateral)) return;
      const p = sideSpot(A, B, s, lateral);
      b.destructibles.push({ kind, x: p.x, z: p.z, yaw: (yaw ?? p.yaw) + rng.range(-jitter, jitter), lift: 0, area: area.id });
    };
    funnelClutter(ctx, area, b, () => rng.pick(FUNNEL_MIX), rng);
    let side = rng.chance(0.5) ? 1 : -1;
    let dumpsters = 0;
    for (let s = sLo + rng.range(0, 6); s < sHi; s += cfg.dumpsterSpacing * rng.range(0.7, 1.3)) {
      if (clear(s, side)) dumpsters++;
      push('dumpster', s, side * (hw - 0.62), 0.05);
      push('trashBags', s + rng.pick([-1.9, 1.9]), side * (hw - 0.55), 3);
      if (rng.chance(0.7)) push(rng.chance(0.5) ? 'crate' : 'barrel', s + rng.range(3.2, 4.5), side * (hw - 0.6), 3);
      if (rng.chance(0.5)) push('trashBags', s + rng.range(5, 8), -side * (hw - 0.55), 3);
      // The other wall: pallets, a crate, the odd sawhorse and some cones left behind by the works.
      const other = rng.next();
      if (other < 0.4) push('pallets', s + rng.range(1, 6), -side * (hw - 0.75), 3);
      else if (other < 0.65) push('crate', s + rng.range(1, 6), -side * (hw - 0.75), 3);
      else if (other < 0.8) push('sawhorse', s + rng.range(2, 6), -side * (hw - 0.95), 0.3);
      if (rng.chance(0.35)) for (let k = 0; k < 2; k++) push('trafficCone', s + rng.range(-2, 7), -side * (hw - rng.range(0.5, 1.4)), 3);
      side = -side;
    }
    // Short alleys whose kicker took every slot still get one, clear of the ramps.
    if (!dumpsters) {
      found: for (const sd of [side, -side]) {
        for (const t of [lo[sd < 0 ? 1 : 0] + 1.5, hi[sd < 0 ? 1 : 0] - 1.5]) {
          if (clear(t, sd) && clear(t + 1.5, sd) && clear(t - 1.5, sd)) {
            push('dumpster', t, sd * (hw - 0.62), 0.05);
            break found;
          }
        }
      }
    }
    return b;
  },
};
