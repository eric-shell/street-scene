/**
 * Start and finish gantries: a lit steel arch over the road with a neon sign
 * (START, LAP n, FINISH; see setSign), chasing LED strips, LED equalizer bars,
 * xenon strobes, neon tubes, waving checkered flags, sweeping beams from the
 * pillar caps, ground searchlights raking the sky, a moving head light rig
 * over the line, a light pool and light curtain, a checkered line on the
 * asphalt, a confetti + spark burst when the player crosses, and fireworks
 * (rockets launched from mortar tubes beside the gantry that burst into
 * colored spheres, rings and willows with streaking trails).
 * Circuits get one full gantry (start = finish); sprints get a lighter START
 * gantry and a full FINISH one. Everything is a handful of draw calls:
 * merged steel, instanced LEDs and beams, one Points cloud for sparks, one
 * InstancedMesh for confetti, one Points + one LineSegments for fireworks
 * (all pooled, no per-frame allocation). Bright parts use colors above 1 so
 * they bloom. Render only.
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
  /**
   * Change the sign over the road at one gate (front face). The canvas is
   * only redrawn when the text changes. `startFinish` falls back to the only
   * gate on circuits.
   */
  setSign(kind: GateKind, text: string, sub?: string): void;
  /** Launch fireworks from beside a gate: a small salvo for a lap, a show at the start, a big one at the finish. */
  fireworks(show: FireworkShow, strength?: number): void;
  /** Called when a shell bursts (world position and 0..1+ size), e.g. for the boom sound. */
  onFirework: ((x: number, y: number, z: number, size: number) => void) | null;
  dispose(): void;
}

export type FireworkShow = 'start' | 'lap' | 'finish';

const LINE_Y = 0.05;
const CONFETTI = 720;
const SPARKS = 1100;
const ROCKETS = 32;
const STARS = 2600;
const FW = ROCKETS + STARS;
const FLASHES = 6;
const GRAVITY = 9.8;

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

/** Sign glow by label: green START, amber LAP n, pink FINISH. */
function signGlow(text: string, fallback: string): string {
  if (text.startsWith('START')) return '#2dff9a';
  if (text.startsWith('FINISH')) return '#ff2d7a';
  if (text.startsWith('LAP') || text.startsWith('FINAL')) return '#ffc22d';
  return fallback;
}

/** Firework star colors (HDR, they bloom). */
const FW_COLORS = [
  [4, 0.45, 0.55],
  [0.6, 4, 1.1],
  [0.55, 1.3, 4.6],
  [4.2, 2.6, 0.7],
  [2.9, 0.75, 4.2],
  [0.7, 3.6, 4.2],
  [3.6, 3.4, 3.2],
  [4.2, 0.9, 2.6],
] as const;

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
  ctx.font = `800 ${size}px "Barlow Condensed", "Arial Black", Impact, sans-serif`;
  const tw = ctx.measureText(text).width;
  const maxW = w - cell * 6 - 80;
  if (tw > maxW) ctx.font = `800 ${Math.floor((size * maxW) / tw)}px "Barlow Condensed", "Arial Black", Impact, sans-serif`;
  ctx.shadowBlur = 42;
  ctx.fillStyle = glow;
  ctx.fillText(text, w / 2, h * 0.47);
  ctx.shadowBlur = 12;
  ctx.fillStyle = '#fff6fb';
  ctx.fillText(text, w / 2, h * 0.47);
  if (sub) {
    ctx.shadowBlur = 8;
    ctx.font = `700 ${Math.round(h * 0.12)}px "Barlow Semi Condensed", sans-serif`;
    ctx.fillStyle = '#c9d4ff';
    ctx.fillText(sub, w / 2, h * 0.86);
  }
  ctx.shadowBlur = 0;
}

interface SignFace {
  texture: THREE.CanvasTexture;
  /** Redraw with new text (no-op when unchanged). */
  set(text: string, glow: string, sub: string): void;
}

