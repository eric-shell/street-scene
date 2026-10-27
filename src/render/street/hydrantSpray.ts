/**
 * Broken fire hydrants gush: a column of water spraying up out of the stump
 * and falling back around it in a ragged fountain, for as long as the
 * hydrant stays broken (the rest of the race). Every drop is a camera facing
 * quad whose whole flight is a function of the scene clock, its slot's start
 * time and a per drop phase, computed in the vertex shader like the manhole
 * steam (steam.ts): the CPU only sets the clock each frame and a slot's
 * position and start when a hydrant breaks or is restored. A few slots at
 * once (the oldest gusher is recycled), one draw call while any is running,
 * none otherwise. Lit a cool sodium grey and fogged like the scene. Render only.
 */
import * as THREE from 'three';
import { FOG_COLOR, FOG_DENSITY } from '../lighting';
import { makeSteamPuff } from '../textures/textures';
import { HEIGHT_FOG_GLSL, HEIGHT_FOG_UNIFORMS } from '../heightFog';

const SPRAY = {
  /** Gushers at once and drops per gusher. */
  slots: 8,
  drops: 72,
  /** Launch speed range up (m/s), sideways spread (m/s) and the loop period of a drop (s). */
  up: [6.5, 11],
  spread: [0.4, 2.4],
  period: 2.3,
  /** Drop size at launch and at the end (m), peak alpha. */
  size: [0.18, 0.75],
  alpha: 0.5,
  /** Height of the nozzle over the stump's base (m). */
  nozzle: 0.45,
  gravity: 9.81,
} as const;

const vert = /* glsl */ `
  attribute vec3 aDrop; // slot, phase 0..1, seed 0..1
  uniform float uTime;
  uniform vec4 uSlots[${SPRAY.slots}];
  uniform float uPeriod;
  uniform vec2 uUp;
  uniform vec2 uSpread;
  uniform vec2 uSize;
  uniform float uGravity;
  uniform float fogDensity;
  ${HEIGHT_FOG_GLSL}
  varying vec2 vUv;
  varying float vAlpha;
  varying float vFog;
  void main() {
    vUv = uv;
    vec4 s = uSlots[int(aDrop.x + 0.5)];
    float age = uTime - s.w;
    float t = fract(age / uPeriod + aDrop.y);
    float T = t * uPeriod;
    // Off, or not launched yet since the hydrant broke: no drop.
    if (s.w < 0.0 || age < T) {
      gl_Position = vec4(2.0, 2.0, 2.0, 1.0);
      vAlpha = 0.0;
      vFog = 0.0;
      return;
    }
    float seed = aDrop.z;
    // Most drops near the column, a ragged few flung wide; a slow wobble so the plume never freezes.
    float wide = seed * seed;
    float up = mix(uUp.y, uUp.x, wide) * (0.92 + 0.08 * sin(uTime * 7.0 + seed * 40.0));
    float ang = seed * 37.7 + aDrop.y * 6.2831;
    float spd = mix(uSpread.x, uSpread.y, wide);
    vec3 v0 = vec3(cos(ang) * spd, up, sin(ang) * spd);
    vec3 c = s.xyz + v0 * T + vec3(0.0, -0.5 * uGravity * T * T, 0.0);
    // Below the street: gone (it has splashed).
    float above = step(s.y - 0.6, c.y);
    float size = mix(uSize.x, uSize.y, t) * (0.7 + 0.6 * seed);
    vAlpha = smoothstep(0.0, 0.06, t) * (1.0 - smoothstep(0.55, 1.0, t)) * above;
    vec4 mv = viewMatrix * vec4(c, 1.0);
    mv.xy += position.xy * size;
    float fd = length(mv.xyz);
    vFog = exp(-fogDensity * fogDensity * fd * fd * hfMulView(mv.xyz));
    gl_Position = projectionMatrix * mv;
  }
`;

