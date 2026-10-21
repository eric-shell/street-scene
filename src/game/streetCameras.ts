/**
 * Cameras for the street stage (game/streetStage.ts):
 *  - ShowreelCamera: the main menu's attract mode. A loop of shots of the
 *    cruising car, cut every several seconds like a car advert: tracking
 *    alongside, chasing, leading it, a roadside camera it drives past, a slow
 *    orbit, a low wheel shot and a high crane over the street. Shots pick the
 *    side of the car that has room and alternate sides from shot to shot.
 *  - FollowOrbit: the garage's Street presentation. Carries the orbit
 *    camera's offset round with the car, so a turn carries the view with it,
 *    and renders through a copy pulled in front of walls and under roofs, so
 *    the player's own zoom is never lost to a passing building.
 * Every camera stays out of the buildings and under anything overhead
 * (render/camera.ts wallHit, render/ceilings.ts clampCeiling). Render only.
 */
import * as THREE from 'three';
import type { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import type { World } from '../city/world';
import type { CarPose } from '../render/carView';
import { wallHit } from '../render/camera';
import { clampCeiling } from '../render/ceilings';
import type { PathSample, StreetStage } from './streetStage';

/** A point in the car's frame: forward, left, up (m). */
type Local = [number, number, number];

interface Shot {
  name: string;
  /** Length (s); a roadside shot ends sooner once the car has gone by. */
  dur: number;
  fov: number;
  /** Camera and look-at in the car's frame at progress u (0..1), favouring `side` (+1 left, -1 right), written into `o`. */
  cam(u: number, side: number, o: Local): Local;
  look(u: number, side: number, o: Local): Local;
  /** Shots that do not care about the side never flip for room. */
  sided: boolean;
}

const lerp = (a: number, b: number, u: number) => a + (b - a) * u;
const ease = (u: number) => u * u * (3 - 2 * u);
/** Write a point in the car's frame into `o` (shots fill a scratch tuple, so nothing is allocated per frame). */
const at = (o: Local, f: number, l: number, up: number): Local => ((o[0] = f), (o[1] = l), (o[2] = up), o);

/** The shot list, in the order the showreel plays it. */
const SHOTS: Shot[] = [
  { name: 'tracking', dur: 9, fov: 38, sided: true, cam: (u, s, o) => at(o, lerp(1.6, -1.0, u), 6.6 * s, 0.9), look: (_u, _s, o) => at(o, 0.1, 0, 0.62) },
  { name: 'chase', dur: 8, fov: 46, sided: true, cam: (u, s, o) => at(o, -6.4, 1.3 * s, 1.55 + 0.25 * u), look: (_u, _s, o) => at(o, 4.5, 0, 0.9) },
  { name: 'roadside', dur: 10, fov: 36, sided: false, cam: (_u, _s, o) => at(o, 0, 0, 0), look: (_u, _s, o) => at(o, 0, 0, 0) },
  { name: 'orbit', dur: 12, fov: 40, sided: true, cam: (u, s, o) => orbit(s * (0.55 + 2.4 * ease(u)), 6.8, 1.5, o), look: (_u, _s, o) => at(o, 0, 0, 0.58) },
  { name: 'lead', dur: 8, fov: 36, sided: true, cam: (u, s, o) => at(o, lerp(8.8, 6.6, u), 1.3 * s, 1.05), look: (_u, _s, o) => at(o, 0, 0, 0.62) },
  { name: 'wheel', dur: 7, fov: 30, sided: true, cam: (u, s, o) => at(o, lerp(2.6, 0.9, u), 2.7 * s, 0.42), look: (_u, s, o) => at(o, 1.25, 0.8 * s, 0.34) },
  { name: 'crane', dur: 10, fov: 48, sided: true, cam: (u, s, o) => at(o, lerp(-10.5, -7.5, u), 2.8 * s, lerp(13.5, 7.5, ease(u))), look: (_u, _s, o) => at(o, 6, 0, 0.4) },
];

/** A point on a circle round the car at angle a (0 = straight ahead, + turning left), radius r and height y. */
function orbit(a: number, r: number, y: number, o: Local): Local {
  return at(o, Math.cos(a) * r, Math.sin(a) * r, y);
}

/** Car frame to world: forward is (sin yaw, cos yaw), left is (cos yaw, -sin yaw). */
function toWorld(p: CarPose, l: Local, out: THREE.Vector3): THREE.Vector3 {
  const s = Math.sin(p.yaw);
  const c = Math.cos(p.yaw);
  return out.set(p.x + l[0] * s + l[1] * c, p.y + l[2], p.z + l[0] * c - l[1] * s);
}

export class ShowreelCamera {
  readonly camera = new THREE.PerspectiveCamera(40, 1, 0.1, 2500);
  private index = -1;
  private t = 0;
  private side = 1;
  /** The roadside shot's fixed camera, and the path distance it was set beside. */
  private readonly fixed = new THREE.Vector3();
  private fixedS = 0;
  private readonly look = new THREE.Vector3();
  private readonly local: Local = [0, 0, 0];
  private readonly scratch: number[] = [];
  private readonly sample: PathSample = { x: 0, z: 0, tx: 0, tz: 1, yaw: 0, k: 0 };
  private clock = 0;

  /** Move on to the next shot now. */
  cut(): void {
    this.t = Infinity;
  }

  update(stage: StreetStage, dt: number): void {
    this.clock += dt;
    this.t += dt;
    const shot = SHOTS[this.index];
    const p = stage.pose;
    const done = !shot || this.t >= shot.dur || (shot.name === 'roadside' && stage.path.wrap(stage.s - this.fixedS) > 24 && stage.path.wrap(stage.s - this.fixedS) < stage.path.length / 2);
    if (done) this.next(stage);
    const s = SHOTS[this.index];
    const u = Math.min(1, this.t / s.dur);
    const cam = this.camera;
    if (s.name === 'roadside') {
      cam.position.copy(this.fixed);
      // Aim a little ahead of the car, so it drives into the frame and past.
      this.look.set(p.x + Math.sin(p.yaw) * 1.5, p.y + 0.6, p.z + Math.cos(p.yaw) * 1.5);
    } else {
      toWorld(p, s.cam(u, this.side, this.local), cam.position);
      toWorld(p, s.look(u, this.side, this.local), this.look);
      this.keepClear(stage.world, p, cam.position);
    }
    // A breath of handheld sway, the same at any frame rate.
    const k = this.clock;
    cam.position.x += Math.sin(k * 0.71) * 0.025 + Math.sin(k * 1.93) * 0.012;
    cam.position.y += Math.sin(k * 0.53 + 1.3) * 0.02;
    cam.lookAt(this.look);
    if (cam.fov !== s.fov) {
      cam.fov = s.fov;
      cam.updateProjectionMatrix();
    }
  }

  /** Cut to the next shot: alternate sides, and take the side with room when the shot has one. */
  private next(stage: StreetStage): void {
    this.index = (this.index + 1) % SHOTS.length;
    this.t = 0;
    const s = SHOTS[this.index];
    const p = stage.pose;
    this.side = -this.side;
    if (s.sided) {
      const room = (side: number) => {
        const c = toWorld(p, s.cam(0.5, side, this.local), this.fixed);
        return wallHit(stage.world, p.x, p.z, c.x, c.z, this.scratch);
      };
      if (room(this.side) < 0.9 && room(-this.side) > room(this.side)) this.side = -this.side;
    }
    if (s.name === 'roadside') this.placeRoadside(stage);
  }

  /** Stand the roadside camera on the right hand curb a few seconds ahead of the car. */
  private placeRoadside(stage: StreetStage): void {
    const ahead = 12 + Math.max(stage.speed, 6) * 3.4;
    this.fixedS = stage.path.wrap(stage.s + ahead);
    const c = stage.path.sample(this.fixedS, this.sample);
    // Right of the heading is (-tz, tx): toward the curb from the right lane.
    const want = 5.4;
    const x = c.x - c.tz * want;
    const z = c.z + c.tx * want;
    const hit = wallHit(stage.world, c.x, c.z, x, z, this.scratch);
    const t = hit < 1 ? Math.max(0.3, hit - 0.15) : 1;
    const fx = c.x + (x - c.x) * t;
    const fz = c.z + (z - c.z) * t;
    this.fixed.set(fx, stage.world.heightAt(fx, fz) + 1.25, fz);
    clampCeiling(stage.world, this.fixed);
  }

  /** Pull a camera in front of any wall between it and the car, keep it off the ground and under roofs. */
  private keepClear(world: World, p: CarPose, pos: THREE.Vector3): void {
    const hit = wallHit(world, p.x, p.z, pos.x, pos.z, this.scratch);
    if (hit < 1) {
      const t = Math.max(0.2, hit - 0.06);
      pos.x = p.x + (pos.x - p.x) * t;
      pos.z = p.z + (pos.z - p.z) * t;
      pos.y += (1 - t) * 1.2;
    }
    pos.y = Math.max(pos.y, world.heightAt(pos.x, pos.z) + 0.3);
    clampCeiling(world, pos);
  }
}

/**
 * The garage's orbit camera on the street: the controls' camera and target ride
 * along in the car's frame (follow, before controls.update()), and `resolve`
 * gives the camera to render with, pulled in front of walls and under roofs.
 */
export class FollowOrbit {
  /** The camera to render with. */
  readonly view = new THREE.PerspectiveCamera();
  /** The car's pose last frame, or not yet known. */
  private readonly last = { x: 0, y: 0, z: 0, yaw: 0 };
  private known = false;
  private readonly scratch: number[] = [];

  /** Forget the car's last pose (after the camera was placed by hand). */
  reset(): void {
    this.known = false;
  }

  /** Carry the camera and the controls' target with the car's move and turn since last frame. */
  follow(camera: THREE.PerspectiveCamera, controls: OrbitControls, pose: CarPose): void {
    const last = this.last;
    if (this.known) {
      const d = pose.yaw - last.yaw;
      const c = Math.cos(d);
      const s = Math.sin(d);
      this.carry(camera.position, pose, c, s);
      this.carry(controls.target, pose, c, s);
    }
    last.x = pose.x;
    last.y = pose.y;
    last.z = pose.z;
    last.yaw = pose.yaw;
    this.known = true;
  }

  /** Move a point that rode with the car at its last pose to the same place relative to the car now (turned by cos c, sin s). */
  private carry(v: THREE.Vector3, pose: CarPose, c: number, s: number): void {
    const ox = v.x - this.last.x;
    const oz = v.z - this.last.z;
    v.set(pose.x + ox * c + oz * s, v.y + pose.y - this.last.y, pose.z - ox * s + oz * c);
  }

  /** The render camera: the orbit camera, pulled toward the car out of walls, off the ground and under roofs. */
  resolve(camera: THREE.PerspectiveCamera, target: THREE.Vector3, world: World): THREE.PerspectiveCamera {
    const v = this.view;
    v.position.copy(camera.position);
    v.quaternion.copy(camera.quaternion);
    if (v.fov !== camera.fov || v.near !== camera.near || v.far !== camera.far) {
      v.fov = camera.fov;
      v.near = camera.near;
      v.far = camera.far;
      v.updateProjectionMatrix();
    }
    const hit = wallHit(world, target.x, target.z, v.position.x, v.position.z, this.scratch);
    let moved = false;
    if (hit < 1) {
      const t = Math.max(0.25, hit - 0.08);
      v.position.x = target.x + (v.position.x - target.x) * t;
      v.position.z = target.z + (v.position.z - target.z) * t;
      moved = true;
    }
    const floor = world.heightAt(v.position.x, v.position.z) + 0.25;
    if (v.position.y < floor) {
      v.position.y = floor;
      moved = true;
    }
    const y = v.position.y;
    clampCeiling(world, v.position);
    if (moved || v.position.y !== y) v.lookAt(target);
    return v;
  }
}
