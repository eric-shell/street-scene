/**
 * Cameras for the street stage (game/streetStage.ts):
 *  - ShowreelCamera: the main menu's attract mode. A new street opens on a
 *    drone shot high behind the car as it rolls up to the start line, over
 *    the crowd and uprights that block the low shots there, then a loop of
 *    shots of the cruising car, cut every several seconds like a car
 *    advert: tracking alongside, chasing, leading it, a roadside camera it drives past, a slow
 *    orbit, a low wheel shot and a high crane over the street. Shots pick the
 *    side of the car that has room and alternate sides from shot to shot.
 *    The menu's steps and transitions move it instead of cutting (setMode):
 *    the race step swings round to a low hero shot of the car's nose, the
 *    setup step drops behind its rear corner as if on the grid, the
 *    settings step drifts into a slow wide orbit, the garage pushes in close
 *    as its door comes down, Explore cranes up for the drone to take over and
 *    a race start drops in low behind the car. Every move eases over from
 *    wherever the camera was, carried along in the car's frame, so it never
 *    jumps however the car moves meanwhile. When the setup step's pick moves
 *    to another car in the convoy (StreetStage.hops) the camera glides to it
 *    along the lane, not through the blocks: its frame rides a point that
 *    runs along the path from where it was to the picked car (back or ahead,
 *    the shorter way), with a swoop up, a wider lens and a touch of speed
 *    blur at the peak.
 *  - FollowOrbit: the garage's Street presentation. Carries the orbit
 *    camera's offset round with the car, so a turn carries the view with it,
 *    and renders through a copy pulled in front of walls and under roofs, so
 *    the player's own zoom is never lost to a passing building.
 * Every camera stays out of the buildings and under anything overhead
 * (render/camera/camera.ts wallHit, render/camera/ceilings.ts clampCeiling). Render only.
 */
