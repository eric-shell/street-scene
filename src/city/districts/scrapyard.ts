/**
 * Weekend special: the Scrapyard (src/city/weekend.ts, docs/weekend.md).
 *
 * A 9 to 12 cell region with five ways from its entry to its exit: the haul road (the region's spine, which the routes
 * drive), the banked Eight, the Canyon between walls of stacked wrecks with the crusher's press and kicker at its end, the
 * Bale Deck four metres up beside the haul road (the Canyon dives under it), and the Perimeter round the fence; scrap
 * mountains fill everything else. Planned only on the seeds whose weekend pick is `scrapyard`; every other seed's plan returns
 * at once, so no other city changes. Its kind is in CORRIDOR_AREAS (districts/types.ts): a racer anywhere in the region is on
 * the corridor, and race progress follows the spine (weekendRegion.ts regionProgress).
 *
 * Where it goes: scrapyardPlan.ts. What is inside, as one pure function of the area the sim, this build and the renderer all
 * read: scrapyardLayout.ts (with its shapes, scrapyardShapes.ts, and its fill, scrapyardFill.ts). This module turns the
 * layout into the city's parts:
 *  - ground: firm yard gravel (`quay`) over the whole region, the haul road's concrete and the entry and exit aprons, dirt
 *    (`offroad`) only on the bowls' outsides, `slick` patches (oil on the haul road, mud in the Eight, oil in the canyon, the
 *    truck wash) each with a hint the renderer draws;
 *  - heights: the bowls' dished floors and their banks (banking.ts rings and arcs), the crusher's kicker and its pit, the launch onto the deck, the weighbridge;
 *    each fades to 0 at its box with an exact gradient;
 *  - the Bale Deck: an `upper` DeckSpan over the ground (the base terrain plus its ramps' profile; nothing of the yard's
 *    heights lies under it), its parapets solid bales with Wall.top (a car flying in passes over) and, over the deck,
 *    Wall.bottom (a car in the canyon beneath passes under), the stacks under it with Wall.under (a car on it passes over);
 *  - walls: the fence (solid both sides) open at the spine's mouths and the perimeter's two, steel posts at every gap's ends,
 *    the stacks and heaps (carStack), the machines, vehicles, posts and towers (crusher);
 *  - the press across the canyon is a timed gate (scrapyardGates.ts, appended to World.timedGates by createWorld);
 *  - clutter: tyre stacks, drums, crates, pallets, spools, sawhorses and bags on every alt line and the haul road's shoulders.
 * The heights the walls need are taken from the base terrain plus the deck's profile (the region's terrain is the base plus
 * this module's own mods, and none of those lies under the deck), so no settle step is needed in world.ts.
 */
import { CITY } from '../config';
import { createTerrain } from '../terrain';
import type { Vec2 } from '../../sim/math';
import { bankMod, bankedRingMod } from './banking';
import { solidWalls } from './geom';
import type { DistrictModule, HeightSample } from './types';
import { emptyBuild } from './types';
import { SCRAPYARD_SHAPES, planScrapyard } from './scrapyardPlan';
import { deckLift, scrapLayout, scrapLines } from './scrapyardLayout';
import { humpMod, pitMod, tableMod } from './scrapyardShapes';
import { carveRegion, regionGround, regionOf } from './weekendRegion';

export { scrapLayout, yardZone, deckLift } from './scrapyardLayout';
export type { ScrapLayout, ScrapStack, YardSolid, DeckParapet } from './scrapyardLayout';

const C = CITY.districts.scrapyard;

/** Hint kinds the renderer reads. */
export const SCRAP_HINT = { slick: 'scrapSlick' } as const;

