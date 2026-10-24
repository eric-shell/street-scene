/**
 * The shop's machines and the small gear round the lifts: parts washer,
 * bench grinder, drill press, hydraulic press, sandblaster, A/C recovery
 * machine and alignment console; then transmission jack, under-hoist stand,
 * battery charger, brake bleeder, diagnostic laptop cart and smoke machine.
 * Render only.
 */
import * as THREE from 'three';
import { caster } from './kit';
import type { Kit } from './kit';

// ---------------------------------------------------------------------------
// Shop machines
// ---------------------------------------------------------------------------

/** A parts washer against a wall, facing local +z: the red base, the sink with its solvent, the lid propped open, the flex tap and a brush. */
export function partsWasher(k: Kit, x: number, z: number, yaw: number): void {
  const m = k.m;
  k.place(x, 0, z, yaw);
  k.box(m.red, 0.9, 0.62, 0.55, 0, 0.31, 0);
  k.box(m.galv, 0.96, 0.22, 0.6, 0, 0.73, 0);
  k.box(m.carbon, 0.88, 0.01, 0.52, 0, 0.8, 0);
  k.box(m.galv, 0.96, 0.6, 0.02, 0, 1.12, -0.33, 0, -0.14);
  k.bar(m.steel, [0.42, 0.84, -0.28], [0.42, 1.38, -0.4], 0.008);
  k.hose(m.chrome, [[0.36, 0.84, -0.27], [0.36, 1.06, -0.2], [0.3, 1.02, 0.0], [0.26, 0.9, 0.06]], 0.012, 16);
  k.box(m.yellow, 0.05, 0.04, 0.24, -0.25, 0.86, 0.1, 0.4);
  k.box(m.black, 0.2, 0.16, 0.16, 0.25, 0.4, 0.28);
  k.box(m.yellow, 0.18, 0.1, 0.004, -0.2, 0.45, 0.277);
}

/** A bench grinder on its pedestal: base, column, motor, two stones under their guards with rests and eye shields, a quench pot. */
export function benchGrinder(k: Kit, x: number, z: number, yaw: number): void {
  const m = k.m;
  k.place(x, 0, z, yaw);
  k.box(m.cast, 0.4, 0.03, 0.4, 0, 0.015, 0);
  k.cyl(m.cast, 0.045, 0.95, 0, 0.5, 0, 'y', 10);
  k.box(m.cast, 0.24, 0.02, 0.2, 0, 0.98, 0);
  k.cyl(m.gunmetal, 0.08, 0.26, 0, 1.08, 0, 'x', 14);
  k.box(m.black, 0.06, 0.04, 0.04, 0, 1.0, 0.1);
  for (const s of [-1, 1]) {
    k.cyl(m.primer, 0.075, 0.03, s * 0.19, 1.08, 0, 'x', 18);
    k.box(m.gunmetal, 0.05, 0.06, 0.18, s * 0.19, 1.16, -0.01);
    k.box(m.gunmetal, 0.05, 0.12, 0.04, s * 0.19, 1.09, -0.09);
    k.box(m.cast, 0.05, 0.01, 0.06, s * 0.19, 1.03, 0.1);
    k.box(m.carbon, 0.08, 0.06, 0.005, s * 0.19, 1.22, 0.08, 0, -0.5);
  }
  k.cyl(m.galv, 0.06, 0.1, 0.16, 0.99, 0.05, 'y', 10);
}

