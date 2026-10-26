/**
 * The 404 page's street (404.html, notFound.ts): a top-down neon city block grid that never ends, with the
 * player's car on it to throw around. A wrong URL lands somewhere you can still drive, in the game's colors:
 * rooftops edged in the palette's hues, sodium pools at every corner, the "404" painted on the road where the
 * car starts. Until the first key, tap or pad input the car cruises a loop of blocks and drifts the corners
 * itself (parked under reduced motion); then it is yours, with a drift score like the race's style callouts.
 *
 * Plain 2D canvas, not three.js, so the page stays a few kilobytes and opens at once even on a weak phone.
 * The car is an arcade top-down model, nothing from src/sim: velocity split along and across the heading,
 * the sideways part bled off at a friction limit, so a fast turn or the handbrake breaks it into a slide.
 * It steps at a fixed 120 Hz whatever the frame rate; drawing scales with dt.
 */
import { PALETTE, rgba, type PaletteColor } from '../ui/kit/palette';
import { damp } from '../shared/anim';
import { clamp, wrapAngle } from '../sim/math';

/** The street grid (m). */
export const STREET = {
  /** One block and one road. */
  pitch: 64,
  /** Road width, curb to curb. */
  road: 16,
  /** The pavement band inside each block, drivable like the game's sidewalks. */
  sidewalk: 3.5,
  /** Share of blocks that are open car parks instead of buildings. */
  lotShare: 0.14,
  /** Metres across the screen's shorter side. */
  view: 105,
} as const;

/** The car (m, s, rad). */
export const CAR = {
  length: 4.4,
  width: 1.95,
  /** The collision circle. */
  radius: 1.5,
  /** Full throttle from rest (m/s²), fading to nothing at top speed (m/s). */
  accel: 16,
  top: 36,
  brake: 30,
  reverseTop: 9,
  /** Rolling and air drag (1/s of speed). */
  drag: 0.3,
  /** The most sideways speed the tires take off per second (m/s²): grip, and with the handbrake on. */
  grip: 24,
  gripHandbrake: 6,
  /** Yaw rate at full lock (rad/s), easing off with speed so the top end stays drivable. */
  steerRate: 2.9,
  /** A wall hit at this speed into it (m/s) ends a drift and throws sparks. */
  crashSpeed: 7,
} as const;

/** One tick's controls: steer -1 (left) to 1, throttle and brake 0 to 1, handbrake on or off. */
export interface Controls {
  steer: number;
  throttle: number;
  brake: number;
  handbrake: boolean;
}

/** What the page shows of a drift: the live points, a drift banked or lost. */
export type DriftEvent = { kind: 'live'; points: number } | { kind: 'banked'; points: number } | { kind: 'crashed'; points: number };

const TICK = 1 / 120;
/** Slide angle (rad) and speed (m/s) a drift scores from. */
const DRIFT = { slip: 0.22, speed: 7, grace: 0.6, rate: 9 } as const;
/** Block hues: the palette's six and the garage's two extra. */
const HUES: PaletteColor[] = ['orange', 'red', 'cyan', 'purple', 'yellow', 'green', 'pink', 'blue'];

/** A steady 0..1 per block and salt, so the city is the same every visit. */
function cellRand(i: number, j: number, salt: number): number {
  let h = Math.imul(i, 374761393) ^ Math.imul(j, 668265263) ^ Math.imul(salt + 1, 2246822519);
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}

/** Whether block (i, j) is a car park; the blocks around the start are always buildings, so the loop has walls. */
function isLot(i: number, j: number): boolean {
  return Math.abs(i) + Math.abs(j) > 2 && cellRand(i, j, 1) < STREET.lotShare;
}

/** The car: position (m), heading (rad, 0 = east, y down), velocity (m/s). */
export class StreetCar {
  x = 6;
  y = 0;
  heading = 0;
  vx = 0;
  vy = 0;
  /** Sideways speed the tires are carrying (m/s), for the smoke and skids. */
  slide = 0;
  braking = false;
  points = 0;
  private grace = 0;
  private acc = 0;