export const scrapyardModule: DistrictModule = {
  kind: 'scrapyard',
  phase: 'graph',
  carve(ctx) {
    if (!C.enabled || ctx.weekend?.kind !== 'scrapyard') return;
    carveRegion(ctx, { kind: 'scrapyard', shapes: SCRAPYARD_SHAPES, spineWidth: C.spineWidth });
  },
  plan(ctx) {
    if (ctx.weekend?.kind !== 'scrapyard') return;
    planScrapyard(ctx);
  },
  lines(area) {
    const r = regionOf(area);
    if (!r || !area.params.planned || !(area.params.R > 0)) return [];
    return scrapLines(area, r);
  },
  build(ctx, area) {
    const b = emptyBuild();
    const id = area.id;
    const r = regionOf(area);
    if (!r || !area.params.planned || !(area.params.R > 0)) return b;
    const L = scrapLayout(area);
    const F = L.frame;
    const base = createTerrain(ctx.seed);
    const lift = { h: 0, d: 0 };
    /** The deck's absolute height (m) over a point (the terrain where it is off the deck's u range). */
    const deckY = (x: number, z: number): number => base.heightAt(x, z) + deckLift(L, (x - F.o.x) * F.u.x + (z - F.o.z) * F.u.z, lift).h;

    // Ground: firm gravel over the region, concrete on the haul road and the aprons, dirt on the bowls' outsides, the slicks on top.
    regionGround(b, r, 'quay');
    for (const p of L.concrete) b.surfaces.push({ surface: 'concrete', polygon: p, priority: 6, area: id });
    for (const p of L.dirt) b.surfaces.push({ surface: 'offroad', polygon: p, priority: 6, area: id });
    for (const p of L.slicks) {
      b.surfaces.push({ surface: 'slick', polygon: p, priority: 7, area: id });
      b.hints.push({ kind: SCRAP_HINT.slick, points: p, values: [] });
    }

    // Walls: the fence (thin solids inward from the ring), the posts, machines and towers, the stacks, the heaps.
    const T = C.fence.thickness;
    for (const p of L.fences) {
      const quad: Vec2[] = [
        { x: p.ax, z: p.az },
        { x: p.bx, z: p.bz },
        { x: p.bx + p.nx * T, z: p.bz + p.nz * T },
        { x: p.ax + p.nx * T, z: p.az + p.nz * T },
      ];
      b.walls.push(...solidWalls(quad, 'scrapFence', id));
    }
    for (const s of L.solids) b.walls.push(...solidWalls(s.poly, s.kind === 'post' ? 'scrapFence' : 'crusher', id));
    for (const s of L.stacks) {
      const walls = solidWalls(s.poly, 'carStack', id);
      // Under the deck: a car up on it passes over (the deck's underside, a little under its surface, at the stack's lowest corner).
      if (s.kind === 'support') {
        const under = Math.min(...s.poly.map((v) => deckY(v.x, v.z))) - 0.5;
        for (const w of walls) w.under = under;
      }
      b.walls.push(...walls);
    }
    for (const h of L.heaps) b.walls.push(...solidWalls(h.poly, 'carStack', id));
    // The deck's parapets: low bales, flown over above their top; over the deck their undersides let a car beneath pass.
    const D = C.deck;
    for (const p of L.deck.parapets) {
      const walls = solidWalls(p.poly, 'carStack', id);
      const ys = p.poly.map((v) => deckY(v.x, v.z));
      const top = Math.min(...ys) + D.parapetTop;
      for (const w of walls) {
        w.top = top;
        if (!p.ramp) w.bottom = Math.min(...ys) - D.under;
      }
      b.walls.push(...walls);
    }

    // Heights: the bowls' banks, the crusher's kicker and pit, the launch, the weighbridge.
    for (const bowl of L.bowls) b.heightMods.push(bankMod(bowl));
    for (const d of L.dishes) b.heightMods.push(bankedRingMod(d));
    b.heightMods.push(tableMod(L.kicker.lip, L.kicker.dir, C.kicker));
    b.heightMods.push(pitMod(L.pit.o, L.pit.dir, L.pit.s0, L.pit.s1, C.pit.halfWidth, C.pit.depth, C.pit.ease));
    b.heightMods.push(tableMod(L.launch.lip, L.launch.dir, C.launch));
    b.heightMods.push(humpMod(L.hump.o, L.hump.dir, C.hump, L.hump.half, 2));

    // The deck: the base terrain plus the ramps' profile along the chord.
    const pr = { h: 0, d: 0 };
    b.decks.push({
      polygon: L.deck.polygon,
      area: id,
      depth: D.height,
      upper(x: number, z: number, out: HeightSample): void {
        const u = (x - F.o.x) * F.u.x + (z - F.o.z) * F.u.z;
        deckLift(L, u, pr);
        const s = base.slopeAt(x, z);
        out.h = base.heightAt(x, z) + pr.h;
        out.gx = s.gx + pr.d * F.u.x;
        out.gz = s.gz + pr.d * F.u.z;
      },
    });

    b.destructibles.push(...L.clutter);
    return b;
  },
};

/** The deck's surface height (m) at a point, from a built world's terrain (for the renderer and the tests): the terrain plus the ramps' profile. */
export function deckSurface(L: ReturnType<typeof scrapLayout>, groundAt: (x: number, z: number) => number, x: number, z: number): number {
  const F = L.frame;
  const out = { h: 0, d: 0 };
  return groundAt(x, z) + deckLift(L, (x - F.o.x) * F.u.x + (z - F.o.z) * F.u.z, out).h;
}