/** A floor drill press: base, column, the table on its collar with a vise, the head and belt cover, motor behind, quill, chuck and the feed handles. */
export function drillPress(k: Kit, x: number, z: number, yaw: number): void {
  const m = k.m;
  k.place(x, 0, z, yaw);
  k.box(m.gunmetal, 0.45, 0.06, 0.6, 0, 0.03, -0.05);
  k.cyl(m.chrome, 0.04, 1.55, 0, 0.83, -0.2, 'y', 12);
  k.cyl(m.gunmetal, 0.07, 0.1, 0, 0.75, -0.2, 'y', 12);
  k.box(m.gunmetal, 0.08, 0.05, 0.25, 0, 0.75, -0.06);
  k.cyl(m.gunmetal, 0.15, 0.04, 0, 0.79, 0.08, 'y', 18);
  k.box(m.blue, 0.14, 0.07, 0.1, 0, 0.845, 0.08);
  k.box(m.gunmetal, 0.22, 0.26, 0.42, 0, 1.5, -0.08);
  k.box(m.gunmetal, 0.26, 0.1, 0.5, 0, 1.68, -0.1);
  k.cyl(m.gunmetal, 0.08, 0.24, 0, 1.52, -0.42, 'y', 12);
  k.cyl(m.chrome, 0.03, 0.14, 0, 1.31, 0.06, 'y', 10);
  k.cyl(m.chrome, 0.015, 0.07, 0, 1.21, 0.06, 'y', 10, 0.026);
  k.cyl(m.steel, 0.004, 0.08, 0, 1.13, 0.06, 'y', 5);
  for (const a of [0.4, 2.5, 4.6]) k.bar(m.chrome, [0.12, 1.45, -0.04], [0.12, 1.45 + Math.sin(a) * 0.2, -0.04 + Math.cos(a) * 0.2], 0.012);
  k.box(m.yellow, 0.05, 0.07, 0.02, -0.07, 1.55, 0.135);
}

/** A hydraulic shop press: the red H-frame, its bed on pins with V-blocks, the bottle ram, the pump and handle, the gauge. */
export function hydraulicPress(k: Kit, x: number, z: number, yaw: number): void {
  const m = k.m;
  k.place(x, 0, z, yaw);
  for (const s of [-1, 1]) {
    k.box(m.red, 0.08, 1.8, 0.12, s * 0.42, 0.9, 0);
    k.box(m.red, 0.1, 0.06, 0.5, s * 0.42, 0.03, 0);
    k.cyl(m.chrome, 0.015, 0.18, s * 0.42, 0.63, 0, 'z', 8);
    k.box(m.cast, 0.14, 0.08, 0.12, s * 0.12, 0.82, 0);
  }
  for (const dz of [-0.05, 0.05]) {
    k.box(m.red, 0.92, 0.12, 0.03, 0, 1.75, dz);
    k.box(m.red, 0.8, 0.12, 0.03, 0, 0.72, dz);
  }
  k.cyl(m.black, 0.06, 0.3, 0, 1.54, 0, 'y', 12);
  k.cyl(m.chrome, 0.035, 0.22, 0, 1.29, 0, 'y', 10);
  k.box(m.black, 0.12, 0.1, 0.2, 0.56, 0.9, 0);
  k.bar(m.chrome, [0.56, 0.95, 0.05], [0.8, 1.3, 0.25], 0.015);
  k.cyl(m.enamel, 0.045, 0.02, 0.2, 1.75, 0.07, 'z', 14);
  k.hose(m.rubber, [[0.56, 0.95, -0.08], [0.5, 1.3, -0.1], [0.1, 1.62, -0.08]], 0.01, 16);
}

/** A sandblast cabinet on legs facing local +z: hopper, cabinet, the slanted window, glove ports with the gloves, side door, the dust collector and its hose. */
export function sandblaster(k: Kit, x: number, z: number, yaw: number): void {
  const m = k.m;
  k.place(x, 0, z, yaw);
  for (const sx of [-1, 1]) for (const sz of [-1, 1]) k.box(m.gunmetal, 0.04, 0.82, 0.04, sx * 0.5, 0.41, sz * 0.34);
  k.add(m.gunmetal, new THREE.CylinderGeometry(0.42, 0.06, 0.3, 4), 0, 0.66, 0, Math.PI / 4);
  k.box(m.gunmetal, 1.1, 0.6, 0.78, 0, 1.1, 0);
  k.box(m.gunmetal, 1.1, 0.32, 0.51, 0, 1.56, -0.135);
  k.box(m.gunmetal, 1.1, 0.42, 0.04, 0, 1.56, 0.255, 0, -0.7);
  k.box(m.carbon, 0.8, 0.28, 0.01, 0, 1.56 + 0.025 * Math.sin(0.7), 0.255 + 0.025 * Math.cos(0.7), 0, -0.7);
  for (const s of [-1, 1]) {
    k.cyl(m.rubber, 0.08, 0.02, s * 0.22, 1.12, 0.395, 'z', 14);
    k.box(m.rubber, 0.1, 0.16, 0.05, s * 0.22, 0.98, 0.41, 0, 0.3);
  }
  k.box(m.black, 0.01, 0.42, 0.52, 0.555, 1.1, 0);
  k.box(m.black, 0.16, 0.04, 0.2, 0.2, 0.02, 0.4);
  k.cyl(m.gunmetal, 0.2, 0.6, 0.82, 0.3, -0.1, 'y', 14);
  k.box(m.black, 0.42, 0.04, 0.42, 0.82, 0.62, -0.1);
  k.hose(m.rubber, [[0.82, 0.64, -0.1], [0.8, 1.1, -0.25], [0.5, 1.4, -0.38]], 0.04, 16);
}

