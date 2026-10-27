/**
 * Drift and handbrake probes against the real sim, headless. Prints a trace
 * every 0.1 s of four scenarios: a handbrake flick held on the throttle with
 * counter steer, handbrake plus brake at speed with the wheel turned, flooring
 * it mid corner in first, and a launch. Columns: speed, forward and sideways
 * velocity, body slip, yaw rate, rpm, gear, rear spin level, rear tread speed
 * against road speed, rear wheel rate. Run before and after a handling change
 * (docs/handling.md): npx tsx .claude/skills/tune/drift.ts [carId]. Closed loop after
 * those, one line: E peak lateral g, F a held drift, G a flick linking it into one the
 * other way. TUNE='{...}' trials an override without editing the JSON.
 */
import { CarState, createCar, stepCar } from '../../../src/sim/car';
import { getBaseTuning } from '../../../src/sim/tuning';
import type { World } from '../../../src/city/world';
import { InputFrame } from '../../../src/sim/input';

const world = {
  heightAt: () => 0,
  driveHeightAt: () => 0,
  slopeAt: () => ({ gx: 0, gz: 0 }),
  surfaceAt: () => 'road',
} as unknown as World;

const DEG = Math.PI / 180;
const carId = process.argv[2] ?? 'protoHatch';
const t = getBaseTuning(carId);
/** TUNE='{"tires":{"slideGrip":0.6}}' lays a trial override over the car (merged key by key) without touching the JSON. */
const merge = (into: Record<string, unknown>, over: Record<string, unknown>): void => {
  for (const [k, v] of Object.entries(over)) {
    if (v && typeof v === 'object' && !Array.isArray(v)) merge(into[k] as Record<string, unknown>, v as Record<string, unknown>);
    else into[k] = v;
  }
};
if (process.env.TUNE) merge(t as unknown as Record<string, unknown>, JSON.parse(process.env.TUNE));
const inp = (p: Partial<InputFrame>): InputFrame => ({ throttle: 0, brake: 0, steer: 0, handbrake: false, nitrous: false, shift: 0, reset: false, ...p });

function row(c: CarState, tick: number): string {
  const fx = Math.sin(c.yaw);
  const fz = Math.cos(c.yaw);
  const vLong = c.vx * fx + c.vz * fz;
  const vLat = c.vx * fz - c.vz * fx;
  return [
    `t=${(tick / 60).toFixed(1).padStart(4)}`,
    `v=${(c.speed * 3.6).toFixed(0).padStart(3)}km/h`,
    `vL=${vLong.toFixed(1).padStart(5)}`,
    `vT=${vLat.toFixed(1).padStart(5)}`,
    `slip=${(c.slipAngle / DEG).toFixed(0).padStart(4)}°`,
    `yawR=${c.yawRate.toFixed(2).padStart(5)}`,
    `rpm=${c.rpm.toFixed(0).padStart(4)}`,
    `g=${c.gear}`,
    `spinR=${c.spinRear.toFixed(2)}`,
    `tread=${c.wheelSpeedRear.toFixed(1)}/${vLong.toFixed(1)}`,
    `wRate=${c.wheels[2].spinRate.toFixed(0)}`,
  ].join(' ');
}

function run(name: string, phases: { ticks: number; input: (c: CarState) => InputFrame; log?: boolean }[]): void {
  console.log(`\n=== ${name} (${carId}) ===`);
  const c = createCar(0, 0, 0, 0);
  let tick = 0;
  for (const ph of phases) {
    for (let i = 0; i < ph.ticks; i++) {
      stepCar(c, t, ph.input(c), { world });
      tick++;
      if (ph.log && tick % 6 === 0) console.log(row(c, tick));
    }
    if (!ph.log) console.log(`-- after ${ph.ticks} ticks: ${row(c, tick)}`);
  }
}

/** Proportional counter steer toward the direction of travel, short of full lock so the drift holds. */
const counter = (c: CarState) => Math.max(-0.6, Math.min(0.6, -c.slipAngle / (45 * DEG)));

run('A. flick, then hold the drift on the throttle with counter steer', [
  { ticks: 60 * 4, input: () => inp({ throttle: 1 }) },
  { ticks: 24, input: () => inp({ throttle: 0.6, steer: -1, handbrake: true }), log: true },
  { ticks: 150, input: (c) => inp({ throttle: 1, steer: counter(c) }), log: true },
  { ticks: 60, input: (c) => inp({ throttle: 0, steer: counter(c) }), log: true },
]);

run('B. handbrake plus brake at speed, wheel turned', [
  { ticks: 60 * 5, input: () => inp({ throttle: 1 }) },
  { ticks: 150, input: () => inp({ brake: 1, steer: -1, handbrake: true }), log: true },
]);

run('C. first gear corner, then floor it', [
  { ticks: 600, input: (c) => inp({ throttle: c.speed < 12 ? 0.6 : 0 }) },
  { ticks: 48, input: () => inp({ throttle: 0.2, steer: -0.8 }), log: true },
  { ticks: 120, input: () => inp({ throttle: 1, steer: -0.8 }), log: true },
]);

