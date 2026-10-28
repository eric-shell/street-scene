/**
 * Boats that sit on the water and move with it: the marina's sailboats, yachts and afloat dinghies, the lake's
 * rowboats on their moorings, the beach's anchored boats. A `BoatFleet` is two builders (lit, and glowing for the
 * windows and lamps) that a district draws its moored boats into instead of the kit's shared ones; every vertex
 * of a boat carries its mooring (`aBoat`: pivot x, z, phase, waterline y; `aBoatB`: how hard it rocks, how far it
 * swings on its line, how far it drifts), and the vertex shader rolls, pitches and heaves it on a swell that follows
 * the wind (`WATER_SKY`), each boat at its own phase. One mesh per builder for the whole fleet, no per frame work
 * but the scene clock's uniform, and no matrix writes at all: the sway is a pure function of the clock, so it
 * looks the same at 30, 60 and 120 fps.
 *
 * The rock is the boat following the water's slope: a tilt vector in the ground plane (along the wind and across
 * it, two incommensurate rates) lifts one side and drops the other, and tops lean the other way, so a mast head
 * swings further than the hull. The swell is a floor of a third of the amplitude on a still night, the full amount
 * at the crest of a gust. The meshes must sit at the origin: positions are world positions.
 */
import * as THREE from 'three';
import { GeoBuilder } from '../geoBuilder';
import { fadeSubPixel } from '../materialFx';
import { WATER_SKY } from '../sky/waterSky';
import type { DistrictKit } from './kit';

/** Every number of the boats that move, in one place. */
export const BOATS = {
  /**
   * The swell a moored boat rides. `roll`/`pitch`: the largest tilt (rad) across and along the wind at full swell;
   * `heave` the rise and fall (m); `hz` the rates (Hz) of the along-wind, across-wind and heave motions (unrelated, so
   * the boat never repeats); `floor` the share of the amplitude on a still night; `yawHz` the rate of the swing on the line.
   */
  rock: { roll: 0.034, pitch: 0.022, heave: 0.085, hz: [0.17, 0.23, 0.31], floor: 0.34, yawHz: 0.035 },
  /** How hard each kind rocks, a multiplier of `rock` (small boats are livelier), and how far it swings (rad) and drifts (m) on its line. */
  kinds: {
    sailboat: { rock: 1, swing: 0.012, drift: 0.05 },
    yacht: { rock: 0.65, swing: 0.008, drift: 0.03 },
    dinghy: { rock: 1.7, swing: 0.05, drift: 0.12 },
    rowboat: { rock: 1.8, swing: 0.12, drift: 0.16 },
    anchored: { rock: 1.1, swing: 0.3, drift: 0.8 },
  },
  /** The ferry (waterfrontFerry.ts): the hull's size (m), its speed (m/s) and the pace of a stop, the dwell at the berth (s), the turn radius (m), the first departure (s, [min, max]), how far out the lane runs (m). */
  ferry: {
    length: 44,
    beam: 11,
    freeboard: 2.4,
    draft: 1.5,
    speed: 7.5,
    accel: 0.28,
    dwell: 50,
    radius: 90,
    firstDeparture: [25, 55] as [number, number],
    run: 1100,
    /** The lane keeps this far from anything standing in the water (m, hull's centreline to the obstacle's edge). */
    clearance: 22,
    /** Without a berth the ferry sails a lane this far beyond everything out in the water (m), at this speed (m/s). */
    laneMargin: 70,
    laneSpeed: 8,
    /** The ferry rocks on the swell more slowly than a small boat. */
    rock: 0.5,
  },
  /** The wake: how far it trails the stern (m), its width at the stern and at the far end (m), and the speed (m/s) at which it is full. */
  wake: { length: 110, near: 5, far: 28, fullSpeed: 6, strength: 0.3 },
  /** The horn: where it can be heard (m, to its half level), the range it is dropped beyond (m), and how long a blast is (s). */
  horn: { half: 260, range: 1500, seconds: 2.4, approach: 300 },
} as const;

/** What a boat is moored by: where it pivots, the waterline there, its phase and what kind of boat rocks how. */
export interface Mooring {
  x: number;
  z: number;
  /** The water's level at the boat (m). */
  y: number;
  /** A phase (rad) that sets this boat's motion apart from its neighbours'. */
  phase: number;
  kind: keyof typeof BOATS.kinds;
}

/** A stable phase (rad) from a place, so a boat rocks the same on every build of its seed. */
export function mooringPhase(x: number, z: number): number {
  const s = Math.sin(x * 12.9898 + z * 78.233) * 43758.5453;
  return (s - Math.floor(s)) * Math.PI * 2;
}

/** Where a boat's vertices start in the two builders, from `begin()` to `end()`. */
export interface FleetMark {
  solid: number;
  glow: number;
}

