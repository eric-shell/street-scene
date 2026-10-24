/**
 * Race start and finish camera shots, layered on top of the chase camera.
 * The chase camera keeps updating underneath every frame, so a shot can land
 * exactly on it (intro) or start from wherever it was (outro).
 *
 * Intro: a fly-in that starts high above the road ahead of the grid, looking
 * back through the start gantry, curves down over the grid and lands on the
 * gameplay camera at the instant the race goes green.
 * Outro: after the player crosses the line the camera swings around the car
 * to a low, wide angle hero shot in front of it, then drifts in a slow orbit.
 * Timing and framing come from CAMERA.intro / CAMERA.outro. Render only.
 * The fly-in carries a title card with the seed's event (Hill Climb, River
 * Run, ...; city/events.ts), shown while the HUD is hidden for the shot.
 * Handoff: free roam taken over from the menu starts on the showreel's shot
 * (game/streetCameras.ts) and swings round the car onto the chase camera; the
 * shot is carried in the car's frame and blended in polar coordinates around
 * the car, so it rides along with the car and never passes through it. The
 * HUD stays hidden until the swing settles, then fades in. The overlays and the
 * HUD's hiding classes are styled by _cinematics.scss beside this file.
 */
import * as THREE from 'three';
import type { World } from '../../city/world';
import { routeSample } from '../../city/route';
import { CAMERA, ChaseCamera } from './camera';
import type { CarPose } from '../car/carView';

const DEG = Math.PI / 180;
const UP = new THREE.Vector3(0, 1, 0);
const SKIP_BLEND = 0.6;

/** Symmetric ease in-out with adjustable steepness (k = 1 is linear). */
function ease(u: number, k: number): number {
  const a = Math.pow(Math.max(0, Math.min(1, u)), k);
  const b = Math.pow(Math.max(0, Math.min(1, 1 - u)), k);
  return a + b > 0 ? a / (a + b) : 0;
}

const smooth = (u: number) => {
  const x = Math.max(0, Math.min(1, u));
  return x * x * (3 - 2 * x);
};

const wrap = (a: number) => {
  while (a > Math.PI) a -= Math.PI * 2;
  while (a < -Math.PI) a += Math.PI * 2;
  return a;
};

interface Pose {
  pos: THREE.Vector3;
  look: THREE.Vector3;
  fov: number;
  roll: number;
}

const newPose = (): Pose => ({ pos: new THREE.Vector3(), look: new THREE.Vector3(), fov: 60, roll: 0 });

/** Smootherstep: starts and lands with no jolt. */
const smoother = (u: number) => {
  const x = Math.max(0, Math.min(1, u));
  return x * x * x * (x * (x * 6 - 15) + 10);
};

/** A camera pose in the car's frame: around the car (rad, 0 straight ahead, + to its left), out from it and up (m), and the look point (forward, left, up). */
interface CarFramePose {
  theta: number;
  radius: number;
  height: number;
  look: THREE.Vector3;
  fov: number;
}

/** How long the HUD's fade in keeps its transition after the handoff settles (s), and the most one frame advances the swing (s). */
const REVEAL = 1.2;
const MAX_STEP = 0.1;
/** How long everything on screen takes to come back once the letterbox lifts (ms): the bars' slide out, then the fade in (body.is-unboxing, _cinematics.scss). */
const UNBOX_MS = 1300;

/** The showreel's shot, where it must be on screen a few seconds before the player gets a HUD. */
export interface HandoffShot {
  position: THREE.Vector3;
  look: THREE.Vector3;
  fov: number;
}