run('D. launch', [
  { ticks: 30, input: () => inp({}) },
  { ticks: 150, input: () => inp({ throttle: 1 }), log: true },
]);

// ---- Closed loop: a driver that holds a slip angle, so drifts are judged as a player drives them ----

/** Slip angle the driver aims for in a held drift. */
const TARGET = 30 * DEG;

/**
 * A drifter holding `TARGET`: counter steer toward the direction of travel and throttle on the slip error,
 * both leading on how fast the angle is changing (a driver catches a swing before it arrives), up to full
 * lock. Each scenario gets its own (it remembers the last tick's slip).
 */
function makeDrifter(): (c: CarState) => InputFrame {
  let last = 0;
  return (c) => {
    const rate = (c.slipAngle - last) * 60;
    last = c.slipAngle;
    const ahead = c.slipAngle + 0.25 * rate;
    const err = TARGET - Math.abs(ahead);
    return inp({ steer: Math.max(-1, Math.min(1, -ahead / (40 * DEG))), throttle: Math.max(0, Math.min(1, 0.65 + 4 * err)) });
  };
}

/** Up to speed in a straight line. */
function upTo(c: CarState, kmh: number): void {
  for (let i = 0; i < 1800 && c.speed * 3.6 < kmh; i++) stepCar(c, t, inp({ throttle: 1 }), { world });
}

/** E: peak lateral g, the wheel ramped slowly at a held 100 km/h (grip, not a slide: body slip under 12°). */
function peakLateral(): number {
  const c = createCar(0, 0, 0, 0);
  upTo(c, 100);
  let peak = 0;
  for (let i = 0; i < 300; i++) {
    stepCar(c, t, inp({ throttle: c.speed < 27.8 ? 0.7 : 0.25, steer: -Math.min(1, i / 240) }), { world });
    if (Math.abs(c.slipAngle) < 12 * DEG) peak = Math.max(peak, Math.abs(c.aLat) / 9.81);
  }
  return peak;
}

/** F and G: a handbrake entry at 80 km/h, the drift held 2 s, then a flick the other way (lift, opposite lock, then power) and that drift held (seconds over 15° in the 2.25 s from the flick). */
function linkedDrifts(): string {
  const c = createCar(0, 0, 0, 0);
  upTo(c, 80);
  for (let i = 0; i < 20; i++) stepCar(c, t, inp({ throttle: 0.6, steer: -1, handbrake: true }), { world });
  let drifter = makeDrifter();
  let held1 = 0;
  const v0 = c.speed;
  for (let i = 0; i < 120; i++) {
    stepCar(c, t, drifter(c), { world });
    if (Math.abs(c.slipAngle) > 15 * DEG) held1 += DT_S;
  }
  const side = Math.sign(c.slipAngle);
  const v1 = c.speed;
  // The flick: off the throttle, full lock the new way, until the slip has swung through to the other side.
  let tFlip = -1;
  let worst = 0;
  let held2 = 0;
  // The flick: a lift with the lock thrown the new way (the entry turned at -1), then power with the lock
  // held until the rear swings through the middle, then the drifter catches and holds it.
  let swung = false;
  for (let i = 0; i < 240; i++) {
    const flicking = i < 12;
    if (!swung && !flicking && Math.sign(c.slipAngle) === -side && Math.abs(c.slipAngle) > 3 * DEG) {
      swung = true;
      drifter = makeDrifter();
    }
    stepCar(c, t, flicking ? inp({ steer: 1 }) : swung ? drifter(c) : inp({ steer: 1, throttle: 1 }), { world });
    if (process.env.TRACE && i % 6 === 0) console.log(row(c, i));
    const other = Math.sign(c.slipAngle) === -side;
    if (tFlip < 0 && other && Math.abs(c.slipAngle) > 15 * DEG) tFlip = i * DT_S;
    if (other) worst = Math.max(worst, Math.abs(c.slipAngle));
    if (other && swung && i < 135 && Math.abs(c.slipAngle) > 15 * DEG) held2 += DT_S;
  }
  return [
    `F held ${held1.toFixed(2)}s/2.0 over 15° (${(v0 * 3.6).toFixed(0)}→${(v1 * 3.6).toFixed(0)} km/h)`,
    `G flick to 15° the other way ${tFlip < 0 ? 'never' : tFlip.toFixed(2) + 's'}, worst ${(worst / DEG).toFixed(0)}°${worst > 80 * DEG ? ' SPUN' : ''}, held ${held2.toFixed(2)}s/2.0`,
  ].join(' | ');
}

const DT_S = 1 / 60;
console.log(`\n=== E/F/G closed loop (${carId}) ===`);
console.log(`E peak lateral ${peakLateral().toFixed(2)} g | ${linkedDrifts()}`);
