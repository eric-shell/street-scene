/**
 * The gantry steel and its lights: one arch over the road (pillars, truss,
 * neon tubes, the sign, flags and banners, the light pool and curtain) per
 * gate, and the light rig that draws every gate's LEDs and sweeping beams as
 * one instanced mesh each. The gantries only record their LEDs and beams in a
 * `LightPlan`; `createLightRig` turns the plan into the two meshes, so the
 * whole finish area stays a handful of draw calls. Render only.
 */
import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import type { World } from '../../city/world';
import { routeSample } from '../../city/route';
import { Disposer } from '../disposer';
import { LINE_Y, UP, THEMES, signGlow, signTexture, poolTexture } from './finishLook';
import type { Theme, SignFace } from './finishLook';
import type { GateKind, FinishGate } from './finishLine';

const box = (w: number, h: number, d: number, x: number, y: number, z: number) => new THREE.BoxGeometry(w, h, d).translate(x, y, z);

/** LED roles: chase strip, xenon strobe, equalizer bar cell, lamp lens (searchlights, rig heads). */
const LED_CHASE = 0;
const LED_STROBE = 1;
const LED_EQ = 2;
const LED_LENS = 3;

interface Led {
  gate: number;
  /** Position along the strip, drives the chase pattern. Strobes: phase. EQ: column. Lens: beam index. */
  u: number;
  kind: number;
  /** EQ: cell row (0 = bottom) out of `rows`. */
  row: number;
  rows: number;
}

/** Beam roles: pillar cap sweeps, ground searchlights, moving heads on the light rig. */
const BEAM_CAP = 0;
const BEAM_SEARCH = 1;
const BEAM_RIG = 2;

interface Beam {
  gate: number;
  /** World position of the lamp. */
  origin: THREE.Vector3;
  /** Offset of its sweep (rad). */
  phase: number;
  /** Sweep direction (-1 or 1); a rig head's color (1 neonA, -1 neonB). */
  side: number;
  kind: number;
}

/** Every gate's LEDs and beams, collected while the gantries are built and drawn as one instanced mesh each. */
export interface LightPlan {
  leds: Led[];
  /** World position of each LED. */
  ledPos: THREE.Vector3[];
  ledScale: number[];
  beams: Beam[];
}

export interface GateRuntime {
  gate: FinishGate;
  theme: Theme;
  full: boolean;
  flags: { geo: THREE.BufferGeometry; base: Float32Array; side: number }[];
  neonA: THREE.MeshBasicMaterial;
  neonB: THREE.MeshBasicMaterial;
  curtain: THREE.MeshBasicMaterial;
  sign: SignFace;
  /** Mortar tube mouths beside the pillars (local x, z), rockets launch from here. */
  tubes: [number, number][];
  /** Burst glow (1 = a full start burst), fading at 0.45 per second. */
  flash: number;
}

/** What the gantries share: the world, the group they hang in, the steel and fabric materials, the beam ramp and the light plan they add to. */
export interface GantryKit {
  world: World;
  group: THREE.Group;
  track: Disposer['track'];
  steelMat: THREE.Material;
  darkMat: THREE.Material;
  flagMat: THREE.Material;
  bannerMat: THREE.Material;
  beamTex: THREE.Texture;
  lights: LightPlan;
}