function signTexture(text: string, glow: string, sub: string): SignFace {
  const [c, ctx] = canvas(1536, 256);
  let cur = '';
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  t.anisotropy = 4;
  const state = { text, glow, sub };
  const draw = () => {
    drawSign(ctx, c.width, c.height, state.text, state.glow, state.sub);
    cur = `${state.text}|${state.glow}|${state.sub}`;
    t.needsUpdate = true;
  };
  draw();
  // Redraw once the display font has loaded (it is usually ready by race time).
  document.fonts?.load(`800 64px "Barlow Condensed"`).then(draw, () => undefined);
  return {
    texture: t,
    set(text2, glow2, sub2) {
      if (`${text2}|${glow2}|${sub2}` === cur) return;
      state.text = text2;
      state.glow = glow2;
      state.sub = sub2;
      draw();
    },
  };
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

interface GateRuntime {
  gate: FinishGate;
  root: THREE.Group;
  theme: Theme;
  full: boolean;
  flags: { geo: THREE.BufferGeometry; base: Float32Array; side: number }[];
  neonA: THREE.MeshBasicMaterial;
  neonB: THREE.MeshBasicMaterial;
  curtain: THREE.MeshBasicMaterial;
  sign: SignFace;
  /** Mortar tube mouths beside the pillars (local x, z), rockets launch from here. */
  tubes: [number, number][];
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
  const ledScale: number[] = [];
  const beams: { gate: number; origin: THREE.Vector3; phase: number; side: number; kind: number; tilt: number; lx: number }[] = [];
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
        beams.push({ gate: gi, origin: toWorld(x, b + 0.95, z), phase: z * 0.7 + (side > 0 ? 2.1 : 0), side, kind: BEAM_SEARCH, tilt: 0, lx: x });
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
        beams.push({ gate: gi, origin: toWorld(x, signY - 1.02, -0.78), phase: k * 1.37, side: k % 2 ? 1 : -1, kind: BEAM_RIG, tilt: 0, lx: x });
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
    const signGeo = track(new THREE.PlaneGeometry(signW - 0.1, signH));
    const sign = signTexture(theme.text, signGlow(theme.text, theme.glow), kind === 'startFinish' ? 'START  ·  FINISH' : '');
    track(sign.texture);
    const front = new THREE.Mesh(signGeo, track(new THREE.MeshBasicMaterial({ map: sign.texture, color: new THREE.Color(1.35, 1.35, 1.35) })));
    front.position.set(0, signY + signH / 2, -0.36);
    front.rotation.y = Math.PI;
    const back = new THREE.Mesh(signGeo, track(new THREE.MeshBasicMaterial({ map: track(signTexture('STREET SCENE', '#2de2ff', '').texture), color: new THREE.Color(1.2, 1.2, 1.2) })));
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
        for (const ph of [0, Math.PI]) beams.push({ gate: gi, origin: toWorld(side * L, H + 0.4, 0), phase: ph + (side > 0 ? 1.3 : 0), side, kind: BEAM_CAP, tilt: 0, lx: side * L });
      }
    }

    runtime.push({ gate, root, theme, full, flags, neonA, neonB, curtain, sign, tubes, flash: 0, burstTime: -1 });
  });

  // ---------- Instanced LEDs ----------
  const ledGeo = track(new THREE.IcosahedronGeometry(0.085, 0));
  const ledMat = track(new THREE.MeshBasicMaterial({ color: 0xffffff }));
  const ledMesh = new THREE.InstancedMesh(ledGeo, ledMat, Math.max(1, leds.length));
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

  // ---------- Fireworks: rockets + stars share one Points (heads) and one LineSegments (trails) ----------
  const fw = {
    pos: new Float32Array(FW * 3),
    vel: new Float32Array(FW * 3),
    col: new Float32Array(FW * 3),
    life: new Float32Array(FW),
    max: new Float32Array(FW),
    drag: new Float32Array(FW),
    grav: new Float32Array(FW),
    /** 0 dead, 1 rocket, 2 star, 3 glitter star (crackles). */
    kind: new Uint8Array(FW),
    /** Rockets: shell size, burst type and palette. */
    size: new Float32Array(ROCKETS),
    type: new Uint8Array(ROCKETS),
    pal: new Uint8Array(ROCKETS),
    nextStar: 0,
    /** Set when a shell burst this frame (its stars may sit behind the loop cursor). */
    spawned: false,
  };
  const headPos = new Float32Array(FW * 3);
  const headCol = new Float32Array(FW * 3);
  const trailPos = new Float32Array(FW * 6);
  const trailCol = new Float32Array(FW * 6);
  const headGeo = track(new THREE.BufferGeometry());
  headGeo.setAttribute('position', new THREE.BufferAttribute(headPos, 3).setUsage(THREE.DynamicDrawUsage));
  headGeo.setAttribute('color', new THREE.BufferAttribute(headCol, 3).setUsage(THREE.DynamicDrawUsage));
  const trailGeo = track(new THREE.BufferGeometry());
  trailGeo.setAttribute('position', new THREE.BufferAttribute(trailPos, 3).setUsage(THREE.DynamicDrawUsage));
  trailGeo.setAttribute('color', new THREE.BufferAttribute(trailCol, 3).setUsage(THREE.DynamicDrawUsage));
  const headMat = track(
    new THREE.PointsMaterial({ size: 0.95, map: dot, vertexColors: true, transparent: true, blending: THREE.AdditiveBlending, depthWrite: false, sizeAttenuation: true }),
  );
  const trailMat = track(new THREE.LineBasicMaterial({ vertexColors: true, transparent: true, blending: THREE.AdditiveBlending, depthWrite: false }));
  const fwHeads = new THREE.Points(headGeo, headMat);
  const fwTrails = new THREE.LineSegments(trailGeo, trailMat);
  for (const o of [fwHeads, fwTrails]) {
    o.frustumCulled = false;
    o.visible = false;
    group.add(o);
  }
  // Burst flashes: a few big additive sprites, hidden when idle.
  const flashes: { sprite: THREE.Sprite; mat: THREE.SpriteMaterial; life: number; size: number }[] = [];
  for (let i = 0; i < FLASHES; i++) {
    const mat = track(new THREE.SpriteMaterial({ map: dot, color: 0xffffff, transparent: true, blending: THREE.AdditiveBlending, depthWrite: false }));
    const sprite = new THREE.Sprite(mat);
    sprite.visible = false;
    sprite.frustumCulled = false;
    group.add(sprite);
    flashes.push({ sprite, mat, life: 0, size: 1 });
  }
  let nextFlash = 0;
  /** Scheduled launches (event driven; the per frame path never allocates). */
  const pending: { at: number; ox: number; oy: number; oz: number; tx: number; ty: number; tz: number; fuse: number; size: number; type: number; pal: number }[] = [];
  let onFirework: FinishLines['onFirework'] = null;

  const rand = (a: number, b: number) => a + Math.random() * (b - a);
  const dummy = new THREE.Object3D();
  const tmpColor = new THREE.Color();
  let last = -1;
  let now = 0;
  let externalAt = -1;

  function spawnSpark(x: number, y: number, z: number, vx: number, vy: number, vz: number, life: number, warm: boolean): void {
    const i = spark.next;
    spark.next = (spark.next + 1) % SPARKS;
    sparkPos[i * 3] = x;
    sparkPos[i * 3 + 1] = y;
    sparkPos[i * 3 + 2] = z;
    spark.vel[i * 3] = vx;
    spark.vel[i * 3 + 1] = vy;
    spark.vel[i * 3 + 2] = vz;
    spark.max[i] = spark.life[i] = life;
    spark.warm[i] = warm ? 1 : 0;
    sparkPoints.visible = true;
  }

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
        const sp = rand(7, 13);
        spawnSpark(fo.at.x, fo.at.y, fo.at.z, fo.dir.x * sp + rand(-2.2, 2.2), fo.dir.y * sp + rand(-1, 1.5), fo.dir.z * sp + rand(-2.2, 2.2), rand(0.7, 1.5), fo.warm);
      }
    }
  }

  // ---------- Fireworks ----------

  /** Gate for a show: the start line for 'start', the finish for 'finish', the circuit line for laps. */
  function gateFor(kind: 'start' | 'finish' | 'lap'): GateRuntime | undefined {
    if (kind === 'lap') return runtime.find((r) => r.gate.kind === 'startFinish');
    return runtime.find((r) => (kind === 'finish' ? r.gate.kind !== 'start' : r.gate.kind !== 'finish'));
  }

  function fireworks(show: FireworkShow, strength = 1): void {
    const rt = gateFor(show);
    if (!rt || !rt.tubes.length) return;
    const g = rt.gate;
    const cy = Math.cos(g.yaw);
    const sy = Math.sin(g.yaw);
    const n = Math.round((show === 'finish' ? 16 : show === 'start' ? 7 : 3) * Math.max(0.3, strength));
    for (let k = 0; k < n; k++) {
      const [lx, lz] = rt.tubes[(k * 5 + Math.floor(Math.random() * 2)) % rt.tubes.length];
      const ox = g.position.x + lx * cy + lz * sy;
      const oz = g.position.z - lx * sy + lz * cy;
      // Bursts land ahead of the line, where a driver looking down the road (or the finish shot) sees them.
      const ahead = show === 'finish' ? rand(-25, 95) : show === 'start' ? rand(35, 95) : rand(55, 100);
      const p = routeSample(route, g.s + ahead);
      const lat = rand(-26, 26);
      const tx = p.x + p.tz * lat;
      const tz = p.z - p.tx * lat;
      const big = show === 'finish' ? rand(0.85, 1.25) : show === 'start' ? rand(0.7, 0.95) : rand(0.5, 0.7);
      const height = show === 'lap' ? rand(18, 30) : show === 'start' ? rand(24, 40) : rand(26, 52);
      const delay = show === 'finish' ? (k < 4 ? k * 0.09 : 0.5 + (k - 4) * 0.28 + rand(0, 0.12)) : show === 'start' ? k * 0.2 + rand(0, 0.1) : k * 0.16;
      // Willows and double shells are saved for the bigger shows.
      const type = show === 'lap' ? Math.floor(rand(0, 2)) : Math.floor(rand(0, 5));
      pending.push({ at: now + delay, ox, oy: h(ox, oz) + 0.9, oz, tx, ty: h(tx, tz) + height, tz, fuse: rand(1.2, 1.55), size: big, type, pal: Math.floor(rand(0, FW_COLORS.length)) });
    }
  }

  function launch(L: (typeof pending)[number]): void {
    let i = -1;
    for (let r = 0; r < ROCKETS; r++) {
      if (fw.kind[r] === 0) {
        i = r;
        break;
      }
    }
    if (i < 0) return;
    const o = i * 3;
    fw.kind[i] = 1;
    fw.pos[o] = L.ox;
    fw.pos[o + 1] = L.oy;
    fw.pos[o + 2] = L.oz;
    // Ballistic: reach the burst point exactly when the fuse runs out.
    const T = L.fuse;
    fw.vel[o] = (L.tx - L.ox) / T;
    fw.vel[o + 1] = (L.ty - L.oy) / T + 0.5 * GRAVITY * T;
    fw.vel[o + 2] = (L.tz - L.oz) / T;
    fw.life[i] = fw.max[i] = T;
    fw.drag[i] = 0;
    fw.grav[i] = GRAVITY;
    fw.size[i] = L.size;
    fw.type[i] = L.type;
    fw.pal[i] = L.pal;
    fw.col[o] = 3.2;
    fw.col[o + 1] = 1.9;
    fw.col[o + 2] = 0.9;
    fwHeads.visible = fwTrails.visible = true;
    // Muzzle flash sparks.
    for (let k = 0; k < 14; k++) spawnSpark(L.ox, L.oy + 0.3, L.oz, rand(-2, 2), rand(3, 9), rand(-2, 2), rand(0.25, 0.6), true);
  }

  function addStar(x: number, y: number, z: number, vx: number, vy: number, vz: number, c: readonly number[], life: number, drag: number, grav: number, glitter: boolean): void {
    const i = ROCKETS + fw.nextStar;
    fw.nextStar = (fw.nextStar + 1) % STARS;
    const o = i * 3;
    fw.spawned = true;
    fw.kind[i] = glitter ? 3 : 2;
    fw.pos[o] = x;
    fw.pos[o + 1] = y;
    fw.pos[o + 2] = z;
    fw.vel[o] = vx;
    fw.vel[o + 1] = vy;
    fw.vel[o + 2] = vz;
    fw.col[o] = c[0];
    fw.col[o + 1] = c[1];
    fw.col[o + 2] = c[2];
    fw.life[i] = fw.max[i] = life;
    fw.drag[i] = drag;
    fw.grav[i] = grav;
  }

  /** A shell bursts: peony (0), ring (1), double (2), willow (3) or glitter crackle (4). */
  function explode(r: number): void {
    const o = r * 3;
    const x = fw.pos[o];
    const y = fw.pos[o + 1];
    const z = fw.pos[o + 2];
    const size = fw.size[r];
    const type = fw.type[r];
    const c1 = FW_COLORS[fw.pal[r]];
    const c2 = FW_COLORS[(fw.pal[r] + 3) % FW_COLORS.length];
    const gold = FW_COLORS[3];
    const n = Math.round((type === 1 ? 90 : 150) * size);
    const speed = 15 * size;
    // Ring plane: a random tilt.
    const ax = rand(-1, 1);
    const az = rand(-1, 1);
    const al = Math.hypot(ax, 1, az);
    const nx = ax / al;
    const ny = 1 / al;
    const nz = az / al;
    // Two axes in the plane.
    let ux = ny;
    let uy = -nx;
    let uz = 0;
    const ul = Math.hypot(ux, uy, uz) || 1;
    ux /= ul;
    uy /= ul;
    uz /= ul;
    const wx = ny * uz - nz * uy;
    const wy = nz * ux - nx * uz;
    const wz = nx * uy - ny * ux;
    for (let k = 0; k < n; k++) {
      let dx: number, dy: number, dz: number;
      if (type === 1) {
        const a = (k / n) * Math.PI * 2;
        dx = Math.cos(a) * ux + Math.sin(a) * wx;
        dy = Math.cos(a) * uy + Math.sin(a) * wy;
        dz = Math.cos(a) * uz + Math.sin(a) * wz;
      } else {
        // Uniform on the sphere (Fibonacci spiral with jitter keeps the shell round).
        const t = (k + 0.5) / n;
        const inc = Math.acos(1 - 2 * t);
        const az2 = k * 2.39996 + rand(-0.05, 0.05);
        dx = Math.sin(inc) * Math.cos(az2);
        dy = Math.cos(inc);
        dz = Math.sin(inc) * Math.sin(az2);
      }
      const inner = type === 2 && k % 2 === 1;
      const sp = speed * (inner ? 0.55 : 1) * rand(0.92, 1.06);
      if (type === 3) addStar(x, y, z, dx * sp * 0.8, dy * sp * 0.8 + 1, dz * sp * 0.8, gold, rand(2.6, 3.4), 1.9, 2.2, true);
      else addStar(x, y, z, dx * sp, dy * sp, dz * sp, inner ? c2 : c1, rand(1.5, 2.2), 1.45, 3.2, type === 4);
    }
    const f = flashes[nextFlash];
    nextFlash = (nextFlash + 1) % FLASHES;
    f.life = 0.35;
    f.size = 16 * size;
    f.sprite.position.set(x, y, z);
    f.sprite.visible = true;
    f.mat.color.setRGB(c1[0] * 0.45, c1[1] * 0.45, c1[2] * 0.45);
    onFirework?.(x, y, z, size);
  }

  function updateFireworks(dt: number): void {
    for (let k = pending.length - 1; k >= 0; k--) {
      if (now >= pending[k].at) {
        launch(pending[k]);
        pending.splice(k, 1);
      }
    }
    for (const f of flashes) {
      if (f.life <= 0) continue;
      f.life -= dt;
      const k = Math.max(0, f.life / 0.35);
      f.sprite.scale.setScalar(f.size * (1.2 - 0.4 * k));
      f.mat.opacity = k * k;
      if (f.life <= 0) f.sprite.visible = false;
    }
    if (!fwHeads.visible) return;
    let alive = 0;
    fw.spawned = false;
    for (let i = 0; i < FW; i++) {
      const o = i * 3;
      const o2 = i * 6;
      const kind = fw.kind[i];
      if (kind === 0) continue;
      fw.life[i] -= dt;
      if (fw.life[i] <= 0) {
        if (kind === 1) explode(i);
        fw.kind[i] = 0;
        headCol[o] = headCol[o + 1] = headCol[o + 2] = 0;
        for (let a = 0; a < 6; a++) trailCol[o2 + a] = 0;
        continue;
      }
      alive++;
      const drag = fw.drag[i] > 0 ? Math.exp(-dt * fw.drag[i]) : 1;
      fw.vel[o] *= drag;
      fw.vel[o + 1] = fw.vel[o + 1] * drag - fw.grav[i] * dt;
      fw.vel[o + 2] *= drag;
      const x = (fw.pos[o] += fw.vel[o] * dt);
      const y = (fw.pos[o + 1] += fw.vel[o + 1] * dt);
      const z = (fw.pos[o + 2] += fw.vel[o + 2] * dt);
      let b: number;
      let tail: number;
      if (kind === 1) {
        // Rocket: steady hot head, long streak, a stream of embers.
        b = 1;
        tail = 0.11;
        if (Math.random() < dt * 70) spawnSpark(x, y, z, -fw.vel[o] * 0.1 + rand(-0.8, 0.8), -fw.vel[o + 1] * 0.1 + rand(-0.8, 0.4), -fw.vel[o + 2] * 0.1 + rand(-0.8, 0.8), rand(0.3, 0.7), true);
      } else {
        const k = fw.life[i] / fw.max[i];
        const age = fw.max[i] - fw.life[i];
        // Pop on the burst, then a slow fade; the last 20% fades out fully.
        b = (age < 0.08 ? 1.8 : 1) * (0.4 + 0.6 * k) * Math.min(1, k / 0.2);
        if (kind === 3) b *= Math.random() < 0.45 ? 1.7 : 0.15;
        tail = 0.075;
      }
      headPos[o] = x;
      headPos[o + 1] = y;
      headPos[o + 2] = z;
      const r = fw.col[o] * b;
      const g = fw.col[o + 1] * b;
      const bl = fw.col[o + 2] * b;
      headCol[o] = r;
      headCol[o + 1] = g;
      headCol[o + 2] = bl;
      // Trail: from the head (lit) back along the velocity to black.
      trailPos[o2] = x;
      trailPos[o2 + 1] = y;
      trailPos[o2 + 2] = z;
      trailPos[o2 + 3] = x - fw.vel[o] * tail;
      trailPos[o2 + 4] = y - fw.vel[o + 1] * tail;
      trailPos[o2 + 5] = z - fw.vel[o + 2] * tail;
      trailCol[o2] = r * 0.7;
      trailCol[o2 + 1] = g * 0.7;
      trailCol[o2 + 2] = bl * 0.7;
      trailCol[o2 + 3] = trailCol[o2 + 4] = trailCol[o2 + 5] = 0;
    }
    headGeo.attributes.position.needsUpdate = true;
    headGeo.attributes.color.needsUpdate = true;
    trailGeo.attributes.position.needsUpdate = true;
    trailGeo.attributes.color.needsUpdate = true;
    if (!alive && !fw.spawned) fwHeads.visible = fwTrails.visible = false;
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

  function update(time: number, external = true): void {
    if (external) externalAt = performance.now();
    const dt = last < 0 ? 0 : Math.min(0.1, Math.max(0, time - last));
    last = time;
    now = time;
    updateBeams(time);
    updateLeds(time);
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
    updateFireworks(dt);
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

  function setSign(kind: GateKind, text: string, sub = ''): void {
    const rt = runtime.find((r) => r.gate.kind === kind) ?? (kind === 'startFinish' && runtime.length === 1 ? runtime[0] : undefined);
    rt?.sign.set(text, signGlow(text, rt.theme.glow), sub);
  }

  return {
    group,
    gates,
    update: (t) => update(t, true),
    burst,
    setSign,
    fireworks,
    get onFirework() {
      return onFirework;
    },
    set onFirework(f) {
      onFirework = f;
    },
    dispose() {
      ledMesh.dispose();
      beamMesh.dispose();
      confMesh.dispose();
      for (const d of disposables) d.dispose();
    },
  };
}
