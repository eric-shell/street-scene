/**
 * Start and finish gantries: a lit steel arch over the road with a neon
 * "FINISH" sign, chasing LED strips, neon tubes, waving checkered flags,
 * sweeping searchlight beams, a light pool and light curtain, a checkered
 * line on the asphalt, and a confetti + spark burst when the player crosses.
 * Circuits get one full gantry (start = finish); sprints get a lighter START
 * gantry and a full FINISH one. Everything is a handful of draw calls:
 * merged steel, instanced LEDs and beams, one Points cloud for sparks and one
 * InstancedMesh for confetti. Bright parts use colors above 1 so they bloom.
 * Render only.
 */
import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import type { World } from '../city/world';
import { routeSample } from '../city/route';
import { GeoBuilder } from './geoBuilder';
import { makeCheckerTexture } from './textures';

export type GateKind = 'start' | 'finish' | 'startFinish';

export interface FinishGate {
  kind: GateKind;
  /** Route distance of the line. */
  s: number;
  /** Road center on the line, at ground height. */
  position: THREE.Vector3;
  /** Heading of the road through the gate (radians, three.js yaw). */
  yaw: number;
  /** Half distance between the pillar centers (m). */
  halfSpan: number;
  /** Height of the sign center above the road (m). */
  signHeight: number;
}

export interface FinishLines {
  group: THREE.Group;
  gates: FinishGate[];
  /** Animate lights, flags, beams and particles. Time in seconds. */
  update(time: number): void;
  /** Fire the celebration at the finish (or start) gate. */
  burst(kind?: 'finish' | 'start', strength?: number): void;
  dispose(): void;
}

const LINE_Y = 0.05;
const CONFETTI = 720;
const SPARKS = 900;

interface Theme {
  led: [THREE.Color, THREE.Color];
  neonA: THREE.Color;
  neonB: THREE.Color;
  text: string;
  glow: string;
}

const THEMES: Record<GateKind, Theme> = {
  finish: { led: [new THREE.Color(1, 0.08, 0.12), new THREE.Color(1, 0.95, 0.85)], neonA: new THREE.Color(2.6, 0.25, 1.9), neonB: new THREE.Color(0.25, 2.2, 3), text: 'FINISH', glow: '#ff2d7a' },
  startFinish: { led: [new THREE.Color(1, 0.08, 0.12), new THREE.Color(1, 0.95, 0.85)], neonA: new THREE.Color(2.6, 0.25, 1.9), neonB: new THREE.Color(0.25, 2.2, 3), text: 'FINISH', glow: '#ff2d7a' },
  start: { led: [new THREE.Color(0.1, 1, 0.35), new THREE.Color(0.9, 1, 0.95)], neonA: new THREE.Color(0.2, 2.6, 1.2), neonB: new THREE.Color(0.25, 2.2, 3), text: 'START', glow: '#2dff9a' },
};

const CONFETTI_COLORS = [0xffd23a, 0xff2d7a, 0x2de2ff, 0xffffff, 0xff4b2b, 0x9dff3a, 0xb06bff].map((c) => new THREE.Color(c).multiplyScalar(1.15));

function canvas(w: number, h: number): [HTMLCanvasElement, CanvasRenderingContext2D] {
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  return [c, c.getContext('2d')!];
}

