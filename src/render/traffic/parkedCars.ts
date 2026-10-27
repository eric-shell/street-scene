/**
 * Parked cars in the yards behind the frontage walls (render/districts/yards.ts
 * decides where: only ground no car can reach, so none is a ghost). Static
 * instances of the civilian traffic's passenger models: the same pre-baked
 * atlas and geometry as render/traffic/traffic.ts (loadTrafficAssets, one load
 * per page), tinted with its muted street paint, a little dustier, with the
 * lamps off. A few have one parking light on (a head lamp warm, a tail lamp
 * red), drawn as dim boxes in one instanced mesh.
 *
 * Two draw calls for every parked car in the city: one BatchedMesh of bodies
 * (a slot per car, per car colour, sorting off since they never move) and the
 * handful of lit lamps. The atlas loads asynchronously, so the instances are
 * built when it resolves, exactly as the traffic view does; until then (and
 * when the models are missing) nothing is drawn. Medium and High only: Low
 * keeps its draw calls and triangles for the road.
 *
 * Culling is the city chunk grid's (cityChunks.ts): each frame `view` snaps
 * the camera to the 100 m lattice and, only when that square (or the cutoff)
 * changes, marks the instances whose 200 m cell lies within the reach visible;
 * the BatchedMesh then frustum culls each car on its own. Per frame cost when
 * the lattice square is unchanged: a compare and a return.
 */
import * as THREE from 'three';
import type { World } from '../../city/world';
import type { Quality } from '../../ui/settings';
import { TRAFFIC } from '../../sim/tuning';
import { VIEW_LATTICE, chunkGrid, type ChunkGrid } from '../cityChunks';
import { planYards, type YardCar } from '../districts/yards';
import { fadeSubPixel } from '../materialFx';
import { applyHeightFog } from '../heightFog';
import { maskVehicleMesh } from '../vehicleMask';
import { PAINTS, TRAFFIC_MODELS, bodyMaterial, loadTrafficAssets } from './traffic';

/** Per tier: how far (m) parked cars are drawn. Zero: none (Low). */
export const PARKED_QUALITY: Record<Quality, { drawDistance: number }> = {
  low: { drawDistance: 0 },
  medium: { drawDistance: 160 },
  high: { drawDistance: 260 },
};

/** How a parked car is dressed (colours linear, HDR for the lamps that bloom). */
const PARKED = {
  /** Paint brightness against the traffic's: parked cars sit under the night's dust and shade. */
  dim: [0.55, 0.9],
  /** Lit lamp colours: a head lamp as a warm parking light, a tail lamp red. Under the bloom's threshold: a glint, not a flare. */
  head: new THREE.Color(0xffb866).multiplyScalar(1.1),
  tail: new THREE.Color(0xff2a30).multiplyScalar(0.9),
  /** Lift above the ground (m): the tyres' flats sink a little. */
  lift: -0.02,
} as const;

export interface ParkedCars {
  group: THREE.Group;
  /** Call before each render with the camera and the fog's cutoff (m; Infinity without chunking). */
  view(camera: THREE.Camera, cutoff: number): void;
  dispose(): void;
}

export interface ParkedOpts {
  quality: Quality;
  /** The scene's culling grid; the city's own when missing. */
  grid?: ChunkGrid;
}

/** Brightness jitter of a car's paint from its plan number (0..1 in, a stable fraction out). */
const jitter = (t: number): number => (t * 7.31) % 1;

/** Build the parked cars of a city; they appear once the traffic models have loaded. */
export function buildParkedCars(world: World, opts: ParkedOpts): ParkedCars {
  const group = new THREE.Group();
  group.name = 'parkedCars';
  const reach = PARKED_QUALITY[opts.quality].drawDistance;
  const disposables: { dispose(): void }[] = [];
  let disposed = false;
  let drawn: (camera: THREE.Camera, cutoff: number) => void = () => {};
  if (reach > 0) {
    const cars = planYards(world).cars;
    if (cars.length) {
      const grid = opts.grid ?? chunkGrid(world.graph.bounds);
      void loadTrafficAssets().then((a) => {
        if (!a || disposed) return;
        drawn = build(world, cars, a, grid, reach, group, disposables);
        applyHeightFog(group);
      });
    }
  }
  return {
    group,
    view: (camera, cutoff) => drawn(camera, cutoff),
    dispose() {
      disposed = true;
      group.removeFromParent();
      for (const d of disposables) d.dispose();
    },
  };
}

