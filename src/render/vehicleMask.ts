/**
 * Cars stand on top of the light they drive through. Street pools, washes,
 * headlight beams, underglow and road paint are layers a few centimeters
 * over the asphalt (any lower and they z-fight it in the distance), and the
 * lower edge of every tire and skirt dips below them, so they drew a washed
 * band across the bottom of each car, as if it sank into the road.
 *
 * Vehicles (race cars, ghosts excepted; traffic; parked meet cars) write a
 * stencil bit wherever they pass the depth test, and those ground layers skip
 * that bit. Vehicles draw after the rest of the opaque city (VEHICLE_ORDER),
 * so a car hidden behind a crest or under an overpass deck never writes the
 * bit and never punches a car-shaped hole in the paint or light in front of
 * it; opaque road paint draws after the vehicles (GROUND_PAINT_ORDER) so it
 * can take the same test. The scene's render targets carry the stencil
 * buffer (post.ts). Free on the GPU: a stencil compare per fragment, no extra
 * pass or draw call.
 */
import * as THREE from 'three';

/** The stencil bit vehicles set. */
const VEHICLE_BIT = 1;
/** Opaque render order of vehicle meshes: after the city, so only visible car pixels mark the stencil. */
export const VEHICLE_ORDER = 1;
/** Opaque render order of road paint that tests the stencil: after the vehicles. */
export const GROUND_PAINT_ORDER = 2;

/** An opaque vehicle material: marks its pixels. Transparent ones (glass, ghosts) are left alone. */
export function maskVehicle(m: THREE.Material): void {
  if (m.transparent) return;
  m.stencilWrite = true;
  m.stencilRef = VEHICLE_BIT;
  m.stencilWriteMask = VEHICLE_BIT;
  m.stencilFunc = THREE.AlwaysStencilFunc;
  m.stencilFail = THREE.KeepStencilOp;
  m.stencilZFail = THREE.KeepStencilOp;
  m.stencilZPass = THREE.ReplaceStencilOp;
}

/** A mesh of a vehicle: its opaque materials mark the stencil and it draws after the city. */
export function maskVehicleMesh(mesh: THREE.Mesh): void {
  const mats = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
  for (const m of mats) maskVehicle(m);
  if (mats.every((m) => !m.transparent)) mesh.renderOrder = VEHICLE_ORDER;
}

/** A ground layer (light pool, wash, beam, underglow, decal, paint): never drawn over a vehicle. */
export function underVehicles(m: THREE.Material): void {
  m.stencilWrite = true;
  m.stencilRef = VEHICLE_BIT;
  m.stencilFuncMask = VEHICLE_BIT;
  m.stencilWriteMask = 0;
  m.stencilFunc = THREE.NotEqualStencilFunc;
  m.stencilFail = THREE.KeepStencilOp;
  m.stencilZFail = THREE.KeepStencilOp;
  m.stencilZPass = THREE.KeepStencilOp;
}

/** Undo maskVehicle (a ghost turned see-through). */
export function unmaskVehicle(m: THREE.Material): void {
  m.stencilWrite = false;
}