/** Neon sign face: dark panel, checkered ends, glowing letters. */
function drawSign(ctx: CanvasRenderingContext2D, w: number, h: number, text: string, glow: string, sub: string): void {
  const g = ctx.createLinearGradient(0, 0, 0, h);
  g.addColorStop(0, '#0b0c16');
  g.addColorStop(1, '#040408');
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, w, h);
  const cell = h / 4;
  for (const x0 of [0, w - cell * 3]) {
    for (let i = 0; i < 3; i++) {
      for (let j = 0; j < 4; j++) {
        ctx.fillStyle = (i + j) % 2 ? '#101010' : '#e8e8e8';
        ctx.fillRect(x0 + i * cell, j * cell, cell, cell);
      }
    }
  }
  ctx.strokeStyle = glow;
  ctx.lineWidth = 6;
  ctx.shadowColor = glow;
  ctx.shadowBlur = 18;
  ctx.strokeRect(cell * 3 + 14, 12, w - cell * 6 - 28, h - 24);
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  const size = Math.round(h * 0.62);
  ctx.font = `900 ${size}px Orbitron, "Arial Black", Impact, sans-serif`;
  const tw = ctx.measureText(text).width;
  const maxW = w - cell * 6 - 80;
  if (tw > maxW) ctx.font = `900 ${Math.floor((size * maxW) / tw)}px Orbitron, "Arial Black", Impact, sans-serif`;
  ctx.shadowBlur = 42;
  ctx.fillStyle = glow;
  ctx.fillText(text, w / 2, h * 0.47);
  ctx.shadowBlur = 12;
  ctx.fillStyle = '#fff6fb';
  ctx.fillText(text, w / 2, h * 0.47);
  if (sub) {
    ctx.shadowBlur = 8;
    ctx.font = `700 ${Math.round(h * 0.12)}px Orbitron, Rajdhani, sans-serif`;
    ctx.fillStyle = '#c9d4ff';
    ctx.fillText(sub, w / 2, h * 0.86);
  }
  ctx.shadowBlur = 0;
}

function signTexture(text: string, glow: string, sub: string): THREE.CanvasTexture {
  const [c, ctx] = canvas(1536, 256);
  drawSign(ctx, c.width, c.height, text, glow, sub);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  t.anisotropy = 4;
  // Redraw once the display font has loaded (it is usually ready by race time).
  document.fonts?.load(`900 64px Orbitron`).then(() => {
    drawSign(ctx, c.width, c.height, text, glow, sub);
    t.needsUpdate = true;
  }, () => undefined);
  return t;
}

/** Vertical gradient: bright at the bottom (v = 0), black at the top. */
function beamTexture(): THREE.CanvasTexture {
  const [c, ctx] = canvas(4, 128);
  const g = ctx.createLinearGradient(0, 128, 0, 0);
  g.addColorStop(0, '#ffffff');
  g.addColorStop(0.25, '#7a7a7a');
  g.addColorStop(0.7, '#1a1a1a');
  g.addColorStop(1, '#000000');
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, 4, 128);
  return new THREE.CanvasTexture(c);
}

/** Soft pool of light on the road: warm center, neon tinted ends. */
function poolTexture(a: string, b: string): THREE.CanvasTexture {
  const [c, ctx] = canvas(256, 128);
  const blob = (x: number, r: number, color: string, alpha: number) => {
    const g = ctx.createRadialGradient(x, 64, 0, x, 64, r);
    g.addColorStop(0, color);
    g.addColorStop(1, 'rgba(0,0,0,0)');
    ctx.globalAlpha = alpha;
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, 256, 128);
  };
  ctx.globalCompositeOperation = 'lighter';
  blob(128, 64, '#ffe2c4', 0.9);
  blob(20, 40, a, 0.8);
  blob(236, 40, b, 0.8);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

function dotTexture(): THREE.CanvasTexture {
  const [c, ctx] = canvas(32, 32);
  const g = ctx.createRadialGradient(16, 16, 0, 16, 16, 16);
  g.addColorStop(0, '#ffffff');
  g.addColorStop(0.35, '#ffffff');
  g.addColorStop(1, 'rgba(0,0,0,0)');
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, 32, 32);
  return new THREE.CanvasTexture(c);
}

const box = (w: number, h: number, d: number, x: number, y: number, z: number) => new THREE.BoxGeometry(w, h, d).translate(x, y, z);

interface Led {
  gate: number;
  /** Position along the strip, drives the chase pattern. */
  u: number;
}

interface GateRuntime {
  gate: FinishGate;
  root: THREE.Group;
  theme: Theme;
  full: boolean;
  flags: { geo: THREE.BufferGeometry; base: Float32Array; side: number }[];
  neonA: THREE.MeshBasicMaterial;
  neonB: THREE.MeshBasicMaterial;
  curtain: THREE.MeshBasicMaterial;
  flash: number;
  burstTime: number;
}

