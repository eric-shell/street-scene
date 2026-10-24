/**
 * River: an LA River style concrete flood channel running east-west across
 * the whole map between two street rows, and a race venue end to end: its
 * floor is one chain of 'channel' edges in the road graph from one tunnel
 * portal to the other, routes dive in anywhere along it and run its length,
 * under every bridge.
 *
 * Centerline: the midline between the two bank rows, sampled column by
 * column from the grid nodes (so it follows a warped grid) and smoothed, plus
 * a slow meander whose amplitude swells and fades along the length; stored
 * as samples in the area params (riverCenter / riverSlope interpolate them),
 * the swing scaled down until every junction clears the band. Nothing here
 * assumes rows are straight or that one edge joins two grid nodes: a
 * crossing street is any edge whose segment crosses the centerline, followed
 * through degree-2 bend nodes into a deck polyline.
 *
 * Cross section (l = z - centerline): flat floor |l| <= floorHalf at -depth,
 * smooth sloped concrete banks up to |l| = top, a fence on top facing the
 * channel. Crossing streets are bridges (edge.bridge) except the fords, which
 * dip through. A bridge is two drivable levels: the terrain under the deck
 * stays at street level (the deck, what the road mesh drapes on and what
 * every height query without a car height returns) and the channel profile
 * runs on beneath it as a DeckSpan the world's height queries return for a
 * car body nearer the floor than the deck. The deck's parapets carry a
 * `bottom` (channel cars pass under them); the piers on the channel floor
 * edges and the abutment boxes on the banks are solids with a `top` (deck
 * cars pass over them), set by settleRiver once the terrain exists.
 *
 * Entrances (6-8 per seed, at least one in every quarter of the length, the
 * outer quarters served first, banks alternating): a ford is two ramps
 * meeting at a foot node on the centerline, a side ramp a trench cut from a
 * bank street (a T node split into it) down to its own foot. Every ramp is an
 * edge of kind 'ramp' between its street node and its foot, every foot a node
 * of the channel chain. Ramp trenches have 'trench' retaining walls and a
 * solid plinth either side; the profile has a rounded lip at the top (a crest
 * you launch over) and a hard kink at the floor edge. A ford dips the whole
 * road, its plinths on the sidewalks. Every trench opens into a bell at its
 * foot (the plinth corners chamfered for a car swinging in off the floor) and
 * a side ramp's into a bell mouth over the last stretch of its run as well
 * (rampHalf), as wide as the room to the next street on each side allows, so
 * the plinths meet the street with angled faces instead of square caps. Every ramp top
 * gets the shortcut treatment: fences and clutter funnelling into the mouth
 * (a side ramp's on the sidewalk, the bank street's lanes left clear, its
 * street furniture kept out) and string lights across it, never a sign.
 *
 * The floor is drivable concrete; a wet 'water' trickle (offroad grip) runs
 * to one side of the racing line; barrels, crates, pallets and bags litter the
 * floor edges with clusters out on the floor; a few set pieces per seed (a
 * hump, a water bar, a tabletop jump, a ledge, a split median:
 * riverFeatures.ts) break up the run; the channel ends in tunnel walls
 * ('channelEnd') well outside the city. The renderer
 * (render/districts/river.ts) draws all of it.
 *
 * The parts live in river/: centerline (the channel's centerline samples), ramps (the entrance ramps), bridges
 * (the street crossings and their decks) and plan (the planner). This module is the district itself (its
 * build, the funnel at a ramp top, the terrain settling) and the public surface the rest of the city imports.
 */
import { CITY } from '../config';
import type { RoadGraph } from '../roadGraph';
import { Vec2, distToSegment, segmentT, sqrt } from '../../sim/math';
import { Rng } from '../../sim/prng';
import type { Wall } from '../blocks';
import type { Terrain } from '../terrain';
import type { PropKind } from '../props';
import type { Area, AreaBuild, DistrictModule, HeightSample } from './types';
import { emptyBuild } from './types';
import { polyWalls, smooth01, type Smooth, solidWalls } from './geom';
import { type FeatureSample, featureHeight, featureSpan, featuresOf, medianBarrierXs } from './riverFeatures';
import { riverCenter, riverL, riverSlope } from './river/centerline';
import { type Ramp, footAlongs, mouthAlongs, rampAlong, rampHalf, rampOuter, rampPoint, rampProfile, rampsOf } from './river/ramps';
import { bridgePoint, bridgesOf, deckBox, deckLine, distToBridge, pierOffsets } from './river/bridges';
import { planRiver } from './river/plan';