import * as THREE from 'three';
import type { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import type { World } from '../city/world';
import type { CarPose } from '../render/car/carView';
import { wallHit } from '../render/camera/camera';
import { clampCeiling } from '../render/camera/ceilings';
import type { PathSample } from './cruise';
import type { StreetStage } from './streetStage';

/** A point in the car's frame: forward, left, up (m). */
type Local = [number, number, number];

/** What a car frame needs: a position (m) and a heading (rad). */
type Frame = Pick<CarPose, 'x' | 'y' | 'z' | 'yaw'>;

/**
 * The glide after a hop: how long it takes over `ref` m of street (s; a longer
 * glide takes longer, by the square root, up to `maxDur`), and at its peak how
 * high it swoops (m), how far the lens widens (degrees) and the speed blur.
 */
const GLIDE = { dur: 0.95, ref: 38, maxDur: 1.9, rise: 1.2, fov: 7, blur: 0.45 } as const;

interface Shot {
  name: string;
  /** Length (s); a roadside shot ends sooner once the car has gone by. */
  dur: number;
  fov: number;
  /** The lens it zooms to by the end, eased with the move (degrees); held at `fov` when missing. */
  fovEnd?: number;
  /** Camera and look-at in the car's frame at progress u (0..1), favouring `side` (+1 left, -1 right), written into `o`. */
  cam(u: number, side: number, o: Local): Local;
  look(u: number, side: number, o: Local): Local;
  /** Shots that do not care about the side never flip for room. */
  sided: boolean;
  /** Ends exactly on the next shot's first frame, so the next shot carries on from it on the same side with no cut. */
  flows?: boolean;
}

const lerp = (a: number, b: number, u: number) => a + (b - a) * u;
const ease = (u: number) => u * u * (3 - 2 * u);
/** Write a point in the car's frame into `o` (shots fill a scratch tuple, so nothing is allocated per frame). */
const at = (o: Local, f: number, l: number, up: number): Local => ((o[0] = f), (o[1] = l), (o[2] = up), o);

/** The shot list, in the order the showreel plays it: the drone opener once, then the rest on a loop. */
const SHOTS: Shot[] = [
  // One move from high behind the car down onto the tracking shot's first frame: the car low in frame with the start
  // line ahead, then a swoop round behind it and down to its flank. It arcs round the car (DRONE) rather than cutting
  // across, and aims at the car and holds the wide lens until late, so the whole car stays in frame all the way down.
  // The height falls late (ease^1.6), so the camera is still about 14 m up as it passes the line (about 4.4 s in, over
  // the full gantry's 11.9 m), flying over the arch, not through it.
  { name: 'drone', dur: 9, fov: 54, fovEnd: 38, sided: true, flows: true, cam: (u, s, o) => drone(ease(u), s, o), look: (u, _s, o) => at(o, lerp(14, 0.1, 1 - (1 - ease(u)) ** 2), 0, lerp(0.5, 0.62, ease(u))) },
  { name: 'tracking', dur: 9, fov: 38, sided: true, cam: (u, s, o) => at(o, lerp(1.6, -1.0, u), 6.6 * s, 0.9), look: (_u, _s, o) => at(o, 0.1, 0, 0.62) },
  { name: 'chase', dur: 8, fov: 46, sided: true, cam: (u, s, o) => at(o, -6.4, 1.3 * s, 1.55 + 0.25 * u), look: (_u, _s, o) => at(o, 4.5, 0, 0.9) },
  { name: 'roadside', dur: 10, fov: 36, sided: false, cam: (_u, _s, o) => at(o, 0, 0, 0), look: (_u, _s, o) => at(o, 0, 0, 0) },
  { name: 'orbit', dur: 12, fov: 40, sided: true, cam: (u, s, o) => orbit(s * (0.55 + 2.4 * ease(u)), 6.8, 1.5, o), look: (_u, _s, o) => at(o, 0, 0, 0.58) },
  { name: 'lead', dur: 8, fov: 36, sided: true, cam: (u, s, o) => at(o, lerp(8.8, 6.6, u), 1.3 * s, 1.05), look: (_u, _s, o) => at(o, 0, 0, 0.62) },
  { name: 'wheel', dur: 7, fov: 30, sided: true, cam: (u, s, o) => at(o, lerp(2.6, 0.9, u), 2.7 * s, 0.42), look: (_u, s, o) => at(o, 1.25, 0.8 * s, 0.34) },
  { name: 'crane', dur: 10, fov: 48, sided: true, cam: (u, s, o) => at(o, lerp(-10.5, -7.5, u), 2.8 * s, lerp(13.5, 7.5, ease(u))), look: (_u, _s, o) => at(o, 6, 0, 0.4) },
];

/** Where the loop starts again: the opener plays once per street. */
const LOOP_START = 1;

/**
 * The drone opener's arc round the car: from 14 m behind and 2.5 m to the
 * other side, round behind the car to the tracking shot's start (1.6 m
 * ahead, 6.6 m out), angle and radius eased together.
 */
const DRONE = { a0: Math.atan2(-2.5, -14), a1: Math.atan2(6.6, 1.6) - 2 * Math.PI, r0: Math.hypot(14, 2.5), r1: Math.hypot(6.6, 1.6) } as const;

/** The drone opener's camera at eased progress e, favouring `side`. */
function drone(e: number, side: number, o: Local): Local {
  return orbit(side * lerp(DRONE.a0, DRONE.a1, e), lerp(DRONE.r0, DRONE.r1, e), lerp(20, 0.9, e ** 1.6), o);
}

/** A point on a circle round the car at angle a (0 = straight ahead, + turning left), radius r and height y. */
function orbit(a: number, r: number, y: number, o: Local): Local {
  return at(o, Math.cos(a) * r, Math.sin(a) * r, y);
}

/** What the showreel shoots: its loop of cut shots, or one held move for a menu step or a transition. */
export type ReelMode = 'reel' | 'hero' | 'grid' | 'calm' | 'push' | 'lift' | 'launch';

/** A held move: camera and look-at in the car's frame t seconds into it, favouring `side`, and its lens. */
interface Move {
  fov: number;
  /** How long the ease over from the previous camera takes (s). */
  blend: number;
  cam(t: number, side: number, o: Local): Local;
  look(t: number, side: number, o: Local): Local;
}

const MOVES: Record<Exclude<ReelMode, 'reel'>, Move> = {
  // The race step: low off the front corner on a long lens, breathing a little closer and back.
  hero: { fov: 32, blend: 1.5, cam: (t, s, o) => at(o, 6.6 + 0.6 * Math.sin(t * 0.21), (2.7 + 0.5 * Math.sin(t * 0.13)) * s, 0.62 + 0.08 * Math.sin(t * 0.17)), look: (_t, s, o) => at(o, -0.2, 0.25 * s, 0.62) },
  // The setup step: low off the rear corner, easing forward along the flank, as if lining up on the grid.
  grid: { fov: 34, blend: 1.3, cam: (t, s, o) => at(o, -6.2 + 0.7 * Math.sin(t * 0.18), (2.9 + 0.3 * Math.sin(t * 0.11)) * s, 0.7), look: (_t, s, o) => at(o, 1.2, 0.2 * s, 0.55) },
  // Settings: a slow, wide orbit while the player reads.
  calm: { fov: 44, blend: 1.8, cam: (t, s, o) => orbit(s * (2.2 + t * 0.045), 9.5, 2.9, o), look: (_t, _s, o) => at(o, 0, 0, 0.5) },
  // Into the garage: a push in close on the flank as the door comes down.
  push: { fov: 30, blend: 0.6, cam: (t, s, o) => at(o, 1.6 - t * 0.6, 2.3 * s, 0.85), look: (_t, _s, o) => at(o, 0.2, 0, 0.6) },
  // Explore: up off the street, looking down the road ahead, where the drone takes over.
  lift: { fov: 50, blend: 0.9, cam: (_t, s, o) => at(o, -13, 2.5 * s, 15), look: (_t, _s, o) => at(o, 14, 0, 0) },
  // A race start: down low behind the car, as if lining up on the grid.
  launch: { fov: 56, blend: 0.45, cam: (_t, s, o) => at(o, -4.6, 0.7 * s, 0.6), look: (_t, _s, o) => at(o, 8, 0, 0.55) },
};

/** Car frame to world: forward is (sin yaw, cos yaw), left is (cos yaw, -sin yaw). */
function toWorld(p: Frame, l: Local, out: THREE.Vector3): THREE.Vector3 {
  const s = Math.sin(p.yaw);
  const c = Math.cos(p.yaw);
  return out.set(p.x + l[0] * s + l[1] * c, p.y + l[2], p.z + l[0] * c - l[1] * s);
}

/** World to the car frame (forward, left, up), the inverse of toWorld. */
function toLocal(p: Frame, v: THREE.Vector3, o: Local): Local {
  const s = Math.sin(p.yaw);
  const c = Math.cos(p.yaw);
  const dx = v.x - p.x;
  const dz = v.z - p.z;
  return at(o, dx * s + dz * c, dx * c - dz * s, v.y - p.y);
}

/** Smootherstep: starts and lands with no jolt. */
const smoother = (u: number) => u * u * u * (u * (u * 6 - 15) + 10);

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
  private mode: ReelMode = 'reel';
  /** Seconds into the current move. */
  private moveT = 0;
  /** The ease from the camera as it was when the mode changed (car frame), 0..1 over `blendDur` s. */
  private blend = 1;
  private blendDur = 1;
  private readonly fromCam: Local = [0, 0, 0];
  private readonly fromLook: Local = [0, 0, 0];
  private fromFov = 40;
  private readonly goal = new THREE.Vector3();
  private readonly goalLook = new THREE.Vector3();
  private readonly tmp = new THREE.Vector3();
  /** The stage last shot, to capture the camera in its car's frame when the mode changes. */
  private stage: StreetStage | null = null;
  /** The stage's hop count last frame: a change starts a glide. */
  private hopsSeen = 0;
  /** The frame the camera was set in last frame (the car's, or the glide's) and its distance along the path (m). */
  private readonly lastFrame: Frame = { x: 0, y: 0, z: 0, yaw: 0 };
  private lastS = 0;
  /**
   * The glide after a hop, 0..1 (1: none): the path distance it covers (m),
   * the camera and its aim where they were in the frame it left, and the
   * height that frame stood above the road under its middle (m).
   */
  private glide = 1;
  private glideDur: number = GLIDE.dur;
  private glideDist = 0;
  private readonly glideCam: Local = [0, 0, 0];
  private readonly glideLook: Local = [0, 0, 0];
  private glideLift = 0;
  private readonly glideFrame: Frame = { x: 0, y: 0, z: 0, yaw: 0 };
  private readonly goalLocal: Local = [0, 0, 0];

  /** Start the reel over on its opener, for a newly built street with the car on the start line. */
  open(): void {
    this.index = -1;
    this.cut();
  }

  /** Move on to the next shot now. */
  cut(): void {
    this.t = Infinity;
    this.blend = 1;
  }

  /** The current mode: the shot loop or a held move. */
  get current(): ReelMode {
    return this.mode;
  }

  /**
   * Ease over to a mode from wherever the camera is now (or cut to it, with
   * `blend` false): a held move, or back to the shot loop, which starts on its
   * next shot.
   */
  setMode(mode: ReelMode, blend = true): void {
    if (mode === this.mode && blend) return;
    const p = this.stage?.pose;
    this.blend = 1;
    if (p && blend) {
      toLocal(p, this.camera.position, this.fromCam);
      toLocal(p, this.look, this.fromLook);
      this.fromFov = this.camera.fov;
      this.blend = 0;
    }
    this.mode = mode;
    this.moveT = 0;
    this.blendDur = mode === 'reel' ? 1.6 : MOVES[mode].blend;
    if (mode === 'reel') this.t = Infinity;
    else if (this.stage) this.pickSide(this.stage, MOVES[mode].cam);
  }

  /** Speed blur for the stage's render: a touch at the peak of a glide, none otherwise. */
  get blur(): number {
    return this.glide < 1 ? GLIDE.blur * Math.sin(Math.PI * smoother(this.glide)) : 0;
  }

  /** The point the camera is aimed at this frame (world space), for a camera taking over from this one. */
  get lookTarget(): THREE.Vector3 {
    return this.look;
  }

  /** Where the camera is and looks, as the drone wants a start pose (yaw and pitch, forward = (sin yaw, cos yaw)). */
  pose(): { x: number; y: number; z: number; yaw: number; pitch: number } {
    const d = this.camera.getWorldDirection(this.tmp);
    return { x: this.camera.position.x, y: this.camera.position.y, z: this.camera.position.z, yaw: Math.atan2(d.x, d.z), pitch: Math.asin(Math.max(-1, Math.min(1, d.y))) };
  }

  update(stage: StreetStage, dt: number): void {
    // A new street starts with its own hop count: nothing to glide from.
    if (stage !== this.stage) {
      this.hopsSeen = stage.hops;
      this.glide = 1;
    }
    if (stage.hops !== this.hopsSeen) this.startGlide(stage);
    this.stage = stage;
    this.clock += dt;
    this.t += dt;
    this.moveT += dt;
    const p = stage.pose;
    const pos = this.goal;
    const look = this.goalLook;
    let fov: number;
    if (this.mode === 'reel') {
      const shot = SHOTS[this.index];
      const done = !shot || this.t >= shot.dur || (shot.name === 'roadside' && stage.path.wrap(stage.s - this.fixedS) > 24 && stage.path.wrap(stage.s - this.fixedS) < stage.path.length / 2);
      if (done) this.next(stage);
      const s = SHOTS[this.index];
      const u = Math.min(1, this.t / s.dur);
      // The zoom comes late (ease^3): the wide lens holds the whole car while the camera is close and above it.
      fov = s.fovEnd === undefined ? s.fov : lerp(s.fov, s.fovEnd, ease(u) ** 3);
      if (s.name === 'roadside') {
        pos.copy(this.fixed);
        // Aim a little ahead of the car, so it drives into the frame and past.
        look.set(p.x + Math.sin(p.yaw) * 1.5, p.y + 0.6, p.z + Math.cos(p.yaw) * 1.5);
      } else {
        toWorld(p, s.cam(u, this.side, this.local), pos);
        toWorld(p, s.look(u, this.side, this.local), look);
        this.keepClear(stage.world, p, pos);
      }
    } else {
      const m = MOVES[this.mode];
      fov = m.fov;
      toWorld(p, m.cam(this.moveT, this.side, this.local), pos);
      toWorld(p, m.look(this.moveT, this.side, this.local), look);
      this.keepClear(stage.world, p, pos);
    }
    const cam = this.camera;
    if (this.blend < 1) {
      // Ease from where the camera was, carried along with the car, so the move never jumps.
      this.blend = Math.min(1, this.blend + dt / this.blendDur);
      const e = smoother(this.blend);
      pos.lerpVectors(toWorld(p, this.fromCam, this.tmp), pos, e);
      look.lerpVectors(toWorld(p, this.fromLook, this.tmp), look, e);
      fov = this.fromFov + (fov - this.fromFov) * e;
      this.keepClear(stage.world, p, pos);
    }
    let frame: Frame = p;
    let frameS = stage.s;
    if (this.glide < 1) {
      this.glide = Math.min(1, this.glide + dt / this.glideDur);
      const e = smoother(this.glide);
      const arc = Math.sin(Math.PI * e);
      frameS = stage.path.wrap(stage.s - this.glideDist * (1 - e));
      frame = this.glideFrameAt(stage, frameS, e);
      // The camera and its aim ease from where they were in the frame they left to the shot's, in the gliding frame.
      const g = this.goalLocal;
      const a = this.glideCam;
      toLocal(p, pos, g);
      toWorld(frame, at(this.local, lerp(a[0], g[0], e), lerp(a[1], g[1], e), lerp(a[2], g[2], e) + GLIDE.rise * arc), pos);
      const b = this.glideLook;
      toLocal(p, look, g);
      toWorld(frame, at(this.local, lerp(b[0], g[0], e), lerp(b[1], g[1], e), lerp(b[2], g[2], e) + 0.5 * GLIDE.rise * arc), look);
      fov += GLIDE.fov * arc;
      this.keepClear(stage.world, frame, pos);
    }
    this.lastFrame.x = frame.x;
    this.lastFrame.y = frame.y;
    this.lastFrame.z = frame.z;
    this.lastFrame.yaw = frame.yaw;
    this.lastS = frameS;
    cam.position.copy(pos);
    this.look.copy(look);
    // A breath of handheld sway, the same at any frame rate.
    const k = this.clock;
    cam.position.x += Math.sin(k * 0.71) * 0.025 + Math.sin(k * 1.93) * 0.012;
    cam.position.y += Math.sin(k * 0.53 + 1.3) * 0.02;
    cam.lookAt(this.look);
    if (Math.abs(cam.fov - fov) > 0.01) {
      cam.fov = fov;
      cam.updateProjectionMatrix();
    }
  }

  /**
   * The pick moved to another car in the convoy: glide to it from the frame the camera
   * was in last frame (mid glide too, so a quick run of picks never jumps),
   * taking over any ease still running. A roadside shot's camera is
   * stood again ahead of the new car.
   */
  private startGlide(stage: StreetStage): void {
    this.hopsSeen = stage.hops;
    if (!this.stage) return;
    const f = this.lastFrame;
    toLocal(f, this.camera.position, this.glideCam);
    toLocal(f, this.look, this.glideLook);
    // Signed: the shorter way round the loop, so a hop back glides back.
    const d = stage.path.wrap(stage.s - this.lastS);
    this.glideDist = d > stage.path.length / 2 ? d - stage.path.length : d;
    this.glideDur = Math.min(GLIDE.maxDur, GLIDE.dur * Math.sqrt(Math.max(1, Math.abs(this.glideDist) / GLIDE.ref)));
    this.glideLift = f.y - stage.world.heightAt(f.x, f.z, f.y);
    // The gliding frame's last height is the level hint under a river deck (World.heightAt).
    this.glideFrame.y = f.y;
    this.glide = 0;
    this.blend = 1;
    if (this.mode === 'reel' && SHOTS[this.index]?.name === 'roadside') this.placeRoadside(stage);
  }

  /**
   * The gliding frame at path distance s, e of the way through the glide: on
   * the lane, its height above the road eased from the old frame's to the
   * car's, so the glide starts and lands exactly on them.
   */
  private glideFrameAt(stage: StreetStage, s: number, e: number): Frame {
    const c = stage.path.sample(s, this.sample);
    const f = this.glideFrame;
    const p = stage.pose;
    const ground = stage.world.heightAt(c.x, c.z, f.y);
    const carLift = p.y - stage.world.heightAt(p.x, p.z, p.y);
    f.x = c.x;
    f.z = c.z;
    f.yaw = c.yaw;
    f.y = ground + lerp(this.glideLift, carLift, e);
    return f;
  }

  /** Take the side of the car with room for a move's camera. */
  private pickSide(stage: StreetStage, cam: Move['cam']): void {
    const p = stage.pose;
    const room = (side: number) => {
      const c = toWorld(p, cam(0, side, this.local), this.tmp);
      return wallHit(stage.world, p.x, p.z, c.x, c.z, this.scratch);
    };
    if (room(this.side) < 0.9 && room(-this.side) > room(this.side)) this.side = -this.side;
  }

  /** Cut to the next shot: alternate sides, and take the side with room when the shot has one (a flowing shot's next keeps its side). */
  private next(stage: StreetStage): void {
    // A shot that flows into this one hands over its side too, or the camera would jump across the car.
    const flowed = SHOTS[this.index]?.flows;
    this.index = this.index + 1 < SHOTS.length ? this.index + 1 : LOOP_START;
    this.t = 0;
    const s = SHOTS[this.index];
    const p = stage.pose;
    if (!flowed) this.side = -this.side;
    if (s.sided && !flowed) {
      // A flowing shot settles where the next one starts, so that is where it needs the room.
      const room = (side: number) => {
        const c = toWorld(p, s.cam(s.flows ? 1 : 0.5, side, this.local), this.fixed);
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
  private keepClear(world: World, p: Frame, pos: THREE.Vector3): void {
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