export class RaceCinematics {
  /** 'intro' until the race goes green, 'outro' after the player finishes, 'handoff' while the menu's shot swings onto the chase camera. */
  phase: 'none' | 'intro' | 'outro' | 'handoff' = 'none';
  private shot = newPose();
  private chase = newPose();
  private skipFrom: Pose | null = null;
  private skipT = 0;
  // Handoff: the shot it starts from in the car's frame, the chase camera read into the same frame, progress.
  private handFrom: CarFramePose = { theta: 0, radius: 1, height: 1, look: new THREE.Vector3(), fov: 60 };
  private handTo: CarFramePose = { theta: Math.PI, radius: 1, height: 1, look: new THREE.Vector3(), fov: 60 };
  private handT = 0;
  private handDur = 1;
  private readonly tmp = new THREE.Vector3();
  /** Seconds left of the HUD's fade in after the handoff. */
  private reveal = 0;
  // Intro geometry, fixed at the start.
  private p0 = new THREE.Vector3();
  private p1 = new THREE.Vector3();
  private l0 = new THREE.Vector3();
  // Outro state.
  private outroT = 0;
  private captured = false;
  private theta0 = 0;
  private radius0 = 0;
  private height0 = 0;
  private fov0 = 60;
  private look0 = new THREE.Vector3();
  private side = 1;
  private yawS = 0;
  readonly hint: HTMLElement | null = null;
  private bars: HTMLElement | null = null;
  private unboxTimer = 0;
  /** The event title card over the fly-in (absent in the open world). */
  private title: HTMLElement | null = null;

  constructor(
    private readonly cam: ChaseCamera,
    private readonly world: World,
    hintParent?: HTMLElement | null,
  ) {
    if (hintParent) {
      this.hint = document.createElement('div');
      this.hint.className = 'cinematic-skip';
      this.hint.textContent = 'Enter / tap to skip';
      hintParent.append(this.hint);
      this.bars = document.createElement('div');
      this.bars.className = 'cinematic-bars';
      hintParent.append(this.bars);
      if (world.event && !world.openWorld) {
        this.title = document.createElement('div');
        this.title.className = 'cinematic-title';
        const name = document.createElement('b');
        name.className = 'cinematic-title__name';
        name.textContent = world.event.name;
        const tag = document.createElement('span');
        tag.className = 'cinematic-title__tagline';
        tag.textContent = world.event.tagline;
        this.title.append(name, tag);
        hintParent.append(this.title);
      }
    }
  }

  get active(): boolean {
    return this.phase !== 'none';
  }

  /** Begin the fly-in for a car sitting on the grid at route distance s. */
  startIntro(p: CarPose, s: number): void {
    const q = CAMERA.intro;
    const route = this.world.route;
    const fx = Math.sin(p.yaw);
    const fz = Math.cos(p.yaw);
    // Left of the heading is (fz, -fx).
    const ahead = routeSample(route, s + q.aheadDist);
    const mid = routeSample(route, s + q.aheadDist * 0.35);
    const hwA = route.segWidth[ahead.seg] / 2;
    const hwM = route.segWidth[mid.seg] / 2;
    this.p0.set(ahead.x + ahead.tz * q.startSide * hwA, p.y + q.startHeight, ahead.z - ahead.tx * q.startSide * hwA);
    this.p1.set(mid.x + mid.tz * q.midSide * hwM, p.y + q.midHeight, mid.z - mid.tx * q.midSide * hwM);
    this.l0.set(p.x + fx * q.lookAhead, p.y + q.lookHeight, p.z + fz * q.lookAhead);
    this.phase = 'intro';
    this.skipFrom = null;
    this.hint?.classList.add('is-visible');
    this.letterbox(true);
  }

