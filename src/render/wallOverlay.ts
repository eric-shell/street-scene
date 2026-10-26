/**
 * Collision overlay (dev builds, `?walls`): every wall the sim collides with
 * drawn where it stands, so a hit box can be checked against what is drawn
 * (invariant 5) by eye instead of by reading planner code.
 *
 *  - Each wall is a translucent panel over the height a car meets it at: a
 *    plain wall from the ground up, a low lip (Wall.top) up to its top, a
 *    deck's parapet (Wall.bottom) from the deck up, a column under the
 *    highway (Wall.under) from the street up to the deck. Coloured by kind
 *    and look: cyan barriers, magenta rails, orange solids, the rest a hue
 *    per look.
 *  - A one sided wall also pushes back a car whose center is up to 3 m
 *    behind it (world.ts collideCircle, the anti tunnelling band): that band
 *    lies on the ground behind the wall in faint red, and a tick from the
 *    wall's middle points the way the wall faces. Anything drivable inside a
 *    red band is a trap.
 *  - Destructible props are rings at their collision radius.
 *
 * Built once per scene, three draw calls, never in production (the caller
 * gates it on import.meta.env.DEV). Render only.
 */
import * as THREE from 'three';
import type { World } from '../city/world';
import type { Wall } from '../city/blocks';
import { GeoBuilder } from './geoBuilder';
import { Disposer } from './disposer';

/** The anti tunnelling band behind a one sided wall (m): world.ts collideCircle's. */
const BAND = 3;
/** Panel height of a plain full height wall (m), and a deck parapet's above its bottom. */
const TALL = 1.6;
const PARAPET = 1.3;

const FIXED: Record<string, number> = {
  barrier: 0x22e6ff,
  rail: 0xff3cd2,
  solid: 0xff8a1a,
  building: 0x7f8fb0,
  boundary: 0xffe14a,
  lotEdge: 0x6cff6a,
  highway: 0xff4a4a,
  alleyLip: 0xffffff,
};

function lookColor(w: Wall): THREE.Color {
  const key = w.kind !== 'wall' ? w.kind : w.solid ? 'solid' : (w.look ?? 'wall');
  const hex = FIXED[key];
  if (hex !== undefined) return new THREE.Color(hex);
  let h = 0;
  for (let i = 0; i < key.length; i++) h = (h * 31 + key.charCodeAt(i)) >>> 0;
  return new THREE.Color().setHSL((h % 360) / 360, 0.75, 0.6);
}

export interface WallOverlay {
  group: THREE.Group;
  dispose(): void;
}

export function buildWallOverlay(world: World): WallOverlay {
  const disposer = new Disposer();
  const { track } = disposer;
  const group = new THREE.Group();
  group.name = 'wallOverlay';
  const panels = new GeoBuilder(true);
  const bands = new GeoBuilder(true);
  const lines: number[] = [];
  const lineColors: number[] = [];
  const line = (ax: number, ay: number, az: number, bx: number, by: number, bz: number, c: THREE.Color) => {
    lines.push(ax, ay, az, bx, by, bz);
    lineColors.push(c.r, c.g, c.b, c.r, c.g, c.b);
  };
  const red = new THREE.Color(0xff2020);

  /** The heights a car meets the wall between, at one of its ends. */
  const span = (w: Wall, x: number, z: number): [number, number] => {
    const g = world.heightAt(x, z);
    if (w.under !== undefined) return [g, w.under];
    if (w.bottom !== undefined) return [w.bottom, w.bottom + PARAPET];
    if (w.top !== undefined) return [g, Number.isFinite(w.top) ? w.top : g + TALL];
    return [g - 0.05, g + TALL];
  };

  for (const w of world.walls) {
    const c = lookColor(w);
    const [a0, a1] = span(w, w.ax, w.az);
    const [b0, b1] = span(w, w.bx, w.bz);
    const v = [panels.vertex(w.ax, a0, w.az, w.nx, 0, w.nz, 0, 0, c), panels.vertex(w.bx, b0, w.bz, w.nx, 0, w.nz, 1, 0, c), panels.vertex(w.bx, b1, w.bz, w.nx, 0, w.nz, 1, 1, c), panels.vertex(w.ax, a1, w.az, w.nx, 0, w.nz, 0, 1, c)];
    panels.quad(v[0], v[1], v[2], v[3]);
    line(w.ax, a1, w.az, w.bx, b1, w.bz, c);
    line(w.ax, a0, w.az, w.bx, b0, w.bz, c);
    line(w.ax, a0, w.az, w.ax, a1, w.az, c);
    // Facing tick from mid height at the middle.
    const mx = (w.ax + w.bx) / 2;
    const mz = (w.az + w.bz) / 2;
    const my = (a0 + a1 + b0 + b1) / 4;
    line(mx, my, mz, mx + w.nx * 0.8, my, mz + w.nz * 0.8, c);
    // A solid collides as a whole; only one sided walls have the band behind them.
    if (w.solid) continue;
    const bx0 = w.ax - w.nx * BAND;
    const bz0 = w.az - w.nz * BAND;
    const bx1 = w.bx - w.nx * BAND;
    const bz1 = w.bz - w.nz * BAND;
    const q = [bands.vertex(w.ax, a0 + 0.08, w.az, 0, 1, 0, 0, 0, red), bands.vertex(w.bx, b0 + 0.08, w.bz, 0, 1, 0, 1, 0, red), bands.vertex(bx1, world.heightAt(bx1, bz1) + 0.08, bz1, 0, 1, 0, 1, 1, red), bands.vertex(bx0, world.heightAt(bx0, bz0) + 0.08, bz0, 0, 1, 0, 0, 1, red)];
    bands.quad(q[0], q[1], q[2], q[3]);
  }

  const ring = new THREE.Color(0xc8ff3c);
  for (const p of world.props) {
    const y = p.y + 0.1;
    for (let k = 0; k < 12; k++) {
      const t0 = (k / 12) * Math.PI * 2;
      const t1 = ((k + 1) / 12) * Math.PI * 2;
      line(p.x + Math.cos(t0) * p.radius, y, p.z + Math.sin(t0) * p.radius, p.x + Math.cos(t1) * p.radius, y, p.z + Math.sin(t1) * p.radius, ring);
    }
  }

  const translucent = (opacity: number) => track(new THREE.MeshBasicMaterial({ vertexColors: true, transparent: true, opacity, side: THREE.DoubleSide, depthWrite: false, fog: false }));
  const panelMesh = new THREE.Mesh(track(panels.build()), translucent(0.28));
  const bandMesh = new THREE.Mesh(track(bands.build()), translucent(0.1));
  const lineGeo = track(new THREE.BufferGeometry());
  lineGeo.setAttribute('position', new THREE.Float32BufferAttribute(lines, 3));
  lineGeo.setAttribute('color', new THREE.Float32BufferAttribute(lineColors, 3));
  const lineMesh = new THREE.LineSegments(lineGeo, track(new THREE.LineBasicMaterial({ vertexColors: true, fog: false, depthTest: true })));
  for (const m of [bandMesh, panelMesh, lineMesh]) {
    m.frustumCulled = false;
    m.renderOrder = 10;
    group.add(m);
  }
  return { group, dispose: () => disposer.dispose() };
}