export function buildFinishLines(world: World): FinishLines {
  const route = world.route;
  const h = world.heightAt;
  const group = new THREE.Group();
  group.name = 'finishLines';
  const disposables: { dispose(): void }[] = [];
  const track = <T extends { dispose(): void }>(x: T): T => {
    disposables.push(x);
    return x;
  };

  const lines: { s: number; kind: GateKind }[] = route.closed
    ? [{ s: route.startS, kind: 'startFinish' }]
    : [
        { s: route.startS, kind: 'start' },
        { s: route.finishS, kind: 'finish' },
      ];

  // ---------- Painted checkered lines ----------
  {
    const gb = new GeoBuilder();
    for (const { s } of lines) {
      const p = routeSample(route, s);
      const half = route.segWidth[p.seg] / 2;
      const v: number[] = [];
      for (const [along, lat, u, vv] of [
        [-1.2, half, 0, 0],
        [1.2, half, 0, 1],
        [1.2, -half, half / 1.2, 1],
        [-1.2, -half, half / 1.2, 0],
      ]) {
        const x = p.x + p.tx * along + p.tz * lat;
        const z = p.z + p.tz * along - p.tx * lat;
        v.push(gb.vertex(x, h(x, z) + LINE_Y, z, 0, 1, 0, u, vv));
      }
      gb.quadFacing(v[0], v[1], v[2], v[3], 0, 1, 0);
    }
    const m = new THREE.Mesh(
      track(gb.build()),
      track(new THREE.MeshStandardMaterial({ map: track(makeCheckerTexture()), roughness: 0.45, polygonOffset: true, polygonOffsetFactor: -1, polygonOffsetUnits: -1 })),
    );
    m.name = 'startLine';
    group.add(m);
  }

  const steelMat = track(new THREE.MeshStandardMaterial({ color: 0x23262f, metalness: 0.75, roughness: 0.38 }));
  const darkMat = track(new THREE.MeshStandardMaterial({ color: 0x0d0e13, metalness: 0.4, roughness: 0.6 }));
  const checker = track(makeCheckerTexture());
  checker.wrapS = checker.wrapT = THREE.RepeatWrapping;
  const flagMat = track(new THREE.MeshBasicMaterial({ map: checker, color: new THREE.Color(0.95, 0.95, 0.95), side: THREE.DoubleSide }));
  const bannerTex = track(makeCheckerTexture());
  bannerTex.wrapS = bannerTex.wrapT = THREE.RepeatWrapping;
  bannerTex.repeat.set(0.25, 3);
  const bannerMat = track(new THREE.MeshBasicMaterial({ map: bannerTex, color: new THREE.Color(0.8, 0.8, 0.8), side: THREE.DoubleSide }));
  const beamTex = track(beamTexture());
  const dot = track(dotTexture());

  const leds: Led[] = [];
  const ledPos: THREE.Vector3[] = [];
  const beams: { gate: number; origin: THREE.Vector3; phase: number; side: number }[] = [];
  const gates: FinishGate[] = [];
  const runtime: GateRuntime[] = [];

  lines.forEach(({ s, kind }, gi) => {
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
    gates.push(gate);
    // Local +x is the road's left, +z the driving direction.
    const toWorld = (x: number, y: number, z: number) => new THREE.Vector3(x, y, z).applyAxisAngle(new THREE.Vector3(0, 1, 0), yaw).add(gate.position);
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
    const sm = new THREE.Mesh(track(mergeGeometries(steel)), steelMat);
    const dm = new THREE.Mesh(track(mergeGeometries(dark)), darkMat);
    steel.forEach((g) => g.dispose());
    dark.forEach((g) => g.dispose());
    root.add(sm, dm);

    // ---------- Signs (front faces approaching cars, back says NIGHT RUN) ----------
    const signGeo = track(new THREE.PlaneGeometry(signW - 0.1, signH));
    const front = new THREE.Mesh(signGeo, track(new THREE.MeshBasicMaterial({ map: track(signTexture(theme.text, theme.glow, kind === 'startFinish' ? 'START  ·  FINISH' : '')), color: new THREE.Color(1.35, 1.35, 1.35) })));
    front.position.set(0, signY + signH / 2, -0.36);
    front.rotation.y = Math.PI;
    const back = new THREE.Mesh(signGeo, track(new THREE.MeshBasicMaterial({ map: track(signTexture('NIGHT RUN', '#2de2ff', '')), color: new THREE.Color(1.2, 1.2, 1.2) })));
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
    const addLed = (x: number, y: number, z: number, u: number) => {
      leds.push({ gate: gi, u });
      ledPos.push(toWorld(x, y, z));
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

    // ---------- Searchlight beams from the pillar caps ----------
    if (full) {
      for (const side of [-1, 1]) {
        for (const ph of [0, Math.PI]) beams.push({ gate: gi, origin: toWorld(side * L, H + 0.4, 0), phase: ph + (side > 0 ? 1.3 : 0), side });
      }
    }

    runtime.push({ gate, root, theme, full, flags, neonA, neonB, curtain, flash: 0, burstTime: -1 });
  });

  // ---------- Instanced LEDs ----------
  const ledGeo = track(new THREE.IcosahedronGeometry(0.085, 0));
  const ledMat = track(new THREE.MeshBasicMaterial({ color: 0xffffff }));
  const ledMesh = new THREE.InstancedMesh(ledGeo, ledMat, Math.max(1, leds.length));
  ledMesh.count = leds.length;
  ledMesh.frustumCulled = false;
  {
    const m = new THREE.Matrix4();
    ledPos.forEach((p, i) => {
      ledMesh.setMatrixAt(i, m.makeTranslation(p.x, p.y, p.z));
      ledMesh.setColorAt(i, new THREE.Color(1, 1, 1));
    });
  }
  group.add(ledMesh);

  // ---------- Instanced beams ----------
  const beamGeo = track(new THREE.CylinderGeometry(3.4, 0.22, 70, 18, 1, true).translate(0, 35, 0));
  const beamMat = track(
    new THREE.MeshBasicMaterial({ map: beamTex, color: 0xffffff, transparent: true, opacity: 1, blending: THREE.AdditiveBlending, depthWrite: false, side: THREE.DoubleSide }),
  );
  const beamMesh = new THREE.InstancedMesh(beamGeo, beamMat, Math.max(1, beams.length));
  beamMesh.count = beams.length;
  beamMesh.frustumCulled = false;
  beams.forEach((_, i) => beamMesh.setColorAt(i, new THREE.Color(0.2, 0.2, 0.2)));
  group.add(beamMesh);

  // ---------- Confetti ----------
  const confGeo = track(new THREE.PlaneGeometry(0.16, 0.1));
  const confMat = track(new THREE.MeshBasicMaterial({ color: 0xffffff, side: THREE.DoubleSide }));
  const confMesh = new THREE.InstancedMesh(confGeo, confMat, CONFETTI);
  confMesh.frustumCulled = false;
  confMesh.visible = false;
  const conf = {
    pos: new Float32Array(CONFETTI * 3),
    vel: new Float32Array(CONFETTI * 3),
    rot: new Float32Array(CONFETTI * 3),
    spin: new Float32Array(CONFETTI * 3),
    life: new Float32Array(CONFETTI),
    ground: new Float32Array(CONFETTI),
    next: 0,
  };
  for (let i = 0; i < CONFETTI; i++) confMesh.setColorAt(i, CONFETTI_COLORS[i % CONFETTI_COLORS.length]);
  group.add(confMesh);

  // ---------- Sparks ----------
  const sparkGeo = track(new THREE.BufferGeometry());
  const sparkPos = new Float32Array(SPARKS * 3);
  const sparkCol = new Float32Array(SPARKS * 3);
  sparkGeo.setAttribute('position', new THREE.BufferAttribute(sparkPos, 3).setUsage(THREE.DynamicDrawUsage));
  sparkGeo.setAttribute('color', new THREE.BufferAttribute(sparkCol, 3).setUsage(THREE.DynamicDrawUsage));
  const sparkMat = track(
    new THREE.PointsMaterial({ size: 0.32, map: dot, vertexColors: true, transparent: true, blending: THREE.AdditiveBlending, depthWrite: false, sizeAttenuation: true }),
  );
  const sparkPoints = new THREE.Points(sparkGeo, sparkMat);
  sparkPoints.frustumCulled = false;
  sparkPoints.visible = false;
  group.add(sparkPoints);
  const spark = { vel: new Float32Array(SPARKS * 3), life: new Float32Array(SPARKS), max: new Float32Array(SPARKS), warm: new Uint8Array(SPARKS), next: 0 };
  /** Active spark fountains: world position, direction, until time, rate, hue. */
  const fountains: { at: THREE.Vector3; dir: THREE.Vector3; until: number; rate: number; acc: number; warm: boolean }[] = [];

  const rand = (a: number, b: number) => a + Math.random() * (b - a);
  const dummy = new THREE.Object3D();
  const tmpColor = new THREE.Color();
  let last = -1;
  let now = 0;
  let externalAt = -1;

  function emitConfetti(rt: GateRuntime, strength: number): void {
    const g = rt.gate;
    const sy = Math.sin(g.yaw);
    const cy = Math.cos(g.yaw);
    const n = Math.round(CONFETTI * Math.min(1, strength));
    for (let k = 0; k < n; k++) {
      const i = conf.next;
      conf.next = (conf.next + 1) % CONFETTI;
      // Two cannons on the pillar caps plus a drop from the whole truss.
      const cannon = k % 3 !== 0;
      const side = k % 2 ? 1 : -1;
      const lx = cannon ? side * g.halfSpan : rand(-g.halfSpan, g.halfSpan);
      const ly = cannon ? (rt.full ? 11.8 : 8.8) : g.signHeight - 1.8;
      const lz = rand(-0.4, 0.4);
      const vlx = cannon ? -side * rand(2, 7) : rand(-1.5, 1.5);
      const vly = cannon ? rand(8, 15) : rand(-1, 3);
      const vlz = rand(-3.5, 3.5);
      // Local (x left, z forward) to world.
      conf.pos[i * 3] = g.position.x + lx * cy + lz * sy;
      conf.pos[i * 3 + 1] = g.position.y + ly;
      conf.pos[i * 3 + 2] = g.position.z - lx * sy + lz * cy;
      conf.vel[i * 3] = vlx * cy + vlz * sy;
      conf.vel[i * 3 + 1] = vly;
      conf.vel[i * 3 + 2] = -vlx * sy + vlz * cy;
      for (let a = 0; a < 3; a++) {
        conf.rot[i * 3 + a] = rand(0, 6.28);
        conf.spin[i * 3 + a] = rand(-9, 9);
      }
      conf.life[i] = rand(5.5, 8);
      conf.ground[i] = g.position.y + LINE_Y + 0.02;
    }
    confMesh.visible = true;
  }

  function emitSparks(dt: number): void {
    for (let f = fountains.length - 1; f >= 0; f--) {
      const fo = fountains[f];
      if (now > fo.until) {
        fountains.splice(f, 1);
        continue;
      }
      fo.acc += fo.rate * dt;
      while (fo.acc >= 1) {
        fo.acc -= 1;
        const i = spark.next;
        spark.next = (spark.next + 1) % SPARKS;
        sparkPos[i * 3] = fo.at.x;
        sparkPos[i * 3 + 1] = fo.at.y;
        sparkPos[i * 3 + 2] = fo.at.z;
        const sp = rand(7, 13);
        spark.vel[i * 3] = fo.dir.x * sp + rand(-2.2, 2.2);
        spark.vel[i * 3 + 1] = fo.dir.y * sp + rand(-1, 1.5);
        spark.vel[i * 3 + 2] = fo.dir.z * sp + rand(-2.2, 2.2);
        spark.max[i] = spark.life[i] = rand(0.7, 1.5);
        spark.warm[i] = fo.warm ? 1 : 0;
      }
    }
  }

  function updateParticles(dt: number): void {
    if (confMesh.visible) {
      let alive = 0;
      for (let i = 0; i < CONFETTI; i++) {
        if (conf.life[i] <= 0) {
          dummy.position.set(0, -1e4, 0);
          dummy.scale.setScalar(0);
          dummy.updateMatrix();
          confMesh.setMatrixAt(i, dummy.matrix);
          continue;
        }
        alive++;
        conf.life[i] -= dt;
        const o = i * 3;
        const onGround = conf.pos[o + 1] <= conf.ground[i];
        if (!onGround) {
          // Paper flutter: heavy drag, a sideways wobble and a low terminal speed.
          const drag = Math.exp(-dt * 1.9);
          conf.vel[o] = conf.vel[o] * drag + Math.sin(now * 6 + i) * 3 * dt;
          conf.vel[o + 1] = conf.vel[o + 1] * drag - 9.8 * dt;
          conf.vel[o + 2] = conf.vel[o + 2] * drag + Math.cos(now * 5 + i * 1.7) * 3 * dt;
          conf.pos[o] += conf.vel[o] * dt;
          conf.pos[o + 1] = Math.max(conf.ground[i], conf.pos[o + 1] + conf.vel[o + 1] * dt);
          conf.pos[o + 2] += conf.vel[o + 2] * dt;
          for (let a = 0; a < 3; a++) conf.rot[o + a] += conf.spin[o + a] * dt;
        } else {
          // Lie flat on the road.
          conf.rot[o] = -Math.PI / 2;
          conf.rot[o + 1] = 0;
        }
        dummy.position.set(conf.pos[o], conf.pos[o + 1], conf.pos[o + 2]);
        dummy.rotation.set(conf.rot[o], conf.rot[o + 1], conf.rot[o + 2]);
        dummy.scale.setScalar(Math.min(1, conf.life[i]));
        dummy.updateMatrix();
        confMesh.setMatrixAt(i, dummy.matrix);
      }
      confMesh.instanceMatrix.needsUpdate = true;
      if (!alive) confMesh.visible = false;
    }
    if (sparkPoints.visible) {
      emitSparks(dt);
      let alive = fountains.length;
      for (let i = 0; i < SPARKS; i++) {
        const o = i * 3;
        if (spark.life[i] <= 0) {
          sparkCol[o] = sparkCol[o + 1] = sparkCol[o + 2] = 0;
          continue;
        }
        alive++;
        spark.life[i] -= dt;
        const drag = Math.exp(-dt * 0.8);
        spark.vel[o] *= drag;
        spark.vel[o + 1] = spark.vel[o + 1] * drag - 9.8 * dt;
        spark.vel[o + 2] *= drag;
        sparkPos[o] += spark.vel[o] * dt;
        sparkPos[o + 1] += spark.vel[o + 1] * dt;
        sparkPos[o + 2] += spark.vel[o + 2] * dt;
        // Hot white cooling to dim orange (or green for the start); additive, so dark = gone.
        const k = Math.max(0, spark.life[i] / spark.max[i]);
        const heat = (0.4 + 3.6 * k * k) * Math.min(1, k * 4);
        if (spark.warm[i]) sparkCol.set([heat, heat * (0.3 + 0.6 * k), heat * k * k], o);
        else sparkCol.set([heat * (0.2 + 0.7 * k * k), heat, heat * (0.45 + 0.4 * k)], o);
      }
      sparkGeo.attributes.position.needsUpdate = true;
      sparkGeo.attributes.color.needsUpdate = true;
      if (!alive) sparkPoints.visible = false;
    }
  }

  function update(time: number, external = true): void {
    if (external) externalAt = performance.now();
    const dt = last < 0 ? 0 : Math.min(0.1, Math.max(0, time - last));
    last = time;
    now = time;
    // LEDs: chasing pairs of the gate colors, strobing white during a burst.
    for (let i = 0; i < leds.length; i++) {
      const l = leds[i];
      const rt = runtime[l.gate];
      const strobe = rt.flash > 0 && Math.sin(time * 38 + l.u * 3) > 0;
      if (strobe) tmpColor.setRGB(4, 4, 4);
      else {
        const wave = 0.5 + 0.5 * Math.sin(l.u * 1.6 - time * 8);
        const b = 0.35 + 3.2 * wave ** 6;
        const c = rt.theme.led[Math.floor(l.u / 2.4 + time * 1.2) % 2];
        tmpColor.copy(c).multiplyScalar(b);
      }
      ledMesh.setColorAt(i, tmpColor);
    }
    if (ledMesh.instanceColor) ledMesh.instanceColor.needsUpdate = true;
    // Beams: slow crossing sweeps; they snap upright and flare on a burst.
    beams.forEach((bm, i) => {
      const rt = runtime[bm.gate];
      const f = Math.min(1, rt.flash);
      const sweep = Math.sin(time * 0.45 + bm.phase);
      dummy.position.copy(bm.origin);
      dummy.rotation.set(0, 0, 0);
      dummy.rotateY(rt.gate.yaw + bm.phase + time * 0.18 * bm.side);
      dummy.rotateX(0.32 + 0.28 * sweep * (1 - f));
      dummy.scale.setScalar(1);
      dummy.updateMatrix();
      beamMesh.setMatrixAt(i, dummy.matrix);
      const b = 0.16 + 0.05 * Math.sin(time * 2.1 + i) + f * 0.4;
      beamMesh.setColorAt(i, tmpColor.setRGB(b * 0.85, b * 0.9, b));
    });
    if (beams.length) {
      beamMesh.instanceMatrix.needsUpdate = true;
      if (beamMesh.instanceColor) beamMesh.instanceColor.needsUpdate = true;
    }
    for (const rt of runtime) {
      // Flags wave from the pole outward.
      for (const fl of rt.flags) {
        const pos = fl.geo.attributes.position as THREE.BufferAttribute;
        const a = pos.array as Float32Array;
        for (let v = 0; v < pos.count; v++) {
          const x = Math.abs(fl.base[v * 3]);
          const y = fl.base[v * 3 + 1];
          a[v * 3 + 2] = Math.sin(x * 2.4 - time * 7 * fl.side + y * 0.8) * 0.22 * (x / 2.4) + Math.sin(time * 3.1 + x) * 0.05 * x;
          a[v * 3 + 1] = y - (x / 2.4) ** 2 * 0.12;
        }
        pos.needsUpdate = true;
      }
      const pulse = 0.85 + 0.15 * Math.sin(time * 3 + rt.gate.s);
      const boost = 1 + rt.flash * 1.5;
      const flicker = rt.flash > 0 && Math.sin(time * 25) > 0.6 ? 0.4 : 1;
      rt.neonA.color.copy(rt.theme.neonA).multiplyScalar(pulse * boost * flicker);
      rt.neonB.color.copy(rt.theme.neonB).multiplyScalar((1.8 - pulse) * boost);
      rt.curtain.color.copy(rt.theme.neonB).multiplyScalar(0.05 + rt.flash * 0.35);
      rt.flash = Math.max(0, rt.flash - dt * 0.45);
    }
    updateParticles(dt);
  }

  // The menu backdrop never calls update(): animate from the render clock instead.
  ledMesh.onBeforeRender = () => {
    if (externalAt < 0 || performance.now() - externalAt > 500) update(performance.now() / 1000, false);
  };

  function burst(kind: 'finish' | 'start' = 'finish', strength = 1): void {
    const rt = runtime.find((r) => (kind === 'finish' ? r.gate.kind !== 'start' : r.gate.kind !== 'finish'));
    if (!rt) return;
    rt.flash = kind === 'finish' ? 2.6 * strength : 1.2 * strength;
    rt.burstTime = now;
    const g = rt.gate;
    const top = rt.full ? 11.9 : 8.9;
    for (const side of [-1, 1]) {
      const at = new THREE.Vector3(side * g.halfSpan, top, 0).applyAxisAngle(new THREE.Vector3(0, 1, 0), g.yaw).add(g.position);
      const inward = new THREE.Vector3(-side * 0.35, 1, 0).applyAxisAngle(new THREE.Vector3(0, 1, 0), g.yaw).normalize();
      fountains.push({ at, dir: inward, until: now + (kind === 'finish' ? 1.8 : 0.8), rate: (kind === 'finish' ? 260 : 160) * strength, acc: 0, warm: kind === 'finish' });
    }
    sparkPoints.visible = true;
    if (kind === 'finish') emitConfetti(rt, strength);
  }

  return {
    group,
    gates,
    update: (t) => update(t, true),
    burst,
    dispose() {
      ledMesh.dispose();
      beamMesh.dispose();
      confMesh.dispose();
      for (const d of disposables) d.dispose();
    },
  };
}
