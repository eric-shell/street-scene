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
 *
 * This module is the public surface and the assembly: the painted lines, the
 * per gate state and the update loop. The gate themes and canvas textures are
 * in finishLook.ts, the steel and the light rig in finishGantry.ts, the
 * confetti, sparks and fireworks in finishCelebration.ts.
 */
import * as THREE from 'three';
import type { World } from '../../city/world';
import { routeSample } from '../../city/route';
import { gateLines } from '../../city/people/gates';
import { GeoBuilder } from '../geoBuilder';
import { makeCheckerTexture } from '../textures/textures';
import { Disposer } from '../disposer';
import { LINE_Y, signGlow, beamTexture, dotTexture } from './finishLook';
import { buildGantry, createLightRig } from './finishGantry';
import type { GateRuntime, LightPlan, GantryKit } from './finishGantry';
import { createCelebration } from './finishCelebration';

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

export function buildFinishLines(world: World): FinishLines {
  const route = world.route;
  const h = world.heightAt;
  const group = new THREE.Group();
  group.name = 'finishLines';
  const res = new Disposer();
  const { track } = res;

  const lines: { s: number; kind: GateKind }[] = gateLines(world);

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

  const lights: LightPlan = { leds: [], ledPos: [], ledScale: [], beams: [] };
  const kit: GantryKit = { world, group, track, steelMat, darkMat, flagMat, bannerMat, beamTex, lights };
  // A circuit starting on a race pass (under the monument's arch, city/route.ts Route.passStart) keeps
  // its painted line but gets no gantry: the landmark is the gate, and steel pillars would stand in
  // the plaza's paving beside the piers. No gantry, no sign, no burst or fireworks there.
  const runtime = route.passStart ? [] : lines.map(({ s, kind }, gi) => buildGantry(kit, s, kind, gi));
  const gates = runtime.map((rt) => rt.gate);
  const rig = createLightRig(group, track, lights, runtime, beamTex);
  const fx = createCelebration(world, group, track, dot);
  let last = -1;
  let externalAt = -1;

  /** Gate for a show: the start line for 'start', the finish for 'finish', the circuit line for laps. */
  function gateFor(kind: 'start' | 'finish' | 'lap'): GateRuntime | undefined {
    if (kind === 'lap') return runtime.find((r) => r.gate.kind === 'startFinish');
    return runtime.find((r) => (kind === 'finish' ? r.gate.kind !== 'start' : r.gate.kind !== 'finish'));
  }

  function update(time: number, external = true): void {
    if (external) externalAt = performance.now();
    const dt = last < 0 ? 0 : Math.min(0.1, Math.max(0, time - last));
    last = time;
    rig.update(time);
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
    fx.update(time, dt);
  }

  // The menu backdrop never calls update(): animate from the render clock instead.
  rig.ledMesh.onBeforeRender = () => {
    if (externalAt < 0 || performance.now() - externalAt > 500) update(performance.now() / 1000, false);
  };

  function burst(kind: 'finish' | 'start' = 'finish', strength = 1): void {
    const rt = gateFor(kind);
    if (!rt) return;
    rt.flash = kind === 'finish' ? 2.6 * strength : 1.2 * strength;
    fx.burst(rt, kind, strength);
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
    fireworks(show, strength) {
      const rt = gateFor(show);
      if (rt) fx.fireworks(rt, show, strength);
    },
    get onFirework() {
      return fx.onFirework;
    },
    set onFirework(f) {
      fx.onFirework = f;
    },
    dispose: () => res.dispose(),
  };
}
