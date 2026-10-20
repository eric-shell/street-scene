/**
 * Steam from the manholes: a few of the covers the decals laid down (more in
 * the alleys) breathe puffs that rise, swell, drift and fade. Every puff is a
 * camera facing quad in one mesh; its whole life is a function of the scene
 * clock and a per puff phase, computed in the vertex shader, so the CPU only
 * sets one uniform per frame. Lit a sodium warm grey and fogged like the
 * scene. Medium and High only (streetPolish.ts). Render only.
 */
import * as THREE from 'three';
import { FOG_COLOR, FOG_DENSITY } from './lighting';

export interface Steam {
  mesh: THREE.Mesh;
  update(time: number): void;
  dispose(): void;
}

const STEAM = {
  /** Puffs per vent and the loop period of each (s). */
  puffs: 6,
  period: 3.4,
  /** Rise (m) and size at birth and death (m). */
  rise: 2.6,
  size: [0.5, 2.0],
  /** Sideways drift (m) over a life. */
  drift: 0.5,
  /** Peak alpha. */
  alpha: 0.55,
} as const;

const vert = /* glsl */ `
  attribute vec3 aCenter;
  attribute vec2 aPuff; // phase 0..1, seed 0..1
  uniform float uTime;
  uniform float uPeriod;
  uniform float uRise;
  uniform vec2 uSize;
  uniform float uDrift;
  uniform float fogDensity;
  varying vec2 vUv;
  varying float vAlpha;
  varying float vFog;
  void main() {
    vUv = uv;
    float t = fract(uTime / uPeriod + aPuff.x);
    float ease = 1.0 - (1.0 - t) * (1.0 - t);
    float size = mix(uSize.x, uSize.y, ease) * (0.8 + 0.4 * aPuff.y);
    // Drift sideways in a direction fixed per puff, wobbling a little as it rises.
    float ang = aPuff.y * 6.2831;
    vec3 c = aCenter + vec3(cos(ang), 0.0, sin(ang)) * uDrift * ease + vec3(0.0, uRise * ease + size * 0.35, 0.0);
    c.x += sin(uTime * 1.3 + aPuff.y * 9.0) * 0.08;
    // Born small and transparent, fattest around a third of the way, gone at the end.
    vAlpha = smoothstep(0.0, 0.18, t) * (1.0 - smoothstep(0.35, 1.0, t));
    vec4 mv = viewMatrix * vec4(c, 1.0);
    float spin = aPuff.y * 6.2831 + uTime * (0.3 + 0.4 * aPuff.y) * (aPuff.x > 0.5 ? 1.0 : -1.0);
    vec2 r = vec2(cos(spin), sin(spin));
    vec2 p = vec2(position.x * r.x - position.y * r.y, position.x * r.y + position.y * r.x) * size;
    mv.xy += p;
    float fd = length(mv.xyz);
    vFog = exp(-fogDensity * fogDensity * fd * fd);
    gl_Position = projectionMatrix * mv;
  }
`;

const frag = /* glsl */ `
  uniform sampler2D map;
  uniform vec3 uColor;
  uniform vec3 fogColor;
  uniform float uAlpha;
  varying vec2 vUv;
  varying float vAlpha;
  varying float vFog;
  void main() {
    float a = texture2D(map, vUv).a * vAlpha * uAlpha;
    vec3 col = mix(fogColor, uColor, vFog);
    gl_FragColor = vec4(col, a);
  }
`;

export function buildSteam(vents: readonly THREE.Vector3[], puff: THREE.Texture): Steam {
  const n = vents.length * STEAM.puffs;
  const geo = new THREE.InstancedBufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute([-0.5, -0.5, 0, 0.5, -0.5, 0, 0.5, 0.5, 0, -0.5, 0.5, 0], 3));
  geo.setAttribute('uv', new THREE.Float32BufferAttribute([0, 0, 1, 0, 1, 1, 0, 1], 2));
  geo.setIndex([0, 1, 2, 0, 2, 3]);
  const centers = new Float32Array(n * 3);
  const puffs = new Float32Array(n * 2);
  vents.forEach((v, i) => {
    for (let k = 0; k < STEAM.puffs; k++) {
      const j = i * STEAM.puffs + k;
      centers[j * 3] = v.x;
      centers[j * 3 + 1] = v.y;
      centers[j * 3 + 2] = v.z;
      // Phases spread evenly so the vent never falls silent; seeds vary size, drift and spin.
      puffs[j * 2] = (k + ((i * 7919) % 97) / 97) / STEAM.puffs;
      puffs[j * 2 + 1] = ((i * 31 + k * 17) % 101) / 101;
    }
  });
  geo.setAttribute('aCenter', new THREE.InstancedBufferAttribute(centers, 3));
  geo.setAttribute('aPuff', new THREE.InstancedBufferAttribute(puffs, 2));
  geo.instanceCount = n;
  const mat = new THREE.ShaderMaterial({
    vertexShader: vert,
    fragmentShader: frag,
    uniforms: {
      map: { value: puff },
      uTime: { value: 0 },
      uPeriod: { value: STEAM.period },
      uRise: { value: STEAM.rise },
      uSize: { value: new THREE.Vector2(STEAM.size[0], STEAM.size[1]) },
      uDrift: { value: STEAM.drift },
      uAlpha: { value: STEAM.alpha },
      uColor: { value: new THREE.Color(0x8c7f70) },
      fogColor: { value: new THREE.Color(FOG_COLOR) },
      fogDensity: { value: FOG_DENSITY },
    },
    transparent: true,
    depthWrite: false,
  });
  const mesh = new THREE.Mesh(geo, mat);
  mesh.name = 'steam';
  mesh.frustumCulled = false;
  mesh.renderOrder = 3;
  return {
    mesh,
    update(time) {
      mat.uniforms.uTime.value = time;
    },
    dispose() {
      mesh.removeFromParent();
      geo.dispose();
      mat.dispose();
    },
  };
}