const frag = /* glsl */ `
  uniform sampler2D map;
  uniform vec3 uColor;
  uniform vec3 fogColor;
  ${HEIGHT_FOG_GLSL}
  uniform float uAlpha;
  varying vec2 vUv;
  varying float vAlpha;
  varying float vFog;
  void main() {
    float a = texture2D(map, vUv).a * vAlpha * uAlpha;
    if (a < 0.003) discard;
    gl_FragColor = vec4(mix(hfFogColorCam(fogColor), uColor, vFog), a);
  }
`;

export interface HydrantSpray {
  mesh: THREE.Mesh;
  /** A hydrant (prop id) broke at scene time `time`: start gushing at its base. */
  start(id: number, x: number, y: number, z: number, time: number): void;
  /** The hydrant is whole again (restart, rewind): stop its gusher. */
  stop(id: number): void;
  update(time: number): void;
  dispose(): void;
}

export function buildHydrantSpray(): HydrantSpray {
  const S = SPRAY;
  const n = S.slots * S.drops;
  const geo = new THREE.InstancedBufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute([-0.5, -0.5, 0, 0.5, -0.5, 0, 0.5, 0.5, 0, -0.5, 0.5, 0], 3));
  geo.setAttribute('uv', new THREE.Float32BufferAttribute([0, 0, 1, 0, 1, 1, 0, 1], 2));
  geo.setIndex([0, 1, 2, 0, 2, 3]);
  const drops = new Float32Array(n * 3);
  for (let i = 0; i < n; i++) {
    const k = i % S.drops;
    drops[i * 3] = Math.floor(i / S.drops);
    // Phases spread evenly so the gusher never pauses; seeds from a fixed hash, the same every scene.
    drops[i * 3 + 1] = (k + 0.5) / S.drops;
    drops[i * 3 + 2] = ((k * 7919 + 104729) % 997) / 997;
  }
  geo.setAttribute('aDrop', new THREE.InstancedBufferAttribute(drops, 3));
  geo.instanceCount = n;
  const slots = Array.from({ length: S.slots }, () => new THREE.Vector4(0, 0, 0, -1));
  const puff = makeSteamPuff();
  const mat = new THREE.ShaderMaterial({
    vertexShader: vert,
    fragmentShader: frag,
    uniforms: {
      map: { value: puff },
      uTime: { value: 0 },
      uSlots: { value: slots },
      uPeriod: { value: S.period },
      uUp: { value: new THREE.Vector2(S.up[0], S.up[1]) },
      uSpread: { value: new THREE.Vector2(S.spread[0], S.spread[1]) },
      uSize: { value: new THREE.Vector2(S.size[0], S.size[1]) },
      uGravity: { value: S.gravity },
      uAlpha: { value: S.alpha },
      uColor: { value: new THREE.Color(0xa9b4bc) },
      fogColor: { value: new THREE.Color(FOG_COLOR) },
      fogDensity: { value: FOG_DENSITY },
      ...HEIGHT_FOG_UNIFORMS,
    },
    transparent: true,
    depthWrite: false,
  });
  const mesh = new THREE.Mesh(geo, mat);
  mesh.name = 'hydrantSpray';
  mesh.frustumCulled = false;
  mesh.renderOrder = 3;
  mesh.visible = false;
  /** Prop id per slot (-1 free) and when each started, to recycle the oldest. */
  const owner = new Int32Array(S.slots).fill(-1);
  const since = new Float64Array(S.slots);
  const refresh = () => {
    mesh.visible = owner.some((o) => o >= 0);
  };
  return {
    mesh,
    start(id, x, y, z, time) {
      let k = owner.indexOf(id);
      if (k < 0) k = owner.indexOf(-1);
      if (k < 0) {
        k = 0;
        for (let i = 1; i < S.slots; i++) if (since[i] < since[k]) k = i;
      }
      owner[k] = id;
      since[k] = time;
      slots[k].set(x, y + S.nozzle, z, time);
      refresh();
    },
    stop(id) {
      const k = owner.indexOf(id);
      if (k < 0) return;
      owner[k] = -1;
      slots[k].w = -1;
      refresh();
    },
    update(time) {
      mat.uniforms.uTime.value = time;
    },
    dispose() {
      mesh.removeFromParent();
      geo.dispose();
      mat.dispose();
      puff.dispose();
    },
  };
}
