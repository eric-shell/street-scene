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
import { TICK_HZ } from '../../sim/constants';
import { GeoBuilder } from '../geoBuilder';
import { fadeSubPixel } from '../materialFx';
import { bakeOcclusion, occlusionFor, occlusionMaterial } from '../street/bakedOcclusion';
import type { DistrictKit, DistrictRenderer } from './kit';
import { treeMaterial } from './trees';
import { alleyRenderer } from './alley';
import { hillsRenderer } from './hills';
import { downtownRenderer } from './downtown';
import { infillRenderer } from './infill';
import { lakeRenderer } from './lake';
import { marketRenderer } from './market';
import { monumentRenderer } from './monument';
import { parkRenderer } from './park';
import { riverRenderer } from './river';
import { roundaboutRenderer } from './roundabout';
import { subwayRenderer } from './subway';
import { highwayRenderer } from './highway';
import { bluffRenderer } from './bluff';
import { tunnelRenderer } from './tunnel';
import { overpassRenderer } from './overpass';
import { waterfrontRenderer } from './waterfront';
import { roadworksRenderer } from './roadworks';
import { driftZoneRenderer } from './driftZones';
import { carParkRenderer } from './carPark';

export const DISTRICT_RENDERERS: readonly DistrictRenderer[] = [
  downtownRenderer,
  riverRenderer,
  parkRenderer,
  roundaboutRenderer,
  alleyRenderer,
  subwayRenderer,
  highwayRenderer,
  bluffRenderer,
  infillRenderer,
  hillsRenderer,
  monumentRenderer,
  tunnelRenderer,
  overpassRenderer,
  carParkRenderer,
  waterfrontRenderer,
  lakeRenderer,
  marketRenderer,
  roadworksRenderer,
  // Markings over the lots and the plaza that pay a drift bonus (sim/driftZones.ts).
  driftZoneRenderer,
];

export interface DistrictMeshes {
  group: THREE.Group;
  update(time: number): void;
  /** Call before each render with the camera rendering the scene. */
  view(camera: THREE.Camera): void;
  /** Pose sim-timed parts (trains, level crossings) at a fractional sim tick from now on; `audible` lets bells ring; `brokenArms` is RaceState.brokenArms. */
  sync(tick: number, audible: boolean, brokenArms?: Uint8Array): void;
  dispose(): void;
}

export interface DistrictMeshOpts {
  quality?: Quality;
  /** The scene's blinking amber (cityMeshes barrierLampMaterial, animated by the scene) for kit.hazard; a steady amber without. */
  hazardLamp?: THREE.Material;
}

export function buildDistrictMeshes(world: World, opts: DistrictMeshOpts = {}): DistrictMeshes {
  const group = new THREE.Group();
  group.name = 'districts';
  const disposables: { dispose(): void }[] = [];
  const animations: ((time: number) => void)[] = [];
  const views: ((camera: THREE.Camera) => void)[] = [];
  // The session's interpolated sim tick, once it drives this scene (NaN: the scene clock).
  let syncTick = NaN;
  let canHear = false;
  let arms: Uint8Array | undefined;
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
    hazard: new GeoBuilder(),
    foliage: new GeoBuilder(true),
    trees: new GeoBuilder(true),
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
    simTick: (time) => (Number.isNaN(syncTick) ? time * TICK_HZ : syncTick),
    audible: () => canHear,
    armBroken: (i) => !!arms?.[i],
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
  // The ground under the El's deck (its yard through the blocks), the lots and plazas along facades: baked occlusion (street/bakedOcclusion.ts).
  bakeOcclusion(kit.ground, occlusionFor(world));
  add(kit.ground, 'districtGround', occlusionMaterial(new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.9, envMapIntensity: 0.5, polygonOffset: true, polygonOffsetFactor: -1, polygonOffsetUnits: -1 })));
  add(kit.paint, 'districtPaint', new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.6, emissive: 0x111216, polygonOffset: true, polygonOffsetFactor: -3, polygonOffsetUnits: -3 }));
  add(kit.solid, 'districtSolid', new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.85, envMapIntensity: 0.5 }));
  add(kit.foliage, 'districtFoliage', new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.95, flatShading: true }));
  add(kit.trees, 'districtTrees', treeMaterial(kit));
  const glow = new THREE.MeshBasicMaterial({ vertexColors: true });
  glow.color.setScalar(1.6);
  // Small emitters (pavement lights, floods, lamps) fade with pixel coverage instead of flickering far away.
  fadeSubPixel(glow, 0.35, 0.3);
  add(kit.glow, 'districtGlow', glow);
  if (kit.hazard.vertexCount) {
    // The scene owns (and disposes) the shared blink; only a stand-in made here is this build's.
    const m = new THREE.Mesh(kit.track(kit.hazard.build()), opts.hazardLamp ?? kit.track(new THREE.MeshBasicMaterial({ color: new THREE.Color(0xffa020).multiplyScalar(3) })));
    m.name = 'districtHazard';
    group.add(m);
  }
  return {
    group,
    update(time) {
      for (const r of DISTRICT_RENDERERS) r.update?.(time);
      for (const fn of animations) fn(time);
    },
    view(camera) {
      for (const fn of views) fn(camera);
    },
    sync(tick, audible, brokenArms) {
      syncTick = tick;
      canHear = audible;
      arms = brokenArms;
    },
    dispose() {
      for (const d of disposables) d.dispose();
    },
  };
}