  /**
   * Override the camera for the intro. u runs 0..1 over the whole shot and
   * reaches 1 exactly at the green light. Call after the chase camera update.
   */
  applyIntro(u: number, dt: number): void {
    if (this.phase !== 'intro') return;
    this.readChase();
    if (u >= 1) {
      this.endIntro();
      return;
    }
    const q = CAMERA.intro;
    const e = ease(u, q.ease);
    // Quadratic Bezier from the opening shot, over the grid, onto the chase camera.
    const a = 1 - e;
    const s = this.shot;
    s.pos.set(0, 0, 0).addScaledVector(this.p0, a * a).addScaledVector(this.p1, 2 * a * e).addScaledVector(this.chase.pos, e * e);
    const land = smooth((u - (1 - q.landPortion)) / Math.max(1e-3, q.landPortion));
    const lookW = Math.max(land, e * e * 0.35);
    s.look.copy(this.l0).lerp(this.chase.look, lookW);
    s.fov = q.startFov + (this.chase.fov - q.startFov) * e;
    s.roll = 0;
    if (u > 1 - q.landPortion) {
      // Settle onto the exact gameplay pose for a seamless hand off.
      s.pos.lerp(this.chase.pos, land);
      s.fov += (this.chase.fov - s.fov) * land;
    }
    this.cam.keepOutOfWalls(this.chase.pos.x, this.chase.pos.z, s.pos, CAMERA.common.groundClearance, 0);
    this.write(this.blendSkip(s, dt));
  }

  /**
   * Take over from the menu: the camera is on `shot` now and swings round the
   * car onto the chase camera over `duration` s, carried along in the car's
   * frame meanwhile. Call before the first frame is rendered.
   */
  startHandoff(shot: HandoffShot, p: CarPose, duration: number): void {
    this.phase = 'handoff';
    this.skipFrom = null;
    this.handT = 0;
    this.handDur = Math.max(0.1, duration);
    this.reveal = 0;
    toCarFrame(p, shot.position, shot.look, shot.fov, this.handFrom);
    // The first frame is the shot itself: written now, before the chase camera has had a frame to move.
    this.shot.pos.copy(shot.position);
    this.shot.look.copy(shot.look);
    this.shot.fov = shot.fov;
    this.shot.roll = 0;
    this.write(this.shot);
  }

  /** Override the camera during the handoff. Call after the chase camera update. */
  applyHandoff(p: CarPose, dt: number): void {
    if (this.phase !== 'handoff') return;
    this.readChase();
    // A stalled frame (the session's first, after its build) must not swallow the swing.
    this.handT += Math.min(dt, MAX_STEP);
    const u = Math.min(1, this.handT / this.handDur);
    const e = smoother(u);
    const a = this.handFrom;
    const b = toCarFrame(p, this.chase.pos, this.chase.look, this.chase.fov, this.handTo);
    // Round the car the short way, in and down (or up) to the chase camera's range and height.
    const theta = a.theta + wrap(b.theta - a.theta) * e;
    const radius = a.radius + (b.radius - a.radius) * e;
    const height = a.height + (b.height - a.height) * e;
    const s = this.shot;
    const yaw = p.yaw + theta;
    s.pos.set(p.x + Math.sin(yaw) * radius, p.y + height, p.z + Math.cos(yaw) * radius);
    fromCarFrame(p, a.look, s.look).lerp(fromCarFrame(p, b.look, this.tmp), e);
    s.fov = a.fov + (b.fov - a.fov) * e;
    s.roll = 0;
    this.cam.keepOutOfWalls(p.x, p.z, s.pos, CAMERA.common.groundClearance, 0, p.y);
    this.write(s);
    if (u >= 1) {
      this.phase = 'none';
      this.reveal = REVEAL;
    }
  }

  /** Jump out of the current shot: blend quickly onto the chase camera. */
  skip(): void {
    if (this.phase === 'intro' && !this.skipFrom) {
      this.skipFrom = { pos: this.cam.camera.position.clone(), look: this.shot.look.clone(), fov: this.cam.camera.fov, roll: 0 };
      this.skipT = 0;
      this.hint?.classList.remove('is-visible');
    }
  }

  get skipping(): boolean {
    return !!this.skipFrom;
  }

  private endIntro(): void {
    this.phase = 'none';
    this.skipFrom = null;
    this.hint?.classList.remove('is-visible');
    this.letterbox(false);
  }

