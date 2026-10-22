/**
 * The waypoint race's waypoints in the city: a column of light standing in
 * each waypoint's intersection, seen over the rooftops from blocks away, and a
 * ring on the asphalt the size of what counts as reaching it (RouteWaypoint
 * radius). The next one burns bright and breathes; the ones after it glow
 * dim; reached ones go out. The finish line has its gantry (finishLine.ts),
 * so it gets no column. Two instanced draw calls (columns, rings), additive
 * and depth-write free; per frame only the next waypoint's color changes.
 * Render only: the session passes the player's next target index.
 */
import * as THREE from 'three';
import type { World } from '../city/world';

export const BEACON = {
  /** Column height (m) and its radius at the foot and the top (m). */
  height: 90,
  footRadius: 1.4,
  topRadius: 2.6,
  /** Ring width (m) inside the reach radius. */
  ringWidth: 1.4,
  /** HDR brightness of the next waypoint (bloom catches it), its breathing depth and rate (Hz), and of the later ones. */
  next: 1.1,
  breathe: 0.35,
  rate: 0.9,
  later: 0.3,
  /** Waypoint race cyan (ui.css --cyan). */
  color: 0x78dce8,
} as const;

export class WaypointBeacons {
  readonly group = new THREE.Group();
  private readonly columns: THREE.InstancedMesh;
  private readonly rings: THREE.InstancedMesh;
  private readonly count: number;
  private readonly disposables: { dispose(): void }[] = [];
  private shownNext = -1;
  private readonly base = new THREE.Color(BEACON.color);
  private readonly tmp = new THREE.Color();

  constructor(world: World) {
    const targets = (world.route.waypoints ?? []).slice(0, -1);
    this.count = targets.length;
    this.group.name = 'waypointBeacons';
    const track = <T extends { dispose(): void }>(x: T): T => {
      this.disposables.push(x);
      return x;
    };
    // The column fades out upward (and in just above the street), so it reads as light, not a tube.
    const fade = track(fadeTexture());
    const column = track(new THREE.CylinderGeometry(BEACON.topRadius, BEACON.footRadius, BEACON.height, 18, 1, true).translate(0, BEACON.height / 2, 0));
    const ring = track(new THREE.RingGeometry(1 - BEACON.ringWidth / 12, 1, 56).rotateX(-Math.PI / 2));
    const glow = (map?: THREE.Texture) =>
      track(new THREE.MeshBasicMaterial({ map, transparent: true, blending: THREE.AdditiveBlending, depthWrite: false, side: THREE.DoubleSide, toneMapped: false, fog: false }));
    this.columns = new THREE.InstancedMesh(column, glow(fade), Math.max(1, this.count));
    this.rings = new THREE.InstancedMesh(ring, glow(), Math.max(1, this.count));
    const m = new THREE.Matrix4();
    const q = new THREE.Quaternion();
    targets.forEach((t, i) => {
      const y = world.heightAt(t.x, t.z);
      this.columns.setMatrixAt(i, m.compose(new THREE.Vector3(t.x, y, t.z), q, new THREE.Vector3(1, 1, 1)));
      this.rings.setMatrixAt(i, m.compose(new THREE.Vector3(t.x, y + 0.06, t.z), q, new THREE.Vector3(t.radius, 1, t.radius)));
    });
    for (const mesh of [this.columns, this.rings]) {
      mesh.count = this.count;
      mesh.frustumCulled = false;
      mesh.renderOrder = 2;
      this.group.add(mesh);
    }
    this.update(0, 0);
  }

  /** The player's next target (RaceCar.nextCheckpoint) and the session clock (s). */
  update(next: number, time: number): void {
    if (!this.count) return;
    if (next !== this.shownNext) {
      this.shownNext = next;
      for (let i = 0; i < this.count; i++) this.paint(i, i < next ? 0 : i === next ? BEACON.next : BEACON.later);
    }
    if (next < this.count) this.paint(next, BEACON.next * (1 - BEACON.breathe * 0.5 * (1 + Math.sin(time * Math.PI * 2 * BEACON.rate))));
  }

  private paint(i: number, k: number): void {
    this.tmp.copy(this.base).multiplyScalar(k);
    this.columns.setColorAt(i, this.tmp);
    this.rings.setColorAt(i, this.tmp);
    this.columns.instanceColor!.needsUpdate = true;
    this.rings.instanceColor!.needsUpdate = true;
  }

  dispose(): void {
    this.group.removeFromParent();
    this.columns.dispose();
    this.rings.dispose();
    for (const d of this.disposables) d.dispose();
  }
}

/** A vertical alpha ramp for the columns (v = 0 at the foot): in over the first meters, out toward the top. */
function fadeTexture(): THREE.CanvasTexture {
  const c = document.createElement('canvas');
  c.width = 1;
  c.height = 128;
  const g = c.getContext('2d')!;
  const grad = g.createLinearGradient(0, 128, 0, 0);
  grad.addColorStop(0, 'rgba(255,255,255,0)');
  grad.addColorStop(0.04, 'rgba(255,255,255,0.55)');
  grad.addColorStop(0.35, 'rgba(255,255,255,0.22)');
  grad.addColorStop(1, 'rgba(255,255,255,0)');
  g.fillStyle = grad;
  g.fillRect(0, 0, 1, 128);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}
