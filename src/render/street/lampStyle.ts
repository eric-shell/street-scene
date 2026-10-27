/**
 * The look of every streetlight, per neighbourhood: which of the three post designs stands there (propGeometry
 * `LampDesign`) and what colour it burns (sodium amber, warm white, cool white LED). The region comes from the
 * building plan's Voronoi cells (architecture.ts `regionAt`), so a lamp matches the facades around it. Each
 * region's defaults are its home profile's lamps (cityIdentity.ts `HOME_PROFILES`). A per-seed twist
 * (`deriveSeed(seed, 'lamps')`) now and then takes the home's colour city-wide (all-sodium New York or
 * Philadelphia, an LED San Francisco; Los Angeles and Miami never, their warm white everywhere would wash out the
 * neighbourhood contrast), or swaps one other region's colour and one other region's post, so no two cities
 * light the same way. The home itself is never swapped: its lamps are part of what the seed is, and a city-wide
 * outcome can only ever agree with it.
 *
 * One plan per world, read by the props (post set and lens tint), lightFx (pool and streak colour) and the point
 * light pool (lighting.ts), so the pole, its lens, the pool on the ground and the real light always agree. The
 * park lanterns, plazas, market strings and expressway lamps keep their own warm light. Render only.
 */
import * as THREE from 'three';
import type { World } from '../../city/world';
import { Rng, deriveSeed } from '../../sim/prng';
import { regionAt, type Region } from '../buildings/architecture';
import { cityIdentity, HOME_PROFILES } from '../cityIdentity';
import { LAMP_DESIGNS, LAMP_DIMS, STREETLIGHT_POLE_H, type LampDesign } from './propGeometry';

export type LampTone = 'sodium' | 'warm' | 'cool';
const TONE_IDS: readonly LampTone[] = ['sodium', 'warm', 'cool'];
const REGION_IDS: readonly Region[] = ['nyc', 'la', 'sf', 'philly', 'miami'];

/** What each tone paints (sRGB hex): the glowing lens (times 4 in the shader), the ground pool, the wet street streak and the real point light. */
export const LAMP_TONES: Record<LampTone, { lens: number; pool: number; streak: number; light: number }> = {
  sodium: { lens: 0xffc27a, pool: 0xffb46a, streak: 0xffb060, light: 0xffb36b },
  warm: { lens: 0xffe3c0, pool: 0xffd7a6, streak: 0xffd49c, light: 0xffd9b0 },
  cool: { lens: 0xd6e8ff, pool: 0xa9c8ff, streak: 0xaecbff, light: 0xbcd4ff },
};

/** The per-seed twist odds: the home's colour city-wide (where its profile allows), one other region's colour swapped, and (separately) one other region's post swapped. */
export const LAMP_TWIST = { citywide: 0.2, regionTone: 0.35, regionDesign: 0.45 } as const;

export interface LampPlan {
  /** Per streetlight (CityBlocks.streetlights order). */
  design: LampDesign[];
  tone: LampTone[];
  /** The region -> tone and region -> design tables after the twist (for tests and logs). */
  regionTone: Record<Region, LampTone>;
  regionDesign: Record<Region, LampDesign>;
}

const plans = new WeakMap<World, LampPlan>();

export function planLamps(world: World): LampPlan {
  let plan = plans.get(world);
  if (!plan) plans.set(world, (plan = planOnce(world)));
  return plan;
}

function planOnce(world: World): LampPlan {
  const rng = new Rng(deriveSeed(world.seed, 'lamps'));
  const id = cityIdentity(world.seed);
  const regionTone = {} as Record<Region, LampTone>;
  const regionDesign = {} as Record<Region, LampDesign>;
  for (const r of REGION_IDS) {
    regionTone[r] = HOME_PROFILES[r].lamps.tone;
    regionDesign[r] = HOME_PROFILES[r].lamps.design;
  }
  const others = REGION_IDS.filter((r) => r !== id.home);
  const roll = rng.next();
  if (roll < LAMP_TWIST.citywide) {
    if (id.lamps.citywide) for (const r of REGION_IDS) regionTone[r] = id.lamps.tone;
  } else if (roll < LAMP_TWIST.citywide + LAMP_TWIST.regionTone) {
    const r = rng.pick(others);
    regionTone[r] = rng.pick(TONE_IDS.filter((t) => t !== regionTone[r]));
  }
  if (rng.chance(LAMP_TWIST.regionDesign)) {
    const r = rng.pick(others);
    regionDesign[r] = rng.pick(LAMP_DESIGNS.filter((d) => d !== regionDesign[r]));
  }
  const at = regionAt(world);
  const design: LampDesign[] = [];
  const tone: LampTone[] = [];
  for (const l of world.blocks.streetlights) {
    const region = at(l.x, l.z);
    design.push(regionDesign[region]);
    tone.push(regionTone[region]);
  }
  return { design, tone, regionTone, regionDesign };
}

/**
 * Move each streetlight's lamp position (from cityMeshes, placed for the cobra head) to its design's head: the
 * reach along the arm and the light's height, so the pool, streak and point light sit in the lamp. In place.
 */
export function fitLampPositions(world: World, positions: THREE.Vector3[], plan: LampPlan): void {
  world.blocks.streetlights.forEach((l, i) => {
    const p = positions[i];
    if (!p) return;
    const ground = p.y - (STREETLIGHT_POLE_H - 0.4);
    const d = LAMP_DIMS[plan.design[i]];
    p.set(l.x + l.dx * d.reach, ground + d.lightY, l.z + l.dz * d.reach);
  });
}

/** One Color per tone, built once: lens tint, pool, streak and real light. */
const cache = new Map<number, THREE.Color>();
export const toneColor = (hex: number): THREE.Color => {
  let c = cache.get(hex);
  if (!c) cache.set(hex, (c = new THREE.Color(hex)));
  return c;
};