/** An A/C recovery machine on its wheels facing local +z: the cabinet, control panel with two gauges and a readout, the red and blue hoses coiled on its hooks. */
export function acMachine(k: Kit, x: number, z: number, yaw: number): void {
  const m = k.m;
  k.place(x, 0, z, yaw);
  k.box(m.blue, 0.55, 0.95, 0.55, 0, 0.63, 0);
  k.box(m.enamel, 0.55, 0.06, 0.55, 0, 1.13, 0);
  k.box(m.black, 0.48, 0.34, 0.01, 0, 0.9, 0.28, 0, -0.15);
  for (const s of [-1, 1]) {
    k.cyl(m.chrome, 0.07, 0.03, s * 0.12, 0.92, 0.29, 'z', 16);
    k.cyl(m.enamel, 0.06, 0.032, s * 0.12, 0.92, 0.29, 'z', 16);
    k.cyl(m.rubber, 0.1, 0.06, s * 0.22, 0.1, -0.2, 'x', 14);
    caster(k, s * 0.2, 0.2, 0.15);
  }
  k.plane(m.screen, 0.14, 0.06, 0, 0.79, 0.296, 0, -0.15);
  k.box(m.black, 0.55, 0.03, 0.55, 0, 0.16, 0);
  for (const [s, c] of [
    [-1, m.red],
    [1, m.blue],
  ] as const) {
    k.box(m.steel, 0.03, 0.03, 0.08, s * 0.29, 0.98, 0);
    k.add(c, new THREE.TorusGeometry(0.16, 0.012, 6, 24), s * 0.3, 0.84, 0, Math.PI / 2);
    k.cyl(m.chrome, 0.015, 0.06, s * 0.3, 0.66, 0.02, 'y', 8);
  }
  k.bar(m.chrome, [-0.2, 1.16, -0.28], [-0.2, 1.36, -0.32], 0.02);
  k.bar(m.chrome, [0.2, 1.16, -0.28], [0.2, 1.36, -0.32], 0.02);
  k.cyl(m.chrome, 0.015, 0.4, 0, 1.36, -0.32, 'x', 8);
}

/** An alignment console facing local +z: cabinet on casters, the monitor on its arm, keyboard tray, printer, the wheel targets hung on its sides. */
export function alignmentConsole(k: Kit, x: number, z: number, yaw: number): void {
  const m = k.m;
  k.place(x, 0, z, yaw);
  k.box(m.gunmetal, 0.9, 0.8, 0.6, 0, 0.53, 0);
  k.box(m.black, 0.8, 0.02, 0.006, 0, 0.62, 0.303);
  k.box(m.chrome, 0.3, 0.02, 0.02, 0, 0.75, 0.31);
  for (const sx of [-1, 1]) for (const sz of [-1, 1]) caster(k, sx * 0.38, sz * 0.24, 0.13);
  k.box(m.black, 0.6, 0.03, 0.26, 0, 0.98, 0.38);
  k.box(m.black, 0.5, 0.015, 0.16, 0, 1.0, 0.38);
  k.box(m.black, 0.32, 0.14, 0.26, 0.24, 1.0, -0.12);
  k.plane(m.enamel, 0.22, 0.004, 0.24, 1.071, -0.08, 0, -Math.PI / 2);
  k.box(m.gunmetal, 0.06, 0.5, 0.06, -0.15, 1.18, -0.2);
  k.box(m.black, 0.62, 0.4, 0.05, -0.15, 1.55, -0.16, 0, -0.08);
  k.plane(m.screen, 0.56, 0.34, -0.15, 1.55 + 0.026 * Math.sin(0.08), -0.16 + 0.026 * Math.cos(0.08), 0, -0.08);
  for (const s of [-1, 1])
    for (let i = 0; i < 2; i++) {
      k.box(m.black, 0.04, 0.26, 0.26, s * (0.47 + i * 0.05), 0.65, 0.12 - i * 0.24);
      k.box(m.yellow, 0.042, 0.1, 0.1, s * (0.47 + i * 0.05), 0.65, 0.12 - i * 0.24);
    }
}