  /** Advance by dt (s) in fixed ticks; `onDrift` hears the score, `onHit` each wall impact (m/s into it). */
  step(dt: number, c: Controls, onDrift: (e: DriftEvent) => void, onHit: (speed: number, x: number, y: number) => void): void {
    this.acc = Math.min(this.acc + dt, 0.1);
    while (this.acc >= TICK) {
      this.acc -= TICK;
      this.tick(c, onDrift, onHit);
    }
  }

  get speed(): number {
    return Math.hypot(this.vx, this.vy);
  }

  private tick(c: Controls, onDrift: (e: DriftEvent) => void, onHit: (speed: number, x: number, y: number) => void): void {
    const fx = Math.cos(this.heading);
    const fy = Math.sin(this.heading);
    let vf = this.vx * fx + this.vy * fy;
    let vr = -this.vx * fy + this.vy * fx;
    this.braking = c.brake > 0 && vf > 0.5;
    if (c.throttle > 0 && vf >= -0.5) vf += CAR.accel * c.throttle * Math.max(0, 1 - vf / CAR.top) * TICK;
    if (c.brake > 0) vf = vf > 0.5 ? Math.max(0, vf - CAR.brake * c.brake * TICK) : Math.max(-CAR.reverseTop, vf - CAR.accel * 0.6 * c.brake * TICK);
    vf -= vf * CAR.drag * TICK;
    // The tires take the sideways speed off up to their limit: past it the car slides.
    const lat = (c.handbrake ? CAR.gripHandbrake : CAR.grip) * TICK;
    vr = Math.abs(vr) <= lat ? 0 : vr - Math.sign(vr) * lat;
    if (c.handbrake) vf -= vf * 0.6 * TICK;
    const roll = clamp(vf / 5, -1, 1);
    this.heading = wrapAngle(this.heading + c.steer * CAR.steerRate * roll * (c.handbrake ? 1.35 : 1) / (1 + Math.abs(vf) / 45) * TICK);
    this.vx = fx * vf - fy * vr;
    this.vy = fy * vf + fx * vr;
    this.x += this.vx * TICK;
    this.y += this.vy * TICK;
    this.slide = Math.abs(vr);

    const hit = this.collide();
    if (hit > 0) onHit(hit, this.x, this.y);
    if (hit > CAR.crashSpeed && this.points > 0) {
      onDrift({ kind: 'crashed', points: Math.round(this.points) });
      this.points = 0;
      this.grace = 0;
      return;
    }
    const speed = this.speed;
    const slip = Math.atan2(Math.abs(vr), Math.abs(vf));
    if (speed > DRIFT.speed && slip > DRIFT.slip && vf > 0) {
      this.points += speed * slip * DRIFT.rate * TICK;
      this.grace = DRIFT.grace;
      onDrift({ kind: 'live', points: Math.round(this.points) });
    } else if (this.points > 0 && (this.grace -= TICK) <= 0) {
      onDrift({ kind: 'banked', points: Math.round(this.points) });
      this.points = 0;
    }
  }

