/**
 * The waypoint race's waypoints in the city: a curtain of light as wide as
 * what counts as reaching the waypoint (RouteWaypoint radius), standing in its
 * intersection and seen over the rooftops from blocks away, with the whole
 * area lit on the asphalt under it, so a racer sees that anywhere inside
 * registers. Bands of light rise up the curtain and pulse out across the
 * floor to its bright rim. The waypoints count in any order: the player's
 * target (RaceCar.waypointTarget, the one the HUD's arrow points at) burns
 * bright and breathes, the others left glow softer, reached ones go out. The
 * finish line has its gantry (finishLine.ts), so it gets none. Three
 * instanced draw calls (curtains, floors, rims), additive and depth-write
 * free; per frame the target's color and two texture offsets change.
 * Render only: the session passes the player's car.
 */
import * as THREE from 'three';
import type { World } from '../../city/world';
import type { RaceCar } from '../../sim/race';
import { Disposer } from '../disposer';
import { canvas } from '../textures/canvasKit';

export const BEACON = {
  /** Curtain height (m), and its radius at the top over the reach radius at the foot. */
  height: 90,
  flare: 1.12,
  /** Rim width (m) inside the reach radius. */
  ringWidth: 1.2,
  /** Rising bands: spacing up the curtain (m) and climb speed (m/s). */
  bandSpacing: 9,
  rise: 7,
  /** Floor pulses: how many across the radius at once, and how many leave the center per second. */
  pulses: 3,
  pulseRate: 0.8,
  /** HDR brightness of the target (bloom catches it), its breathing depth and rate (Hz), and of the other waypoints left. */
  next: 1.1,
  breathe: 0.35,
  rate: 0.9,
  later: 0.45,
  /** Waypoint race cyan (`--cyan` in ui/styles). */
  color: 0x78dce8,
} as const;

export class WaypointBeacons {
  readonly group = new THREE.Group();
  private readonly curtains: THREE.InstancedMesh;
  private readonly floors: THREE.InstancedMesh;
  private readonly rims: THREE.InstancedMesh;
  private readonly count: number;
  private readonly owned = new Disposer();
  /** The scrolling band textures (alpha maps) of the curtains and the floors. */
  private readonly bands: THREE.Texture;
  private readonly pulses: THREE.Texture;
  private shownReached = -1;
  private shownTarget = -1;
  private readonly base = new THREE.Color(BEACON.color);
  private readonly tmp = new THREE.Color();

  constructor(world: World) {
    const targets = (world.route.waypoints ?? []).slice(0, -1);
    this.count = targets.length;
    this.group.name = 'waypointBeacons';
    const { track } = this.owned;
    // The curtain fades in just above the street and out upward, so it reads as light, not a tube.
    const fade = track(rampTexture([[0, 0], [0.07, 0.5], [0.35, 0.22], [1, 0]]));
    this.bands = track(bandTexture(0.4));
    this.bands.repeat.set(1, BEACON.height / BEACON.bandSpacing);
    // The floor: a soft wash over the area brightening toward the rim (v is the radius).
    const wash = track(rampTexture([[0, 0.12], [0.75, 0.22], [0.97, 0.45], [1, 0.2]]));
    this.pulses = track(bandTexture(0.25));
    this.pulses.repeat.set(1, BEACON.pulses);
    const curtain = track(new THREE.CylinderGeometry(BEACON.flare, 1, BEACON.height, 48, 1, true).translate(0, BEACON.height / 2, 0));
    const floor = track(radialDisc(64, 8).rotateX(-Math.PI / 2));
    const rim = track(new THREE.RingGeometry(1 - BEACON.ringWidth / 14, 1, 64).rotateX(-Math.PI / 2));
    const glow = (map?: THREE.Texture, alphaMap?: THREE.Texture) =>
      track(new THREE.MeshBasicMaterial({ map, alphaMap, transparent: true, blending: THREE.AdditiveBlending, depthWrite: false, side: THREE.DoubleSide, toneMapped: false, fog: false }));
    const n = Math.max(1, this.count);
    this.curtains = track(new THREE.InstancedMesh(curtain, glow(fade, this.bands), n));
    this.floors = track(new THREE.InstancedMesh(floor, glow(wash, this.pulses), n));
    this.rims = track(new THREE.InstancedMesh(rim, glow(), n));
    const m = new THREE.Matrix4();
    const q = new THREE.Quaternion();
    const v = new THREE.Vector3();
    const s = new THREE.Vector3();
    targets.forEach((t, i) => {
      const y = world.heightAt(t.x, t.z);
      this.curtains.setMatrixAt(i, m.compose(v.set(t.x, y, t.z), q, s.set(t.radius, 1, t.radius)));
      this.floors.setMatrixAt(i, m.compose(v.set(t.x, y + 0.05, t.z), q, s));
      this.rims.setMatrixAt(i, m.compose(v.set(t.x, y + 0.07, t.z), q, s));
    });
    for (const mesh of [this.curtains, this.floors, this.rims]) {
      mesh.count = this.count;
      mesh.frustumCulled = false;
      mesh.renderOrder = 2;
      this.group.add(mesh);
    }
    this.update(null, 0);
  }

