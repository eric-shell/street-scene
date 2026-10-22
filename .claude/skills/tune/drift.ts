/**
 * Drift and handbrake probes against the real sim, headless. Prints a trace
 * every 0.1 s of four scenarios: a handbrake flick held on the throttle with
 * counter steer, handbrake plus brake at speed with the wheel turned, flooring
 * it mid corner in first, and a launch. Columns: speed, forward and sideways
 * velocity, body slip, yaw rate, rpm, gear, rear spin level, rear tread speed
 * against road speed, rear wheel rate. Run before and after a handling change
 * (docs/handling.md): npx tsx .claude/skills/tune/drift.ts [carId]
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
const carId = process.argv[2] ?? 'proto';
const t = getBaseTuning(carId);
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