  /** Push the car out of the building it overlaps and take the speed into the wall; the impact (m/s), 0 if none. */
  private collide(): number {
    const P = STREET.pitch;
    const i = Math.floor(this.x / P);
    const j = Math.floor(this.y / P);
    let worst = 0;
    for (let di = -1; di <= 1; di++) {
      for (let dj = -1; dj <= 1; dj++) {
        const ci = i + di;
        const cj = j + dj;
        if (isLot(ci, cj)) continue;
        const inset = STREET.road / 2 + STREET.sidewalk;
        const x0 = ci * P + inset;
        const x1 = (ci + 1) * P - inset;
        const y0 = cj * P + inset;
        const y1 = (cj + 1) * P - inset;
        const px = clamp(this.x, x0, x1);
        const py = clamp(this.y, y0, y1);
        let nx = this.x - px;
        let ny = this.y - py;
        let d = Math.hypot(nx, ny);
        if (d >= CAR.radius) continue;
        if (d === 0) {
          // The centre got inside: out through the nearest face.
          const faces = [this.x - x0, x1 - this.x, this.y - y0, y1 - this.y];
          const k = faces.indexOf(Math.min(...faces));
          nx = k === 0 ? -1 : k === 1 ? 1 : 0;
          ny = k === 2 ? -1 : k === 3 ? 1 : 0;
          d = 0;
          this.x = k === 0 ? x0 - CAR.radius : k === 1 ? x1 + CAR.radius : this.x;
          this.y = k === 2 ? y0 - CAR.radius : k === 3 ? y1 + CAR.radius : this.y;
        } else {
          nx /= d;
          ny /= d;
          this.x = px + nx * CAR.radius;
          this.y = py + ny * CAR.radius;
        }
        const into = -(this.vx * nx + this.vy * ny);
        if (into <= 0) continue;
        // Lose the speed into the wall with a little bounce, and some of the speed along it.
        this.vx += nx * into * 1.3;
        this.vy += ny * into * 1.3;
        this.vx *= 0.85;
        this.vy *= 0.85;
        worst = Math.max(worst, into);
      }
    }
    return worst;
  }
}

/**
 * The cruise before the player takes over: round a two by two loop of blocks clockwise, braking for each corner
 * and flicking the handbrake to slide it, as the menu's car shows the city off.
 */
export class Cruise {
  private corner = 0;
  private static readonly LOOP: [number, number][] = [
    [2, 0],
    [2, 2],
    [0, 2],
    [0, 0],
  ];

  controls(car: StreetCar): Controls {
    const [ci, cj] = Cruise.LOOP[this.corner];
    const tx = ci * STREET.pitch;
    const ty = cj * STREET.pitch;
    const dist = Math.hypot(tx - car.x, ty - car.y);
    if (dist < 11) this.corner = (this.corner + 1) % Cruise.LOOP.length;
    const err = wrapAngle(Math.atan2(ty - car.y, tx - car.x) - car.heading);
    const speed = car.speed;
    const target = dist < 40 ? 18 : 32;
    return {
      steer: clamp(err * 2.4, -1, 1),
      throttle: speed < target ? 1 : 0,
      brake: speed > target + 5 ? 1 : 0,
      handbrake: Math.abs(err) > 0.55 && speed > 12,
    };
  }
}

interface Skid {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
  age: number;
}
interface Puff {
  x: number;
  y: number;
  vx: number;
  vy: number;
  age: number;
  life: number;
  size: number;
  spark: boolean;
}

/** Skid segments kept (oldest dropped), smoke and spark particles. */
const MAX_SKIDS = 900;
const MAX_PUFFS = 160;
/** How long a skid mark takes to fade (s). */
const SKID_LIFE = 9;

/** Draws the street around the car into a canvas, following it with a leading camera. */
export class StreetView {
  private readonly ctx: CanvasRenderingContext2D;
  private readonly lamp: HTMLCanvasElement;
  private readonly glow: HTMLCanvasElement;
  private readonly skids: Skid[] = [];
  private readonly puffs: Puff[] = [];
  private cam = { x: 0, y: 0 };
  private shake = 0;
  private lastWheels: [number, number, number, number] | null = null;
  private w = 1;
  private h = 1;
  private dpr = 1;

  constructor(private readonly canvas: HTMLCanvasElement, private readonly reducedMotion: boolean) {
    this.ctx = canvas.getContext('2d')!;
    this.lamp = sprite(96, (g) => {
      g.addColorStop(0, 'rgba(255, 190, 120, 0.42)');
      g.addColorStop(0.45, 'rgba(255, 170, 100, 0.12)');
      g.addColorStop(1, 'rgba(255, 160, 90, 0)');
    });
    this.glow = sprite(64, (g) => {
      g.addColorStop(0, rgba('cyan', 0.55));
      g.addColorStop(1, rgba('cyan', 0));
    });
    this.resize();
  }