export { channelWidth, riverCenter, riverFrame, riverL, riverSlope } from './river/centerline';
export { type Ramp, footAlongs, mouthAlongs, rampAlong, rampHalf, rampOuter, rampPoint, rampProfile, rampsOf } from './river/ramps';
export { type Bridge, bridgePoint, bridgesOf, distToBridge, pierOffsets, pierReach } from './river/bridges';

/** Scratch for the terrain's smoothsteps (queried per wheel per substep, so nothing allocates). */
const SMOOTH: Smooth = { v: 0, d: 0 };

const CFG = CITY.districts.river;
/** The parapets, deck openings and span footprints reach this far beyond the band's top edge (m). */
const DECK_END = 2.5;

// ---------------------------------------------------------------------------
// The module

export const riverModule: DistrictModule = {
  kind: 'river',
  phase: 'graph',
  plan: planRiver,

  build(ctx, area) {
    const b = emptyBuild();
    const p = area.params;
    const id = area.id;
    const F = p.floor;
    const T = p.top;
    const D = p.depth;
    const body = CFG.bridgeBody;
    const fenceL = T + 0.5;
    const bridges = bridgesOf(ctx.graph, area);
    const ramps = rampsOf(area);
    const features = featuresOf(p);
    const spans = features.map((f) => featureSpan(f, F));
    const feat: FeatureSample = { h: 0, hx: 0, hl: 0 };
    const zc = (x: number) => riverCenter(p, x);
    const at = (x: number, l: number): Vec2 => ({ x, z: zc(x) + l });
    const band = (xa: number, xb: number, la: number, lb: number, step = 16): Vec2[] => {
      const top: Vec2[] = [];
      const bot: Vec2[] = [];
      const n = Math.max(1, Math.ceil((xb - xa) / step));
      for (let i = 0; i <= n; i++) {
        const x = xa + ((xb - xa) * i) / n;
        top.push(at(x, lb));
        bot.push(at(x, la));
      }
      return bot.concat(top.reverse());
    };
    /** Ramp frame: distance along its axis from the foot and lateral offset (left of the axis). */
    const frame = (r: Ramp, x: number, z: number) => ({ along: (x - r.ax) * r.ux + (z - r.az) * r.uz, lat: -(x - r.ax) * r.uz + (z - r.az) * r.ux });

    /**
     * The channel profile at (x, z): height below ground and gradient, ramp trenches included (the
     * lower of the two wins); `flat` also flattens it under the bridge decks (the terrain: the deck).
     */
    const profile = (x: number, z: number, out: HeightSample, flat: boolean): void => {
      const s = riverSlope(p, x);
      const l = z - zc(x);
      const sg = l >= 0 ? 1 : -1;
      const al = l * sg;
      let h = 0;
      let gl = 0;
      let gx0 = 0;
      if (al < T) {
        const st = smooth01(F, T, al, SMOOTH);
        h = -D * (1 - st.v);
        gl = D * st.d * sg;
      }
      for (const r of ramps) {
        if (r.side !== sg || al <= F || al >= r.topL) continue;
        const fr = frame(r, x, z);
        if (Math.abs(fr.lat) > rampHalf(r, fr.along, fr.lat >= 0 ? 1 : -1)) continue;
        const u = (r.topL - al) / (r.topL - F);
        const pr = rampProfile(u);
        const hr = -D * pr.f;
        if (hr < h) {
          h = hr;
          gl = ((D * pr.df) / (r.topL - F)) * sg;
        }
      }
      // The set pieces on the floor (riverFeatures.ts): partials in x and l, l's gradient being (-slope, 1).
      for (let i = 0; i < features.length; i++) {
        if (Math.abs(x - features[i].x) >= spans[i]) continue;
        featureHeight(features[i], F, x, l, feat);
        h += feat.h;
        gl += feat.hl;
        // feat.hx is at fixed l: the x gradient below adds -gl * s for l's own drift.
        gx0 += feat.hx;
      }
      if (h === 0) return;
      let gx = gx0 - gl * s;
      let gz = gl;
      if (flat) {
        for (const br of bridges) {
          if (Math.abs(x - br.cx) > 90) continue;
          const lim = br.dk + body;
          const d = distToBridge(br, x, z);
          if (d >= lim) continue;
          // Flat across the deck and half a meter past its parapets (the wheels of a car against one).
          const m = smooth01(br.dk + 0.5, lim, d, SMOOTH);
          // Gradient of the distance to the nearest deck segment.
          let ddx = 0;
          let ddz = 0;
          let best = Infinity;
          for (let i = 0; i + 1 < br.pts.length; i++) {
            const a = br.pts[i];
            const c = br.pts[i + 1];
            const t = segmentT(x, z, a.x, a.z, c.x, c.z);
            const qx = a.x + (c.x - a.x) * t;
            const qz = a.z + (c.z - a.z) * t;
            const dd = sqrt((x - qx) ** 2 + (z - qz) ** 2);
            if (dd < best) {
              best = dd;
              ddx = dd > 1e-6 ? (x - qx) / dd : 0;
              ddz = dd > 1e-6 ? (z - qz) / dd : 0;
            }
          }
          gx = gx * m.v + h * m.d * ddx;
          gz = gz * m.v + h * m.d * ddz;
          h *= m.v;
        }
      }
      out.h += h;
      out.gx += gx;
      out.gz += gz;
    };
    let lMax = T + 1;
    for (const r of ramps) lMax = Math.max(lMax, r.topL + 1);
    let zMin = Infinity;
    let zMax = -Infinity;
    for (let x = p.x0; x <= p.x1 + 1e-6; x += 8) {
      zMin = Math.min(zMin, zc(x));
      zMax = Math.max(zMax, zc(x));
    }
    b.heightMods.push({
      minX: p.x0 - 2,
      maxX: p.x1 + 2,
      minZ: zMin - lMax,
      maxZ: zMax + lMax,
      add(x, z, out: HeightSample) {
        profile(x, z, out, true);
      },
    });
    // Two levels under every deck: the lower is the unflattened profile.
    const scratch: HeightSample = { h: 0, gx: 0, gz: 0 };
    for (const br of bridges) {
      b.decks.push({
        polygon: deckBox(p, br, br.dk + body + 0.3, -(T + DECK_END + 0.5), T + DECK_END + 0.5),
        area: id,
        depth: D,
        lower(x, z, out) {
          scratch.h = 0;
          scratch.gx = 0;
          scratch.gz = 0;
          profile(x, z, scratch, false);
          out.h += scratch.h;
          out.gx += scratch.gx;
          out.gz += scratch.gz;
          scratch.h = 0;
          scratch.gx = 0;
          scratch.gz = 0;
          profile(x, z, scratch, true);
          out.h -= scratch.h;
          out.gx -= scratch.gx;
          out.gz -= scratch.gz;
          // The terrain is the deck less what the flattening left of the profile (nothing on the deck proper).
          return -scratch.h;
        },
      });
    }

    // No buildings or infill near the channel.
    const clear = T + CFG.clearance;
    for (let x = p.x0; x < p.x1; x += 24) b.exclusions.push(band(x, Math.min(p.x1, x + 24), -clear, clear, 24));
    b.surfaces.push({ surface: 'concrete', polygon: area.polygon, priority: 1, area: id });
    // The trickle outranks the road classification of the channel edges, so it stays slippery; it runs
    // on under the decks (World.surfaceAt keeps the river's patches off the deck level).
    for (let x = p.x0; x < p.x1 - 2; x += 48) b.surfaces.push({ surface: 'water', polygon: band(x, Math.min(p.x1, x + 48), CFG.waterOffset - CFG.waterHalf, CFG.waterOffset + CFG.waterHalf), priority: 6, area: id });

    // Bridges: parapets along the deck edges (channel cars pass under them), the deck's frontage opened
    // over the band so the city draws no wall there, an abutment box on each bank and pier rows along
    // the floor edges under the deck (deck cars pass over them, their tops set by settleRiver).
    const gapsBySide: Record<number, [number, number][]> = { 1: [], [-1]: [] };
    for (const br of bridges) {
      const W = br.dk + body;
      for (const s of [-1, 1]) {
        const line = deckLine(p, br, s * br.dk, -(T + DECK_END), T + DECK_END);
        b.walls.push(...polyWalls(line, s > 0, 'parapet', id, false));
        const box = deckBox(p, br, W, s * (F + CFG.abutment), s * (T + 1.5));
        b.walls.push(...solidWalls(box, 'culvert', id));
        const lo = s * (T + 0.5);
        const xa = bridgePoint(p, br, -W - 0.3, lo).x;
        const xb = bridgePoint(p, br, W + 0.3, lo).x;
        gapsBySide[s].push([Math.min(xa, xb) - 0.3, Math.max(xa, xb) + 0.3]);
        // Piers at the floor edge, square to the deck, from one parapet to the other.
        const lp = s * (F - CFG.pierInset);
        for (const w of pierOffsets(br)) {
          const c = bridgePoint(p, br, w, lp);
          const h = CFG.pier / 2;
          const square = [
            { x: c.x - br.dx * h - br.nx * h, z: c.z - br.dz * h - br.nz * h },
            { x: c.x + br.dx * h - br.nx * h, z: c.z + br.dz * h - br.nz * h },
            { x: c.x + br.dx * h + br.nx * h, z: c.z + br.dz * h + br.nz * h },
            { x: c.x - br.dx * h + br.nx * h, z: c.z - br.dz * h + br.nz * h },
          ];
          b.walls.push(...solidWalls(square, 'pier', id));
        }
      }
      b.openings.push(deckBox(p, br, br.dk + 1.2, -(T + DECK_END - 0.3), T + DECK_END - 0.3));
      const corners = deckBox(p, br, W, -(T + DECK_END), T + DECK_END);
      b.hints.push({ kind: 'bridge', points: corners, values: [br.edge, br.dk] });
    }

    // Ramps: trench walls, a solid plinth either side (outer face, foot and top caps), a drivable
    // concrete surface, buildings kept out, the street frontage opened at a side ramp's mouth, and
    // the funnel at the top.
    const rng = new Rng(p.seed >>> 0 || 1);
    for (const r of ramps) {
      const s = r.side;
      const aF = rampAlong(p, r, F);
      const aTop = rampAlong(p, r, r.topL);
      const aFence = rampAlong(p, r, fenceL);
      const aCurb = r.ford ? aTop : rampAlong(p, r, r.curbL);
      const P = (along: number, lat: number) => rampPoint(r, along, lat);
      const wall = (a: Vec2, c: Vec2, nx: number, nz: number) => b.walls.push({ ax: a.x, az: a.z, bx: c.x, bz: c.z, nx, nz, kind: 'wall', look: 'trench', area: id });
      // Left of the axis is (-uz, ux).
      const lx = -r.uz;
      const lz = r.ux;
      for (const sd of [1, -1]) {
        // At the floor edge the trench is at its foot bell's full width.
        const inner = sd * rampHalf(r, 0, sd);
        const outer = sd * rampOuter(r, 0, sd);
        // Each face starts where its own line reaches the floor edge (a skewed axis puts them at
        // different distances along it), so no wall pokes into the channel edge's corridor.
        const fIn = rampAlong(p, r, F, inner);
        const fOut = rampAlong(p, r, F, outer);
        // Inner trench face, normal into the trench: in along the foot bell, straight up the run,
        // then out along the bell mouth (rampHalf). Plinth outer face, normal away from it: straight,
        // pushed out with either bell where it would leave less than mouthBody of plinth (rampOuter).
        const inFace = [P(fIn, inner)];
        const outFace = [P(fOut, outer)];
        for (const a of [...footAlongs(r), ...mouthAlongs(r, aTop)]) {
          if (a > fIn + 0.5) inFace.push(P(a, sd * rampHalf(r, a, sd)));
          if (a > fOut + 0.5) outFace.push(P(a, sd * rampOuter(r, a, sd)));
        }
        // Each piece's normal is its perpendicular on the side `toward` points to.
        const face = (pts: Vec2[], tx: number, tz: number) => {
          for (let k = 0; k + 1 < pts.length; k++) {
            const q0 = pts[k];
            const q1 = pts[k + 1];
            const len = sqrt((q1.x - q0.x) ** 2 + (q1.z - q0.z) ** 2) || 1;
            const nx = (q1.z - q0.z) / len;
            const nz = -(q1.x - q0.x) / len;
            const k1 = nx * tx + nz * tz >= 0 ? 1 : -1;
            wall(q0, q1, k1 * nx, k1 * nz);
          }
        };
        face(inFace, -sd * lx, -sd * lz);
        face(outFace, sd * lx, sd * lz);
        // Plinth caps: at the floor edge facing the floor, at the top facing the street.
        wall(P(fIn, inner), P(fOut, outer), -r.ux, -r.uz);
        wall(P(aTop, sd * rampHalf(r, aTop, sd)), P(aTop, sd * rampOuter(r, aTop, sd)), r.ux, r.uz);
      }
      const gx = r.ax + r.ux * aFence;
      gapsBySide[s].push([gx - (r.hw + r.body) - 0.3, gx + (r.hw + r.body) + 0.3]);
      // Up the left edge (both bells included) to the curb and back down the right.
      const edgeAt = [aF - 0.5, ...footAlongs(r), ...mouthAlongs(r, aTop), aCurb];
      const trench = [...edgeAt.map((a) => P(a, rampHalf(r, a, 1))), ...edgeAt.reverse().map((a) => P(a, -rampHalf(r, a, -1)))];
      b.surfaces.push({ surface: 'concrete', polygon: trench, priority: 2, area: id });
      const m = CITY.districts.infill.gap;
      const oL = rampOuter(r, aTop, 1);
      const oR = rampOuter(r, aTop, -1);
      b.exclusions.push([P(aF - 2, -oR - m), P(aF - 2, oL + m), P(aTop + 2, oL + m), P(aTop + 2, -oR - m)]);
      if (!r.ford) {
        // The bank street's frontage line crosses the trench mouth and the plinth tops: no wall there.
        b.openings.push([P(aTop - 2, -oR - 0.1), P(aTop - 2, oL + 0.1), P(aTop + 1.5, oL + 0.1), P(aTop + 1.5, -oR - 0.1)]);
        // The sidewalk across the mouth and its funnel belongs to the funnel: no streetlight, hydrant
        // or bench in the way of a car turning in.
        const mid = (aTop + aCurb) / 2;
        const rad = (aCurb - aTop) / 2 + 0.5;
        const lo = -Math.min(oR + CFG.funnelFlare + 2, r.roomR - 1);
        const hi = Math.min(oL + CFG.funnelFlare + 2, r.roomL - 1);
        for (let lat = lo; lat <= hi + 1e-6; lat += rad) {
          const q = P(mid, lat);
          b.reserved.push({ x: q.x, z: q.z, r: rad });
        }
      }
      b.hints.push({ kind: 'ramp', points: [P(0, 0), P(aTop, 0)], values: [s, r.hw, r.body, aF, aTop, r.ford, aFence, aCurb] });
      funnel(ctx.graph, b, rng, r, aTop, aCurb, id);
    }

    // Bank top fences between bridges and ramps, normals toward the channel.
    for (const s of [-1, 1]) {
      const gaps = gapsBySide[s].sort((u, v) => u[0] - v[0]);
      let x = p.x0;
      const pieces: [number, number][] = [];
      for (const [g0, g1] of gaps) {
        if (g0 > x) pieces.push([x, g0]);
        x = Math.max(x, g1);
      }
      if (x < p.x1) pieces.push([x, p.x1]);
      for (const [u0, u1] of pieces) {
        const pts: Vec2[] = [];
        const n = Math.max(1, Math.ceil((u1 - u0) / 8));
        for (let i = 0; i <= n; i++) pts.push(at(u0 + ((u1 - u0) * i) / n, s * fenceL));
        // Travelling +x: the channel is on the right for the north (+l) fence.
        b.walls.push(...polyWalls(pts, s > 0, 'fence', id, false));
        b.hints.push({ kind: 'fence', points: pts, values: [s] });
      }
    }
    // Tunnel walls at both ends of the channel.
    b.walls.push({ ax: p.x0, az: zc(p.x0) - fenceL, bx: p.x0, bz: zc(p.x0) + fenceL, nx: 1, nz: 0, kind: 'wall', look: 'channelEnd', area: id });
    b.walls.push({ ax: p.x1, az: zc(p.x1) - fenceL, bx: p.x1, bz: zc(p.x1) + fenceL, nx: -1, nz: 0, kind: 'wall', look: 'channelEnd', area: id });

    // Clutter along the floor edges, clear of feet (closures and meets stand there), decks and the features.
    const busy = (x: number, half = 0) => ramps.some((r) => Math.abs(x - r.ax) < r.hw + r.body + 14 + half) || bridges.some((br) => Math.abs(x - br.cx) < br.dk + body + 8 + half) || features.some((f, i) => Math.abs(x - f.x) < spans[i] + 6 + half);
    const push = (kind: PropKind, x: number, l: number) => b.destructibles.push({ kind, x, z: zc(x) + l, yaw: rng.range(0, Math.PI * 2), lift: 0, area: id });
    const kinds: PropKind[] = ['barrel', 'barrel', 'crate', 'trashBags', 'trashBags', 'pallets', 'sandbags', 'barrel', 'crate'];
    for (let x = p.x0 + 40; x < p.x1 - 40; x += CFG.clutterSpacing * rng.range(0.6, 1.4)) {
      if (busy(x)) continue;
      const s = rng.chance(0.5) ? 1 : -1;
      const n = rng.int(1, 4);
      for (let i = 0; i < n; i++) {
        // Right at the floor edge: an obstacle for a car hugging the bank, like back alley clutter.
        push(kinds[rng.int(0, kinds.length - 1)], x + rng.range(-3, 3), s * (F - 0.75 - rng.range(0, 0.9)));
      }
    }
    // Clusters out on the floor, on the side away from the trickle: a stack of pallets or a water
    // barrier with barrels and crates around it, something to thread or smash through at speed.
    const floorSide = -Math.sign(CFG.waterOffset) || 1;
    const floorKinds: PropKind[] = ['barrel', 'crate', 'pallets', 'barrel', 'sandbags'];
    for (let x = p.x0 + 70 + rng.range(0, 30); x < p.x1 - 70; x += CFG.floorClutterSpacing * rng.range(0.7, 1.3)) {
      if (busy(x, 4)) continue;
      const l = floorSide * rng.range(3, F - 4);
      push(rng.chance(0.5) ? 'waterBarrier' : 'pallets', x, l);
      const n = rng.int(1, 3);
      for (let i = 0; i < n; i++) {
        const a = rng.range(0, Math.PI * 2);
        const d = rng.range(1.6, 2.6);
        push(floorKinds[rng.int(0, floorKinds.length - 1)], x + Math.cos(a) * d, l + Math.sin(a) * d);
      }
    }
    // A median's barriers along its ridge: water barriers and sandbags in turn, lying along the channel.
    for (const f of features) {
      if (f.kind !== 'median') continue;
      let k = 0;
      for (const x of medianBarrierXs(f)) {
        const yaw = Math.atan2(-riverSlope(p, x), 1);
        b.destructibles.push({ kind: k++ % 2 ? 'sandbags' : 'waterBarrier', x, z: zc(x), yaw, lift: 0, area: id });
      }
    }
    return b;
  },
};

