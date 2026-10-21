/**
 * District render registry: one renderer per area kind (src/render/districts/<kind>.ts),
 * all appending into a shared kit of merged builders, so every district
 * together costs a handful of draw calls. Read only with respect to the sim.
 */
import * as THREE from 'three';
import type { World } from '../../city/world';
import type { Wall } from '../../city/blocks';
import type { WallLook } from '../../city/districts/types';
import type { Quality } from '../../ui/settings';
import { GeoBuilder } from '../geoBuilder';
import { fadeSubPixel } from '../lightFx';
import type { DistrictKit, DistrictRenderer } from './kit';
import { alleyRenderer } from './alley';
import { hillsRenderer } from './hills';
import { downtownRenderer } from './downtown';
import { infillRenderer } from './infill';
import { lakeRenderer } from './lake';
import { monumentRenderer } from './monument';
import { parkRenderer } from './park';
import { riverRenderer } from './river';
import { roundaboutRenderer } from './roundabout';
import { subwayRenderer } from './subway';
import { tunnelRenderer } from './tunnel';
import { overpassRenderer } from './overpass';
import { waterfrontRenderer } from './waterfront';

export const DISTRICT_RENDERERS: readonly DistrictRenderer[] = [
  downtownRenderer,
  riverRenderer,
  parkRenderer,
  roundaboutRenderer,
  alleyRenderer,
  subwayRenderer,
  infillRenderer,
  hillsRenderer,
  monumentRenderer,
  tunnelRenderer,
  overpassRenderer,
  waterfrontRenderer,
  lakeRenderer,
];

export interface DistrictMeshes {
  group: THREE.Group;
  update(time: number): void;
  /** Call before each render with the camera rendering the scene. */
  view(camera: THREE.Camera): void;
  dispose(): void;
}

export function buildDistrictMeshes(world: World, opts: { quality?: Quality } = {}): DistrictMeshes {
  const group = new THREE.Group();
  group.name = 'districts';
  const disposables: { dispose(): void }[] = [];
  const animations: ((time: number) => void)[] = [];
  const views: ((camera: THREE.Camera) => void)[] = [];
  const walls = new Map<WallLook, Wall[]>();
  for (const w of world.walls) {
    if (w.kind !== 'wall' || !w.look) continue;
    let list = walls.get(w.look);
    if (!list) walls.set(w.look, (list = []));
    list.push(w);
  }
  const kit: DistrictKit = {
    world,
    h: world.heightAt,
    solid: new GeoBuilder(true),
    ground: new GeoBuilder(true),
    paint: new GeoBuilder(true),
    glow: new GeoBuilder(true),
    foliage: new GeoBuilder(true),
    group,
    walls,
    builds: world.districts.builds,
    quality: opts.quality ?? 'medium',
    track: (x) => {
      disposables.push(x);
      return x;
    },
    animate: (fn) => animations.push(fn),
    view: (fn) => views.push(fn),
  };
  for (const r of DISTRICT_RENDERERS) {
    const areas = world.areas.filter((a) => r.kinds.includes(a.kind));
    if (areas.length || r.kinds.includes('infill')) r.build(kit, areas);
  }
  const add = (gb: GeoBuilder, name: string, mat: THREE.Material, order = 0) => {
    if (!gb.vertexCount) return;
    const m = new THREE.Mesh(kit.track(gb.build()), kit.track(mat));
    m.name = name;
    m.renderOrder = order;
    group.add(m);
  };
  add(kit.ground, 'districtGround', new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.9, envMapIntensity: 0.5, polygonOffset: true, polygonOffsetFactor: -1, polygonOffsetUnits: -1 }));
  add(kit.paint, 'districtPaint', new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.6, emissive: 0x111216, polygonOffset: true, polygonOffsetFactor: -3, polygonOffsetUnits: -3 }));
  add(kit.solid, 'districtSolid', new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.85, envMapIntensity: 0.5 }));
  add(kit.foliage, 'districtFoliage', new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.95, flatShading: true }));
  const glow = new THREE.MeshBasicMaterial({ vertexColors: true });
  glow.color.setScalar(1.6);
  // Small emitters (pavement lights, floods, lamps) fade with pixel coverage instead of flickering far away.
  fadeSubPixel(glow, 0.35, 0.3);
  add(kit.glow, 'districtGlow', glow);
  return {
    group,
    update(time) {
      for (const r of DISTRICT_RENDERERS) r.update?.(time);
      for (const fn of animations) fn(time);
    },
    view(camera) {
      for (const fn of views) fn(camera);
    },
    dispose() {
      for (const d of disposables) d.dispose();
    },
  };
}