  resize(): void {
    this.dpr = Math.min(window.devicePixelRatio || 1, 2);
    this.w = this.canvas.clientWidth || window.innerWidth;
    this.h = this.canvas.clientHeight || window.innerHeight;
    this.canvas.width = Math.round(this.w * this.dpr);
    this.canvas.height = Math.round(this.h * this.dpr);
  }

  /** Pixels per metre. */
  private get scale(): number {
    return Math.min(this.w, this.h) / STREET.view;
  }

  /** A screen point (CSS px) in world metres. */
  toWorld(sx: number, sy: number): { x: number; y: number } {
    const s = this.scale;
    return { x: this.cam.x + (sx - this.w / 2) / s, y: this.cam.y + (sy - this.h / 2) / s };
  }

  /** A wall hit: sparks at the car and, past a crash, a shake. */
  hit(speed: number, x: number, y: number): void {
    if (!this.reducedMotion) this.shake = Math.max(this.shake, Math.min(1.2, speed / 14));
    const n = Math.min(14, Math.round(speed));
    for (let k = 0; k < n; k++) {
      const a = Math.random() * Math.PI * 2;
      const v = 6 + Math.random() * speed;
      this.addPuff({ x, y, vx: Math.cos(a) * v, vy: Math.sin(a) * v, age: 0, life: 0.25 + Math.random() * 0.3, size: 0.25, spark: true });
    }
  }

  /** Snap the camera onto the car (the first frame). */
  jump(car: StreetCar): void {
    this.cam.x = car.x;
    this.cam.y = car.y;
  }

  frame(car: StreetCar, dt: number): void {
    // The camera leads the car by where it will be in a moment, eased so a slide swings it smoothly.
    const k = damp(4, dt);
    this.cam.x += (car.x + car.vx * 0.45 - this.cam.x) * k;
    this.cam.y += (car.y + car.vy * 0.45 - this.cam.y) * k;
    this.shake *= Math.exp(-6 * dt);
    this.trace(car, dt);

    const { ctx } = this;
    const s = this.scale;
    const sx = this.shake ? (Math.random() - 0.5) * this.shake : 0;
    const sy = this.shake ? (Math.random() - 0.5) * this.shake : 0;
    ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    ctx.fillStyle = '#1c1a1d';
    ctx.fillRect(0, 0, this.w, this.h);
    ctx.setTransform(this.dpr * s, 0, 0, this.dpr * s, this.dpr * (this.w / 2 - (this.cam.x + sx) * s), this.dpr * (this.h / 2 - (this.cam.y + sy) * s));

    const P = STREET.pitch;
    const half = { x: this.w / 2 / s + P, y: this.h / 2 / s + P };
    const i0 = Math.floor((this.cam.x - half.x) / P);
    const i1 = Math.floor((this.cam.x + half.x) / P);
    const j0 = Math.floor((this.cam.y - half.y) / P);
    const j1 = Math.floor((this.cam.y + half.y) / P);

    for (let i = i0; i <= i1; i++) for (let j = j0; j <= j1; j++) this.block(i, j);
    this.markings(i0, i1, j0, j1);
    this.paint404();
    this.drawSkids();
    // Light adds: the corner lamps' pools and the car's own lights.
    ctx.globalCompositeOperation = 'lighter';
    const r = STREET.road / 2 + STREET.sidewalk * 0.4;
    const L = 30;
    for (let i = i0; i <= i1; i++) {
      for (let j = j0; j <= j1; j++) {
        for (const [dx, dy] of [[-r, -r], [r, -r], [-r, r], [r, r]]) ctx.drawImage(this.lamp, i * P + dx - L / 2, j * P + dy - L / 2, L, L);
      }
    }
    this.carLights(car);
    ctx.globalCompositeOperation = 'source-over';
    this.drawPuffs(dt);
    this.drawCar(car);
  }