/** Fill the batch with every car and return the per frame view function. */
function build(world: World, cars: readonly YardCar[], a: NonNullable<Awaited<ReturnType<typeof loadTrafficAssets>>>, grid: ChunkGrid, reach: number, group: THREE.Group, disposables: { dispose(): void }[]): (camera: THREE.Camera, cutoff: number) => void {
  // Only the kinds in use go into the batch.
  const used = [...new Set(cars.map((c) => c.kind))].sort((p, q) => p - q);
  const geos = used.map((k) => a.body[k]);
  const verts = geos.reduce((n, g) => n + g.getAttribute('position').count, 0);
  const idx = geos.reduce((n, g) => n + g.getIndex()!.count, 0);
  const mat = bodyMaterial(a.atlas);
  const bodies = new THREE.BatchedMesh(cars.length, verts, idx, mat);
  const geoId = new Map(used.map((k, i) => [k, bodies.addGeometry(geos[i])]));
  // Static, so each car is culled on its own and nothing is sorted.
  bodies.frustumCulled = false;
  bodies.sortObjects = false;
  bodies.name = 'parkedCars';
  maskVehicleMesh(bodies);
  group.add(bodies);
  disposables.push(mat, bodies);

  const m = new THREE.Matrix4();
  const q = new THREE.Quaternion();
  const e = new THREE.Euler(0, 0, 0, 'YXZ');
  const p = new THREE.Vector3();
  const one = new THREE.Vector3(1, 1, 1);
  const c = new THREE.Color();
  /** Each car's chunk cell, and the lit ones' lamp matrices (16 floats) with their colour and cell. */
  const cell: number[] = [];
  const lampM: number[] = [];
  const lampC: number[] = [];
  const lampCell: number[] = [];
  const lm = new THREE.Matrix4();
  for (const car of cars) {
    const model = TRAFFIC_MODELS.kinds[TRAFFIC.kinds[car.kind].name];
    const fx = Math.sin(car.yaw);
    const fz = Math.cos(car.yaw);
    // Left of the car (local +x) in the world, for the roll across the slope.
    const lx = Math.cos(car.yaw);
    const lz = -Math.sin(car.yaw);
    const hl = model.halfLength * 0.8;
    const hw = model.halfWidth * 0.9;
    const hf = world.heightAt(car.x + fx * hl, car.z + fz * hl);
    const hb = world.heightAt(car.x - fx * hl, car.z - fz * hl);
    const hL = world.heightAt(car.x + lx * hw, car.z + lz * hw);
    const hR = world.heightAt(car.x - lx * hw, car.z - lz * hw);
    e.set(Math.atan2(hb - hf, 2 * hl), car.yaw, Math.atan2(hL - hR, 2 * hw));
    q.setFromEuler(e);
    m.compose(p.set(car.x, (hf + hb + hL + hR) / 4 + PARKED.lift, car.z), q, one);
    const id = bodies.addInstance(geoId.get(car.kind)!);
    bodies.setMatrixAt(id, m);
    // The muted street palette, dimmer; the unpainted models (the SUV) keep their atlas colours.
    if (model.tinted) c.copy(PAINTS[Math.min(PAINTS.length - 1, Math.floor(car.tint * PAINTS.length))]).multiplyScalar(PARKED.dim[0] + (PARKED.dim[1] - PARKED.dim[0]) * jitter(car.tint));
    else c.setRGB(1, 1, 1);
    bodies.setColorAt(id, c);
    const k = grid.cellOf(car.x, car.z);
    cell.push(k);
    if (car.light >= 0) {
      const lamp = model.lamps[car.light];
      lm.multiplyMatrices(m, new THREE.Matrix4().compose(new THREE.Vector3(...lamp.p), new THREE.Quaternion(), new THREE.Vector3(...lamp.s)));
      lampM.push(...lm.elements);
      (lamp.role === 'tail' ? PARKED.tail : PARKED.head).toArray(lampC, lampC.length);
      lampCell.push(k);
    }
  }

  // One instanced mesh for the lit lamps, compacted to the visible cells' on each change.
  const lampMat = new THREE.MeshBasicMaterial({ color: 0xffffff });
  fadeSubPixel(lampMat, 0.12, 0.3);
  const lampGeo = new THREE.BoxGeometry(1, 1, 1);
  const lamps = new THREE.InstancedMesh(lampGeo, lampMat, Math.max(1, lampCell.length));
  lamps.setColorAt(0, c.setRGB(1, 1, 1));
  lamps.count = 0;
  lamps.frustumCulled = false;
  lamps.name = 'parkedLamps';
  group.add(lamps);
  disposables.push(lampMat, lampGeo, lamps);

  const visible = new Uint8Array(grid.count);
  let lastX = NaN;
  let lastZ = NaN;
  let lastCut = NaN;
  return (camera, cutoff) => {
    const L = VIEW_LATTICE.snap;
    const sx = grid.minX + (Math.floor((camera.position.x - grid.minX) / L) + 0.5) * L;
    const sz = grid.minZ + (Math.floor((camera.position.z - grid.minZ) / L) + 0.5) * L;
    if (sx === lastX && sz === lastZ && cutoff === lastCut) return;
    lastX = sx;
    lastZ = sz;
    lastCut = cutoff;
    grid.cellsWithin(sx, sz, Math.min(reach, cutoff), visible, L / 2);
    for (let i = 0; i < cell.length; i++) bodies.setVisibleAt(i, visible[cell[i]] === 1);
    const arr = lamps.instanceMatrix.array as Float32Array;
    const col = lamps.instanceColor!.array as Float32Array;
    let n = 0;
    for (let i = 0; i < lampCell.length; i++) {
      if (!visible[lampCell[i]]) continue;
      for (let j = 0; j < 16; j++) arr[n * 16 + j] = lampM[i * 16 + j];
      for (let j = 0; j < 3; j++) col[n * 3 + j] = lampC[i * 3 + j];
      n++;
    }
    lamps.count = n;
    lamps.instanceMatrix.needsUpdate = true;
    lamps.instanceColor!.needsUpdate = true;
  };
}
