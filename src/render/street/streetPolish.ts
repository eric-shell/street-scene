/**
 * Street level polish: the lived in detail that the big meshes leave out.
 * Road decals and puddles (streetDecals.ts), graffiti, posters, grime, air
 * conditioners, pipes, blade signs and banners on the walls
 * (wallDressing.ts) and steam off the manholes (steam.ts), built once per
 * scene from the world and the drawn podium geometry. Five draw calls at
 * most. The procedural atlases are drawn once per seed and kept, so the race
 * that follows the menu city pays nothing for them. Render only.
 */
import * as THREE from 'three';
import type { World } from '../../city/world';
import type { Quality } from '../../ui/settings';
import { buildStreetDecals } from './streetDecals';
import { buildWallDressing } from '../buildings/wallDressing';
import { buildSteam, Steam } from './steam';
import { FacadeProbe } from '../buildings/wallProbe';
import { makeBladeSignAtlas, makeGraffitiAtlas, makeSteamPuff, makeStreetDecalAtlas } from '../textures/textures';

export interface StreetPolishOptions {
  quality: Quality;
  /** The drawn podium geometry (cityMeshes 'podiums'); without it nothing is pasted on the facades. */
  facades?: THREE.BufferGeometry | null;
}

export interface StreetPolish {
  group: THREE.Group;
  update(time: number): void;
  dispose(): void;
}

/** What each graphics tier gets: densities are multipliers, banners a cap. */
export const POLISH = {
  low: { decals: 0.55, puddles: true, walls: 0.5, banners: 4, steam: false },
  medium: { decals: 0.9, puddles: true, walls: 0.85, banners: 9, steam: true },
  high: { decals: 1.1, puddles: true, walls: 1.1, banners: 14, steam: true },
} as const satisfies Record<Quality, { decals: number; puddles: boolean; walls: number; banners: number; steam: boolean }>;

interface Atlases {
  seed: number;
  decals: { map: THREE.Texture; roughness: THREE.Texture };
  graffiti: THREE.Texture;
  blades: THREE.Texture;
  puff: THREE.Texture;
}

/** The last two seeds' atlases (the menu city and a race on another seed can coexist). */
const cache: Atlases[] = [];

function atlasesFor(seed: number): Atlases {
  const hit = cache.find((a) => a.seed === seed);
  if (hit) return hit;
  const a: Atlases = { seed, decals: makeStreetDecalAtlas(seed), graffiti: makeGraffitiAtlas(seed), blades: makeBladeSignAtlas(), puff: makeSteamPuff() };
  cache.push(a);
  while (cache.length > 2) {
    const old = cache.shift()!;
    old.decals.map.dispose();
    old.decals.roughness.dispose();
    old.graffiti.dispose();
    old.blades.dispose();
    old.puff.dispose();
  }
  return a;
}

export function buildStreetPolish(world: World, opts: StreetPolishOptions): StreetPolish {
  const q = POLISH[opts.quality] ?? POLISH.medium;
  const atlases = atlasesFor(world.seed);
  const group = new THREE.Group();
  group.name = 'streetPolish';
  const decals = buildStreetDecals(world, atlases.decals, { density: q.decals, puddles: q.puddles });
  for (const m of decals.meshes) group.add(m);
  const probe = new FacadeProbe(opts.facades);
  const walls = buildWallDressing(world, probe, { graffiti: atlases.graffiti, blades: atlases.blades }, { density: q.walls, banners: q.banners });
  for (const m of walls.meshes) group.add(m);
  let steam: Steam | null = null;
  if (q.steam && decals.vents.length) {
    steam = buildSteam(decals.vents, atlases.puff);
    group.add(steam.mesh);
  }
  return {
    group,
    update(time) {
      steam?.update(time);
    },
    dispose() {
      decals.dispose();
      walls.dispose();
      steam?.dispose();
      group.removeFromParent();
    },
  };
}