/** One gate: steel arch, signs, neon, banners, flags, light pool and curtain; its LEDs and beams go into the kit's light plan. */
export function buildGantry(kit: GantryKit, s: number, kind: GateKind, gi: number): GateRuntime {
  const { world, group, track, steelMat, darkMat, flagMat, bannerMat, beamTex } = kit;
  const { leds, ledPos, ledScale, beams } = kit.lights;
  const route = world.route;
  const h = world.heightAt;
  const p = routeSample(route, s);
  const half = route.segWidth[p.seg] / 2;
  const full = kind !== 'start';
  const theme = THEMES[kind];
  const yaw = Math.atan2(p.tx, p.tz);
  const y0 = h(p.x, p.z);
  const L = half + 1.7;
  const pw = full ? 1.25 : 0.9;
  const H = full ? 11.6 : 8.6;
  const signY = full ? 7.4 : 5.9;
  const signH = full ? 2.7 : 1.9;
  const signW = 2 * L - pw - 0.2;
  const root = new THREE.Group();
  root.position.set(p.x, y0, p.z);
  root.rotation.y = yaw;
  group.add(root);
  const gate: FinishGate = { kind, s, position: new THREE.Vector3(p.x, y0, p.z), yaw, halfSpan: L, signHeight: signY + signH / 2 };
  // Local +x is the road's left, +z the driving direction.
  const toWorld = (x: number, y: number, z: number) => new THREE.Vector3(x, y, z).applyAxisAngle(UP, yaw).add(gate.position);
  const baseY = (x: number) => Math.min(h(p.x + p.tz * x, p.z - p.tx * x), y0) - y0 - 0.4;

  // ---------- Steel ----------
  const steel: THREE.BufferGeometry[] = [];
  const dark: THREE.BufferGeometry[] = [];
  for (const side of [-1, 1]) {
    const x = side * L;
    const b = baseY(x);
    steel.push(box(pw, H - b, pw, x, (H + b) / 2, 0));
    steel.push(box(pw + 0.7, 0.7, pw + 0.7, x, b + 0.75, 0));
    steel.push(box(pw + 0.3, 0.35, pw + 0.3, x, H + 0.17, 0));
    // Lattice rungs on the pillar faces.
    for (let y = 1.6; y < signY - 0.6; y += 1.1) dark.push(box(pw + 0.06, 0.14, pw + 0.06, x, y, 0));
  }
  // Truss chords above and below the sign, with diagonal braces behind it.
  steel.push(box(2 * L, 0.36, 1.05, 0, signY - 0.3, 0));
  steel.push(box(2 * L, 0.36, 1.05, 0, signY + signH + 0.3, 0));
  dark.push(box(signW, signH + 0.2, 0.7, 0, signY + signH / 2, 0));
  for (let x = -L + 1, k = 0; x < L - 1; x += 1.6, k++) {
    const brace = new THREE.BoxGeometry(0.12, Math.hypot(1.6, signH + 0.4), 0.12);
    brace.rotateZ(Math.atan2(1.6, signH + 0.4) * (k % 2 ? 1 : -1));
    brace.translate(x + 0.8, signY + signH / 2, 0);
    dark.push(brace);
  }
  if (full) {
    // Flag poles on the pillar caps.
    for (const side of [-1, 1]) steel.push(new THREE.CylinderGeometry(0.06, 0.07, 3.2, 6).translate(side * L, H + 1.9, 0));
  }
  // Firework mortar racks just outside the pillars, slightly tilted down the road.
  const tubes: [number, number][] = [];
  for (const side of [-1, 1]) {
    const x0 = side * (L + pw / 2 + 0.75);
    const b = baseY(x0) + 0.4;
    dark.push(box(0.5, 0.25, 2.2, x0, b + 0.12, 0));
    for (const z of [-0.7, 0, 0.7]) {
      const tube = new THREE.CylinderGeometry(0.15, 0.17, 0.9, 8);
      tube.rotateX(0.18);
      tube.translate(x0, b + 0.6, z);
      dark.push(tube);
      tubes.push([x0, z]);
    }
  }
  // Ground searchlights behind the sidewalk edge, raking the sky.
  const searchX = half + 4.45;
  const searchZ = full ? [-8, 10] : [-7];
  for (const side of [-1, 1]) {
    for (const z of searchZ) {
      const x = side * searchX;
      const b = baseY(x) + 0.4;
      dark.push(box(0.7, 0.45, 0.7, x, b + 0.22, z));
      dark.push(new THREE.CylinderGeometry(0.32, 0.26, 0.5, 10).translate(x, b + 0.7, z));
      beams.push({ gate: gi, origin: toWorld(x, b + 0.95, z), phase: z * 0.7 + (side > 0 ? 2.1 : 0), side, kind: BEAM_SEARCH });
      leds.push({ gate: gi, u: beams.length - 1, kind: LED_LENS, row: 0, rows: 1 });
      ledPos.push(toWorld(x, b + 0.98, z));
      ledScale.push(3.4);
    }
  }
  // Light rig: moving heads hanging under the front of the lower truss chord.
  {
    const heads = full ? 6 : 4;
    dark.push(box(2 * L - pw - 0.4, 0.18, 0.18, 0, signY - 0.62, -0.78));
    for (let k = 0; k < heads; k++) {
      const x = (k / (heads - 1) - 0.5) * (2 * L - pw - 1.6);
      dark.push(box(0.3, 0.32, 0.3, x, signY - 0.86, -0.78));
      beams.push({ gate: gi, origin: toWorld(x, signY - 1.02, -0.78), phase: k * 1.37, side: k % 2 ? 1 : -1, kind: BEAM_RIG });
      leds.push({ gate: gi, u: beams.length - 1, kind: LED_LENS, row: 0, rows: 1 });
      ledPos.push(toWorld(x, signY - 1.04, -0.78));
      ledScale.push(1.9);
    }
  }
  const sm = new THREE.Mesh(track(mergeGeometries(steel)), steelMat);
  const dm = new THREE.Mesh(track(mergeGeometries(dark)), darkMat);
  steel.forEach((g) => g.dispose());
  dark.forEach((g) => g.dispose());
  root.add(sm, dm);

  // ---------- Signs (front faces approaching cars, back says STREET SCENE) ----------
  // The start gantry's back carries the event's name (city/events.ts): the intro opens on it, looking back at the grid.
  const event = kind !== 'finish' ? world.event : undefined;
  const signGeo = track(new THREE.PlaneGeometry(signW - 0.1, signH));
  const sign = signTexture(theme.text, signGlow(theme.text, theme.glow), kind === 'startFinish' ? 'START  ·  FINISH' : '');
  track(sign.texture);
  const front = new THREE.Mesh(signGeo, track(new THREE.MeshBasicMaterial({ map: sign.texture, color: new THREE.Color(1.35, 1.35, 1.35) })));
  front.position.set(0, signY + signH / 2, -0.36);
  front.rotation.y = Math.PI;
  const back = new THREE.Mesh(signGeo, track(new THREE.MeshBasicMaterial({ map: track(signTexture(event ? event.name.toUpperCase() : 'STREET SCENE', '#2de2ff', event ? 'STREET SCENE' : '').texture), color: new THREE.Color(1.2, 1.2, 1.2) })));
  back.position.set(0, signY + signH / 2, 0.36);
  root.add(front, back);

  // ---------- Neon tubes ----------
  const neonA = track(new THREE.MeshBasicMaterial({ color: theme.neonA.clone() }));
  const neonB = track(new THREE.MeshBasicMaterial({ color: theme.neonB.clone() }));
  const tubesA: THREE.BufferGeometry[] = [];
  const tubesB: THREE.BufferGeometry[] = [];
  for (const side of [-1, 1]) {
    const xi = side * (L - pw / 2 - 0.03);
    const b = baseY(side * L) + 1.2;
    for (const z of [-pw / 2 - 0.03, pw / 2 + 0.03]) tubesA.push(box(0.08, H - b, 0.08, xi, (H + b) / 2, z));
  }
  for (const z of [-0.56, 0.56]) {
    tubesB.push(box(2 * L - pw, 0.07, 0.07, 0, signY - 0.06, z));
    tubesB.push(box(2 * L - pw, 0.07, 0.07, 0, signY + signH + 0.06, z));
  }
  const ta = new THREE.Mesh(track(mergeGeometries(tubesA)), neonA);
  const tb = new THREE.Mesh(track(mergeGeometries(tubesB)), neonB);
  tubesA.forEach((g) => g.dispose());
  tubesB.forEach((g) => g.dispose());
  root.add(ta, tb);

  // ---------- Checkered banners hanging on the pillars ----------
  if (full) {
    const bw = pw - 0.15;
    const bh = signY - 2.2;
    for (const side of [-1, 1]) {
      for (const z of [-1, 1]) {
        const geo = track(new THREE.PlaneGeometry(bw, bh));
        const m = new THREE.Mesh(geo, bannerMat);
        m.position.set(side * L, signY - 0.6 - bh / 2, z * (pw / 2 + 0.02));
        if (z < 0) m.rotation.y = Math.PI;
        root.add(m);
      }
    }
  }

  // ---------- Waving flags ----------
  const flags: GateRuntime['flags'] = [];
  if (full) {
    for (const side of [-1, 1]) {
      const geo = track(new THREE.PlaneGeometry(2.4, 1.5, 12, 6));
      // Hinge on the pole, flag flying outward from the road.
      geo.translate(1.2, 0, 0);
      if (side < 0) geo.scale(-1, 1, 1);
      const m = new THREE.Mesh(geo, flagMat);
      m.position.set(side * L, H + 2.7, 0);
      m.frustumCulled = false;
      root.add(m);
      flags.push({ geo, base: Float32Array.from(geo.attributes.position.array as Float32Array), side });
    }
  }

  // ---------- Light pool and light curtain ----------
  const pool = new THREE.Mesh(
    track(new THREE.PlaneGeometry(2 * L + 6, full ? 18 : 12)),
    track(
      new THREE.MeshBasicMaterial({
        map: track(poolTexture(`#${theme.neonA.clone().multiplyScalar(0.38).getHexString()}`, `#${theme.neonB.clone().multiplyScalar(0.33).getHexString()}`)),
        color: new THREE.Color(full ? 0.55 : 0.4, full ? 0.55 : 0.4, full ? 0.55 : 0.4),
        transparent: true,
        blending: THREE.AdditiveBlending,
        depthWrite: false,
        polygonOffset: true,
        polygonOffsetFactor: -2,
        polygonOffsetUnits: -2,
      }),
    ),
  );
  pool.rotation.x = -Math.PI / 2;
  pool.position.y = LINE_Y + 0.03;
  root.add(pool);
  const curtain = track(
    new THREE.MeshBasicMaterial({
      map: beamTex,
      color: theme.neonB.clone().multiplyScalar(0.05),
      transparent: true,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
      side: THREE.DoubleSide,
    }),
  );
  const cm = new THREE.Mesh(track(new THREE.PlaneGeometry(2 * L - pw, signY - 0.5)), curtain);
  // Brightest at the ground, fading toward the sign.
  cm.position.set(0, (signY - 0.5) / 2, 0);
  root.add(cm);

  // ---------- LED strips (chase lights) ----------
  const addLed = (x: number, y: number, z: number, u: number, kind = LED_CHASE, scale = 1, row = 0, rows = 1) => {
    leds.push({ gate: gi, u, kind, row, rows });
    ledPos.push(toWorld(x, y, z));
    ledScale.push(scale);
  };
  const step = full ? 0.42 : 0.6;
  for (const z of [-0.62, 0.62]) {
    for (let x = -L + pw / 2 + 0.2; x <= L - pw / 2 - 0.2; x += step) {
      addLed(x, signY - 0.52, z, Math.abs(x));
      if (full) addLed(x, signY + signH + 0.52, z, Math.abs(x) + 0.5);
    }
    for (const side of [-1, 1]) {
      for (let y = baseY(side * L) + 1.4; y < signY - 0.6; y += step) addLed(side * (L - pw / 2 - 0.1), y, Math.sign(z) * (pw / 2 + 0.06), L + (signY - y));
    }
  }

  // ---------- Xenon strobes on the pillar tops (front, back, cap) ----------
  for (const side of [-1, 1]) {
    const x = side * L;
    addLed(x, H - 0.55, -pw / 2 - 0.1, side * 1.7, LED_STROBE, 2.6);
    addLed(x, H - 0.55, pw / 2 + 0.1, side * 1.7 + 0.9, LED_STROBE, 2.6);
    addLed(x + side * (pw / 2 + 0.1), H - 1.4, 0, side * 1.7 + 2.3, LED_STROBE, 2.6);
  }

  // ---------- LED equalizer bars on the outer pillar faces ----------
  if (full) {
    const rows = Math.floor((signY - 1.8) / 0.3);
    for (const side of [-1, 1]) {
      const x = side * (L + pw / 2 + 0.07);
      for (let c = 0; c < 3; c++) {
        for (let r = 0; r < rows; r++) addLed(x, 1.5 + r * 0.3, (c - 1) * 0.36, c + (side > 0 ? 3 : 0), LED_EQ, 1.45, r, rows);
      }
    }
  }

  // ---------- Searchlight beams from the pillar caps ----------
  if (full) {
    for (const side of [-1, 1]) {
      for (const ph of [0, Math.PI]) beams.push({ gate: gi, origin: toWorld(side * L, H + 0.4, 0), phase: ph + (side > 0 ? 1.3 : 0), side, kind: BEAM_CAP });
    }
  }

  return { gate, theme, full, flags, neonA, neonB, curtain, sign, tubes, flash: 0 };
}