/**
 * The funnel at a ramp top, in the shortcut language (see districts/alleyDressing.ts
 * constructionSite): two lines of fence panels splaying from the plinths out
 * toward the street, a sawhorse and a water barrier at each line's street
 * end, cones scattered along, and two strings of lights across the mouth and
 * across the street edge in front of it. Everything breaks before it can
 * stop a car. A ford's lines narrow its own road into the dip (cones where
 * they stand on the road); a side ramp's stay on the sidewalk, from the
 * plinths' tips out to the curb, so the bank street's lanes stay clear and a
 * car turning in has the whole flare leading into the bell mouth.
 */
function funnel(g: RoadGraph, b: AreaBuild, rng: Rng, r: Ramp, aTop: number, aCurb: number, area: number): void {
  // Side ramps: the bank street's pieces at the T. It runs along the river, not always square to the
  // ramp's axis, so a point is pulled back toward the mouth until it stands behind the curb.
  const street: { a: Vec2; b: Vec2; half: number }[] = [];
  if (!r.ford)
    for (const eid of g.nodes[r.node].edges) {
      const e = g.edges[eid];
      if (eid !== r.edge) street.push({ a: g.nodes[e.a], b: g.nodes[e.b], half: e.width / 2 + 0.6 });
    }
  const offStreet = (q: Vec2): Vec2 => {
    for (let k = 0; k < 40 && street.some((s) => distToSegment(q.x, q.z, s.a.x, s.a.z, s.b.x, s.b.z) < s.half); k++) q = { x: q.x - r.ux * 0.25, z: q.z - r.uz * 0.25 };
    return q;
  };
  const P = (along: number, lat: number): Vec2 => offStreet(rampPoint(r, along, lat));
  const push = (kind: PropKind, q: Vec2, yaw: number, lift = 0) => b.destructibles.push({ kind, x: q.x, z: q.z, yaw, lift, area });
  // A ford's plinths cover the street's sidewalks and the outer road edge: the road ends inside them.
  const roadHalf = r.ford ? r.hw + r.body - CITY.sidewalk : g.edges[r.edge].width / 2;
  // Fords: the street's own road continues into the dip; the funnel narrows it from the sidewalk corners
  // to the trench. Side ramps, per side: from the plinth's tip out to the curb, short of the next corridor.
  const latInOf = (sd: number) => (r.ford ? r.hw + 0.3 : rampOuter(r, aTop, sd));
  const latOutOf = (sd: number) => (r.ford ? r.hw + r.body - 0.6 : Math.max(latInOf(sd), Math.min(latInOf(sd) + CFG.funnelFlare, (sd > 0 ? r.roomL : r.roomR) - 2.5)));
  const aStart = r.ford ? aTop + 1.5 : aTop + 1.2;
  const aEnd = r.ford ? aTop + 1.5 + CFG.funnelReach + 3 : aCurb - 0.6;
  const onRoad = (along: number, lat: number) => (r.ford ? Math.abs(lat) < roadHalf - 0.2 : along > aCurb - 0.3);
  for (const sd of [1, -1]) {
    const latIn = latInOf(sd);
    const latOut = latOutOf(sd);
    const A = P(aStart, sd * latIn);
    const B = P(aEnd, sd * latOut);
    const len = sqrt((B.x - A.x) ** 2 + (B.z - A.z) ** 2);
    const ux = (B.x - A.x) / len;
    const uz = (B.z - A.z) / len;
    const yaw = Math.atan2(-uz, ux);
    const n = Math.max(2, Math.round(len / 2.1));
    for (let k = 0; k <= n; k++) {
      const t = k / n;
      const q = { x: A.x + (B.x - A.x) * t, z: A.z + (B.z - A.z) * t };
      const along = aStart + (aEnd - aStart) * t;
      const lat = latIn + (latOut - latIn) * t;
      push(onRoad(along, lat) ? 'trafficCone' : 'fencePanel', q, yaw + rng.range(-0.1, 0.1));
    }
    // Cones scattered inside the line (clear of the panels: generateProps drops overlaps; light enough
    // that a car through them barely notices).
    // Square off the line toward the axis (a side ramp's line runs steeply across the short sidewalk).
    const inX = sd * r.uz;
    const inZ = -sd * r.ux;
    const k0 = uz * inX - ux * inZ >= 0 ? 1 : -1;
    for (let k = 0; k < 3; k++) {
      const t = 0.2 + k * 0.28 + rng.range(0, 0.1);
      const off = rng.range(1.6, 2.4);
      const q = offStreet({ x: A.x + (B.x - A.x) * t + k0 * uz * off, z: A.z + (B.z - A.z) * t - k0 * ux * off });
      push('trafficCone', q, rng.range(0, Math.PI * 2));
    }
    if (r.ford) {
      // A sawhorse across the line's street end and a water barrier or sandbags beyond it.
      push('sawhorse', P(aEnd + 2.4, sd * (latOut + 0.4)), yaw + Math.PI / 2 + rng.range(-0.15, 0.15));
      push(rng.chance(0.5) ? 'waterBarrier' : 'sandbags', P(aEnd + 2.2, sd * (latOut + 3.2)), yaw);
    } else {
      // A sawhorse along the curb past the line's end; nothing heavy where a car running wide lands.
      push('sawhorse', P(aEnd - 0.4, sd * (latOut + 2.2)), Math.atan2(-r.ux, -r.uz) + rng.range(-0.15, 0.15));
    }
  }
  // Two rows of fence panels across the way in, both to be broken through: one across the mouth (a
  // side ramp's on the sidewalk between the plinth tips, a ford's across its road past the top) and
  // one down the lip inside the trench, each spanning the trench's width where it stands.
  const rowYaw = Math.atan2(-r.ux, -r.uz);
  for (const along of [r.ford ? aTop + CFG.fordFenceRow : (aTop + aCurb) / 2, aTop - CFG.fenceRowDrop]) {
    const inside = along < aTop;
    const latL = inside ? rampHalf(r, along, 1) - 0.6 : r.ford ? r.hw - 0.4 : rampHalf(r, aTop, 1) - 0.4;
    const latR = inside ? rampHalf(r, along, -1) - 0.6 : r.ford ? r.hw - 0.4 : rampHalf(r, aTop, -1) - 0.4;
    const n = Math.max(2, Math.round((latL + latR) / 2.1));
    for (let k = 0; k <= n; k++) push('fencePanel', rampPoint(r, along, -latR + ((latL + latR) * k) / n), rowYaw + rng.range(-0.08, 0.08));
  }
  // String lights: across the mouth between the plinths' tops, and across the street edge in front.
  const mouthA = r.ford ? aTop + 1.2 : aTop + 1.0;
  const mouthAt = (sd: number) => (r.ford ? r.hw + r.body - 0.4 : latInOf(sd) + 0.6);
  b.hints.push({ kind: 'stringLights', points: [P(mouthA, -mouthAt(-1)), P(mouthA, mouthAt(1))], values: [] });
  const frontA = r.ford ? aTop + 8 : aCurb - 0.6;
  const frontAt = (sd: number) => (r.ford ? r.hw + r.body - 0.4 : latOutOf(sd));
  b.hints.push({ kind: 'stringLights', points: [P(frontA, -frontAt(-1)), P(frontA, frontAt(1))], values: [] });
}