  private block(i: number, j: number): void {
    const { ctx } = this;
    const P = STREET.pitch;
    const a = STREET.road / 2;
    const x = i * P + a;
    const y = j * P + a;
    const size = P - STREET.road;
    // The pavement, then the building or car park inside it.
    ctx.fillStyle = '#2a272b';
    ctx.fillRect(x, y, size, size);
    const b = STREET.sidewalk;
    const bx = x + b;
    const by = y + b;
    const bs = size - 2 * b;
    if (isLot(i, j)) {
      ctx.fillStyle = '#211f22';
      ctx.fillRect(bx, by, bs, bs);
      ctx.strokeStyle = rgba('text', 0.14);
      ctx.lineWidth = 0.18;
      ctx.beginPath();
      for (let row = 0; row < 2; row++) {
        const yy = by + 6 + row * (bs - 12);
        for (let sx = bx + 3; sx <= bx + bs - 3; sx += 3) {
          ctx.moveTo(sx, yy);
          ctx.lineTo(sx, yy + (row ? -5 : 5));
        }
      }
      ctx.stroke();
      return;
    }
    const hue = HUES[Math.floor(cellRand(i, j, 2) * HUES.length)];
    // Some blocks are two buildings with a lane between them.
    const split = cellRand(i, j, 3) < 0.4;
    const rects: [number, number, number, number][] = split
      ? cellRand(i, j, 4) < 0.5
        ? [
            [bx, by, bs * 0.45, bs],
            [bx + bs * 0.55, by, bs * 0.45, bs],
          ]
        : [
            [bx, by, bs, bs * 0.45],
            [bx, by + bs * 0.55, bs, bs * 0.45],
          ]
      : [[bx, by, bs, bs]];
    rects.forEach(([rx, ry, rw, rh], n) => {
      ctx.fillStyle = '#131214';
      ctx.fillRect(rx, ry, rw, rh);
      // Rooftop plant: a few boxes and a lit skylight in the block's hue.
      const seed = n * 7;
      ctx.fillStyle = '#1d1c1f';
      for (let k = 0; k < 3; k++) {
        const w = 3 + cellRand(i, j, 10 + seed + k) * 6;
        const hgt = 3 + cellRand(i, j, 20 + seed + k) * 5;
        ctx.fillRect(rx + 2 + cellRand(i, j, 30 + seed + k) * (rw - w - 4), ry + 2 + cellRand(i, j, 40 + seed + k) * (rh - hgt - 4), w, hgt);
      }
      ctx.fillStyle = rgba(hue, 0.18);
      ctx.fillRect(rx + rw * 0.3, ry + rh * 0.62, rw * 0.4, Math.min(4, rh * 0.15));
      // The neon edge: a soft wide glow under a crisp line.
      ctx.strokeStyle = rgba(hue, 0.14);
      ctx.lineWidth = 2.2;
      ctx.strokeRect(rx, ry, rw, rh);
      ctx.strokeStyle = rgba(hue, 0.9);
      ctx.lineWidth = 0.4;
      ctx.strokeRect(rx + 0.2, ry + 0.2, rw - 0.4, rh - 0.4);
    });
  }

  /** Dashed centre lines between the junctions and a zebra on each arm of every junction. */
  private markings(i0: number, i1: number, j0: number, j1: number): void {
    const { ctx } = this;
    const P = STREET.pitch;
    const a = STREET.road / 2;
    ctx.strokeStyle = rgba('yellow', 0.5);
    ctx.lineWidth = 0.3;
    ctx.setLineDash([3, 3]);
    ctx.beginPath();
    for (let j = j0; j <= j1; j++) {
      for (let i = i0; i <= i1; i++) {
        ctx.moveTo(i * P + a + 4, j * P);
        ctx.lineTo((i + 1) * P - a - 4, j * P);
        ctx.moveTo(i * P, j * P + a + 4);
        ctx.lineTo(i * P, (j + 1) * P - a - 4);
      }
    }
    ctx.stroke();
    ctx.setLineDash([]);
    ctx.fillStyle = rgba('text', 0.13);
    for (let i = i0; i <= i1; i++) {
      for (let j = j0; j <= j1; j++) {
        const cx = i * P;
        const cy = j * P;
        for (let k = -a + 1; k < a - 1; k += 2) {
          ctx.fillRect(cx + a + 0.6, cy + k, 2.4, 1);
          ctx.fillRect(cx - a - 3, cy + k, 2.4, 1);
          ctx.fillRect(cx + k, cy + a + 0.6, 1, 2.4);
          ctx.fillRect(cx + k, cy - a - 3, 1, 2.4);
        }
      }
    }
  }