/** The instanced LEDs and beams of every gate and their animation: chases, strobes, equalizers, sweeps, all flaring on a burst. */
export function createLightRig(group: THREE.Group, track: Disposer['track'], plan: LightPlan, runtime: GateRuntime[], beamTex: THREE.Texture) {
  const { leds, ledPos, ledScale, beams } = plan;

  // ---------- Instanced LEDs ----------
  const ledGeo = track(new THREE.IcosahedronGeometry(0.085, 0));
  const ledMat = track(new THREE.MeshBasicMaterial({ color: 0xffffff }));
  const ledMesh = track(new THREE.InstancedMesh(ledGeo, ledMat, Math.max(1, leds.length)));
  ledMesh.count = leds.length;
  ledMesh.frustumCulled = false;
  {
    const m = new THREE.Matrix4();
    const white = new THREE.Color(1, 1, 1);
    ledPos.forEach((p, i) => {
      const k = ledScale[i] ?? 1;
      ledMesh.setMatrixAt(i, m.makeScale(k, k, k).setPosition(p.x, p.y, p.z));
      ledMesh.setColorAt(i, white);
    });
  }
  group.add(ledMesh);

  // ---------- Instanced beams ----------
  const beamGeo = track(new THREE.CylinderGeometry(3.4, 0.22, 70, 18, 1, true).translate(0, 35, 0));
  const beamMat = track(
    new THREE.MeshBasicMaterial({ map: beamTex, color: 0xffffff, transparent: true, opacity: 1, blending: THREE.AdditiveBlending, depthWrite: false, side: THREE.DoubleSide }),
  );
  const beamMesh = track(new THREE.InstancedMesh(beamGeo, beamMat, Math.max(1, beams.length)));
  beamMesh.count = beams.length;
  beamMesh.frustumCulled = false;
  const idle = new THREE.Color(0.2, 0.2, 0.2);
  beams.forEach((_, i) => beamMesh.setColorAt(i, idle));
  group.add(beamMesh);

  const dummy = new THREE.Object3D();
  const tmpColor = new THREE.Color();
  const beamLevel = new Float32Array(Math.max(1, beams.length));

  function updateBeams(time: number): void {
    for (let i = 0; i < beams.length; i++) {
      const bm = beams[i];
      const rt = runtime[bm.gate];
      const f = Math.min(1, rt.flash);
      dummy.position.copy(bm.origin);
      dummy.rotation.set(0, 0, 0);
      let b: number;
      if (bm.kind === BEAM_CAP) {
        // Slow crossing sweeps; they snap upright and flare on a burst.
        const sweep = Math.sin(time * 0.45 + bm.phase);
        dummy.rotateY(rt.gate.yaw + bm.phase + time * 0.18 * bm.side);
        dummy.rotateX(0.32 + 0.28 * sweep * (1 - f));
        dummy.scale.setScalar(1);
        b = 0.16 + 0.05 * Math.sin(time * 2.1 + i) + f * 0.4;
        tmpColor.setRGB(b * 0.85, b * 0.9, b);
      } else if (bm.kind === BEAM_SEARCH) {
        // Long thin sky beams raking in slow figure eights; upright and bright on a burst.
        dummy.rotateY(rt.gate.yaw + bm.phase + Math.sin(time * 0.21 + bm.phase) * 1.4 + time * 0.07 * bm.side);
        dummy.rotateX((0.16 + 0.34 * (0.5 + 0.5 * Math.sin(time * 0.33 + bm.phase * 1.7))) * (1 - 0.7 * f));
        dummy.scale.set(0.38, 2.2, 0.38);
        b = 0.12 + 0.03 * Math.sin(time * 1.3 + i) + f * 0.3;
        tmpColor.setRGB(b * 0.82, b * 0.9, b);
      } else {
        // Moving heads over the line: tight cones sweeping the asphalt in the gate colors.
        dummy.rotateY(rt.gate.yaw);
        dummy.rotateX(Math.PI - 0.22 + 0.42 * Math.sin(time * 0.9 + bm.phase));
        dummy.rotateZ(0.36 * Math.sin(time * 0.67 + bm.phase * 1.3));
        dummy.scale.set(0.3, 0.14, 0.3);
        const c = bm.side > 0 ? rt.theme.neonA : rt.theme.neonB;
        b = 0.075 + f * 0.09;
        const strobe = f > 0 && Math.sin(time * 30 + bm.phase * 4) > 0.3 ? 1.6 : 1;
        tmpColor.copy(c).multiplyScalar(b * strobe);
      }
      beamLevel[i] = b;
      dummy.updateMatrix();
      beamMesh.setMatrixAt(i, dummy.matrix);
      beamMesh.setColorAt(i, tmpColor);
    }
    if (beams.length) {
      beamMesh.instanceMatrix.needsUpdate = true;
      if (beamMesh.instanceColor) beamMesh.instanceColor.needsUpdate = true;
    }
  }

  function updateLeds(time: number): void {
    for (let i = 0; i < leds.length; i++) {
      const l = leds[i];
      const rt = runtime[l.gate];
      if (l.kind === LED_CHASE) {
        // Chasing pairs of the gate colors, strobing white during a burst.
        const strobe = rt.flash > 0 && Math.sin(time * 38 + l.u * 3) > 0;
        if (strobe) tmpColor.setRGB(4, 4, 4);
        else {
          const wave = 0.5 + 0.5 * Math.sin(l.u * 1.6 - time * 8);
          const b = 0.35 + 3.2 * wave ** 6;
          const c = rt.theme.led[Math.floor(l.u / 2.4 + time * 1.2) % 2];
          tmpColor.copy(c).multiplyScalar(b);
        }
      } else if (l.kind === LED_STROBE) {
        // Idle: a rare double flash each; during a burst: fast alternating strobing.
        let on: boolean;
        if (rt.flash > 0) on = Math.sin(time * 47 + l.u * 2.1) > 0.7;
        else {
          const ph = (((time * 0.29 + l.u * 0.173) % 1) + 1) % 1;
          on = ph < 0.012 || (ph > 0.035 && ph < 0.047);
        }
        if (on) tmpColor.setRGB(6, 6, 6.6);
        else tmpColor.setRGB(0.05, 0.05, 0.06);
      } else if (l.kind === LED_EQ) {
        // Equalizer: three bouncing bars per pillar, green to amber to red.
        const c = l.u;
        const level = 0.42 + 0.2 * Math.sin(time * 7.1 + c * 1.3) + 0.16 * Math.sin(time * 11.3 + c * 2.7) + 0.12 * Math.sin(time * 3.1 + c) + rt.flash * 0.35;
        const f = (l.row + 0.5) / l.rows;
        if (f < level) {
          if (f < 0.6) tmpColor.setRGB(0.2, 2.6, 0.55);
          else if (f < 0.85) tmpColor.setRGB(2.8, 1.9, 0.2);
          else tmpColor.setRGB(3.2, 0.25, 0.22);
        } else tmpColor.setRGB(0.02, 0.025, 0.03);
      } else {
        // Lamp lens: follows its beam's brightness.
        const b = beamLevel[l.u] ?? 0.15;
        const bm = beams[l.u];
        if (bm && bm.kind === BEAM_RIG) tmpColor.copy(bm.side > 0 ? rt.theme.neonA : rt.theme.neonB).multiplyScalar(b * 14);
        else tmpColor.setRGB(b * 18, b * 19, b * 21);
      }
      ledMesh.setColorAt(i, tmpColor);
    }
    if (ledMesh.instanceColor) ledMesh.instanceColor.needsUpdate = true;
  }

  return {
    ledMesh,
    update(time: number): void {
      updateBeams(time);
      updateLeds(time);
    },
  };
}