  /** The player's car (null before the race has one) and the session clock (s). */
  update(car: Pick<RaceCar, 'waypointsReached' | 'waypointTarget' | 'finished'> | null, time: number): void {
    if (!this.count) return;
    const reached = car ? (car.finished ? (1 << this.count) - 1 : car.waypointsReached) : 0;
    const target = car && !car.finished ? car.waypointTarget : 0;
    if (reached !== this.shownReached || target !== this.shownTarget) {
      this.shownReached = reached;
      this.shownTarget = target;
      for (let i = 0; i < this.count; i++) this.paint(i, reached & (1 << i) ? 0 : i === target ? BEACON.next : BEACON.later);
    }
    if (target < this.count && !(reached & (1 << target))) this.paint(target, BEACON.next * (1 - BEACON.breathe * 0.5 * (1 + Math.sin(time * Math.PI * 2 * BEACON.rate))));
    // A falling offset moves the bands toward higher v: up the curtain, out across the floor.
    this.bands.offset.y = -((time * BEACON.rise) / BEACON.bandSpacing) % 1;
    this.pulses.offset.y = -(time * BEACON.pulseRate) % 1;
  }

  private paint(i: number, k: number): void {
    this.tmp.copy(this.base).multiplyScalar(k);
    for (const mesh of [this.curtains, this.floors, this.rims]) {
      mesh.setColorAt(i, this.tmp);
      mesh.instanceColor!.needsUpdate = true;
    }
  }

  dispose(): void {
    this.group.removeFromParent();
    this.owned.dispose();
  }
}

/** A white alpha ramp along v (v = 0 at the canvas foot) through [v, alpha] stops. */
function rampTexture(stops: [number, number][]): THREE.CanvasTexture {
  const [c, g] = canvas(1, 128);
  const grad = g.createLinearGradient(0, 128, 0, 0);
  for (const [at, a] of stops) grad.addColorStop(at, `rgba(255,255,255,${a})`);
  g.fillStyle = grad;
  g.fillRect(0, 0, 1, 128);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

/** One soft band per repeat over a `floor` level (alpha maps read the green channel), wrapping along v. */
function bandTexture(floor: number): THREE.CanvasTexture {
  const [c, g] = canvas(1, 64);
  for (let y = 0; y < 64; y++) {
    const k = floor + (1 - floor) * Math.pow(0.5 + 0.5 * Math.cos(((y + 0.5) / 64) * Math.PI * 2), 3);
    const l = Math.round(k * 255);
    g.fillStyle = `rgb(${l},${l},${l})`;
    g.fillRect(0, y, 1, 1);
  }
  const t = new THREE.CanvasTexture(c);
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  return t;
}

/** A unit disc in the XY plane whose uv is (angle / 2pi, radius), so a texture scrolled along v runs outward. */
function radialDisc(segments: number, rings: number): THREE.RingGeometry {
  const geo = new THREE.RingGeometry(0.01, 1, segments, rings);
  const pos = geo.attributes.position;
  const uv = geo.attributes.uv;
  for (let i = 0; i < pos.count; i++) {
    const x = pos.getX(i);
    const y = pos.getY(i);
    uv.setXY(i, (Math.atan2(y, x) / (Math.PI * 2) + 1) % 1, Math.hypot(x, y));
  }
  return geo;
}