// ---------------------------------------------------------------------------
// Round the lifts: jacks, stands, chargers, diagnostics
// ---------------------------------------------------------------------------

/** A transmission jack with its saddle at height `top`: the H base on casters, the ram, the saddle and its arms, pedal and handles. */
export function transmissionJack(k: Kit, x: number, z: number, yaw: number, top: number): void {
  const m = k.m;
  k.place(x, 0, z, yaw);
  for (const s of [-1, 1]) {
    k.box(m.red, 0.06, 0.06, 0.9, s * 0.3, 0.12, 0);
    for (const e of [-1, 1]) caster(k, s * 0.3, e * 0.4, 0.09);
    k.bar(m.chrome, [s * 0.1, 0.5, 0.05], [s * 0.18, 1.0, 0.25], 0.02);
  }
  k.box(m.red, 0.66, 0.06, 0.08, 0, 0.12, 0);
  k.cyl(m.red, 0.06, 0.42, 0, 0.36, 0, 'y', 12);
  k.cyl(m.chrome, 0.04, top - 0.62, 0, (top + 0.52) / 2, 0, 'y', 10);
  k.box(m.red, 0.42, 0.03, 0.36, 0, top, 0);
  for (const sx of [-1, 1]) for (const sz of [-1, 1]) k.box(m.red, 0.03, 0.12, 0.03, sx * 0.19, top + 0.06, sz * 0.16);
  k.box(m.black, 0.1, 0.03, 0.22, 0.18, 0.17, -0.3);
}

/** A tall under-hoist stand holding a car on the lift at height `top`: tripod legs, the tube, its screw and the rubber cup. */
export function underhoistStand(k: Kit, x: number, z: number, top: number): void {
  const m = k.m;
  k.place(x, 0, z, 0);
  for (let i = 0; i < 3; i++) {
    const a = (i * Math.PI * 2) / 3 + 0.3;
    k.bar(m.yellow, [Math.cos(a) * 0.36, 0.02, Math.sin(a) * 0.36], [0, 0.42, 0], 0.035);
  }
  k.cyl(m.yellow, 0.035, top - 0.62, 0, (top + 0.22) / 2, 0, 'y', 10);
  k.cyl(m.chrome, 0.02, 0.24, 0, top - 0.14, 0, 'y', 8);
  k.cyl(m.rubber, 0.06, 0.04, 0, top - 0.02, 0, 'y', 12);
}

/** A battery charger on its wheels: the red case, the meter, the handle, the clamped leads coiled over it. */
export function batteryCharger(k: Kit, x: number, z: number, yaw: number): void {
  const m = k.m;
  k.place(x, 0, z, yaw);
  k.box(m.red, 0.38, 0.5, 0.3, 0, 0.42, 0);
  k.box(m.black, 0.3, 0.22, 0.01, 0, 0.52, 0.155);
  k.cyl(m.enamel, 0.06, 0.012, -0.06, 0.55, 0.16, 'z', 14);
  for (const dx of [0.07, 0.12]) k.cyl(m.chrome, 0.015, 0.02, dx, 0.5, 0.165, 'z', 8);
  for (const s of [-1, 1]) {
    k.cyl(m.rubber, 0.1, 0.05, s * 0.22, 0.1, -0.08, 'x', 14);
    k.bar(m.chrome, [s * 0.17, 0.6, -0.15], [s * 0.17, 0.95, -0.2], 0.02);
  }
  k.cyl(m.black, 0.02, 0.38, 0, 0.95, -0.2, 'x', 8);
  k.box(m.steel, 0.3, 0.03, 0.06, 0, 0.18, 0.15);
  for (const [s, c] of [
    [-1, m.red],
    [1, m.black],
  ] as const) {
    k.add(c, new THREE.TorusGeometry(0.11, 0.012, 6, 20), s * 0.08, 0.84, -0.2);
    k.box(c, 0.04, 0.1, 0.03, s * 0.08, 0.7, -0.17);
  }
}