  /** Begin the finish shot from wherever the camera is now. */
  startOutro(p: CarPose): void {
    this.phase = 'outro';
    this.outroT = 0;
    this.captured = false;
    this.yawS = p.yaw;
    this.skipFrom = null;
    // Swing around the side with the most room.
    const fx = Math.sin(p.yaw);
    const fz = Math.cos(p.yaw);
    const r = 8;
    const left = this.cam.wallHit(p.x, p.z, p.x + fz * r, p.z - fx * r);
    const right = this.cam.wallHit(p.x, p.z, p.x - fz * r, p.z + fx * r);
    this.side = left >= right ? 1 : -1;
    this.letterbox(true);
    this.hint?.classList.add('is-visible');
  }

  /** Drop the skip hint and letterbox (results are up); the camera keeps orbiting. */
  settle(): void {
    this.hint?.classList.remove('is-visible');
    this.letterbox(false);
  }

  /** Override the camera for the finish shot. Call after the chase camera update. */
  applyOutro(p: CarPose, dt: number): void {
    if (this.phase !== 'outro') return;
    const q = CAMERA.outro;
    this.outroT += dt;
    this.yawS += wrap(p.yaw - this.yawS) * (1 - Math.exp(-dt * q.yawSmoothing));
    if (this.outroT < q.holdTime) return;
    const ground = this.world.heightAt(p.x, p.z);
    const cam = this.cam.camera;
    if (!this.captured) {
      // Polar coordinates of the chase camera around the car, in the car's frame.
      this.captured = true;
      const dx = cam.position.x - p.x;
      const dz = cam.position.z - p.z;
      this.radius0 = Math.max(1, Math.hypot(dx, dz));
      // theta = 0 is straight behind, positive toward the car's left.
      this.theta0 = wrap(Math.atan2(-dx, -dz) - this.yawS);
      this.height0 = cam.position.y - ground;
      this.fov0 = cam.fov;
      this.look0.copy(this.cam.lookTarget).sub(new THREE.Vector3(p.x, p.y, p.z));
      this.look0.applyAxisAngle(UP, -this.yawS);
    }
    const t = this.outroT - q.holdTime;
    const e = ease(t / Math.max(0.1, q.swingTime), 2);
    const target = this.side * (Math.PI - q.heroAngle * DEG);
    const drift = Math.max(0, t - q.swingTime) * q.orbitSpeed * this.side;
    const theta = this.theta0 + (target - this.theta0) * e + drift;
    const radius = this.radius0 + (q.heroRadius - this.radius0) * e;
    const a = this.yawS + theta;
    const s = this.shot;
    s.pos.set(p.x - Math.sin(a) * radius, 0, p.z - Math.cos(a) * radius);
    s.pos.y = this.world.heightAt(s.pos.x, s.pos.z) + this.height0 + (q.heroHeight - this.height0) * e;
    const look0 = this.look0.clone().applyAxisAngle(UP, this.yawS).add(new THREE.Vector3(p.x, p.y, p.z));
    s.look.set(p.x, p.y + q.heroLookHeight, p.z);
    s.look.lerp(look0, 1 - e);
    s.fov = this.fov0 + (q.heroFov - this.fov0) * e;
    s.roll = q.heroRoll * DEG * e * this.side;
    this.cam.keepOutOfWalls(p.x, p.z, s.pos, q.groundMin, 0, p.y);
    this.write(s);
  }

  /** Seconds since the outro started (0 when not in the outro). */
  get outroTime(): number {
    return this.phase === 'outro' ? this.outroT : 0;
  }

  private readChase(): void {
    this.chase.pos.copy(this.cam.camera.position);
    this.chase.look.copy(this.cam.lookTarget);
    this.chase.fov = this.cam.camera.fov;
  }