  /** "404" in road paint on the street the car starts on. */
  private paint404(): void {
    const { ctx } = this;
    ctx.save();
    ctx.translate(STREET.pitch / 2, 0);
    ctx.font = `italic 900 10px 'Google Sans Flex', system-ui, sans-serif`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillStyle = rgba('text', 0.2);
    ctx.fillText('404', 0, 0.6);
    ctx.restore();
  }

  /** Lay skid marks from the rear wheels and smoke from the tires while the car slides. */
  private trace(car: StreetCar, dt: number): void {
    for (const sk of this.skids) sk.age += dt;
    while (this.skids.length && this.skids[0].age > SKID_LIFE) this.skids.shift();
    const c = Math.cos(car.heading);
    const s = Math.sin(car.heading);
    const back = -CAR.length * 0.32;
    const side = CAR.width * 0.42;
    const wheels: [number, number, number, number] = [car.x + c * back - s * side, car.y + s * back + c * side, car.x + c * back + s * side, car.y + s * back - c * side];
    const sliding = car.slide > 3.5 && car.speed > 5;
    if (sliding && this.lastWheels) {
      const [ax, ay, bx, by] = this.lastWheels;
      this.skids.push({ x0: ax, y0: ay, x1: wheels[0], y1: wheels[1], age: 0 }, { x0: bx, y0: by, x1: wheels[2], y1: wheels[3], age: 0 });
      if (this.skids.length > MAX_SKIDS) this.skids.splice(0, this.skids.length - MAX_SKIDS);
      if (Math.random() < Math.min(1, car.slide / 10) * 0.9) {
        const w = Math.random() < 0.5 ? 0 : 2;
        this.addPuff({ x: wheels[w], y: wheels[w + 1], vx: car.vx * 0.2 + (Math.random() - 0.5) * 3, vy: car.vy * 0.2 + (Math.random() - 0.5) * 3, age: 0, life: 0.9 + Math.random() * 0.6, size: 1.2, spark: false });
      }
    }
    this.lastWheels = sliding ? wheels : null;
  }

  private addPuff(p: Puff): void {
    if (this.puffs.length >= MAX_PUFFS) this.puffs.shift();
    this.puffs.push(p);
  }

  private drawSkids(): void {
    const { ctx } = this;
    ctx.lineWidth = 0.32;
    ctx.lineCap = 'round';
    for (const sk of this.skids) {
      ctx.strokeStyle = `rgba(6, 5, 7, ${(0.75 * (1 - sk.age / SKID_LIFE)).toFixed(3)})`;
      ctx.beginPath();
      ctx.moveTo(sk.x0, sk.y0);
      ctx.lineTo(sk.x1, sk.y1);
      ctx.stroke();
    }
    ctx.lineCap = 'butt';
  }

  private drawPuffs(dt: number): void {
    const { ctx } = this;
    for (let k = this.puffs.length - 1; k >= 0; k--) {
      const p = this.puffs[k];
      p.age += dt;
      if (p.age >= p.life) {
        this.puffs.splice(k, 1);
        continue;
      }
      const drag = Math.exp(-(p.spark ? 3 : 2) * dt);
      p.vx *= drag;
      p.vy *= drag;
      p.x += p.vx * dt;
      p.y += p.vy * dt;
      const t = p.age / p.life;
      if (p.spark) {
        ctx.strokeStyle = rgba('yellow', 1 - t);
        ctx.lineWidth = 0.18;
        ctx.beginPath();
        ctx.moveTo(p.x, p.y);
        ctx.lineTo(p.x - p.vx * 0.04, p.y - p.vy * 0.04);
        ctx.stroke();
      } else {
        ctx.fillStyle = `rgba(225, 222, 232, ${(0.22 * (1 - t)).toFixed(3)})`;
        ctx.beginPath();
        ctx.arc(p.x, p.y, p.size * (1 + t * 2.2), 0, Math.PI * 2);
        ctx.fill();
      }
    }
  }