/** The vertex shader's sway. */
function swayVertex(): string {
  const R = BOATS.rock;
  const f = (n: number) => n.toFixed(5);
  return /* glsl */ `
    {
      float ph = aBoat.z;
      float t = uWaterTime;
      float sw = ${f(R.floor)} + ${f(1 - R.floor)} * uWaterWind;
      float w1 = sin(t * ${f(R.hz[0] * Math.PI * 2)} + ph);
      float w2 = sin(t * ${f(R.hz[1] * Math.PI * 2)} + ph * 1.7 + 1.3);
      float w3 = sin(t * ${f(R.hz[2] * Math.PI * 2)} + ph * 2.9);
      vec2 hd = uWaterHeading;
      vec2 pd = vec2(-hd.y, hd.x);
      // The water's slope under the boat: the surface rises toward +tilt.
      vec2 tilt = (hd * w1 * ${f(R.pitch)} + pd * w2 * ${f(R.roll)}) * sw * aBoatB.x;
      vec2 rel = transformed.xz - aBoat.xy;
      float up = transformed.y - aBoat.w;
      float ya = aBoatB.y * sin(t * ${f(R.yawHz * Math.PI * 2)} + ph * 3.1);
      float cy = cos(ya);
      float sy = sin(ya);
      rel = vec2(cy * rel.x - sy * rel.y, sy * rel.x + cy * rel.y);
      vec2 dr = aBoatB.z * vec2(sin(t * 0.11 + ph), cos(t * 0.083 + ph * 1.3));
      transformed.y += ${f(R.heave)} * sw * aBoatB.x * (0.65 * w3 + 0.35 * w2) + dot(rel, tilt);
      transformed.xz = aBoat.xy + rel + dr - up * tilt;
    }
  `;
}

/** Give a material the boats' sway (chains whatever `onBeforeCompile` and cache key it already has). */
export function swayMaterial<T extends THREE.Material>(m: T): T {
  const prevCompile = m.onBeforeCompile;
  const prevKey = m.customProgramCacheKey;
  m.onBeforeCompile = function (this: THREE.Material, shader, renderer) {
    prevCompile.call(this, shader, renderer);
    shader.uniforms.uWaterTime = WATER_SKY.time;
    shader.uniforms.uWaterWind = WATER_SKY.wind;
    shader.uniforms.uWaterHeading = WATER_SKY.heading;
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', '#include <common>\nattribute vec4 aBoat;\nattribute vec3 aBoatB;\nuniform float uWaterTime;\nuniform float uWaterWind;\nuniform vec2 uWaterHeading;')
      .replace('#include <begin_vertex>', `#include <begin_vertex>\n${swayVertex()}`);
  };
  m.customProgramCacheKey = function (this: THREE.Material) {
    return `${prevKey.call(this)}|boats`;
  };
  m.needsUpdate = true;
  return m;
}

/** The boats of one district, drawn into two builders and mounted as two meshes. */
export class BoatFleet {
  /** Lit, vertex coloured: hulls, cabins, masts. */
  readonly solid = new GeoBuilder(true);
  /** Unlit, bright: windows and lamps. */
  readonly glow = new GeoBuilder(true);
  private tagsS: number[] = [];
  private tagsG: number[] = [];
  private tagsSB: number[] = [];
  private tagsGB: number[] = [];

  /** Call before drawing a boat into `solid` and `glow`. */
  begin(): FleetMark {
    return { solid: this.solid.vertexCount, glow: this.glow.vertexCount };
  }

  /** Call after: every vertex drawn since `begin()` rocks on this mooring. */
  end(mark: FleetMark, m: Mooring): void {
    const k = BOATS.kinds[m.kind];
    const fill = (gb: GeoBuilder, from: number, a: number[], b: number[]) => {
      for (let i = from; i < gb.vertexCount; i++) {
        a.push(m.x, m.z, m.phase, m.y);
        b.push(k.rock, k.swing, k.drift);
      }
    };
    fill(this.solid, mark.solid, this.tagsS, this.tagsSB);
    fill(this.glow, mark.glow, this.tagsG, this.tagsGB);
  }

  get vertexCount(): number {
    return this.solid.vertexCount + this.glow.vertexCount;
  }

  /** Build the meshes into the kit's group: `<name>` lit and `<name>Lights` glowing. Nothing is added for an empty builder. */
  mount(kit: DistrictKit, name: string): THREE.Mesh[] {
    const out: THREE.Mesh[] = [];
    const add = (gb: GeoBuilder, a: number[], b: number[], mat: THREE.Material, n: string) => {
      if (!gb.vertexCount) return;
      const geo = kit.track(gb.build());
      geo.setAttribute('aBoat', new THREE.Float32BufferAttribute(a, 4));
      geo.setAttribute('aBoatB', new THREE.Float32BufferAttribute(b, 3));
      const mesh = new THREE.Mesh(geo, kit.track(mat));
      mesh.name = n;
      // The sway never moves a boat further than a metre or two from its bounds: cull on the build-time sphere, grown a little.
      geo.boundingSphere!.radius += 6;
      kit.group.add(mesh);
      out.push(mesh);
    };
    add(this.solid, this.tagsS, this.tagsSB, swayMaterial(new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.85, envMapIntensity: 0.5 })), name);
    // The kit's glow material, with its own sub pixel fade.
    const glow = new THREE.MeshBasicMaterial({ vertexColors: true });
    glow.color.setScalar(1.6);
    fadeSubPixel(glow, 0.35, 0.3);
    add(this.glow, this.tagsG, this.tagsGB, swayMaterial(glow), `${name}Lights`);
    return out;
  }
}
