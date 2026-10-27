/**
 * The sidewalk trees (city/streetTrees.ts): one tree on every street tree
 * trunk the sim has, and nothing else, so every drawn trunk is a solid and
 * every solid a tree (invariant 5). Positions, trunk radius, crown size and
 * height are the sim's data; the neighbourhood only picks the species: palms
 * line the Los Angeles and Miami streets (the same shares as the yards'),
 * everywhere else a broadleaf, now and then a poplar or a conifer (tree()'s
 * own hash of the position). They go into the district tree layer, so they cost
 * no draw call and cull with the other trees in the city's chunks; every tier
 * draws all of them (a trunk that is drawn nowhere would still stop a car), the
 * Low detail ladder in trees.ts being their cheaper form.
 */
import { Rng } from '../../sim/prng';
import { regionAt } from '../buildings/architecture';
import type { DistrictKit } from './kit';
import { palm, tree } from './trees';

/** Share of a palm region's street trees that are palms; of the others that are conifers; a palm's height over the plan's (the fronds reach well past the crown radius). */
const LOOK = { palm: { la: 0.7, miami: 0.9 }, conifer: 0.04, palmHeight: 1.25 } as const;

/** Plant a tree on every street tree trunk, standing on the sidewalk (the sim's foot height). */
export function plantStreetTrees(kit: DistrictKit): void {
  const region = regionAt(kit.world);
  for (const t of kit.world.blocks.trees) {
    // The pick comes from a hash of the position (like tree()'s), so the menu city and a race agree.
    const roll = new Rng((Math.imul(Math.round(t.x * 64), 40503) ^ Math.imul(Math.round(t.z * 64), 9973)) >>> 0).next();
    const r = region(t.x, t.z);
    if ((r === 'la' || r === 'miami') && roll < LOOK.palm[r]) palm(kit, t.x, t.z, t.height * LOOK.palmHeight, { y: t.y, trunk: t.radius });
    else tree(kit, t.x, t.z, t.size, t.height, { y: t.y, trunk: t.radius, conifer: LOOK.conifer });
  }
}