/** A pressure brake bleeder on its dolly: the yellow tank, pump and gauge on top, the line coiled with its reservoir cap. */
export function brakeBleeder(k: Kit, x: number, z: number, yaw: number): void {
  const m = k.m;
  k.place(x, 0, z, yaw);
  k.box(m.steel, 0.4, 0.03, 0.4, 0, 0.08, 0);
  for (const sx of [-1, 1]) for (const sz of [-1, 1]) caster(k, sx * 0.15, sz * 0.15, 0.065);
  k.cyl(m.yellow, 0.16, 0.44, 0, 0.32, 0, 'y', 16);
  k.add(m.yellow, new THREE.SphereGeometry(0.16, 14, 6, 0, Math.PI * 2, 0, Math.PI / 2), 0, 0.54, 0);
  k.cyl(m.chrome, 0.02, 0.24, 0, 0.78, 0, 'y', 8);
  k.cyl(m.black, 0.02, 0.18, 0, 0.9, 0, 'x', 8);
  k.cyl(m.chrome, 0.04, 0.02, 0.1, 0.66, 0.06, 'z', 12);
  k.add(m.rubber, new THREE.TorusGeometry(0.14, 0.01, 6, 20), 0, 0.4, 0.17);
  k.cyl(m.black, 0.04, 0.03, 0.16, 0.12, 0.24, 'y', 12);
}

/** A diagnostic laptop on a rolling stand: five-star base on casters, the pole, the tray, the laptop open on the live data and the interface box. */
export function laptopCart(k: Kit, x: number, z: number, yaw: number): void {
  const m = k.m;
  k.place(x, 0, z, yaw);
  for (let i = 0; i < 5; i++) {
    const a = (i * Math.PI * 2) / 5;
    k.bar(m.black, [0, 0.12, 0], [Math.cos(a) * 0.3, 0.1, Math.sin(a) * 0.3], 0.03);
    caster(k, Math.cos(a) * 0.3, Math.sin(a) * 0.3, 0.08);
  }
  k.cyl(m.chrome, 0.025, 0.86, 0, 0.55, 0, 'y', 10);
  k.box(m.black, 0.46, 0.02, 0.36, 0, 0.99, 0);
  k.box(m.black, 0.36, 0.02, 0.25, 0, 1.01, 0.02);
  k.box(m.black, 0.36, 0.24, 0.012, 0, 1.13, -0.11, 0, -0.25);
  k.plane(m.screen, 0.32, 0.2, 0, 1.13 + 0.007 * Math.sin(0.25), -0.11 + 0.007 * Math.cos(0.25), 0, -0.25);
  k.box(m.yellow, 0.1, 0.04, 0.16, 0.2, 1.02, 0.1);
}

/** A smoke machine for finding leaks, on the floor: its case, handle, gauge and the clear line coiled beside it. */
export function smokeMachine(k: Kit, x: number, z: number, yaw: number): void {
  const m = k.m;
  k.place(x, 0, z, yaw);
  k.box(m.yellow, 0.34, 0.24, 0.22, 0, 0.12, 0);
  k.box(m.black, 0.34, 0.03, 0.22, 0, 0.255, 0);
  k.bar(m.black, [-0.12, 0.27, 0], [-0.12, 0.36, 0], 0.02);
  k.bar(m.black, [0.12, 0.27, 0], [0.12, 0.36, 0], 0.02);
  k.cyl(m.black, 0.015, 0.26, 0, 0.36, 0, 'x', 8);
  k.cyl(m.enamel, 0.035, 0.012, -0.08, 0.15, 0.112, 'z', 12);
  k.add(m.galv, new THREE.TorusGeometry(0.12, 0.01, 6, 20), 0.32, 0.012, 0.05, 0, Math.PI / 2);
}