  private blendSkip(s: Pose, dt: number): Pose {
    if (!this.skipFrom) return s;
    this.skipT += dt;
    const w = smooth(this.skipT / SKIP_BLEND);
    s.pos.copy(this.skipFrom.pos).lerp(this.chase.pos, w);
    s.look.copy(this.skipFrom.look).lerp(this.chase.look, w);
    s.fov = this.skipFrom.fov + (this.chase.fov - this.skipFrom.fov) * w;
    if (w >= 1) this.endIntro();
    return s;
  }

  private write(s: Pose): void {
    const cam = this.cam.camera;
    cam.position.copy(s.pos);
    cam.up.set(0, 1, 0);
    cam.lookAt(s.look);
    if (s.roll) cam.rotateZ(s.roll);
    if (Math.abs(cam.fov - s.fov) > 0.01) {
      cam.fov = s.fov;
      cam.updateProjectionMatrix();
    }
  }

  /** Toggle the HUD hiding classes for the current phase; `dt` times the fade in after a handoff. */
  syncHud(hud: HTMLElement, preRoll: boolean, dt = 0): void {
    const intro = this.phase === 'intro' && preRoll && !this.skipFrom;
    if (this.title && this.title.classList.contains('is-visible') !== intro) this.title.classList.toggle('is-visible', intro);
    hud.classList.toggle('is-intro', intro);
    hud.classList.toggle('is-outro', this.phase === 'outro');
    const handoff = this.phase === 'handoff';
    hud.classList.toggle('is-handoff', handoff);
    // The fade in: the transition only while it runs, so the HUD's own transitions (messages, warnings) come back after.
    if (!handoff && this.reveal > 0) this.reveal = Math.max(0, this.reveal - Math.min(dt, MAX_STEP));
    hud.classList.toggle('is-revealing', handoff || this.reveal > 0);
  }

  /**
   * The letterbox in or out. While it is up everything on screen steps aside but the shot's own parts, the
   * countdown and the finish message (body.is-letterboxed); when it lifts, it all fades back in after the
   * bars have slid away (body.is-unboxing for UNBOX_MS).
   */
  private letterbox(on: boolean): void {
    if (!this.bars) return;
    this.bars.classList.toggle('is-visible', on);
    const body = document.body.classList;
    if (body.contains('is-letterboxed') === on) return;
    body.toggle('is-letterboxed', on);
    body.toggle('is-unboxing', !on);
    clearTimeout(this.unboxTimer);
    if (!on) this.unboxTimer = window.setTimeout(() => body.remove('is-unboxing'), UNBOX_MS);
  }

  dispose(): void {
    clearTimeout(this.unboxTimer);
    document.body.classList.remove('is-letterboxed', 'is-unboxing');
    this.hint?.remove();
    this.bars?.remove();
    this.title?.remove();
  }
}

/** A world camera pose into the car's frame: polar around the car for the position, forward/left/up for the look point. */
function toCarFrame(p: CarPose, pos: THREE.Vector3, look: THREE.Vector3, fov: number, out: CarFramePose): CarFramePose {
  const s = Math.sin(p.yaw);
  const c = Math.cos(p.yaw);
  const dx = pos.x - p.x;
  const dz = pos.z - p.z;
  // Forward is (s, c), left is (c, -s).
  out.theta = Math.atan2(dx * c - dz * s, dx * s + dz * c);
  out.radius = Math.max(0.5, Math.hypot(dx, dz));
  out.height = pos.y - p.y;
  const lx = look.x - p.x;
  const lz = look.z - p.z;
  out.look.set(lx * s + lz * c, lx * c - lz * s, look.y - p.y);
  out.fov = fov;
  return out;
}

/** A point in the car's frame (forward, left, up) back into the world. */
function fromCarFrame(p: CarPose, l: THREE.Vector3, out: THREE.Vector3): THREE.Vector3 {
  const s = Math.sin(p.yaw);
  const c = Math.cos(p.yaw);
  return out.set(p.x + l.x * s + l.y * c, p.y + l.z, p.z + l.x * c - l.y * s);
}