/**
 * Once the terrain exists (createCity, before the blocks read the walls):
 * the level walls under every bridge get their heights from the deck
 * there, deckClear below it: the parapets' `bottom` (so a car on the
 * channel floor passes under them) and the abutments' and piers' `top` (so a
 * car on the deck passes over them). The deck is the terrain over the wall,
 * pulled in onto the deck proper (|w| <= dk, flat across) for the abutment
 * faces beyond its edge, where the terrain is already down the channel's
 * profile; the base terrain rolls along and across a bridge, so each wall
 * takes the deck right above it.
 */
export function settleRiver(g: RoadGraph, areas: readonly Area[], builds: readonly AreaBuild[], terrain: Terrain): void {
  for (const area of areas) {
    if (area.kind !== 'river') continue;
    const p = area.params;
    const bridges = bridgesOf(g, area);
    if (!bridges.length) continue;
    for (const w of builds[area.id].walls) {
      if (!isDeckWall(w)) continue;
      const mx = (w.ax + w.bx) / 2;
      const mz = (w.az + w.bz) / 2;
      let br = bridges[0];
      let best = Infinity;
      for (const c of bridges) {
        const d = distToBridge(c, mx, mz);
        if (d < best) {
          best = d;
          br = c;
        }
      }
      // The deck under the wall, at its lowest along it: a long skewed abutment face (a diagonal over
      // the band) spans a deck that climbs with the ground, and a car on the deck must clear all of it.
      const deckAt = (x: number, z: number) => {
        const l = riverL(p, x, z);
        const c = bridgePoint(p, br, 0, l);
        const wv = Math.max(-br.dk, Math.min(br.dk, (x - c.x) * br.nx + (z - c.z) * br.nz));
        const q = bridgePoint(p, br, wv, l);
        return terrain.heightAt(q.x, q.z);
      };
      let deck = deckAt(mx, mz);
      if (w.look !== 'parapet') {
        const steps = Math.ceil(Math.hypot(w.bx - w.ax, w.bz - w.az) / 4);
        for (let k = 0; k <= steps; k++) deck = Math.min(deck, deckAt(w.ax + ((w.bx - w.ax) * k) / steps, w.az + ((w.bz - w.az) * k) / steps));
      }
      if (w.look === 'parapet') w.bottom = deck - p.depth / 2;
      else w.top = deck - CFG.deckClear;
    }
    // A solid is collided whole at the first face a car does not clear, so its faces share one top:
    // the lowest of them.
    const solidTop = new Map<object, number>();
    for (const w of builds[area.id].walls) if (w.solid && w.top !== undefined) solidTop.set(w.solid, Math.min(solidTop.get(w.solid) ?? Infinity, w.top));
    for (const w of builds[area.id].walls) if (w.solid && w.top !== undefined) w.top = solidTop.get(w.solid)!;
  }
}

/** True for a node of the channel floor (a ramp foot or a point along the chain). */
export function isChannelNode(g: RoadGraph, id: number): boolean {
  return g.nodes[id].edges.some((eid) => g.edges[eid].kind === 'channel');
}

/** A wall of a bridge: the deck's parapets and the abutments and piers beneath it. */
const isDeckWall = (w: Wall): boolean => w.look === 'parapet' || w.look === 'culvert' || w.look === 'pier';
