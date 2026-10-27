/**
 * Everything that glows on the street besides the streetlights and the podium
 * neon signs, gathered as the extra emitters of the wet street's reflection
 * streaks (lightFx.ts): the park lanterns, the night market's lantern strings,
 * the neon blade signs over the sidewalks, the traffic signal heads and bus
 * shelter lights (props.ts, which also tell which prop each belongs to so a
 * smashed one goes dark), and the route's amber beacons and cyan chevron boards
 * (race/routeArrows.ts). Roof neon is left out (too high to reflect), and so
 * are the El stations' name boards and canopy tubes: they hang under a deck
 * 8 m up, inside the district renderer's merged geometry, with no list to
 * read. The order here is the index order of `LightFx.extraBase + i`. Render only.
 */
import * as THREE from 'three';
import type { World } from '../../city/world';
import { marketLightPoints } from '../districts/marketPlan';
import { routeEmitters, type BarrierInfo } from '../race/routeArrows';
import type { LightEmitter } from './lightFx';
import { PARK_LANTERN_Y, parkLamps, propEmitters } from './props';

export interface StreakEmitters {
  list: LightEmitter[];
  /** Index in `list` of the first park lantern (the k-th park lamp, parkLamps order, is `parkBase + k`). */
  parkBase: number;
  /** For each prop that carries emitters, their indices in `list` (a broken prop darkens them). */
  ofProp: Map<number, number[]>;
}

const LANTERN = new THREE.Color(0xffc890);
const MARKET = new THREE.Color(0xffc060);

export function collectStreakEmitters(world: World, blades: readonly { pos: THREE.Vector3; color: THREE.Color }[], barriers: BarrierInfo[]): StreakEmitters {
  const list: LightEmitter[] = [];
  const ofProp = new Map<number, number[]>();
  const parkBase = list.length;
  for (const p of parkLamps(world)) list.push({ pos: new THREE.Vector3(p.x, p.y + PARK_LANTERN_Y, p.z), color: LANTERN, cls: 'lantern' });
  for (const p of marketLightPoints(world)) list.push({ pos: new THREE.Vector3(p.x, p.y, p.z), color: MARKET, cls: 'string' });
  for (const b of blades) list.push({ pos: b.pos, color: b.color, cls: 'blade' });
  for (const e of propEmitters(world)) {
    const at = ofProp.get(e.prop);
    if (at) at.push(list.length);
    else ofProp.set(e.prop, [list.length]);
    list.push({ pos: new THREE.Vector3(e.x, e.y, e.z), color: e.color, cls: e.cls, phase: e.phase });
  }
  for (const e of routeEmitters(world, barriers)) list.push(e);
  return { list, parkBase, ofProp };
}