  /** Headlight beams ahead, and the underglow while it slides. */
  private carLights(car: StreetCar): void {
    const { ctx } = this;
    ctx.save();
    ctx.translate(car.x, car.y);
    ctx.rotate(car.heading);
    const beam = ctx.createLinearGradient(CAR.length / 2, 0, CAR.length / 2 + 22, 0);
    beam.addColorStop(0, 'rgba(255, 240, 210, 0.32)');
    beam.addColorStop(1, 'rgba(255, 240, 210, 0)');
    ctx.fillStyle = beam;
    ctx.beginPath();
    ctx.moveTo(CAR.length / 2, -CAR.width * 0.42);
    ctx.lineTo(CAR.length / 2 + 22, -7);
    ctx.lineTo(CAR.length / 2 + 22, 7);
    ctx.lineTo(CAR.length / 2, CAR.width * 0.42);
    ctx.closePath();
    ctx.fill();
    if (car.slide > 2) {
      ctx.globalAlpha = Math.min(1, car.slide / 8);
      ctx.drawImage(this.glow, -CAR.length * 0.85, -CAR.width * 1.4, CAR.length * 1.7, CAR.width * 2.8);
      ctx.globalAlpha = 1;
    }
    ctx.restore();
  }

  private drawCar(car: StreetCar): void {
    const { ctx } = this;
    const L = CAR.length;
    const W = CAR.width;
    ctx.save();
    ctx.translate(car.x, car.y);
    ctx.rotate(car.heading);
    // Shadow, body, glass, roof; then the lamps.
    ctx.fillStyle = 'rgba(0, 0, 0, 0.45)';
    roundRect(ctx, -L / 2 + 0.2, -W / 2 + 0.25, L, W, 0.5);
    ctx.fill();
    ctx.fillStyle = PALETTE.orange;
    roundRect(ctx, -L / 2, -W / 2, L, W, 0.5);
    ctx.fill();
    ctx.fillStyle = '#2b2733';
    roundRect(ctx, -L * 0.2, -W * 0.4, L * 0.52, W * 0.8, 0.3);
    ctx.fill();
    ctx.fillStyle = '#e6834f';
    roundRect(ctx, -L * 0.12, -W * 0.36, L * 0.3, W * 0.72, 0.2);
    ctx.fill();
    ctx.fillStyle = PALETTE.yellow;
    ctx.fillRect(L / 2 - 0.25, -W / 2 + 0.15, 0.22, 0.45);
    ctx.fillRect(L / 2 - 0.25, W / 2 - 0.6, 0.22, 0.45);
    ctx.fillStyle = car.braking ? '#ff2d55' : PALETTE.red;
    ctx.globalAlpha = car.braking ? 1 : 0.7;
    ctx.fillRect(-L / 2 + 0.03, -W / 2 + 0.15, 0.22, 0.5);
    ctx.fillRect(-L / 2 + 0.03, W / 2 - 0.65, 0.22, 0.5);
    ctx.globalAlpha = 1;
    ctx.restore();
  }
}

function roundRect(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number): void {
  ctx.beginPath();
  ctx.roundRect(x, y, w, h, r);
}

/** A radial glow drawn once into its own canvas, so each lamp is one drawImage rather than a gradient a frame. */
function sprite(size: number, stops: (g: CanvasGradient) => void): HTMLCanvasElement {
  const c = document.createElement('canvas');
  c.width = c.height = size;
  const g2 = c.getContext('2d')!;
  const g = g2.createRadialGradient(size / 2, size / 2, 0, size / 2, size / 2, size / 2);
  stops(g);
  g2.fillStyle = g;
  g2.fillRect(0, 0, size, size);
  return c;
}
