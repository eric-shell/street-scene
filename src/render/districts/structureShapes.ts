/**
 * What the structures over the streets look like in 3D, shared by their
 * renderers (tunnel.ts, overpass.ts) and the camera's ceiling clamp
 * (render/camera/ceilings.ts) so the camera stops exactly under what is drawn. The
 * sim only knows the walls; everything overhead is decided here, read only,
 * from the area params and the terrain.
 */
import type { World } from '../../city/world';
import type { Area, HeightSample } from '../../city/districts/types';
import { CITY } from '../../city/config';
import { RidgeShape, TunnelShape, ridgeAt, ridgeRawAt, ridgeShape, tunnelShape } from '../../city/districts/tunnel';
import { ViaductShape, viaductShape } from '../../city/districts/overpass';
import { smooth01 } from '../../city/districts/geom';
import { toLocal, toWorld } from '../../city/districts/structures';

/** Storey height of the air rights building (m). */
export const FLOOR_H = 3.4;
/** The ridge's vault: spring line below the nominal clearance and crown above it (m). */
const VAULT_SPRING = 1.1;
const VAULT_CROWN = 0.7;

/** Road height on a tunnel's centerline at u (m): the bore's floor reference. */
export function boreRoad(world: World, t: TunnelShape, u: number): number {
  const p = toWorld(t, u, 0);
  return world.heightAt(p.x, p.z);
}

/**
 * Ceiling above the road at lateral offset v (m): flat under a building, a
 * segmental vault through a ridge (springing from the tunnel walls).
 */
export function ceilingAbove(t: TunnelShape, ridge: boolean, v: number): number {
  if (!ridge) return t.clearance;
  const c = t.wall;
  const rise = VAULT_SPRING + VAULT_CROWN;
  const R = (c * c + rise * rise) / (2 * rise);
  const top = t.clearance + VAULT_CROWN;
  const x = Math.min(Math.abs(v), c);
  return top - R + Math.sqrt(Math.max(0, R * R - x * x));
}

/** The bore's ceiling profile across the tunnel wall to wall, as (v, height above the road) pairs. */
export function vaultProfile(t: TunnelShape, ridge: boolean, steps = 10): { v: number; y: number }[] {
  const out: { v: number; y: number }[] = [];
  for (let i = 0; i <= steps; i++) {
    const v = -t.wall + (2 * t.wall * i) / steps;
    out.push({ v, y: ceilingAbove(t, ridge, v) });
  }
  return out;
}

/** The air rights building's portal facades stand this far past the wingwalls' ends (m), over the shut in building line. */
export const FACADE_OUT = 0.5;

/** Covered length either side of a tunnel's center (m): to the portal in a ridge, to the facade under a building. */
export function coverOf(t: TunnelShape, ridge: boolean): number {
  return ridge ? t.half : t.half + t.wing + FACADE_OUT;
}

/** Roof of the air rights building above the road at its center (m). */
export function bridgeTop(a: Area): number {
  return a.params.clearance + CITY.districts.tunnel.slab + a.params.floors * FLOOR_H + 1.2;
}

/** Height of the ridge's rock surface at (x, z): the terrain with the cut corridor filled back in (m). */
export function rockAt(world: World, r: RidgeShape, x: number, z: number): number {
  const l = toLocal(r, x, z);
  const m = smooth01(r.m0, r.m1, Math.abs(l.v)).v;
  return world.heightAt(x, z) + ridgeRawAt(r, x, z) * (1 - m);
}

const lift: HeightSample = { h: 0, gx: 0, gz: 0 };

/**
 * What the tunnels' ridges add to the terrain at a point (m), or null when the
 * city has none: the city's coarse ground plane leaves them out (cityMeshes),
 * since a ridge climbs its full height within a few meters of its street.
 */
export function ridgeLift(world: World): ((x: number, z: number) => number) | null {
  const ridges = world.areas.filter((a) => a.kind === 'tunnel' && a.variant === 'ridge').map(ridgeShape);
  if (!ridges.length) return null;
  return (x, z) => {
    lift.h = 0;
    lift.gx = 0;
    lift.gz = 0;
    for (const r of ridges) ridgeAt(r, x, z, lift);
    return lift.h;
  };
}

/** A viaduct's deck underside: a straight grade y = a + b * s (s along the deck from end 0), clear of the ground by its clearance everywhere. */
export function deckLine(world: World, v: ViaductShape): { a: number; b: number } {
  const ground = (s: number) => {
    let g = -Infinity;
    for (const lat of [-v.half, 0, v.half]) g = Math.max(g, world.heightAt(v.x0 + v.ux * s - v.uz * lat, v.z0 + v.uz * s + v.ux * lat));
    return g;
  };
  const b = (ground(v.length) - ground(0)) / v.length;
  let a = -Infinity;
  for (let s = 0; s <= v.length + 1e-9; s += 3) a = Math.max(a, ground(s) + v.clearance - b * s);
  return { a, b };
}

export { ridgeShape, tunnelShape, viaductShape };
export type { RidgeShape, TunnelShape, ViaductShape };
